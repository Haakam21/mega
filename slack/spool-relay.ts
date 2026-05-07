/**
 * Slack ↔ Spool relay. Bidirectional bridge:
 *   inbound  : Slack Socket Mode WebSocket → Spool publish (ns=slack, type=message)
 *   outbound : Spool cursor tail (ns=message, type=end) → Slack chat.postMessage
 *
 * Same shape as agentmail/spool-relay.ts. The Mega consumer
 * (core/spool-loop.ts::startSlackConsumer) sits between, fetching
 * thread history, invoking Claude, and publishing the response.
 *
 * Thread topology: one Spool thread per bot user — `slack/<bot_user_id>`.
 * Channel + thread_ts ride in event data; per-Slack-thread isolation is
 * the consumer's responsibility (via Claude session_id).
 */

import { connectWebSocket } from "../core/websocket";
import { type SpoolClient, type SpoolEvent } from "../core/spool";

const botToken = process.env.SLACK_BOT_TOKEN!;
const appToken = process.env.SLACK_APP_TOKEN!;

const THINKING_EMOJI = "thinking_face";

let botUserId: string | null = null;

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

async function slackAPI(method: string, body: any): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return await res.json();
}

/** The Spool thread this bot publishes to and tails. Computed from the
 *  bot user id resolved at startup. */
export async function slackThread(): Promise<string> {
  const id = await getBotUserId();
  return `slack/${id}`;
}

export async function startInbound(spool: SpoolClient): Promise<void> {
  const myId = await getBotUserId();
  const thread = await slackThread();
  console.log(`[slack-spool] inbound: ${thread}`);

  connectWebSocket({
    url: async () => {
      const res = await fetch("https://slack.com/api/apps.connections.open", {
        method: "POST",
        headers: { Authorization: `Bearer ${appToken}` },
      });
      const data = (await res.json()) as any;
      if (!data.ok) {
        throw new Error(`apps.connections.open failed: ${data.error}`);
      }
      return data.url;
    },
    label: "slack-spool",
    onOpen: () => {
      console.log("[slack-spool] inbound: socket mode connected");
    },
    onMessage: (data, ws) => {
      // Slack requires envelope ack within 3s, even if we don't act on it.
      if (data.envelope_id) {
        ws.send(JSON.stringify({ envelope_id: data.envelope_id }));
      }
      if (data.type === "hello") {
        console.log("[slack-spool] inbound: ready");
        return;
      }
      if (data.type !== "events_api") return;
      const evt = data.payload?.event;
      if (!evt || evt.type !== "message") return;
      // Drop bot messages (including our own) and message subtypes that
      // aren't user-authored content.
      if (evt.bot_id || evt.user === myId) return;
      if (evt.subtype && evt.subtype !== "file_share") return;

      void publishInbound(spool, thread, evt, data.envelope_id, myId);
    },
  });
}

async function publishInbound(
  spool: SpoolClient,
  thread: string,
  evt: any,
  envelopeId: string | undefined,
  myId: string
): Promise<void> {
  const channel = evt.channel;
  const ts = evt.ts;
  const threadTs = evt.thread_ts || evt.ts;

  // 🤔 reaction signals "Mega is thinking"; outbound clears it on reply.
  // Best-effort — don't block the publish on this.
  slackAPI("reactions.add", {
    channel,
    timestamp: ts,
    name: THINKING_EMOJI,
  }).catch((err) => {
    console.warn("[slack-spool] reactions.add failed:", err);
  });

  try {
    await spool.publish(thread, [
      {
        ns: "slack",
        type: "message",
        id: envelopeId,
        source: `slack.relay@${process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz"}`,
        data: {
          event_id: envelopeId,
          bot_user_id: myId,
          channel,
          user: evt.user,
          thread_ts: threadTs,
          ts,
          text: evt.text || "",
          files: evt.files || [],
        },
      },
    ]);
  } catch (e) {
    console.error("[slack-spool] inbound publish failed:", e);
  }
}

export async function startOutbound(spool: SpoolClient): Promise<void> {
  const thread = await slackThread();
  await spool.createThread(thread);
  const cursor = await spool.createCursor(thread, {
    name: "slack-outbound",
    filter_ns: "message",
    filter_type: "end",
  });
  console.log(
    `[slack-spool] outbound: cursor=${cursor.id} from seq=${cursor.cursor_seq}`
  );

  (async () => {
    try {
      for await (const ev of spool.tailCursor(cursor.id)) {
        await handleOutbound(ev);
        await spool.ackCursor(cursor.id, ev.seq + 1);
      }
    } catch (e) {
      console.error("[slack-spool] outbound tail failed:", e);
    }
  })();
}

async function handleOutbound(ev: SpoolEvent): Promise<void> {
  const channel = ev.data.channel;
  const threadTs = ev.data.thread_ts;
  const ts = ev.data.ts;
  const text = ev.data.content;
  if (
    typeof channel !== "string" ||
    typeof threadTs !== "string" ||
    typeof text !== "string"
  ) {
    console.warn(
      `[slack-spool] outbound: skipping seq=${ev.seq} (missing channel/thread_ts/content)`
    );
    return;
  }

  const result = await slackAPI("chat.postMessage", {
    channel,
    text,
    thread_ts: threadTs,
  });
  if (!result.ok) {
    throw new Error(`chat.postMessage in ${channel}: ${result.error}`);
  }

  // Best-effort: clear the 🤔 reaction added on inbound. Not load-bearing.
  if (typeof ts === "string") {
    slackAPI("reactions.remove", {
      channel,
      timestamp: ts,
      name: THINKING_EMOJI,
    }).catch((err) => {
      console.warn("[slack-spool] reactions.remove failed:", err);
    });
  }

  console.log(`[slack-spool] outbound: replied in ${channel}/${threadTs}`);
}

/** Fetch thread history via conversations.replies. Used by the Mega
 *  consumer to give Claude context on prior messages in a Slack thread.
 *  Exposed here so the consumer doesn't need its own Slack token plumbing. */
export async function fetchThreadHistory(
  channel: string,
  threadTs: string
): Promise<any[]> {
  const result = await slackAPI("conversations.replies", {
    channel,
    ts: threadTs,
  });
  if (result.ok && Array.isArray(result.messages)) return result.messages;
  return [];
}
