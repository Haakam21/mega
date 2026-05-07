/**
 * Mega's consumer loops. One per channel (agentmail, slack). Each
 * subscribes to a Spool cursor, invokes Claude on inbound events, and
 * publishes Claude's reply as a `message.end` event back to the same
 * thread. The channel's spool-relay picks up `message.end` and sends
 * the actual API call (email reply / Slack chat.postMessage).
 *
 * v1: each consumer processes events serially (one Claude at a time
 * per cursor). The existing channel.ts files have interrupt-and-merge
 * for bursts on the same conversation; we'll layer that back when the
 * round trips are verified end-to-end.
 */

import { invokeWithHandle } from "./invoke";
import { fetchThreadHistory } from "../slack/spool-relay";
import type { SpoolClient, SpoolEvent } from "./spool";

const AGENTMAIL_SYSTEM_PROMPT =
  "You are responding via email. Your final response will be sent verbatim as an email reply, so make sure it contains only the reply body.";

const SLACK_SYSTEM_PROMPT =
  "You are responding via Slack. Your final response will be posted verbatim as a Slack message, so make sure it contains only the message text.";

/** Subscribe + drive Claude. Long-running — drives the loop for the
 *  lifetime of the process. */
export async function startAgentMailConsumer(
  spool: SpoolClient,
  thread: string,
  cursorName: string
): Promise<void> {
  await spool.createThread(thread);
  const cursor = await spool.createCursor(thread, {
    name: cursorName,
    filter_ns: "agentmail",
    filter_type: "message",
  });
  console.log(
    `[spool-loop] consumer: cursor=${cursor.id} on ${thread} from seq=${cursor.cursor_seq}`
  );

  (async () => {
    try {
      for await (const ev of spool.tailCursor(cursor.id)) {
        const wakeAt = Date.now();
        await handleInbound(spool, thread, ev, wakeAt);
        await spool.ackCursor(cursor.id, ev.seq + 1);
      }
    } catch (e) {
      console.error("[spool-loop] consumer tail failed:", e);
    }
  })();
}

async function handleInbound(
  spool: SpoolClient,
  thread: string,
  ev: SpoolEvent,
  wakeAt: number
): Promise<void> {
  const threadId = ev.data.thread_id as string | undefined;
  const messageId = ev.data.message_id as string | undefined;
  if (!threadId || !messageId) {
    console.warn(
      `[spool-loop] consumer: skipping seq=${ev.seq} (missing thread_id/message_id)`
    );
    return;
  }

  const prompt = buildAgentMailPrompt(ev);
  const handle = invokeWithHandle({
    eventId: ev.data.event_id ?? `spool-seq-${ev.seq}`,
    sessionId: threadId,
    prompt,
    systemPrompt: AGENTMAIL_SYSTEM_PROMPT,
  });

  const response = await handle.promise;
  if (response == null) {
    console.warn(
      `[spool-loop] consumer: claude returned no response for seq=${ev.seq}`
    );
    return;
  }

  const wakeMs = wakeAt - new Date(ev.time).getTime();
  console.log(
    `[spool-loop] consumer: seq=${ev.seq} done in ${Date.now() - wakeAt}ms (wake=${wakeMs}ms)`
  );

  await spool.publish(thread, [
    {
      ns: "message",
      type: "end",
      source: `mega@${process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz"}`,
      data: {
        content: response,
        // Carry the routing keys forward so the outbound relay knows
        // which AgentMail message to reply to without doing its own
        // event-history walk.
        reply_to_message_id: messageId,
        thread_id: threadId,
        inbox_id: ev.data.inbox_id,
      },
    },
  ]);
}

function buildAgentMailPrompt(ev: SpoolEvent): string {
  const d = ev.data;
  const to = Array.isArray(d.to) ? d.to.join(", ") : d.to;
  return `New email received:

From: ${d.from}
To: ${to}
Subject: ${d.subject}
Thread ID: ${d.thread_id}
Message ID: ${d.message_id}
Inbox ID: ${d.inbox_id}

${d.text || "(no text content)"}`;
}

/** Slack consumer. Tails ns=slack/type=message events, fetches thread
 *  history for context, invokes Claude with sessionId=slack-channel-threadTs,
 *  publishes message.end so the slack-spool outbound relay can post the
 *  reply. */
export async function startSlackConsumer(
  spool: SpoolClient,
  thread: string,
  cursorName: string
): Promise<void> {
  await spool.createThread(thread);
  const cursor = await spool.createCursor(thread, {
    name: cursorName,
    filter_ns: "slack",
    filter_type: "message",
  });
  console.log(
    `[spool-loop] slack consumer: cursor=${cursor.id} on ${thread} from seq=${cursor.cursor_seq}`
  );

  (async () => {
    try {
      for await (const ev of spool.tailCursor(cursor.id)) {
        const wakeAt = Date.now();
        await handleSlackInbound(spool, thread, ev, wakeAt);
        await spool.ackCursor(cursor.id, ev.seq + 1);
      }
    } catch (e) {
      console.error("[spool-loop] slack consumer tail failed:", e);
    }
  })();
}

async function handleSlackInbound(
  spool: SpoolClient,
  thread: string,
  ev: SpoolEvent,
  wakeAt: number
): Promise<void> {
  const channel = ev.data.channel as string | undefined;
  const threadTs = ev.data.thread_ts as string | undefined;
  const ts = ev.data.ts as string | undefined;
  if (!channel || !threadTs || !ts) {
    console.warn(
      `[spool-loop] slack: skipping seq=${ev.seq} (missing channel/thread_ts/ts)`
    );
    return;
  }

  // Pull the Slack thread's prior messages so Claude has context even
  // on a fresh session. Best-effort — empty array if the API call fails.
  let history: any[] = [];
  try {
    history = await fetchThreadHistory(channel, threadTs);
  } catch (e) {
    console.warn("[spool-loop] slack: thread history fetch failed:", e);
  }

  const prompt = buildSlackPrompt(ev, history, ts);
  const sessionId = `slack-${channel}-${threadTs}`;

  const handle = invokeWithHandle({
    eventId: ev.data.event_id ?? `spool-seq-${ev.seq}`,
    sessionId,
    prompt,
    systemPrompt: SLACK_SYSTEM_PROMPT,
  });

  const response = await handle.promise;
  if (response == null) {
    console.warn(
      `[spool-loop] slack: claude returned no response for seq=${ev.seq}`
    );
    return;
  }

  const wakeMs = wakeAt - new Date(ev.time).getTime();
  console.log(
    `[spool-loop] slack consumer: seq=${ev.seq} done in ${Date.now() - wakeAt}ms (wake=${wakeMs}ms)`
  );

  await spool.publish(thread, [
    {
      ns: "message",
      type: "end",
      source: `mega@${process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz"}`,
      data: {
        content: response,
        // Routing keys for the slack-spool outbound relay. `ts` is the
        // user's message we reacted to — outbound clears the 🤔 emoji
        // from it after posting the reply.
        channel,
        thread_ts: threadTs,
        ts,
      },
    },
  ]);
}

function buildSlackPrompt(
  ev: SpoolEvent,
  history: any[],
  currentTs: string
): string {
  const d = ev.data;
  const fileNote =
    Array.isArray(d.files) && d.files.length > 0
      ? `\n\n(The user attached ${d.files.length} file(s): ${d.files
          .map((f: any) => f.name || "unknown")
          .join(", ")}. You cannot view these yet — let the user know.)`
      : "";

  const priorLines = history
    .filter((m) => m.ts !== currentTs)
    .map((m) => {
      const who = m.bot_id || m.user === d.bot_user_id ? "mega" : m.user;
      return `[${who}]: ${m.text || "(no text)"}`;
    });
  const historyBlock =
    priorLines.length === 0
      ? ""
      : `Thread history (earlier messages in this thread):\n${priorLines.join(
          "\n"
        )}\n\n---\n\n`;

  return `${historyBlock}New Slack message:

From user: ${d.user}
Channel: ${d.channel}
Thread: ${d.thread_ts}

${d.text || "(no text)"}${fileNote}`;
}
