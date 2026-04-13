import { invokeWithHandle, type InvokeHandle } from "../core/invoke";
import { connectWebSocket } from "../core/websocket";

const botToken = process.env.SLACK_BOT_TOKEN!;
const appToken = process.env.SLACK_APP_TOKEN!;

const SYSTEM_PROMPT =
  "CRITICAL: Your entire response will be sent verbatim as a Slack message. Output ONLY the message text — no thinking, no commentary, no narration, no action summaries. Just the message as Mega would write it. Keep it casual and concise.";

const THINKING_EMOJI = "thinking_face";

let botUserId: string | null = null;

const activeInvocations = new Map<
  string,
  { handle: InvokeHandle; messages: any[]; reactedTs: string }
>();

async function getBotUserId(): Promise<string> {
  if (botUserId) return botUserId;
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const data = (await res.json()) as any;
  if (!data.ok) throw new Error(`auth.test failed: ${data.error}`);
  botUserId = data.user_id;
  return botUserId!;
}

async function slackAPI(method: string, body: any) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as any;
}

async function handleThreadStarted(evt: any) {
  const thread = evt.assistant_thread;
  const channel = thread.channel_id;
  const threadTs = thread.thread_ts;

  console.log(`[slack] New agent thread in ${channel}`);

  await slackAPI("assistant.threads.setSuggestedPrompts", {
    channel_id: channel,
    thread_ts: threadTs,
    prompts: [
      { title: "Check my emails", message: "Any unread emails I should know about?" },
      { title: "Review a PR", message: "Review this PR for me: " },
      { title: "What's on your mind?", message: "What have you been working on lately?" },
    ],
  });
}

export function buildPrompt(channel: string, user: string, threadTs: string, messages: any[]): string {
  const parts: string[] = [];
  const allFiles: string[] = [];

  for (const evt of messages) {
    if (evt.text) parts.push(evt.text);
    if (evt.files) {
      for (const f of evt.files) {
        allFiles.push(f.name || "unknown");
      }
    }
  }

  let attachmentNote = "";
  if (allFiles.length > 0) {
    attachmentNote = `\n\n(The user attached ${allFiles.length} file(s): ${allFiles.join(", ")}. You cannot view these yet — let the user know.)`;
  }

  return `New Slack message:

From user: ${user}
Channel: ${channel}
Thread: ${threadTs}

${parts.join("\n")}${attachmentNote}`;
}

async function handleMessage(evt: any) {
  const channel = evt.channel;
  const user = evt.user;
  const threadTs = evt.thread_ts || evt.ts;
  const sessionKey = `${channel}-${threadTs}`;
  const sessionId = `slack-${channel}-${threadTs}`;

  console.log(
    `[slack] Message from ${user} in ${channel}: ${(evt.text || "").substring(0, 80)}`
  );

  // Interrupt active invocation if one exists
  const active = activeInvocations.get(sessionKey);
  if (active) {
    console.log(`[slack] Interrupting active invocation — adding message`);
    active.handle.kill();
    await slackAPI("reactions.remove", {
      channel,
      timestamp: active.reactedTs,
      name: THINKING_EMOJI,
    });
    active.messages.push(evt);
  }

  // React to latest message to signal thinking
  await slackAPI("reactions.add", {
    channel,
    timestamp: evt.ts,
    name: THINKING_EMOJI,
  });

  const messages = active ? active.messages : [evt];
  const prompt = buildPrompt(channel, user, threadTs, messages);

  const handle = invokeWithHandle({
    eventId: `slack-${channel}-${evt.ts}`,
    sessionId,
    prompt,
    systemPrompt: SYSTEM_PROMPT,
  });

  activeInvocations.set(sessionKey, { handle, messages, reactedTs: evt.ts });

  try {
    const response = await handle.promise;

    // If we were killed, a new invocation has taken over — bail out
    if (activeInvocations.get(sessionKey)?.handle !== handle) return;

    activeInvocations.delete(sessionKey);

    await slackAPI("reactions.remove", {
      channel,
      timestamp: evt.ts,
      name: THINKING_EMOJI,
    });

    if (response) {
      console.log("[slack] Sending reply...");
      const result = await slackAPI("chat.postMessage", {
        channel,
        text: response,
        thread_ts: threadTs,
      });
      if (result.ok) {
        console.log("[slack] Reply sent.");
      } else {
        console.error("[slack] Failed to send reply:", result.error);
      }
    }
  } catch (err) {
    if (activeInvocations.get(sessionKey)?.handle === handle) {
      activeInvocations.delete(sessionKey);
    }
    console.error("[slack] Error in handleMessage:", err);
  }
}

export async function start() {
  const myUserId = await getBotUserId();

  console.log("[slack] Starting...");

  connectWebSocket({
    url: async () => {
      const res = await fetch("https://slack.com/api/apps.connections.open", {
        method: "POST",
        headers: { Authorization: `Bearer ${appToken}` },
      });
      const data = (await res.json()) as any;
      if (!data.ok) throw new Error(`apps.connections.open failed: ${data.error}`);
      return data.url;
    },
    label: "slack",
    onOpen: () => {
      console.log("[slack] Connected to Socket Mode.");
    },
    onMessage: (data, ws) => {
      // Acknowledge envelope immediately (Slack requires this within 3s)
      if (data.envelope_id) {
        ws.send(JSON.stringify({ envelope_id: data.envelope_id }));
      }

      if (data.type === "hello") {
        console.log("[slack] Ready. Waiting for messages...");
        return;
      }

      if (data.type === "disconnect") {
        console.log("[slack] Server requested disconnect. Will reconnect...");
        return;
      }

      if (data.type !== "events_api") return;

      const evt = data.payload?.event;
      if (!evt) return;

      if (evt.type === "assistant_thread_started") {
        handleThreadStarted(evt);
        return;
      }

      if (evt.type === "assistant_thread_context_changed") {
        console.log("[slack] Thread context changed:", evt.assistant_thread?.channel_id);
        return;
      }

      if (evt.type !== "message") return;

      // Ignore bot messages (including our own)
      if (evt.bot_id || evt.user === myUserId) return;
      // Ignore message subtypes except file_share
      if (evt.subtype && evt.subtype !== "file_share") return;

      handleMessage(evt);
    },
  });
}
