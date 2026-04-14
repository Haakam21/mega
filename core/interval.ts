// Tiny helper for periodic tasks like the watchdog and log-rotator. Both want
// the same shape: run the tick once synchronously on startup (so any
// already-bad state surfaces immediately), then schedule it on an interval,
// then `unref()` the timer so it doesn't keep the event loop alive past
// process exit. Wrapping it here keeps the call sites short and ensures one
// of them can't accidentally forget the unref.

export interface IntervalHandle {
  stop: () => void;
}

export function startInterval(
  tick: () => void,
  intervalMs: number
): IntervalHandle {
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}
