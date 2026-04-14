import { describe, test, expect, mock } from "bun:test";
import { startInterval } from "./interval";

describe("startInterval", () => {
  test("runs the tick once synchronously before returning", () => {
    const tick = mock(() => {});
    const handle = startInterval(tick, 60_000);
    // The synchronous initial tick fires before startInterval returns.
    expect(tick).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  test("returns a stoppable handle that clears the timer", () => {
    const tick = mock(() => {});
    const handle = startInterval(tick, 60_000);
    expect(typeof handle.stop).toBe("function");
    handle.stop();
    // Calling stop twice should be safe (clearInterval on a cleared id is a no-op).
    expect(() => handle.stop()).not.toThrow();
  });

  test("schedules subsequent ticks on the interval", async () => {
    const tick = mock(() => {});
    const handle = startInterval(tick, 30);
    // Wait for at least 2 more ticks (initial + ~3 intervals × 30ms = 90ms).
    await new Promise((r) => setTimeout(r, 110));
    handle.stop();
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
