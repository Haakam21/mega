/**
 * AgentMail ↔ Spool relay (outbound). Inbound now arrives via webhook
 * (see `agentmail/webhook.ts`); this file only owns the reply path:
 *   outbound : Spool cursor tail (ns=message, type=end) → AgentMail API send
 *
 * The Mega consumer in `core/spool-loop.ts` writes `message.end` events;
 * this relay tails them and posts replies via the AgentMail messages
 * API. Single cursor, single tail, single thread per inbox.
 */

import { type SpoolClient, type SpoolEvent } from "../core/spool";

const API = "https://api.agentmail.to/v0";
const apiKey = process.env.AGENTMAIL_API_KEY!;
const inboxId = process.env.AGENTMAIL_INBOX_ID!;

/** Spool thread carrying every email + every reply for this inbox. */
export function inboxThread(): string {
  return `agentmail/${inboxId}`;
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
        // Per-event try/catch: a single bad reply (e.g. 404 on a stale
        // message_id) must not tear down the whole outbound loop. Log
        // and advance so the queue keeps moving; the consumer is the
        // place to retry, not this relay.
        try {
          await handleOutbound(ev);
        } catch (e) {
          console.error(
            `[agentmail-spool] outbound: failed seq=${ev.seq}, advancing anyway:`,
            e
          );
        }
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
