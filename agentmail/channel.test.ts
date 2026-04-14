import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";

// Set required env vars before importing the module — the channel module
// reads AGENTMAIL_INBOX_ID/API_KEY at module load.
const originalEnv: Record<string, string | undefined> = {};
for (const key of [
  "AGENTMAIL_API_KEY",
  "AGENTMAIL_INBOX_ID",
  "MEGA_AGENTMAIL_MAX_CONCURRENT",
  "MEGA_AGENTMAIL_MAX_QUEUE",
  "MEGA_CLAUDE_BIN",
  "MEGA_INVOKE_TIMEOUT_MS",
]) {
  originalEnv[key] = process.env[key];
}
process.env.AGENTMAIL_API_KEY = "test-key";
process.env.AGENTMAIL_INBOX_ID = "test@agentmail.to";
process.env.MEGA_AGENTMAIL_MAX_CONCURRENT = "2";
process.env.MEGA_AGENTMAIL_MAX_QUEUE = "5";
process.env.MEGA_CLAUDE_BIN = join(import.meta.dir, "..", "test", "slow-claude.sh");
process.env.MEGA_INVOKE_TIMEOUT_MS = "60000";

const channel = await import("./channel");

afterEach(() => {
  channel.__resetForTests();
});

// Restore env at the very end so other test files aren't affected.
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // But re-set the ones we need for the next test (afterEach runs between tests).
  process.env.AGENTMAIL_API_KEY = "test-key";
  process.env.AGENTMAIL_INBOX_ID = "test@agentmail.to";
  process.env.MEGA_AGENTMAIL_MAX_CONCURRENT = "2";
  process.env.MEGA_AGENTMAIL_MAX_QUEUE = "5";
  process.env.MEGA_CLAUDE_BIN = join(import.meta.dir, "..", "test", "slow-claude.sh");
  process.env.MEGA_INVOKE_TIMEOUT_MS = "60000";
});

const makeEvent = (overrides: Partial<{ thread_id: string; message_id: string; from: string; subject: string; body: string; event_id: string }> = {}) => ({
  event_id: overrides.event_id ?? `evt-${Math.random().toString(36).slice(2)}`,
  message: {
    thread_id: overrides.thread_id ?? "thread-1",
    message_id: overrides.message_id ?? `msg-${Math.random().toString(36).slice(2)}`,
    from_: overrides.from ?? "alice@example.com",
    to: ["test@agentmail.to"],
    subject: overrides.subject ?? "Hello",
    extracted_text: overrides.body ?? "Hi there",
  },
});

describe("buildPrompt", () => {
  test("renders a single email in the legacy single-message format", () => {
    const evt = makeEvent({
      from: "alice@example.com",
      subject: "Project update",
      thread_id: "t-1",
      message_id: "m-1",
      body: "Quick question about the deploy.",
    });
    const prompt = channel.buildPrompt([evt]);
    expect(prompt).toContain("New email received:");
    expect(prompt).toContain("From: alice@example.com");
    expect(prompt).toContain("Subject: Project update");
    expect(prompt).toContain("Thread ID: t-1");
    expect(prompt).toContain("Message ID: m-1");
    expect(prompt).toContain("Quick question about the deploy.");
  });

  test("renders multiple merged emails with numbered blocks and a reply target", () => {
    const events = [
      makeEvent({
        thread_id: "t-2",
        message_id: "m-1",
        body: "First message",
      }),
      makeEvent({
        thread_id: "t-2",
        message_id: "m-2",
        body: "Follow-up two minutes later",
      }),
      makeEvent({
        thread_id: "t-2",
        message_id: "m-3",
        body: "And one more",
      }),
    ];
    const prompt = channel.buildPrompt(events);
    expect(prompt).toContain("3 new emails in this thread");
    expect(prompt).toContain("Thread ID: t-2");
    expect(prompt).toContain("--- Email 1 ---");
    expect(prompt).toContain("--- Email 2 ---");
    expect(prompt).toContain("--- Email 3 ---");
    expect(prompt).toContain("First message");
    expect(prompt).toContain("Follow-up two minutes later");
    expect(prompt).toContain("And one more");
    // Reply target is the latest message id
    expect(prompt).toContain("in response to message m-3");
  });

  test("returns empty string for empty input", () => {
    expect(channel.buildPrompt([])).toBe("");
  });

  test("falls back to msg.text when extracted_text is missing", () => {
    const evt = {
      event_id: "evt-x",
      message: {
        thread_id: "t-3",
        message_id: "m-x",
        from_: "bob@example.com",
        to: "test@agentmail.to",
        subject: "Plain text",
        text: "this is the text field",
      },
    };
    expect(channel.buildPrompt([evt])).toContain("this is the text field");
  });
});

describe("handleMessage queueing", () => {
  test("a single new thread takes a slot immediately", async () => {
    const evt = makeEvent({ thread_id: "t-a" });
    await channel.handleMessage(evt);
    const state = channel.__stateForTests();
    expect(state.activeCount).toBe(1);
    expect(state.queueLength).toBe(0);
    expect(state.activeThreadIds).toContain("t-a");
  });

  test("a second event in the same thread interrupts and merges (still 1 slot)", async () => {
    await channel.handleMessage(makeEvent({ thread_id: "t-a", message_id: "m-1" }));
    await channel.handleMessage(makeEvent({ thread_id: "t-a", message_id: "m-2" }));
    const state = channel.__stateForTests();
    expect(state.activeCount).toBe(1);
    expect(state.queueLength).toBe(0);
  });

  test("distinct threads each take a slot up to the cap", async () => {
    await channel.handleMessage(makeEvent({ thread_id: "t-a" }));
    await channel.handleMessage(makeEvent({ thread_id: "t-b" }));
    const state = channel.__stateForTests();
    expect(state.activeCount).toBe(2); // cap is 2 in test env
    expect(state.queueLength).toBe(0);
  });

  test("events beyond the cap go to the queue", async () => {
    await channel.handleMessage(makeEvent({ thread_id: "t-a" }));
    await channel.handleMessage(makeEvent({ thread_id: "t-b" }));
    await channel.handleMessage(makeEvent({ thread_id: "t-c" }));
    await channel.handleMessage(makeEvent({ thread_id: "t-d" }));
    const state = channel.__stateForTests();
    expect(state.activeCount).toBe(2);
    expect(state.queueLength).toBe(2);
  });

  test("the queue is bounded by MAX_QUEUE_LENGTH; excess events are dropped", async () => {
    await channel.handleMessage(makeEvent({ thread_id: "t-a" }));
    await channel.handleMessage(makeEvent({ thread_id: "t-b" }));
    // Cap=2, max queue=5, so threads c..g fill the queue (5 entries), then h is dropped
    for (const t of ["c", "d", "e", "f", "g"]) {
      await channel.handleMessage(makeEvent({ thread_id: `t-${t}` }));
    }
    let state = channel.__stateForTests();
    expect(state.activeCount).toBe(2);
    expect(state.queueLength).toBe(5);
    await channel.handleMessage(makeEvent({ thread_id: "t-h" })); // should be dropped
    state = channel.__stateForTests();
    expect(state.queueLength).toBe(5);
  });
});
