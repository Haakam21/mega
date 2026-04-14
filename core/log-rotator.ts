import { statSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { parsePositiveInt, parseString } from "./env";

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
 * If the log file at `path` exceeds `maxBytes`, truncate it in place and
 * return the byte count that was just dropped. Returns 0 if no rotation
 * happened (file missing, under threshold, or stat failed). Best-effort —
 * any I/O error swallows to 0 so a transient EAGAIN doesn't crash the
 * harness.
 */
export function rotateLogIfNeeded(
  path: string = logPath(),
  cap: number = maxBytes()
): number {
  let size: number;
  try {
    if (!existsSync(path)) return 0;
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

export interface LogRotatorHandle {
  stop: () => void;
}

/**
 * Start the log-rotator interval. Returns a handle whose `stop()` clears
 * the timer.
 */
export function startLogRotator(): LogRotatorHandle {
  const path = logPath();
  const cap = maxBytes();
  const ms = intervalMs();
  console.log(
    `[log-rotator] started (path=${path} max_bytes=${cap} interval=${ms}ms)`
  );
  // Initial check so a stale-large file from a previous run gets rotated
  // right away on startup, not after the first interval.
  rotateLogIfNeeded(path, cap);
  const timer = setInterval(() => {
    rotateLogIfNeeded(path, cap);
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
