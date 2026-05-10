import { describe, test, expect } from "bun:test";
import { createHmac } from "crypto";

// Set the secret BEFORE importing — verifySignature reads it at module load.
process.env.LINEAR_WEBHOOK_SECRET = "test-secret";

const {
  verifySignature,
  isRelevantEvent,
  deriveDedupId,
  LINEAR_HYGIENE_THREAD,
} = await import("./spool-relay");

const sign = (body: string, secret = "test-secret") =>
  createHmac("sha256", secret).update(body).digest("hex");

describe("verifySignature", () => {
  test("accepts a correctly signed body", () => {
    const body = '{"foo":"bar"}';
    expect(verifySignature(body, sign(body))).toBe(true);
  });

  test("rejects a body signed with a different secret", () => {
    const body = '{"foo":"bar"}';
    expect(verifySignature(body, sign(body, "other-secret"))).toBe(false);
  });

  test("rejects a tampered body", () => {
    const body = '{"foo":"bar"}';
    const sig = sign(body);
    expect(verifySignature('{"foo":"baz"}', sig)).toBe(false);
  });

  test("rejects an empty signature", () => {
    expect(verifySignature("anything", "")).toBe(false);
  });

  test("rejects a malformed (different-length) signature without throwing", () => {
    expect(verifySignature("anything", "deadbeef")).toBe(false);
  });
});

describe("isRelevantEvent", () => {
  test("issue created directly into In Progress is relevant", () => {
    expect(
      isRelevantEvent({
        action: "create",
        type: "Issue",
        data: { state: { name: "In Progress" } },
      })
    ).toBe(true);
  });

  test("issue created directly into In Review is relevant", () => {
    expect(
      isRelevantEvent({
        action: "create",
        type: "Issue",
        data: { state: { name: "In Review" } },
      })
    ).toBe(true);
  });

  test("issue created in another state is NOT relevant", () => {
    expect(
      isRelevantEvent({
        action: "create",
        type: "Issue",
        data: { state: { name: "Backlog" } },
      })
    ).toBe(false);
  });

  test("issue updated INTO In Progress (state change) is relevant", () => {
    expect(
      isRelevantEvent({
        action: "update",
        type: "Issue",
        data: { state: { name: "In Progress" } },
        updatedFrom: { stateId: "abc" },
      })
    ).toBe(true);
  });

  test("issue updated while staying In Progress (non-state change) is NOT relevant", () => {
    expect(
      isRelevantEvent({
        action: "update",
        type: "Issue",
        data: { state: { name: "In Progress" } },
        updatedFrom: { title: "old title" },
      })
    ).toBe(false);
  });

  test("project moving to In Progress is relevant", () => {
    expect(
      isRelevantEvent({
        action: "update",
        type: "Project",
        data: { state: { name: "In Progress" } },
        updatedFrom: { stateId: "x" },
      })
    ).toBe(true);
  });

  test("project moving to Completed is NOT relevant", () => {
    expect(
      isRelevantEvent({
        action: "update",
        type: "Project",
        data: { state: { name: "Completed" } },
        updatedFrom: { stateId: "x" },
      })
    ).toBe(false);
  });

  test("comment events are NOT relevant", () => {
    expect(
      isRelevantEvent({
        action: "create",
        type: "Comment",
        data: { id: "c1" },
      })
    ).toBe(false);
  });
});

describe("deriveDedupId", () => {
  test("retries of an identical body produce the same id", () => {
    const body = '{"action":"create","type":"Issue","data":{"id":"x"}}';
    expect(deriveDedupId(body)).toBe(deriveDedupId(body));
  });

  test("distinct bodies produce distinct ids", () => {
    const a = deriveDedupId('{"webhookTimestamp":1}');
    const b = deriveDedupId('{"webhookTimestamp":2}');
    expect(a).not.toBe(b);
  });

  test("produces a hex sha256 (64 chars)", () => {
    expect(deriveDedupId("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("LINEAR_HYGIENE_THREAD", () => {
  test("is the expected stable name", () => {
    expect(LINEAR_HYGIENE_THREAD).toBe("linear/hygiene");
  });
});
