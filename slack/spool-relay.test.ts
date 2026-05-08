import { describe, test, expect } from "bun:test";
import { slackForkName } from "./spool-relay";

describe("slackForkName", () => {
  test("composes parent + channel + thread_ts with slashes", () => {
    expect(slackForkName("slack/U08TMCS2KRT", "C0123", "1234.5678")).toBe(
      "slack/U08TMCS2KRT/C0123/1234.5678"
    );
  });

  test("is stable across calls — same inputs produce identical fork name", () => {
    const a = slackForkName("slack/Ubot", "Cchan", "111.222");
    const b = slackForkName("slack/Ubot", "Cchan", "111.222");
    expect(a).toBe(b);
  });

  test("differs when channel or thread_ts differ", () => {
    const base = slackForkName("slack/Ubot", "Cchan", "1.2");
    expect(slackForkName("slack/Ubot", "Cother", "1.2")).not.toBe(base);
    expect(slackForkName("slack/Ubot", "Cchan", "1.3")).not.toBe(base);
    expect(slackForkName("slack/Uother", "Cchan", "1.2")).not.toBe(base);
  });
});
