import { statSync, writeFileSync } from "fs";
import { join } from "path";
import { parsePositiveInt, parseString } from "./env";
import { startInterval, type IntervalHandle } from "./interval";

// Periodic harness.log rotator. The harness writes to harness.log via the
// shell redirect set up by `make start`. `make start` uses `>>` (O_APPEND)
// so the kernel atomically seeks to end-of-file before each write — that
// way an in-place truncate from this module actually frees disk space.
// Without O_APPEND, fd 1's offset would persist across the truncate and
// subsequent writes would create a sparse file with the old offset as a
// hole.
//
// Configurable via env:
//   MEGA_LOG_MAX_BYTES         rotate when over this many bytes (default 10 MB)
//   MEGA_LOG_ROTATE_INTERVAL_MS poll interval (default 60_000)
//   MEGA_LOG_PATH              path to harness.log (default <repo>/harness.log)

const ROOT = join(import.meta.dir, "..");
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_INTERVAL_MS = 60_000;

const logPath = () => parseString("MEGA_LOG_PATH", join(ROOT, "harness.log"));
const maxBytes = () => parsePositiveInt("MEGA_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
const intervalMs = () =>
  parsePositiveInt("MEGA_LOG_ROTATE_INTERVAL_MS", DEFAULT_INTERVAL_MS);

/**
 * Pure rotation step: if the log file at `path` exceeds `cap` bytes,
 * truncate it in place and return the byte count that was just dropped.
 * Returns 0 if no rotation happened (file missing, under cap, or stat /
 * write failed). Best-effort — any I/O error swallows to 0 so a transient
 * EAGAIN doesn't crash the harness.
 *
 * No env reads. The caller supplies the path and cap so tests can drive
 * this deterministically without setting env vars.
 */
export function rotateLogIfNeeded(path: string, cap: number): number {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return 0;
  }
  if (size <= cap) return 0;
  try {
    writeFileSync(path, "");
  } catch {
    return 0;
  }
  // Self-log so the operator can tell rotation just happened. This line
  // lands in the freshly-truncated file as the first entry of the next
  // window, which is exactly what we want.
  console.log(
    `[log-rotator] truncated ${path} (was ${size} bytes, cap ${cap})`
  );
  return size;
}

/**
 * Production tick: read env, call `rotateLogIfNeeded`. The split between
 * this and `rotateLogIfNeeded` keeps the test suite free of env coupling
 * while still exercising the rotation logic — same shape as
 * `core/watchdog.ts` `evaluateWatchdog` + `watchdogTick`.
 */
export function logRotatorTick(): number {
  return rotateLogIfNeeded(logPath(), maxBytes());
}

/**
 * Start the log-rotator interval. Returns a handle whose `stop()` clears
 * the timer.
 */
export function startLogRotator(): IntervalHandle {
  const path = logPath();
  const cap = maxBytes();
  const ms = intervalMs();
  console.log(
    `[log-rotator] started (path=${path} max_bytes=${cap} interval=${ms}ms)`
  );
  return startInterval(logRotatorTick, ms);
}
