import { describe, expect, test } from "bun:test";
import { isDirectAddressSlack, slackDedupId } from "./spool-loop";
import type { SpoolEvent } from "./spool";

function ev(data: Record<string, unknown>, extra: Partial<SpoolEvent> = {}): SpoolEvent {
  return {
    seq: 1,
    thread: "slack/U/abc",
    ns: "slack",
    type: "app_mention",
    id: "Ev-default",
    time: new Date().toISOString(),
    data,
    ...extra,
  } as SpoolEvent;
}

describe("slackDedupId", () => {
  test("collapses app_mention + message.channels for the same inner (channel, ts)", () => {
    const appMention = ev(
      { type: "app_mention", channel: "C9", ts: "1700000000.000100", text: "<@U> hi" },
      { id: "Ev-app-mention" },
    );
    const message = ev(
      { type: "message", channel: "C9", ts: "1700000000.000100", text: "<@U> hi" },
      { type: "message", id: "Ev-message-channels" },
    );
    expect(slackDedupId(appMention)).toBe(slackDedupId(message));
  });

  test("distinguishes messages with the same channel but different ts", () => {
    const a = ev({ channel: "C9", ts: "1700000000.000100" });
    const b = ev({ channel: "C9", ts: "1700000000.000200" });
    expect(slackDedupId(a)).not.toBe(slackDedupId(b));
  });

  test("distinguishes same ts in different channels", () => {
    const a = ev({ channel: "C9", ts: "1700000000.000100" });
    const b = ev({ channel: "C8", ts: "1700000000.000100" });
    expect(slackDedupId(a)).not.toBe(slackDedupId(b));
  });

  test("falls back to event_id / spool id when channel or ts is missing", () => {
    const noChannel = ev({ ts: "1700000000.000100" }, { id: "Ev-spool" });
    const noTs = ev({ channel: "C9", event_id: "Ev-data" });
    expect(slackDedupId(noChannel)).toBe("Ev-spool");
    expect(slackDedupId(noTs)).toBe("Ev-data");
  });

  test("falls back to spool-seq when nothing else is available", () => {
    const ev0 = { seq: 42, thread: "slack/x", ns: "slack", type: "x", id: "", time: "", data: {} } as SpoolEvent;
    expect(slackDedupId(ev0)).toBe("spool-seq-42");
  });
});

describe("isDirectAddressSlack", () => {
  test("true for app_mention", () => {
    expect(isDirectAddressSlack(ev({ type: "app_mention", channel: "C9", ts: "1" }))).toBe(true);
  });
  test("true for DM (channel_type=im)", () => {
    expect(isDirectAddressSlack(ev({ type: "message", channel_type: "im", channel: "D1", ts: "1" }))).toBe(true);
  });
  test("false for message in a channel", () => {
    expect(isDirectAddressSlack(ev({ type: "message", channel: "C9", ts: "1" }))).toBe(false);
  });
  test("false for unknown event shapes", () => {
    expect(isDirectAddressSlack(ev({}))).toBe(false);
  });
});
