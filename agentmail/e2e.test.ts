import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const API = "https://api.agentmail.to/v0";
const apiKey = process.env.AGENTMAIL_API_KEY!;
const inboxId = process.env.AGENTMAIL_INBOX_ID!;
const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

function encode(id: string) {
  return encodeURIComponent(id);
}

let senderInboxId: string;
let encodedSender: string;

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`${API}${path}`, { headers, ...opts });
  return res.json() as any;
}

async function poll(
  fn: () => Promise<any>,
  check: (result: any) => boolean,
  timeoutMs = 90000,
  intervalMs = 3000
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (check(result)) return result;
    await Bun.sleep(intervalMs);
  }
  throw new Error("Poll timed out");
}

describe("AgentMail E2E", () => {
  beforeAll(async () => {
    if (!apiKey || !inboxId) {
      throw new Error("AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID required");
    }

    // Create a test sender inbox
    const sender = await api("/inboxes", {
      method: "POST",
      body: JSON.stringify({ display_name: "E2E Test" }),
    });
    senderInboxId = sender.inbox_id;
    encodedSender = encode(senderInboxId);
    console.log(`Test sender: ${senderInboxId}`);

    // Wait for inbox to be fully provisioned
    await Bun.sleep(2000);
  });

  afterAll(async () => {
    // Clean up test inbox
    if (senderInboxId) {
      await api(`/inboxes/${encodedSender}`, { method: "DELETE" });
      console.log("Test sender cleaned up.");
    }
  });

  test(
    "receives email and sends reply",
    async () => {
      // Send email to the agent
      const sent = await api(`/inboxes/${encodedSender}/messages/send`, {
        method: "POST",
        body: JSON.stringify({
          to: inboxId,
          subject: "E2E Test",
          text: "My name is Pixel. Just say hi.",
        }),
      });
      expect(sent.message_id).toBeTruthy();
      expect(sent.thread_id).toBeTruthy();
      console.log(`Sent email. Thread: ${sent.thread_id}`);

      // Poll for reply at sender inbox
      const result = await poll(
        () => api(`/inboxes/${encodedSender}/messages?include_spam=true`),
        (data) => {
          const received = data.messages?.filter((m: any) =>
            m.labels?.includes("received")
          );
          return received?.length > 0;
        }
      );

      const received = result.messages.filter((m: any) =>
        m.labels?.includes("received")
      );
      expect(received.length).toBe(1);
      console.log(`Reply received: ${received[0].preview?.substring(0, 80)}`);
    },
    120000
  );

  test(
    "maintains session continuity across thread",
    async () => {
      // Find the agent's reply to reply to
      const msgs = await api(
        `/inboxes/${encodedSender}/messages?include_spam=true`
      );
      const agentReply = msgs.messages.find((m: any) =>
        m.labels?.includes("received")
      );
      expect(agentReply).toBeTruthy();

      const encodedMsg = encode(agentReply.message_id);

      // Send follow-up asking Claude to remember
      await api(`/inboxes/${encodedSender}/messages/${encodedMsg}/reply`, {
        method: "POST",
        body: JSON.stringify({
          text: "What is my name? Prove you remember.",
        }),
      });
      console.log("Sent follow-up.");

      // Poll for the second reply
      const result = await poll(
        () => api(`/inboxes/${encodedSender}/messages?include_spam=true`),
        (data) => {
          const received = data.messages?.filter((m: any) =>
            m.labels?.includes("received")
          );
          return received?.length >= 2;
        }
      );

      const received = result.messages.filter((m: any) =>
        m.labels?.includes("received")
      );
      expect(received.length).toBe(2);

      // Check that the latest reply mentions "Pixel"
      const latest = received[0];
      const mentionsPixel = latest.preview
        ?.toLowerCase()
        .includes("pixel");
      console.log(`Follow-up reply: ${latest.preview?.substring(0, 80)}`);
      expect(mentionsPixel).toBe(true);
    },
    120000
  );
});
