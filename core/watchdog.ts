import { spawnSync } from "child_process";
import { parsePositiveInt, parseNonNegativeInt, parseString } from "./env";

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

const intervalMs = () => parsePositiveInt("MEGA_WATCHDOG_INTERVAL_MS", DEFAULT_INTERVAL_MS);
const threshold = () => parseNonNegativeInt("MEGA_WATCHDOG_THRESHOLD", DEFAULT_THRESHOLD);
const pattern = () => parseString("MEGA_WATCHDOG_PATTERN", DEFAULT_PATTERN);

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
 * Pure threshold-evaluation step: warn if `count` exceeds `thresh`. No I/O,
 * no env reads — every value is supplied by the caller. Used by tests to
 * drive the warn semantics deterministically.
 */
export function evaluateWatchdog(
  count: number,
  thresh: number,
  patternStr: string
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

/**
 * Production tick: count processes and evaluate against the env-derived
 * threshold. The split between this and `evaluateWatchdog` keeps the test
 * suite free of `pgrep` calls while still exercising the warn logic.
 */
export function watchdogTick(): number {
  return evaluateWatchdog(countMatchingProcesses(), threshold(), pattern());
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
  watchdogTick();
  const timer = setInterval(watchdogTick, ms);
  // Don't keep the event loop alive just for the watchdog — if the harness
  // is otherwise idle and exiting, the watchdog shouldn't block exit.
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
