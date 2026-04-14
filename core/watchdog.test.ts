import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  countMatchingProcesses,
  evaluateWatchdog,
  startWatchdog,
} from "./watchdog";

describe("countMatchingProcesses", () => {
  test("returns 0 for a pattern that can't match anything", () => {
    const count = countMatchingProcesses("__never_matches_anything_xyz__");
    expect(count).toBe(0);
  });

  test("returns the bun test runner itself when grepped (sanity check)", () => {
    // The bun test runner is, by definition, a process that exists right
    // now and matches `bun`. If this returns 0 something is very wrong with
    // pgrep on the host.
    const count = countMatchingProcesses("bun");
    expect(count).toBeGreaterThan(0);
  });
});

describe("evaluateWatchdog", () => {
  let warnSpy: ReturnType<typeof mock>;
  const originalWarn = console.warn;

  beforeEach(() => {
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test("does not warn when count equals the threshold", () => {
    evaluateWatchdog(8, 8, "^claude --print");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("does not warn when count is below the threshold", () => {
    evaluateWatchdog(3, 8, "^claude --print");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("warns when count exceeds the threshold", () => {
    evaluateWatchdog(9, 8, "^claude --print");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("9 processes");
    expect(msg).toContain("threshold: 8");
    expect(msg).toContain("claude --print");
  });

  test("returns the count it was given (passthrough for callers)", () => {
    expect(evaluateWatchdog(5, 8, "x")).toBe(5);
    expect(evaluateWatchdog(15, 8, "x")).toBe(15);
  });
});

describe("startWatchdog", () => {
  const originalEnv: Record<string, string | undefined> = {};
  const keys = [
    "MEGA_WATCHDOG_INTERVAL_MS",
    "MEGA_WATCHDOG_THRESHOLD",
    "MEGA_WATCHDOG_PATTERN",
  ];
  let warnSpy: ReturnType<typeof mock>;
  const originalWarn = console.warn;

  beforeEach(() => {
    for (const k of keys) originalEnv[k] = process.env[k];
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
    for (const k of keys) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  test("returns a stoppable handle and only logs the startup banner when nothing's leaking", () => {
    process.env.MEGA_WATCHDOG_INTERVAL_MS = "60000";
    process.env.MEGA_WATCHDOG_PATTERN = "__never_matches__";
    process.env.MEGA_WATCHDOG_THRESHOLD = "100";
    const handle = startWatchdog();
    expect(typeof handle.stop).toBe("function");
    // Initial tick ran synchronously inside startWatchdog. Pattern matches
    // nothing, so the tick should not have warned.
    expect(warnSpy).not.toHaveBeenCalled();
    handle.stop();
  });

  test("initial tick fires synchronously and warns when the threshold is exceeded", () => {
    // Pick a pattern that's guaranteed to have at least 1 hit (the test
    // runner itself) and a threshold of 0, so the initial synchronous
    // tick must warn before startWatchdog returns.
    process.env.MEGA_WATCHDOG_INTERVAL_MS = "60000";
    process.env.MEGA_WATCHDOG_THRESHOLD = "0";
    process.env.MEGA_WATCHDOG_PATTERN = "bun";
    const handle = startWatchdog();
    handle.stop();
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("[watchdog]");
    expect(msg).toContain("threshold: 0");
  });
});
