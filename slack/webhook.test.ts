import { describe, test, expect } from "bun:test";
import { createHmac } from "crypto";

// Slack signing secrets are plain strings (NOT base64 like Svix).
const TEST_SECRET = "test-slack-signing-secret-xyz";

// Required env vars before import — webhook.ts reads SLACK_SIGNING_SECRET
// at module load.
process.env.SLACK_SIGNING_SECRET = TEST_SECRET;
process.env.SLACK_BOT_TOKEN = "xoxb-test";

const { verifySlackSignature } = await import("./webhook");

const sign = (ts: string, body: string, secret = TEST_SECRET) =>
  "v0=" +
  createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

const headersFor = (ts: string, sig: string) =>
  new Headers({
    "x-slack-request-timestamp": ts,
    "x-slack-signature": sig,
  });

describe("verifySlackSignature", () => {
  test("accepts a correctly signed payload at the current time", () => {
    const body = '{"type":"event_callback","event":{}}';
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const sig = sign(ts, body);
    expect(verifySlackSignature(body, headersFor(ts, sig), TEST_SECRET, nowMs)).toBe(true);
  });

  test("rejects a payload signed with a different secret", () => {
    const body = '{"type":"event_callback"}';
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const sig = sign(ts, body, "different-secret");
    expect(verifySlackSignature(body, headersFor(ts, sig), TEST_SECRET, nowMs)).toBe(false);
  });

  test("rejects a tampered body", () => {
    const body = '{"type":"event_callback","event":{"user":"U1"}}';
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const sig = sign(ts, body);
    expect(
      verifySlackSignature(
        '{"type":"event_callback","event":{"user":"U2"}}',
        headersFor(ts, sig),
        TEST_SECRET,
        nowMs
      )
    ).toBe(false);
  });

  test("rejects timestamp outside 5-min replay window", () => {
    const body = '{"type":"event_callback"}';
    const nowMs = Date.now();
    const oldTs = String(Math.floor(nowMs / 1000) - 6 * 60);
    const sig = sign(oldTs, body);
    expect(verifySlackSignature(body, headersFor(oldTs, sig), TEST_SECRET, nowMs)).toBe(false);
  });

  test("accepts timestamp at the edge of the replay window", () => {
    const body = '{"type":"event_callback"}';
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000) - 4 * 60);
    const sig = sign(ts, body);
    expect(verifySlackSignature(body, headersFor(ts, sig), TEST_SECRET, nowMs)).toBe(true);
  });

  test("rejects future timestamp beyond tolerance", () => {
    const body = '{"type":"event_callback"}';
    const nowMs = Date.now();
    const futureTs = String(Math.floor(nowMs / 1000) + 6 * 60);
    const sig = sign(futureTs, body);
    expect(verifySlackSignature(body, headersFor(futureTs, sig), TEST_SECRET, nowMs)).toBe(false);
  });

  test("rejects when timestamp header is missing", () => {
    const body = '{"type":"event_callback"}';
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const sig = sign(ts, body);
    const headers = new Headers({ "x-slack-signature": sig });
    expect(verifySlackSignature(body, headers, TEST_SECRET, nowMs)).toBe(false);
  });

  test("rejects when signature header is missing", () => {
    const body = '{"type":"event_callback"}';
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const headers = new Headers({ "x-slack-request-timestamp": ts });
    expect(verifySlackSignature(body, headers, TEST_SECRET, nowMs)).toBe(false);
  });

  test("rejects when timestamp is not numeric", () => {
    const body = '{"type":"event_callback"}';
    const nowMs = Date.now();
    const sig = sign("not-a-number", body);
    expect(
      verifySlackSignature(body, headersFor("not-a-number", sig), TEST_SECRET, nowMs)
    ).toBe(false);
  });

  test("rejects a signature with no v0= prefix even if hex matches", () => {
    const body = '{"type":"event_callback"}';
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const fullSig = sign(ts, body);
    const noPrefix = fullSig.slice(3); // strip "v0="
    expect(
      verifySlackSignature(body, headersFor(ts, noPrefix), TEST_SECRET, nowMs)
    ).toBe(false);
  });

  test("rejects with an empty secret (env unset)", () => {
    const body = '{"type":"event_callback"}';
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    const sig = sign(ts, body);
    expect(verifySlackSignature(body, headersFor(ts, sig), "", nowMs)).toBe(false);
  });

  test("rejects an empty signature header", () => {
    const body = '{"type":"event_callback"}';
    const nowMs = Date.now();
    const ts = String(Math.floor(nowMs / 1000));
    expect(verifySlackSignature(body, headersFor(ts, ""), TEST_SECRET, nowMs)).toBe(false);
  });
});
