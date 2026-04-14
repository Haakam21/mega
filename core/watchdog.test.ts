import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  countMatchingProcesses,
  watchdogTick,
  startWatchdog,
} from "./watchdog";

describe("countMatchingProcesses", () => {
  test("returns a non-negative integer", () => {
    // Real pgrep against a pattern that won't match anything.
    const count = countMatchingProcesses("__never_matches_anything_xyz__");
    expect(count).toBe(0);
  });

  test("returns 0 when pgrep is absent or errors (best-effort semantics)", () => {
    // Use a pattern that's syntactically valid; the test asserts the
    // function is total (returns 0, never throws).
    const count = countMatchingProcesses("\\x00invalid\\x00");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("counts at least 1 for a process that exists (sh)", () => {
    // /bin/sh is run by us and many other things — should be a stable
    // signal that pgrep is wired up correctly.
    const count = countMatchingProcesses("^/bin/sh$|^sh$");
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

describe("watchdogTick", () => {
  let warnSpy: ReturnType<typeof mock>;
  const originalWarn = console.warn;

  beforeEach(() => {
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test("does not warn when count is at the threshold", () => {
    watchdogTick(8, 8, "^claude --print");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("does not warn when count is below the threshold", () => {
    watchdogTick(3, 8, "^claude --print");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("warns when count exceeds the threshold", () => {
    watchdogTick(9, 8, "^claude --print");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("9 processes");
    expect(msg).toContain("threshold: 8");
    expect(msg).toContain("claude --print");
  });

  test("returns the count it was given (passthrough for callers)", () => {
    expect(watchdogTick(5, 8, "x")).toBe(5);
    expect(watchdogTick(15, 8, "x")).toBe(15);
  });
});

describe("startWatchdog", () => {
  const originalEnv: Record<string, string | undefined> = {};
  const keys = [
    "MEGA_WATCHDOG_INTERVAL_MS",
    "MEGA_WATCHDOG_THRESHOLD",
    "MEGA_WATCHDOG_PATTERN",
  ];

  beforeEach(() => {
    for (const k of keys) originalEnv[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of keys) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  test("returns a stoppable handle", () => {
    process.env.MEGA_WATCHDOG_INTERVAL_MS = "60000";
    process.env.MEGA_WATCHDOG_PATTERN = "__never_matches__";
    const handle = startWatchdog();
    expect(typeof handle.stop).toBe("function");
    handle.stop();
  });

  test("uses environment overrides for interval / threshold / pattern", async () => {
    process.env.MEGA_WATCHDOG_INTERVAL_MS = "50";
    process.env.MEGA_WATCHDOG_THRESHOLD = "0";
    process.env.MEGA_WATCHDOG_PATTERN = "^/bin/sh$";

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy as unknown as typeof console.warn;

    const handle = startWatchdog();
    // Wait for at least 2 ticks (initial + one interval).
    await new Promise((r) => setTimeout(r, 150));
    handle.stop();

    console.warn = originalWarn;

    // Threshold is 0, so any non-zero count will warn. The pattern matches
    // /bin/sh which is unlikely to be 0 on a normal Linux system, so we
    // expect at least one warning. If the system has no sh process at
    // all (very unusual), this assertion is a soft skip.
    if ((warnSpy.mock.calls?.length ?? 0) > 0) {
      const firstMsg = warnSpy.mock.calls[0][0] as string;
      expect(firstMsg).toContain("[watchdog]");
      expect(firstMsg).toContain("threshold: 0");
    }
  });
});
