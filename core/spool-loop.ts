/**
 * Mega's main consumer loop. Subscribes to a Spool cursor on a single
 * thread, invokes Claude on each `agentmail.message` event, and
 * publishes Claude's reply as a `message.end` event back on the same
 * thread. The agentmail-spool outbound relay picks up `message.end` and
 * sends the actual API reply.
 *
 * v1: process events serially (one Claude at a time per cursor). The
 * existing channel.ts has interrupt-and-merge for bursts on the same
 * email thread; we'll layer that back when the round trip is verified.
 */

import { invokeWithHandle } from "./invoke";
import type { SpoolClient, SpoolEvent } from "./spool";

const SYSTEM_PROMPT =
  "You are responding via email. Your final response will be sent verbatim as an email reply, so make sure it contains only the reply body.";

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

  const prompt = buildPrompt(ev);
  const handle = invokeWithHandle({
    eventId: ev.data.event_id ?? `spool-seq-${ev.seq}`,
    sessionId: threadId,
    prompt,
    systemPrompt: SYSTEM_PROMPT,
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

function buildPrompt(ev: SpoolEvent): string {
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
