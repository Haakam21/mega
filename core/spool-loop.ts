/**
 * Mega's channel runners — thin glue over `@fabric/consumer-sdk`.
 *
 * The SDK owns fork discovery, per-fork tail, dedup, and Claude
 * invocation with MCP wired to fabric's hosted action tools. Mega
 * supplies tenant-specific config: prompt builder, response gate,
 * system prompt, MCP URLs.
 *
 * No reply text travels through stdout anymore — Claude calls fabric's
 * `reply` tool (or doesn't), which publishes `message.end` to the fork
 * directly. Mega's previous job of stitching responses into Spool
 * events is gone.
 */

import {
  SpoolClient,
  startForkedChannel,
  type SpoolEvent,
} from "../fabric/packages/consumer-sdk/src";

const AGENTMAIL_SYSTEM_PROMPT =
  "You are responding via email. If the email warrants a reply, call " +
  "the `agentmail-action__reply` tool with `text` set to your reply body. " +
  "Routing context (reply_to_message_id, thread_id) is pre-filled from " +
  "the invocation headers — you only need to supply `text`. If the email " +
  "doesn't warrant a reply (auto-replies, list mail, side conversations " +
  "between other people), simply do not call the tool and end your turn.";

const SLACK_SYSTEM_PROMPT =
  "You are responding in Slack. Routing context (channel, ts, thread_ts) " +
  "is pre-filled from the invocation headers for every tool that takes " +
  "those fields — you only need to supply the variable bits (text, emoji " +
  "name).\n\n" +
  "Available tools:\n" +
  "  • slack-action__post_message({ text }) — send a Slack reply.\n" +
  "  • slack-action__react({ name }) — add an emoji reaction to the user's " +
  "message. `name` is the Slack emoji name without colons (`thinking_face`, " +
  "`white_check_mark`, `fire`, etc.).\n" +
  "  • slack-action__unreact({ name }) — remove a reaction you added.\n\n" +
  "Decision flow:\n" +
  "1. If the message doesn't warrant a reply (side conversations between " +
  "other people, off-topic chatter, messages not addressed to you), end " +
  "your turn without calling any tool.\n" +
  "2. Otherwise call `react({ name: \"thinking_face\" })` immediately so the " +
  "user sees you're working on it, compose your response, call " +
  "`post_message({ text })`, then `unreact({ name: \"thinking_face\" })` to " +
  "clear the thinking reaction. Use other reactions whenever they fit " +
  "(e.g. `white_check_mark` to confirm a request, `eyes` for \"I'm looking at it\").";

const SLACK_CURSORS = {
  // -v8: inbound cursors switched from seq_mode=lineage to seq_mode=local
  // to stop the nested-fork double-fire (leaf cursors were replaying their
  // channel parent's ancestor events). Spool locks seq_mode at cursor
  // creation, so a name bump is required.
  discovery: "mega-slack-discovery-v8",
  inbound: "mega-slack-inbound-v8",
} as const;

const AGENTMAIL_CURSORS = {
  // -v7: seq_mode bumped to local (see SLACK_CURSORS comment). Agentmail
  // doesn't currently have nested forks, but keep parity to avoid
  // accidental future drift.
  discovery: "mega-agentmail-discovery-v7",
  inbound: "mega-agentmail-inbound-v7",
} as const;

const FABRIC_URL = process.env.FABRIC_URL ?? "https://fabric.delivery";
const CLIENT_ID = `mega@${process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz"}`;

/** Slack delivers @mentions as both `app_mention` and `message.channels`
 *  with distinct envelope event_ids. Key dedup on the inner (channel, ts)
 *  pair so we fire Claude once per Slack message. */
export function slackDedupId(ev: SpoolEvent): string {
  const channel = ev.data.channel as string | undefined;
  const ts = ev.data.ts as string | undefined;
  if (channel && ts) return `slack:${channel}:${ts}`;
  const eventId = ev.data.event_id as string | undefined;
  return eventId || ev.id || `spool-seq-${ev.seq}`;
}

/** Cheap pre-LLM filter: skip bot-authored events (loop prevention) and
 *  channel chatter mega isn't addressed by. Claude then makes the final
 *  reply-or-not decision via the `reply` tool. */
function shouldConsiderReplySlack(
  ev: SpoolEvent,
  ctx: { hasReplied: () => boolean },
): boolean {
  const d = ev.data as {
    type?: unknown;
    channel_type?: unknown;
    bot_id?: unknown;
    subtype?: unknown;
    app_id?: unknown;
  };
  if (typeof d.bot_id === "string") return false;
  if (typeof d.app_id === "string") return false;
  if (d.subtype === "bot_message") return false;

  if (d.type === "app_mention") return true;
  if (d.channel_type === "im") return true;
  if (d.type === "message" && ctx.hasReplied()) return true;
  return false;
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
Thread: ${d.thread_ts ?? d.ts}

${d.text || "(no text)"}${fileNote}`;
}

function buildAgentMailPrompt(ev: SpoolEvent): string {
  const d = ev.data;
  const to = Array.isArray(d.to) ? d.to.join(", ") : d.to;
  return `New email received:

From: ${d.from}
To: ${to}
Subject: ${d.subject}

${d.text || "(no text content)"}`;
}

/** Build a single MCP server entry with the framework headers fabric
 *  always expects (X-Client-Id, X-Fabric-Fork) plus any provider-specific
 *  routing headers. Undefined provider header values are dropped so the
 *  tool's Zod `min(1)` validation reports "missing field" rather than
 *  swallowing an empty string. */
function mcpServer(
  name: string,
  fork: string,
  providerHeaders: Record<string, string | undefined>,
): Record<string, { url: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = {
    "X-Client-Id": CLIENT_ID,
    "X-Fabric-Fork": fork,
  };
  for (const [k, v] of Object.entries(providerHeaders)) {
    if (typeof v === "string" && v.length > 0) headers[k] = v;
  }
  return { [name]: { url: `${FABRIC_URL}/mcp/${name}`, headers } };
}

/** Compute the per-thread leaf fork name for a Slack event, given the
 *  fork it currently lives in. Top-level channel events live in the
 *  channel thread `<binding>/<channel>`; the leaf is `<binding>/<channel>/<ts>`
 *  (Slack creates a thread when Mega replies with thread_ts=ts). Thread
 *  replies already live in the leaf, so the input fork is the leaf. */
function slackLeafFork(ev: { data: Record<string, unknown> }, fork: string): string {
  const d = ev.data;
  const ts =
    typeof d?.thread_ts === "string"
      ? d.thread_ts
      : typeof d?.ts === "string"
        ? d.ts
        : null;
  if (!ts) return fork;
  return fork.endsWith(`/${ts}`) ? fork : `${fork}/${ts}`;
}

export async function startSlack(spool: SpoolClient, parent: string): Promise<void> {
  return startForkedChannel({
    spool,
    parent,
    label: "slack",
    cursors: SLACK_CURSORS,
    // Two-level discovery: parent (bot) → channel forks → per-thread forks.
    // Inbound consumers run at depth 1 (channel: top-level @mentions, DMs)
    // and depth 2 (per-thread fork: thread replies).
    depth: 2,
    inboundFilter: { ns: "slack" },
    shouldRespond: shouldConsiderReplySlack,
    dedupId: slackDedupId,
    buildPrompt: buildSlackPrompt,
    systemPrompt: SLACK_SYSTEM_PROMPT,
    // Stable session id across the "top-level @mention in channel →
    // first user thread reply on per-thread fork" handoff. Both events
    // map to the same leaf fork name; Claude --resume keeps the
    // conversation continuous.
    sessionIdFor: (ev, { fork }) => slackLeafFork(ev, fork),
    // slack-action's post_message tool publishes ns=slack, type=post-message
    // — that's mega's "has replied here?" signal.
    repliedIndicator: { ns: "slack", type: "post-message" },
    mcpServers: ({ fork, event }) => {
      const d = event.data as Record<string, unknown>;
      // X-Fabric-Fork points at the LEAF (per-thread fork). For top-level
      // events on the channel thread, this is the prospective leaf that
      // fabric's MCP handler creates lazily on Mega's first post_message.
      // For thread-reply events the input fork is already the leaf.
      const leafFork = slackLeafFork(event, fork);
      return mcpServer("slack-action", leafFork, {
        "X-Slack-Channel": typeof d.channel === "string" ? d.channel : undefined,
        "X-Slack-Ts": typeof d.ts === "string" ? d.ts : undefined,
        "X-Slack-Thread-Ts":
          typeof d.thread_ts === "string"
            ? d.thread_ts
            : typeof d.ts === "string"
              ? d.ts
              : undefined,
      });
    },
  });
}

export async function startAgentMail(spool: SpoolClient, parent: string): Promise<void> {
  return startForkedChannel({
    spool,
    parent,
    label: "agentmail",
    cursors: AGENTMAIL_CURSORS,
    inboundFilter: { ns: "agentmail" },
    shouldRespond: () => true,
    buildPrompt: buildAgentMailPrompt,
    systemPrompt: AGENTMAIL_SYSTEM_PROMPT,
    mcpServers: ({ fork, event }) => {
      const d = event.data as Record<string, unknown>;
      return mcpServer("agentmail-action", fork, {
        "X-Agentmail-Reply-To-Message-Id":
          typeof d.message_id === "string" ? d.message_id : undefined,
        "X-Agentmail-Thread-Id":
          typeof d.thread_id === "string" ? d.thread_id : undefined,
      });
    },
  });
}
