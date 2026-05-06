/**
 * AgentMail ↔ Spool relay. Bidirectional bridge:
 *   inbound  : AgentMail WebSocket → Spool publish (ns=agentmail, type=message)
 *   outbound : Spool cursor tail (ns=message, type=end) → AgentMail API send
 *
 * The Mega consumer (core/spool-loop.ts) sits between, reading inbound
 * events and publishing replies. This relay is dumb — no Claude, no
 * routing logic.
 */

import { connectWebSocket } from "../core/websocket";
import {
  type SpoolClient,
  type SpoolEvent,
} from "../core/spool";

const API = "https://api.agentmail.to/v0";
const apiKey = process.env.AGENTMAIL_API_KEY!;
const inboxId = process.env.AGENTMAIL_INBOX_ID!;

/** Spool thread carrying every email + every reply for this inbox. */
export function inboxThread(): string {
  return `agentmail/${inboxId}`;
}

/** Subscribe to AgentMail's WebSocket and publish each incoming email
 *  as a `ns=agentmail, type=message` event on the inbox thread. */
export function startInbound(spool: SpoolClient): void {
  const thread = inboxThread();
  console.log(`[agentmail-spool] inbound: ${thread}`);

  connectWebSocket({
    url: `wss://ws.agentmail.to/v0?api_key=${apiKey}`,
    label: "agentmail-spool",
    onOpen: (ws) => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          inbox_ids: [inboxId],
          event_types: ["message.received", "message.received.spam"],
        })
      );
    },
    onMessage: async (data) => {
      if (data.type === "subscribed") {
        console.log("[agentmail-spool] inbound: subscribed");
        return;
      }
      if (
        data.event_type !== "message.received" &&
        data.event_type !== "message.received.spam"
      ) {
        return;
      }
      try {
        await spool.publish(thread, [
          {
            ns: "agentmail",
            type: "message",
            // Producer-assigned id provides a hint for downstream dedup;
            // Spool itself doesn't dedup on it.
            id: data.event_id,
            source: `agentmail.relay@${process.env.MEGA_DOMAIN ?? "india-desert.exe.xyz"}`,
            data: {
              event_id: data.event_id,
              inbox_id: inboxId,
              thread_id: data.message.thread_id,
              message_id: data.message.message_id,
              from: data.message.from_,
              to: data.message.to,
              subject: data.message.subject,
              text: data.message.extracted_text || data.message.text || "",
            },
          },
        ]);
      } catch (e) {
        console.error("[agentmail-spool] inbound publish failed:", e);
      }
    },
  });
}

/** Tail the inbox thread for `message.end` events and post each as a
 *  reply via the AgentMail API. Cursor-based: position persists across
 *  restarts, no replay of already-sent messages. */
export async function startOutbound(spool: SpoolClient): Promise<void> {
  const thread = inboxThread();
  await spool.createThread(thread);
  const cursor = await spool.createCursor(thread, {
    name: "agentmail-outbound",
    filter_ns: "message",
    filter_type: "end",
  });
  console.log(
    `[agentmail-spool] outbound: cursor=${cursor.id} from seq=${cursor.cursor_seq}`
  );

  // Long-running tail — drives the loop for the lifetime of the process.
  // Errors here are logged but the loop restarts on tear-down (a future
  // hardening pass should reconnect explicitly; for now the harness's
  // process supervisor restarts on crash).
  (async () => {
    try {
      for await (const ev of spool.tailCursor(cursor.id)) {
        await handleOutbound(ev);
        await spool.ackCursor(cursor.id, ev.seq + 1);
      }
    } catch (e) {
      console.error("[agentmail-spool] outbound tail failed:", e);
    }
  })();
}

async function handleOutbound(ev: SpoolEvent): Promise<void> {
  const replyTo = ev.data.reply_to_message_id;
  const text = ev.data.content;
  if (typeof replyTo !== "string" || typeof text !== "string") {
    console.warn(
      `[agentmail-spool] outbound: skipping seq=${ev.seq} (missing reply_to_message_id or content)`
    );
    return;
  }
  const encodedInbox = encodeURIComponent(inboxId);
  const encodedMsg = encodeURIComponent(replyTo);
  const res = await fetch(
    `${API}/inboxes/${encodedInbox}/messages/${encodedMsg}/reply`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[agentmail-spool] reply ${replyTo} failed: ${res.status} ${body}`
    );
  }
  console.log(`[agentmail-spool] outbound: replied to ${replyTo}`);
}
