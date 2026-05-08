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
import { fetchThreadHistory, startForkOutbound } from "../slack/spool-relay";
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

/** Slack v2 consumer. Tails a discovery cursor on the bot's root thread
 *  filtered to `thread.forked` events; spawns a per-fork inbound consumer
 *  + outbound relay each time a new fork is announced. Each per-fork
 *  inbound consumer reads `ns=slack, type=message` events in `Lineage`
 *  mode (transparently walking the parent if it ever got events before
 *  the fork existed), invokes Claude with sessionId = fork name, and
 *  publishes `message.end` back to the same fork — the outbound consumer
 *  picks that up and posts to Slack.
 *
 *  Idempotent on restart: the discovery cursor's persisted position
 *  replays missed forks; the in-memory `active` set keeps a re-announce
 *  during backfill from double-spawning. */
export async function startSlackV2(
  spool: SpoolClient,
  parent: string
): Promise<void> {
  await spool.createThread(parent);
  const discovery = await spool.createCursor(parent, {
    name: "mega-slack-discovery",
    filter_ns: "thread",
    filter_type: "forked",
  });
  console.log(
    `[spool-loop] slack v2 discovery: cursor=${discovery.id} on ${parent} from seq=${discovery.cursor_seq}`
  );

  const active = new Set<string>();

  (async () => {
    try {
      for await (const ev of spool.tailCursor(discovery.id)) {
        const child = ev.data?.child as string | undefined;
        if (!child) {
          console.warn(
            `[spool-loop] slack v2 discovery: malformed thread.forked event seq=${ev.seq}`
          );
          await spool.ackCursor(discovery.id, ev.seq + 1);
          continue;
        }
        if (!active.has(child)) {
          active.add(child);
          spawnSlackForkConsumer(spool, child);
          void startForkOutbound(spool, child).catch((e) => {
            console.error(
              `[spool-loop] slack v2 outbound spawn (${child}) failed:`,
              e
            );
          });
          console.log(
            `[spool-loop] slack v2: spawned consumer + outbound for ${child}`
          );
        }
        await spool.ackCursor(discovery.id, ev.seq + 1);
      }
    } catch (e) {
      console.error("[spool-loop] slack v2 discovery tail failed:", e);
    }
  })();
}

function spawnSlackForkConsumer(spool: SpoolClient, fork: string): void {
  (async () => {
    try {
      const cursor = await spool.createCursor(fork, {
        name: "mega-slack-inbound",
        filter_ns: "slack",
        filter_type: "message",
        seq_mode: "lineage",
      });
      console.log(
        `[spool-loop] slack v2 inbound: cursor=${cursor.id} on ${fork} from seq=${cursor.cursor_seq}`
      );
      for await (const ev of spool.tailCursor(cursor.id)) {
        const wakeAt = Date.now();
        await handleSlackInbound(spool, fork, ev, wakeAt);
        await spool.ackCursor(cursor.id, ev.seq + 1);
      }
    } catch (e) {
      console.error(
        `[spool-loop] slack v2 inbound tail (${fork}) failed:`,
        e
      );
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
