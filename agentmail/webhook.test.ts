import { describe, test, expect } from "bun:test";
import { createHmac } from "crypto";

// Set required env vars BEFORE importing — webhook.ts reads
// AGENTMAIL_INBOX_ID + AGENTMAIL_WEBHOOK_SECRET at module load.
const TEST_SECRET = "whsec_dGVzdC1zZWNyZXQtZm9yLXVuaXQtdGVzdHM="; // base64("test-secret-for-unit-tests")
process.env.AGENTMAIL_INBOX_ID = "unit-test@agentmail.to";
process.env.AGENTMAIL_WEBHOOK_SECRET = TEST_SECRET;

const { verifySvixSignature } = await import("./webhook");

const secretBytes = Buffer.from(TEST_SECRET.replace("whsec_", ""), "base64");

const sign = (id: string, ts: string, body: string, secret = secretBytes) =>
  createHmac("sha256", secret)
    .update(`${id}.${ts}.${body}`)
    .digest("base64");

const headersFor = (id: string, ts: string, sig: string) =>
  new Headers({
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": `v1,${sig}`,
  });

describe("verifySvixSignature", () => {
  test("accepts a correctly signed payload at the current time", () => {
    const body = '{"event_id":"evt-1","event_type":"message.received"}';
    const id = "msg_1";
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const sig = sign(id, ts, body);
    expect(verifySvixSignature(body, headersFor(id, ts, sig), TEST_SECRET, nowMs)).toBe(true);
  });

  test("rejects a payload signed with a different secret", () => {
    const body = '{"event_id":"evt-1"}';
    const id = "msg_1";
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const sig = sign(id, ts, body, Buffer.from("wrong-secret"));
    expect(verifySvixSignature(body, headersFor(id, ts, sig), TEST_SECRET, nowMs)).toBe(false);
  });

  test("rejects a tampered body", () => {
    const body = '{"event_id":"evt-1"}';
    const id = "msg_1";
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const sig = sign(id, ts, body);
    expect(
      verifySvixSignature('{"event_id":"evt-2"}', headersFor(id, ts, sig), TEST_SECRET, nowMs)
    ).toBe(false);
  });

  test("rejects when timestamp is outside the 5-minute tolerance", () => {
    const body = '{"event_id":"evt-1"}';
    const id = "msg_1";
    const nowMs = Date.now();
    const oldTs = String(Math.floor(nowMs / 1000) - 6 * 60); // 6 minutes ago
    const sig = sign(id, oldTs, body);
    expect(verifySvixSignature(body, headersFor(id, oldTs, sig), TEST_SECRET, nowMs)).toBe(false);
  });

  test("accepts when timestamp is at the edge of tolerance", () => {
    const body = '{"event_id":"evt-1"}';
    const id = "msg_1";
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000) - 4 * 60); // 4 minutes ago (within 5)
    const sig = sign(id, ts, body);
    expect(verifySvixSignature(body, headersFor(id, ts, sig), TEST_SECRET, nowMs)).toBe(true);
  });

  test("rejects when svix-id is missing", () => {
    const body = '{"event_id":"evt-1"}';
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const sig = sign("msg_1", ts, body);
    const headers = new Headers({
      "svix-timestamp": ts,
      "svix-signature": `v1,${sig}`,
    });
    expect(verifySvixSignature(body, headers, TEST_SECRET, nowMs)).toBe(false);
  });

  test("rejects when svix-signature is missing", () => {
    const body = '{"event_id":"evt-1"}';
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const headers = new Headers({
      "svix-id": "msg_1",
      "svix-timestamp": ts,
    });
    expect(verifySvixSignature(body, headers, TEST_SECRET, nowMs)).toBe(false);
  });

  test("rejects when timestamp is not numeric", () => {
    const body = '{"event_id":"evt-1"}';
    const id = "msg_1";
    const nowMs = Date.now();
    const sig = sign(id, "not-a-number", body);
    expect(
      verifySvixSignature(body, headersFor(id, "not-a-number", sig), TEST_SECRET, nowMs)
    ).toBe(false);
  });

  test("accepts when one of multiple space-delimited signatures matches", () => {
    const body = '{"event_id":"evt-1"}';
    const id = "msg_1";
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const goodSig = sign(id, ts, body);
    const headers = new Headers({
      "svix-id": id,
      "svix-timestamp": ts,
      // First sig is wrong, second is right — should still accept.
      "svix-signature": `v1,BAD/sig+goes+here= v1,${goodSig}`,
    });
    expect(verifySvixSignature(body, headers, TEST_SECRET, nowMs)).toBe(true);
  });

  test("rejects when no signature version is v1", () => {
    const body = '{"event_id":"evt-1"}';
    const id = "msg_1";
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const goodSig = sign(id, ts, body);
    const headers = new Headers({
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": `v2,${goodSig}`, // unknown version
    });
    expect(verifySvixSignature(body, headers, TEST_SECRET, nowMs)).toBe(false);
  });

  test("rejects with an empty secret (env unset)", () => {
    const body = '{"event_id":"evt-1"}';
    const id = "msg_1";
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const sig = sign(id, ts, body);
    expect(verifySvixSignature(body, headersFor(id, ts, sig), "", nowMs)).toBe(false);
  });
});
