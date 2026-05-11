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
import type { SpoolClient, SpoolEvent } from "./spool";

const AGENTMAIL_SYSTEM_PROMPT =
  "You are responding via email. Your final response will be sent verbatim as an email reply, so make sure it contains only the reply body.";

const SLACK_SYSTEM_PROMPT =
  "You are responding via Slack. Your final response will be posted verbatim as a Slack message, so make sure it contains only the message text.";

/** Cursor names + event filters. Centralised so a typo can't silently
 *  create a new cursor or filter to nothing. */
const SLACK_CURSORS = {
  discovery: "mega-slack-discovery",
  // Bumped to -v2 when we moved off the pre-fabric publish scheme that
  // emitted every event as `type=message`. Fabric publishes with the
  // actual Slack event type (app_mention, message, etc.), so we drop
  // the type filter and discriminate in shouldRespondSlack.
  inbound: "mega-slack-inbound-v2",
} as const;

const AGENTMAIL_CURSORS = {
  discovery: "mega-agentmail-discovery",
  inbound: "mega-agentmail-inbound",
} as const;

const THREAD_NS = "thread";
const FORKED_TYPE = "forked";
const SLACK_NS = "slack";
const AGENTMAIL_NS = "agentmail";
const MESSAGE_TYPE = "message";

/** AgentMail v2 consumer (fabric-fork model).
 *
 *  Mirrors `startSlackV2`. Tails a discovery cursor on the bot's parent
 *  thread filtered to `thread.forked` events; fabric's webhook publishes
 *  each inbound email into a forked child thread `<parent>/<email_thread_id>`,
 *  which surfaces as a thread.forked event on the parent. Each fork
 *  triggers a per-fork inbound consumer that reads
 *  `ns=agentmail, type=message` events in lineage mode, invokes Claude
 *  with sessionId = fork name, and publishes `message.end` back to the
 *  fork. Fabric's outbound supervisor (with fork=true on the matching
 *  outbound binding) picks up message.end and calls AgentMail's reply API.
 *
 *  Mega no longer owns inbound webhook receipt or outbound reply
 *  dispatch — fabric does both. */
export async function startAgentMailV2(
  spool: SpoolClient,
  parent: string
): Promise<void> {
  await spool.createThread(parent);
  const discovery = await spool.createCursor(parent, {
    name: AGENTMAIL_CURSORS.discovery,
    filter_ns: THREAD_NS,
    filter_type: FORKED_TYPE,
  });
  console.log(
    `[spool-loop] agentmail v2 discovery: cursor=${discovery.id} on ${parent} from seq=${discovery.cursor_seq}`
  );

  const active = new Set<string>();

  // Spawn consumers for forks that already exist. The discovery cursor
  // doesn't replay thread.forked events it has already ack'd, so without
  // this Mega would never reconnect to a fork created before the last
  // restart. Spool's listChildren is authoritative.
  await respawnExistingForks(spool, parent, active, spawnAgentMailForkConsumer, "agentmail");

  (async () => {
    try {
      for await (const ev of spool.tailCursor(discovery.id)) {
        const child = ev.data?.child as string | undefined;
        if (!child) {
          console.warn(
            `[spool-loop] agentmail v2 discovery: malformed thread.forked event seq=${ev.seq}`
          );
          await spool.ackCursor(discovery.id, ev.seq + 1);
          continue;
        }
        if (!active.has(child)) {
          active.add(child);
          spawnAgentMailForkConsumer(spool, child);
          console.log(
            `[spool-loop] agentmail v2: spawned consumer for ${child}`
          );
        }
        await spool.ackCursor(discovery.id, ev.seq + 1);
      }
    } catch (e) {
      console.error("[spool-loop] agentmail v2 discovery tail failed:", e);
    }
  })();
}

/** Enumerate existing children of the parent thread and spawn a per-fork
 *  consumer for each. Idempotent via the caller's `active` set — a fork
 *  that later surfaces as a `thread.forked` event won't be double-spawned. */
async function respawnExistingForks(
  spool: SpoolClient,
  parent: string,
  active: Set<string>,
  spawn: (spool: SpoolClient, fork: string) => void,
  label: string
): Promise<void> {
  try {
    const children = await spool.listChildren(parent);
    for (const child of children) {
      if (!active.has(child.name)) {
        active.add(child.name);
        spawn(spool, child.name);
        console.log(
          `[spool-loop] ${label} v2: respawned consumer for ${child.name}`
        );
      }
    }
  } catch (e) {
    console.warn(
      `[spool-loop] ${label} v2: respawnExistingForks (${parent}) failed: ${(e as Error).message}`
    );
  }
}

function spawnAgentMailForkConsumer(spool: SpoolClient, fork: string): void {
  (async () => {
    try {
      const cursor = await spool.createCursor(fork, {
        name: AGENTMAIL_CURSORS.inbound,
        filter_ns: AGENTMAIL_NS,
        filter_type: MESSAGE_TYPE,
        seq_mode: "lineage",
      });
      console.log(
        `[spool-loop] agentmail v2 inbound: cursor=${cursor.id} on ${fork} from seq=${cursor.cursor_seq}`
      );
      for await (const ev of spool.tailCursor(cursor.id)) {
        const wakeAt = Date.now();
        await handleAgentMailInbound(spool, fork, ev, wakeAt);
        await spool.ackCursor(cursor.id, ev.seq + 1);
      }
    } catch (e) {
      console.error(
        `[spool-loop] agentmail v2 inbound tail (${fork}) failed:`,
        e
      );
    }
  })();
}

async function handleAgentMailInbound(
  spool: SpoolClient,
  thread: string,
  ev: SpoolEvent,
  wakeAt: number
): Promise<void> {
  const threadId = ev.data.thread_id as string | undefined;
  const messageId = ev.data.message_id as string | undefined;
  if (!threadId || !messageId) {
    console.warn(
      `[spool-loop] agentmail: skipping seq=${ev.seq} on ${thread} (missing thread_id/message_id)`
    );
    return;
  }

  const prompt = buildAgentMailPrompt(ev);
  const handle = invokeWithHandle({
    eventId: ev.data.event_id ?? ev.id ?? `spool-seq-${thread}-${ev.seq}`,
    sessionId: thread,
    prompt,
    systemPrompt: AGENTMAIL_SYSTEM_PROMPT,
  });

  const response = await handle.promise;
  if (response == null) {
    console.warn(
      `[spool-loop] agentmail: claude returned no response for seq=${ev.seq}`
    );
    return;
  }

  const wakeMs = wakeAt - new Date(ev.time).getTime();
  console.log(
    `[spool-loop] agentmail consumer: seq=${ev.seq} done in ${Date.now() - wakeAt}ms (wake=${wakeMs}ms)`
  );

  await spool.publish(thread, [
    {
      ns: "message",
      type: "end",
      source: `mega@${process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz"}`,
      data: {
        content: response,
        // Routing keys for fabric's outbound dispatch. `reply_to_message_id`
        // is the AgentMail message id the fabric AgentMail connector calls
        // /messages/<id>/reply on; thread_id is informational.
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
 *  replays missed forks; the in-memory `active` set keeps duplicate
 *  spawns from racing two tail loops on the same cursor (which would
 *  double-invoke Claude on every event). */
export async function startSlackV2(
  spool: SpoolClient,
  parent: string
): Promise<void> {
  await spool.createThread(parent);
  const discovery = await spool.createCursor(parent, {
    name: SLACK_CURSORS.discovery,
    filter_ns: THREAD_NS,
    filter_type: FORKED_TYPE,
  });
  console.log(
    `[spool-loop] slack v2 discovery: cursor=${discovery.id} on ${parent} from seq=${discovery.cursor_seq}`
  );

  const active = new Set<string>();

  await respawnExistingForks(spool, parent, active, spawnSlackForkConsumer, "slack");

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
          console.log(
            `[spool-loop] slack v2: spawned consumer for ${child}`
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
      await primeSlackRepliedForks(spool, fork);
      const cursor = await spool.createCursor(fork, {
        name: SLACK_CURSORS.inbound,
        filter_ns: SLACK_NS,
        // No filter_type — fabric publishes with the actual Slack event
        // type (app_mention, message, etc.). shouldRespondSlack
        // discriminates per-event.
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

/** Per-fork "I've replied here before" memory. Lets us follow up on
 *  channel-thread messages in conversations Mega has already engaged
 *  with, without responding to unrelated channel chatter. The set is
 *  derived from Spool history on consumer spawn (see
 *  `primeSlackRepliedForks`) and topped up live in `handleSlackInbound`
 *  after each successful publish — so a restart re-derives state from
 *  the durable record instead of forgetting it. */
const SLACK_REPLIED_FORKS = new Set<string>();

/** Seed `SLACK_REPLIED_FORKS` for a fork by checking Spool for any
 *  prior `ns=message, type=end` event. Failures degrade gracefully:
 *  the consumer still runs, just without follow-up tracking until the
 *  next @mention/DM re-seeds. */
async function primeSlackRepliedForks(
  spool: SpoolClient,
  fork: string
): Promise<void> {
  try {
    const past = await spool.readEvents(fork, {
      ns: "message",
      type: "end",
      limit: 1,
    });
    if (past.length > 0) SLACK_REPLIED_FORKS.add(fork);
  } catch (e) {
    console.warn(
      `[spool-loop] slack v2: primeSlackRepliedForks (${fork}) failed: ${(e as Error).message}`
    );
  }
}

function shouldRespondSlack(ev: SpoolEvent, fork: string): boolean {
  const d = ev.data as {
    type?: unknown;
    channel_type?: unknown;
    bot_id?: unknown;
    subtype?: unknown;
    app_id?: unknown;
  };
  // Bot-authored messages — most importantly Mega's own replies — must
  // not re-enter the consumer loop. Slack tags bot messages via bot_id
  // (the bot's id, set on every bot-originated message in any channel),
  // app_id (the originating app), and/or subtype:"bot_message".
  if (typeof d.bot_id === "string") return false;
  if (typeof d.app_id === "string") return false;
  if (d.subtype === "bot_message") return false;

  if (d.type === "app_mention") return true;
  if (d.channel_type === "im") return true;
  if (d.type === "message" && SLACK_REPLIED_FORKS.has(fork)) return true;
  return false;
}

async function handleSlackInbound(
  spool: SpoolClient,
  thread: string,
  ev: SpoolEvent,
  wakeAt: number
): Promise<void> {
  if (!shouldRespondSlack(ev, thread)) {
    return;
  }
  const channel = ev.data.channel as string | undefined;
  const ts = ev.data.ts as string | undefined;
  // Top-level app_mentions have no thread_ts — Slack only sets it on
  // replies-in-threads. The message's own ts becomes the thread_ts as
  // soon as anyone (including the bot) replies. Mirror that here so the
  // outbound reply lands in-thread.
  const threadTs = (ev.data.thread_ts as string | undefined) ?? ts;
  if (!channel || !threadTs || !ts) {
    console.warn(
      `[spool-loop] slack: skipping seq=${ev.seq} (missing channel/ts)`
    );
    return;
  }

  // No history fetch — Claude's session continuity (sessionId is stable
  // per-thread) carries prior turns, and every message Slack delivers
  // already flows through Spool into this fork. Bot-added-to-existing-
  // thread is the only edge case that loses context; rare enough to
  // defer until a tenant complains.
  const prompt = buildSlackPrompt(ev);
  const sessionId = `slack-${channel}-${threadTs}`;

  const handle = invokeWithHandle({
    eventId: ev.data.event_id ?? ev.id ?? `spool-seq-${thread}-${ev.seq}`,
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
        // Routing keys for fabric's slack outbound dispatch. `ts` is the
        // user's message id — fabric uses it to clear the thinking-emoji
        // reaction after posting the reply.
        channel,
        thread_ts: threadTs,
        ts,
      },
    },
  ]);
  SLACK_REPLIED_FORKS.add(thread);
}

function buildSlackPrompt(ev: SpoolEvent): string {
  const d = ev.data;
  const fileNote =
    Array.isArray(d.files) && d.files.length > 0
      ? `\n\n(The user attached ${d.files.length} file(s): ${d.files
          .map((f: any) => f.name || "unknown")
          .join(", ")}. You cannot view these yet — let the user know.)`
      : "";

  return `New Slack message:

From user: ${d.user}
Channel: ${d.channel}
Thread: ${d.thread_ts}

${d.text || "(no text)"}${fileNote}`;
}
