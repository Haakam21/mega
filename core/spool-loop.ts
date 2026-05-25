/**
 * Mega's channel runners — thin glue over `@fabric/consumer-sdk`.
 *
 * The SDK owns fork discovery, per-fork tail, dedup, and agent
 * invocation (claude or codex, per MEGA_AGENT) with MCP wired to
 * fabric's hosted action tools. Mega supplies tenant-specific config:
 * prompt builder, response gate, system prompt, MCP URLs.
 *
 * No reply text travels through stdout anymore — the agent calls fabric's
 * `reply` tool (or doesn't), which publishes `message.end` to the fork
 * directly. Mega's previous job of stitching responses into Spool
 * events is gone.
 */

import {
  SpoolClient,
  startForkedChannel,
  type AgentBackend,
  type SpoolEvent,
} from "../fabric/packages/consumer-sdk/src";
import { parseString } from "./env";
import {
  AGENTMAIL_EVENT_TYPES,
  AGENTMAIL_NS,
} from "../fabric/src/connectors/agentmail/shared";
import {
  SLACK_EVENT_TYPES,
  SLACK_NS,
} from "../fabric/src/connectors/slack/shared";

const SESSIONS_SYSTEM_PROMPT =
  "You are responding in a session — a Spool thread that carries the " +
  "full chronological log of one logical conversation, potentially " +
  "spanning multiple channels. The prompt above describes the latest " +
  "event. The action tools wired into this turn are listed in your " +
  "tool catalog; per-event routing fields (channel ids, message ids, " +
  "thread ids, recipients, etc.) are pre-filled into the relevant " +
  "tools' headers, so you only supply the variable parts (text, emoji " +
  "name, etc.).\n\n" +
  "The session's own events are the source of truth for routing — " +
  "which channel/thread/recipient to respond to, who's in the " +
  "conversation, what's been said. Always derive routing decisions " +
  "from `read_thread`, never from prior knowledge or guesses. Even " +
  "values that look familiar from earlier conversations are likely " +
  "stale — re-read every turn.\n\n" +
  "Reading history with `read_thread`:\n" +
  "  • `read_thread()` returns the most recent events on the current " +
  "fork (oldest first within the window). Each entry exposes its `seq`.\n" +
  "  • To walk back further — typically when responding in a sub-fork " +
  "that was spawned from a parent session and you need the originating " +
  "context — call `read_thread({ from_seq: N })` where N is below the " +
  "lowest seq you've seen. Spool walks ancestor threads automatically " +
  "when N drops below this fork's start, so you don't need to know the " +
  "parent thread's name.\n" +
  "  • Walk back in modest steps (e.g. `lowest_seq - 100` and double " +
  "if needed). Don't pass `from_seq: 0` — sessions can be very long " +
  "and walking from the absolute root pulls in irrelevant history.\n\n" +
  "If the latest event doesn't warrant a reply (bot chatter, side " +
  "conversations between other people), end your turn without calling " +
  "any tool.\n\n" +
  "Tool-failure discipline: the wired action tools are the canonical " +
  "path — they write routing records so future replies fold back into " +
  "this session automatically. If a tool rejects your input (schema " +
  "error, missing field), fix it and retry. Don't bypass via `Bash` or " +
  "other MCP servers; those paths skip the audit + routing layer and " +
  "break the cross-channel contract. If you can't make a tool work " +
  "after a retry or two, surface the failure via a reply on the " +
  "current channel and stop, rather than succeeding silently through " +
  "a back-channel.";

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
  discovery: "mega-slack-discovery-v9",
  inbound: "mega-slack-inbound-v9",
} as const;

const AGENTMAIL_CURSORS = {
  discovery: "mega-agentmail-discovery-v8",
  inbound: "mega-agentmail-inbound-v8",
} as const;

const SESSIONS_CURSORS = {
  discovery: "mega-sessions-discovery-v1",
  inbound: "mega-sessions-inbound-v1",
} as const;

const FABRIC_URL = process.env.FABRIC_URL ?? "https://fabric.delivery";
const CLIENT_ID = `mega@${process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz"}`;

// Which agent CLI the SDK spawns per turn, across every channel. `claude`
// (default) or `codex`. Anything else falls back to `claude`. Optional
// `MEGA_CODEX_BIN` overrides the codex binary path (default `codex` on PATH).
const AGENT_BACKEND: AgentBackend =
  parseString("MEGA_AGENT", "claude") === "codex" ? "codex" : "claude";
const CODEX_BIN = process.env.MEGA_CODEX_BIN;

// Slack bot's own user id — needed to detect @mentions in plain `message`
// events (their text contains `<@<bot_id>>`). Slack delivers an @mention as
// TWO events with the same (channel, ts): `app_mention` AND `message.channels`.
// slackDedupId collapses them into one Claude turn, but the gate must accept
// EITHER delivery — whichever arrives first wins.
const BOT_USER_ID = (() => {
  const fromEnv = process.env.MEGA_SLACK_BOT_USER_ID;
  if (fromEnv) return fromEnv;
  const parent = process.env.MEGA_SLACK_PARENT;
  if (parent) {
    const seg = parent.split("/").pop();
    if (seg) return seg;
  }
  return null;
})();

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
  // Channel @mention: Slack also delivers the same logical message as
  // `message.channels` (d.type === "message") with text containing
  // `<@<bot_id>>`. Accept it so dedup-order (app_mention vs message.channels
  // arrival) doesn't drop the turn on a fresh fork where hasReplied=false.
  if (d.type === "message" && BOT_USER_ID) {
    const text = typeof (d as { text?: unknown }).text === "string"
      ? ((d as { text: string }).text)
      : "";
    if (text.includes(`<@${BOT_USER_ID}>`)) return true;
  }
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
    backend: AGENT_BACKEND,
    codexBin: CODEX_BIN,
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

/** Session-routed consumer.
 *
 *  Sessions are direct children of `parent` (e.g. `mega/sessions`).
 *  Inbound events on a session can come from any provider — fabric's
 *  dispatcher routes via `session_routes` so a Slack thread and the
 *  email it spawned land in the same session fork chronologically.
 *
 *  Every turn wires BOTH slack-action and agentmail-action MCPs.
 *  Per-event provider headers populate the originating channel's MCP
 *  fully; the other gets just framework headers (X-Client-Id +
 *  X-Fabric-Fork), exposing only its "start-a-new-conversation" tools
 *  (`agentmail-action.send_message`, or `slack-action.post_message`
 *  with an explicit `channel`).
 *
 *  Operator setup: create a `parent` Spool thread, then add four
 *  bindings on fabric (slack-event, slack-action, agentmail-event,
 *  agentmail-action), all with `thread: parent, fork: true,
 *  use_sessions: true`. */
export async function startSessions(spool: SpoolClient, parent: string): Promise<void> {
  return startForkedChannel({
    spool,
    parent,
    label: "sessions",
    cursors: SESSIONS_CURSORS,
    // Depth 2: sessions at depth=1, per-agent-spawned-conversation
    // sub-forks at depth=2. Each gets its own Claude session — parent
    // session for the original convo, sub-fork sessions for each side
    // conversation the parent agent kicks off (emails, cross-channel
    // posts). Fabric's session-routed supervisor mirrors this depth.
    depth: 2,
    // Multi-provider: events come in under ns=slack or ns=agentmail.
    // No Spool-level filter — gating happens in shouldRespond.
    inboundFilter: {},
    shouldRespond: shouldConsiderReplySession,
    dedupId: sessionDedupId,
    buildPrompt: buildSessionPrompt,
    systemPrompt: SESSIONS_SYSTEM_PROMPT,
    backend: AGENT_BACKEND,
    codexBin: CODEX_BIN,
    sessionIdFor: (_ev, { fork }) => fork,
    // Track outputs from either action — used by the loop-prevention path.
    repliedIndicator: { ns: "slack", type: "post-message" },
    mcpServers: ({ fork, event }) => {
      const d = event.data as Record<string, unknown>;
      // Slack-action: full headers when this event came from Slack, just
      // X-Fabric-Fork otherwise. Agent can still call post_message with
      // an explicit `channel` from any session.
      const slackHeaders =
        event.ns === SLACK_NS
          ? {
              "X-Slack-Channel": typeof d.channel === "string" ? d.channel : undefined,
              "X-Slack-Ts": typeof d.ts === "string" ? d.ts : undefined,
              "X-Slack-Thread-Ts":
                typeof d.thread_ts === "string"
                  ? d.thread_ts
                  : typeof d.ts === "string"
                    ? d.ts
                    : undefined,
            }
          : {};
      const agentmailHeaders =
        event.ns === AGENTMAIL_NS
          ? {
              "X-Agentmail-Reply-To-Message-Id":
                typeof d.message_id === "string" ? d.message_id : undefined,
              "X-Agentmail-Thread-Id":
                typeof d.thread_id === "string" ? d.thread_id : undefined,
            }
          : {};
      return {
        ...mcpServer("slack-action", fork, slackHeaders),
        ...mcpServer("agentmail-action", fork, agentmailHeaders),
      };
    },
  });
}

// Per-ns sets of agent-authored event types we must never echo back as
// input — recursing on our own output would loop the conversation.
const SLACK_AGENT_OUTPUTS = new Set<string>([
  SLACK_EVENT_TYPES.POST_MESSAGE,
  SLACK_EVENT_TYPES.UPDATE_MESSAGE,
  SLACK_EVENT_TYPES.REACTION_ADD,
  SLACK_EVENT_TYPES.REACTION_REMOVE,
]);
const AGENTMAIL_AGENT_OUTPUTS = new Set<string>([
  AGENTMAIL_EVENT_TYPES.REPLY,
  AGENTMAIL_EVENT_TYPES.SEND_MESSAGE,
]);

function shouldConsiderReplySession(
  ev: SpoolEvent,
  ctx: { hasReplied: () => boolean },
): boolean {
  if (ev.ns === "thread" || ev.ns === "consumer") return false;
  if (ev.ns === SLACK_NS) {
    if (SLACK_AGENT_OUTPUTS.has(ev.type)) return false;
    return shouldConsiderReplySlack(ev, ctx);
  }
  if (ev.ns === AGENTMAIL_NS) {
    if (AGENTMAIL_AGENT_OUTPUTS.has(ev.type)) return false;
    return true;
  }
  return false;
}

function sessionDedupId(ev: SpoolEvent): string {
  if (ev.ns === SLACK_NS) return slackDedupId(ev);
  if (ev.ns === AGENTMAIL_NS) {
    const eventId = ev.data?.event_id as string | undefined;
    if (eventId) return `agentmail:${eventId}`;
  }
  return ev.id || `spool-seq-${ev.seq}`;
}

function buildSessionPrompt(ev: SpoolEvent): string {
  if (ev.ns === SLACK_NS) {
    return `New Slack event in this session:\n\n${buildSlackPrompt(ev)}`;
  }
  if (ev.ns === AGENTMAIL_NS) {
    return `New AgentMail event in this session:\n\n${buildAgentMailPrompt(ev)}`;
  }
  return `New ${ev.ns}/${ev.type} event in this session:\n\n${JSON.stringify(ev.data, null, 2)}`;
}

export async function startAgentMail(spool: SpoolClient, parent: string): Promise<void> {
  return startForkedChannel({
    spool,
    parent,
    label: "agentmail",
    cursors: AGENTMAIL_CURSORS,
    inboundFilter: { ns: "agentmail" },
    shouldRespond: () => true,
    // shouldRespond doesn't gate on hasReplied so the indicator is
    // largely decorative for agentmail, but keep it set to the action
    // emission so read_thread's eager-replied path is consistent with
    // slack's.
    repliedIndicator: { ns: "agentmail", type: "reply" },
    buildPrompt: buildAgentMailPrompt,
    systemPrompt: AGENTMAIL_SYSTEM_PROMPT,
    backend: AGENT_BACKEND,
    codexBin: CODEX_BIN,
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
