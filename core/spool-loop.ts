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
  "You are responding via email. If the email warrants a reply, call the " +
  "`agentmail-action__reply` tool with the reply text. If it doesn't " +
  "warrant a reply (auto-replies, list mail, side conversations between " +
  "other people), simply do not call the tool and end your turn.";

const SLACK_SYSTEM_PROMPT =
  "You are responding in Slack. If the message warrants a reply, call the " +
  "`slack-action__reply` tool with the reply text. If it doesn't warrant " +
  "a reply (side conversations between other people, off-topic chatter, " +
  "messages not addressed to you), simply do not call the tool and end " +
  "your turn.";

const SLACK_CURSORS = {
  // -v6 bump: v5 hit a Spool pagination gotcha — `next_seq` with `limit=1`
  // is `first_seq+1`, not the head. v6 cursors are created after a proper
  // pagination walk so they start at the true head.
  discovery: "mega-slack-discovery-v6",
  inbound: "mega-slack-inbound-v6",
} as const;

const AGENTMAIL_CURSORS = {
  discovery: "mega-agentmail-discovery-v6",
  inbound: "mega-agentmail-inbound-v6",
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
ts: ${d.ts}

${d.text || "(no text)"}${fileNote}

If you decide to reply, call the slack-action__reply tool with channel="${d.channel}", ts="${d.ts}", thread_ts="${d.thread_ts ?? d.ts}", and your reply text.`;
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

${d.text || "(no text content)"}

If you decide to reply, call the agentmail-action__reply tool with reply_to_message_id="${d.message_id}", thread_id="${d.thread_id}", and your reply text.`;
}

export async function startSlack(spool: SpoolClient, parent: string): Promise<void> {
  return startForkedChannel({
    spool,
    parent,
    label: "slack",
    cursors: SLACK_CURSORS,
    inboundFilter: { ns: "slack" },
    shouldRespond: shouldConsiderReplySlack,
    dedupId: slackDedupId,
    buildPrompt: buildSlackPrompt,
    systemPrompt: SLACK_SYSTEM_PROMPT,
    mcpServers: ({ fork }) => ({
      "slack-action": {
        url: `${FABRIC_URL}/mcp/slack-action`,
        headers: {
          "X-Client-Id": CLIENT_ID,
          "X-Fabric-Fork": fork,
        },
      },
    }),
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
    mcpServers: ({ fork }) => ({
      "agentmail-action": {
        url: `${FABRIC_URL}/mcp/agentmail-action`,
        headers: {
          "X-Client-Id": CLIENT_ID,
          "X-Fabric-Fork": fork,
        },
      },
    }),
  });
}

// Back-compat exports — index.ts still imports the v2 names. Drop in a
// follow-up once the dust settles.
export const startSlackV2 = startSlack;
export const startAgentMailV2 = startAgentMail;
