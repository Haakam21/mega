/**
 * Slack ↔ Spool relay. Outbound + shared intake:
 *   inbound  : `handleSlackEvent` is called from `slack/webhook.ts` after
 *              an Events API delivery. Applies the type/author/subtype
 *              filter, then forks the per-Slack-thread Spool thread and
 *              publishes `ns=slack, type=message`.
 *   outbound : Spool cursor tail per fork (ns=message, type=end) →
 *              Slack chat.postMessage. Per-fork outbound consumers are
 *              spawned by the discovery loop in `core/spool-loop.ts`.
 *
 * Thread topology: root `slack/<bot_user_id>` only carries
 * `thread.forked` audit events. Each Slack thread gets its own fork
 * `slack/<bot>/<channel>/<thread_ts>` carrying that conversation's
 * inbound + outbound events. The consumer (`startSlackV2` in spool-loop)
 * tails a discovery cursor on the root and spawns per-fork consumers as
 * forks appear.
 */

import { type SpoolClient, type SpoolEvent } from "../core/spool";

const botToken = process.env.SLACK_BOT_TOKEN!;

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

/** The bot's root Spool thread — `slack/<bot_user_id>`. Resolved from
 *  Slack's `auth.test` at startup. Forks descend from this. */
export async function slackThread(): Promise<string> {
  const id = await getBotUserId();
  return `slack/${id}`;
}

/** Fork name for a single Slack thread under the bot's root. Stable per
 *  `(channel, thread_ts)` so two events on the same Slack thread land on
 *  the same fork. Exported so the discovery loop can recompute it for
 *  cross-checks. */
export function slackForkName(
  parent: string,
  channel: string,
  threadTs: string
): string {
  return `${parent}/${channel}/${threadTs}`;
}

/** Inbound intake — called from `slack/webhook.ts` after an Events API
 *  delivery is signature-verified. Applies the type/author/subtype
 *  filter, then delegates to `publishInbound`. */
export async function handleSlackEvent(
  spool: SpoolClient,
  evt: any,
  eventId: string | undefined
): Promise<void> {
  if (!evt) return;
  if (evt.type !== "message" && evt.type !== "app_mention") return;
  const myId = await getBotUserId();
  if (evt.bot_id || evt.user === myId) return;
  if (evt.subtype && evt.subtype !== "file_share") return;
  const parent = await slackThread();
  await publishInbound(spool, parent, evt, eventId, myId);
}

async function publishInbound(
  spool: SpoolClient,
  parent: string,
  evt: any,
  envelopeId: string | undefined,
  myId: string
): Promise<void> {
  const channel = evt.channel;
  const ts = evt.ts;
  const threadTs = evt.thread_ts || evt.ts;
  const fork = slackForkName(parent, channel, threadTs);

  // Three intake shapes:
  //  - `app_mention`: opt-in, always proceed and fork-or-resume the thread.
  //  - DM (`channel_type === "im"`): same, since DMs are inherently 1:1.
  //  - Channel `message`: only proceed if Mega is already participating
  //    in this Slack thread, gated on `threadExists` so unrelated channel
  //    chatter doesn't trigger Mega.
  const isOptIn = evt.type === "app_mention" || evt.channel_type === "im";
  let forkAlreadyExists = false;
  if (!isOptIn) {
    try {
      forkAlreadyExists = await spool.threadExists(fork);
    } catch (e) {
      console.warn(`[slack-spool] inbound threadExists(${fork}) failed:`, e);
      return;
    }
    if (!forkAlreadyExists) return;
  }

  // 🤔 reaction signals "Mega is thinking"; outbound clears it on reply.
  // Best-effort — don't block the publish on this.
  slackAPI("reactions.add", {
    channel,
    timestamp: ts,
    name: THINKING_EMOJI,
  }).catch((err) => {
    console.warn("[slack-spool] reactions.add failed:", err);
  });

  if (!forkAlreadyExists) {
    try {
      // Idempotent: existing forks are 409'd and treated as success by the
      // client. Server resolves seq_offset to the parent's current tail.
      await spool.createThread(fork, parent);
    } catch (e) {
      console.error("[slack-spool] inbound forkThread failed:", e);
      return;
    }
  }

  try {
    await spool.publish(fork, [
      {
        ns: "slack",
        type: "message",
        // `channel:ts` is the stable identity of a Slack message. Slack
        // delivers a single user @mention as TWO Socket Mode events
        // (`app_mention` + `message.groups`/`message.channels`) with
        // different `envelope_id`s; publishing both with envelope-derived
        // ids would double-fire the consumer. Spool dedups on `id`.
        id: `${channel}:${ts}`,
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

/** Fire-and-forget outbound consumer on a single fork. The discovery
 *  loop in `core/spool-loop.ts::startSlackV2` calls this once per fork
 *  as `thread.forked` events arrive. Idempotent on `(client_id, fork)`
 *  — a re-spawn on harness restart resumes from the persisted position.
 *  Errors are logged on the loop's own task; the caller doesn't await. */
export function startForkOutbound(spool: SpoolClient, fork: string): void {
  (async () => {
    try {
      const cursor = await spool.createCursor(fork, {
        name: "slack-outbound",
        filter_ns: "message",
        filter_type: "end",
      });
      console.log(
        `[slack-spool] outbound: cursor=${cursor.id} on ${fork} from seq=${cursor.cursor_seq}`
      );
      for await (const ev of spool.tailCursor(cursor.id)) {
        // Per-event try/catch — one bad chat.postMessage (channel
        // archived, bot kicked, transient 5xx) must not tear down the
        // tail. Same fix shape as agentmail's outbound.
        try {
          await handleOutbound(ev);
        } catch (e) {
          console.error(
            `[slack-spool] outbound: failed seq=${ev.seq} on ${fork}, advancing anyway:`,
            e
          );
        }
        await spool.ackCursor(cursor.id, ev.seq + 1);
      }
    } catch (e) {
      console.error(`[slack-spool] outbound tail (${fork}) failed:`, e);
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
