import { invoke } from "../core/invoke";
import { connectWebSocket } from "../core/websocket";

const API = "https://api.agentmail.to/v0";
const apiKey = process.env.AGENTMAIL_API_KEY!;
const inboxId = process.env.AGENTMAIL_INBOX_ID!;
const encodedInbox = encodeURIComponent(inboxId);

const SYSTEM_PROMPT =
  "You are responding via email. Your final response will be sent verbatim as an email reply, so make sure it contains only the reply body.";

async function handleMessage(data: any) {
  const msg = data.message;
  const from = msg.from_;
  const subject = msg.subject;
  const to = Array.isArray(msg.to) ? msg.to.join(", ") : msg.to;
  const threadId = msg.thread_id;
  const messageId = msg.message_id;
  const body = msg.extracted_text || msg.text || "(no text content)";

  console.log(
    `[agentmail] New email from ${from}: ${subject} (thread: ${threadId})`
  );

  const prompt = `New email received:

From: ${from}
To: ${to}
Subject: ${subject}
Thread ID: ${threadId}
Message ID: ${messageId}
Inbox ID: ${inboxId}

${body}`;

  const response = await invoke({
    eventId: data.event_id,
    sessionId: threadId,
    prompt,
    systemPrompt: SYSTEM_PROMPT,
  });

  if (response) {
    console.log("[agentmail] Sending reply...");
    const encodedMsg = encodeURIComponent(messageId);
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
      console.error("[agentmail] Failed to send reply:", res.status, await res.text());
    }
  }
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
