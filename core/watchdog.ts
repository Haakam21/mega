import { spawnSync } from "child_process";

// Periodic process-count watchdog. Belt-and-suspenders for the runaway-process
// fix set: if every other defense layer (per-invocation timeout, tree-kill,
// channel concurrency cap) somehow lets a leak through, the watchdog catches
// it and warns into harness.log so the operator notices before the host dies.
//
// Configurable via env:
//   MEGA_WATCHDOG_INTERVAL_MS   poll interval (default 30_000)
//   MEGA_WATCHDOG_THRESHOLD     warn when count > threshold (default 8)
//   MEGA_WATCHDOG_PATTERN       pgrep -f pattern (default "^claude --print")

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_THRESHOLD = 8;
const DEFAULT_PATTERN = "^claude --print";

function intervalMs(): number {
  const raw = parseInt(process.env.MEGA_WATCHDOG_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

function threshold(): number {
  const raw = parseInt(process.env.MEGA_WATCHDOG_THRESHOLD ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_THRESHOLD;
}

function pattern(): string {
  return process.env.MEGA_WATCHDOG_PATTERN || DEFAULT_PATTERN;
}

/**
 * Count processes matching the watchdog's pgrep pattern. Returns 0 on any
 * error (pgrep missing, no matches, etc.) — the watchdog is best-effort.
 */
export function countMatchingProcesses(pgrepPattern: string = pattern()): number {
  try {
    const result = spawnSync("pgrep", ["-cf", pgrepPattern], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!result.stdout) return 0;
    const n = parseInt(result.stdout.toString().trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Run a single tick of the watchdog: count processes and emit a warning if
 * over threshold. Pure function (modulo console.warn) so tests can drive it
 * with an injected counter.
 *
 * Returns the count so callers can assert.
 */
export function watchdogTick(
  count: number = countMatchingProcesses(),
  thresh: number = threshold(),
  patternStr: string = pattern()
): number {
  if (count > thresh) {
    console.warn(
      `[watchdog] ${count} processes matching ${JSON.stringify(
        patternStr
      )} (threshold: ${thresh}) — possible runaway claude leak`
    );
  }
  return count;
}

export interface WatchdogHandle {
  stop: () => void;
}

/**
 * Start the watchdog interval. Returns a handle whose `stop()` clears the
 * timer — useful for tests and for a graceful shutdown path.
 */
export function startWatchdog(): WatchdogHandle {
  const ms = intervalMs();
  const t = threshold();
  const p = pattern();
  console.log(
    `[watchdog] started (interval=${ms}ms threshold=${t} pattern=${JSON.stringify(p)})`
  );
  // Run once immediately so an already-leaked state surfaces fast on startup.
  watchdogTick(undefined, t, p);
  const timer = setInterval(() => {
    watchdogTick(undefined, t, p);
  }, ms);
  // Don't keep the event loop alive just for the watchdog — if the harness
  // is otherwise idle and exiting, the watchdog shouldn't block exit.
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
