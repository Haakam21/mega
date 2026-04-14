import { invokeWithHandle, type InvokeHandle } from "../core/invoke";
import { connectWebSocket } from "../core/websocket";
import { parsePositiveInt } from "../core/env";

const API = "https://api.agentmail.to/v0";
const apiKey = process.env.AGENTMAIL_API_KEY!;
const inboxId = process.env.AGENTMAIL_INBOX_ID!;
const encodedInbox = encodeURIComponent(inboxId);

const SYSTEM_PROMPT =
  "You are responding via email. Your final response will be sent verbatim as an email reply, so make sure it contains only the reply body.";

// Cap the number of concurrent Claude invocations across all email threads.
// Each invocation is bounded by the per-invocation timeout in core/invoke.ts,
// but a flood of unrelated emails can still spawn N parallel processes; this
// caps that parallelism. Excess events queue (up to MAX_QUEUE_LENGTH) until a
// slot frees. New emails in an already-active thread *interrupt and merge*
// instead of taking a slot.
//
// Read at module load — restart the harness to pick up new values.
const MAX_CONCURRENT_INVOCATIONS = parsePositiveInt(
  "MEGA_AGENTMAIL_MAX_CONCURRENT",
  4
);
const MAX_QUEUE_LENGTH = parsePositiveInt("MEGA_AGENTMAIL_MAX_QUEUE", 100);

interface ActiveInvocation {
  handle: InvokeHandle;
  messages: any[];
  latestMessageId: string;
}

const activeInvocations = new Map<string, ActiveInvocation>();
const pendingQueue: any[] = [];

export function buildPrompt(events: any[]): string {
  if (events.length === 0) return "";
  if (events.length === 1) {
    const msg = events[0].message;
    const to = Array.isArray(msg.to) ? msg.to.join(", ") : msg.to;
    const body = msg.extracted_text || msg.text || "(no text content)";
    return `New email received:

From: ${msg.from_}
To: ${to}
Subject: ${msg.subject}
Thread ID: ${msg.thread_id}
Message ID: ${msg.message_id}
Inbox ID: ${inboxId}

${body}`;
  }

  // Multiple messages — render them in arrival order so Claude sees the full
  // conversation. Reply to the latest message in the thread.
  const latest = events[events.length - 1].message;
  const blocks = events.map((evt, i) => {
    const m = evt.message;
    const to = Array.isArray(m.to) ? m.to.join(", ") : m.to;
    const body = m.extracted_text || m.text || "(no text content)";
    return `--- Email ${i + 1} ---
From: ${m.from_}
To: ${to}
Subject: ${m.subject}
Message ID: ${m.message_id}

${body}`;
  });

  return `${events.length} new emails in this thread (most recent last):

Thread ID: ${latest.thread_id}
Inbox ID: ${inboxId}

${blocks.join("\n\n")}

Reply will be sent in response to message ${latest.message_id}.`;
}

async function sendReply(replyToMessageId: string, response: string): Promise<void> {
  console.log("[agentmail] Sending reply...");
  const encodedMsg = encodeURIComponent(replyToMessageId);
  const res = await fetch(
    `${API}/inboxes/${encodedInbox}/messages/${encodedMsg}/reply`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: response }),
    }
  );
  if (res.ok) {
    console.log("[agentmail] Reply sent.");
  } else {
    console.error(
      "[agentmail] Failed to send reply:",
      res.status,
      await res.text()
    );
  }
}

function spawnInvocation(threadId: string, messages: any[]): void {
  const latestMessageId = messages[messages.length - 1].message.message_id;
  const prompt = buildPrompt(messages);

  const handle = invokeWithHandle({
    // eventId carries the latest message id so dedup is per-message; if the
    // same event_id arrives twice (e.g. WebSocket reconnect replay) we skip.
    eventId: messages[messages.length - 1].event_id,
    sessionId: threadId,
    prompt,
    systemPrompt: SYSTEM_PROMPT,
  });

  activeInvocations.set(threadId, { handle, messages, latestMessageId });

  handle.promise
    .then(async (response) => {
      // If our handle was replaced by an interrupt-and-merge, bail out — the
      // newer invocation will produce the reply and free the slot.
      if (activeInvocations.get(threadId)?.handle !== handle) return;
      activeInvocations.delete(threadId);
      if (response) {
        await sendReply(latestMessageId, response);
      }
      pumpQueue();
    })
    .catch((err) => {
      if (activeInvocations.get(threadId)?.handle === handle) {
        activeInvocations.delete(threadId);
      }
      console.error("[agentmail] Invocation error:", err);
      pumpQueue();
    });
}

function pumpQueue(): void {
  while (
    activeInvocations.size < MAX_CONCURRENT_INVOCATIONS &&
    pendingQueue.length > 0
  ) {
    const next = pendingQueue.shift();
    const threadId = next.message.thread_id;
    const active = activeInvocations.get(threadId);
    if (active) {
      // The queued event's thread became active while it was waiting;
      // interrupt-and-merge into the current invocation. Doesn't free a slot.
      active.handle.kill();
      active.messages.push(next);
      spawnInvocation(threadId, active.messages);
    } else {
      spawnInvocation(threadId, [next]);
    }
  }
}

async function handleMessage(data: any): Promise<void> {
  const msg = data.message;
  const threadId = msg.thread_id;

  console.log(
    `[agentmail] New email from ${msg.from_}: ${msg.subject} (thread: ${threadId})`
  );

  const active = activeInvocations.get(threadId);
  if (active) {
    console.log(
      `[agentmail] Interrupting active invocation for thread ${threadId} (now ${
        active.messages.length + 1
      } messages)`
    );
    active.handle.kill();
    active.messages.push(data);
    spawnInvocation(threadId, active.messages);
    return;
  }

  if (activeInvocations.size >= MAX_CONCURRENT_INVOCATIONS) {
    if (pendingQueue.length >= MAX_QUEUE_LENGTH) {
      console.warn(
        `[agentmail] Queue full (${MAX_QUEUE_LENGTH}); dropping email from ${msg.from_} (${msg.message_id})`
      );
      return;
    }
    pendingQueue.push(data);
    console.log(
      `[agentmail] Concurrency cap reached (${MAX_CONCURRENT_INVOCATIONS} active), queued (depth=${pendingQueue.length})`
    );
    return;
  }

  spawnInvocation(threadId, [data]);
}

// Test seam: lets unit tests reset the in-memory state between cases without
// having to re-import the module. Not exported from the public surface.
export function __resetForTests(): void {
  activeInvocations.clear();
  pendingQueue.length = 0;
}

export function __stateForTests() {
  return {
    activeCount: activeInvocations.size,
    queueLength: pendingQueue.length,
    activeThreadIds: Array.from(activeInvocations.keys()),
  };
}

export function start() {
  console.log(`[agentmail] Starting... Inbox: ${inboxId}`);

  connectWebSocket({
    url: `wss://ws.agentmail.to/v0?api_key=${apiKey}`,
    label: "agentmail",
    onOpen: (ws) => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          inbox_ids: [inboxId],
          event_types: ["message.received", "message.received.spam"],
        })
      );
    },
    onMessage: (data) => {
      if (data.type === "subscribed") {
        console.log("[agentmail] Subscribed. Waiting for emails...");
        return;
      }

      if (
        data.event_type !== "message.received" &&
        data.event_type !== "message.received.spam"
      )
        return;

      handleMessage(data);
    },
  });
}

export { handleMessage };
