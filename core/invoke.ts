import { existsSync, readFileSync, appendFile, writeFile, realpathSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";

const ROOT = join(import.meta.dir, "..");
const SEEN_FILE = join(ROOT, ".seen_events");
const MEMORIES_SYMLINK = join(ROOT, "memories");

// Cap the dedup window. Webhook deduplication only needs to remember events
// for as long as a redelivery might arrive (seconds, occasionally minutes),
// so a generous fixed cap is more than enough — and bounded forever, unlike
// the previous unbounded grow-and-load-at-startup behavior.
const DEFAULT_MAX_SEEN_EVENTS = 10_000;
function maxSeenEvents(): number {
  const raw = parseInt(process.env.MEGA_MAX_SEEN_EVENTS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_SEEN_EVENTS;
}

// Resolve the memories symlink to the real path (FUSE mount)
// Claude's tools don't follow symlinks into FUSE mounts, so we need --add-dir
const MEMORIES_REAL_PATH = existsSync(MEMORIES_SYMLINK)
  ? realpathSync(MEMORIES_SYMLINK)
  : null;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 2000;

// Read lazily so tests can override via env between calls.
function claudeBin(): string {
  return process.env.MEGA_CLAUDE_BIN || "claude";
}

function invokeTimeoutMs(): number {
  const raw = parseInt(process.env.MEGA_INVOKE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

// Send a signal to the entire process group of `proc`, falling back to the
// single process if the group signal fails. `proc` must have been spawned with
// `detached: true` for the process-group path to reach children.
export function treeKill(
  proc: ChildProcess,
  signal: NodeJS.Signals
): boolean {
  if (!proc.pid) return false;
  try {
    process.kill(-proc.pid, signal);
    return true;
  } catch {
    try {
      proc.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

// Convert any string to a deterministic UUID-formatted hash
// Claude CLI requires session IDs to be valid UUIDs
export function toUUID(input: string): string {
  const hash = createHash("sha256").update(input).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "4" + hash.slice(13, 16),
    "a" + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join("-");
}

// Load persisted seen events into memory. We keep both a Set (for O(1)
// dedup lookups) and a parallel ordered list (so we can drop the oldest
// when the cap is exceeded). They're kept in sync inside `isDuplicate`.
const initialSeen = existsSync(SEEN_FILE)
  ? readFileSync(SEEN_FILE, "utf-8").split("\n").filter(Boolean)
  : [];
let seenList: string[] = initialSeen.slice(-maxSeenEvents());
const seenEvents = new Set<string>(seenList);

export function isDuplicate(eventId: string): boolean {
  if (!eventId) return false;
  if (seenEvents.has(eventId)) return true;
  seenEvents.add(eventId);
  seenList.push(eventId);
  const cap = maxSeenEvents();
  if (seenList.length > cap) {
    // Drop the oldest half. Rewriting the file is O(cap) but rare —
    // happens once every ~cap/2 events, not on every append.
    const dropCount = seenList.length - Math.floor(cap / 2);
    const dropped = seenList.splice(0, dropCount);
    for (const e of dropped) seenEvents.delete(e);
    writeFile(SEEN_FILE, seenList.join("\n") + "\n", () => {});
  } else {
    appendFile(SEEN_FILE, eventId + "\n", () => {});
  }
  return false;
}

// Test seam: lets unit tests reset and inspect the dedup state without
// touching the filesystem. Not part of the public surface.
export function __resetSeenEventsForTests(): void {
  seenList = [];
  seenEvents.clear();
}

export function __seenEventsCountForTests(): number {
  return seenList.length;
}

export interface InvokeOptions {
  eventId?: string;
  sessionId: string;
  prompt: string;
  systemPrompt: string;
}

export interface InvokeHandle {
  promise: Promise<string | null>;
  kill: () => void;
}

// Fire-and-forget invoke (used by email channel)
export async function invoke(options: InvokeOptions): Promise<string | null> {
  return invokeWithHandle(options).promise;
}

// Invoke with a killable handle (used by Slack channel for interruption)
export function invokeWithHandle(options: InvokeOptions): InvokeHandle {
  const { eventId, sessionId, prompt, systemPrompt } = options;
  // Short session prefix for log lines so the operator can correlate
  // [invoke] entries to the originating thread without leaking long ids.
  const sessionTag = sessionId.length > 24 ? sessionId.slice(0, 24) + "…" : sessionId;
  const promptBytes = Buffer.byteLength(prompt, "utf-8");

  let killed = false;
  let currentProc: ChildProcess | null = null;

  const kill = () => {
    killed = true;
    if (currentProc && currentProc.pid) {
      const pid = currentProc.pid;
      console.log(`[invoke] kill session=${sessionTag} pid=${pid} — tree-killing`);
      treeKill(currentProc, "SIGTERM");
      const proc = currentProc;
      setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null) {
          console.log(`[invoke] grace expired session=${sessionTag} pid=${pid} — SIGKILL`);
          treeKill(proc, "SIGKILL");
        }
      }, KILL_GRACE_MS);
    }
  };

  const promise = (async (): Promise<string | null> => {
    if (eventId && isDuplicate(eventId)) {
      console.log(`[invoke] skip duplicate session=${sessionTag} event=${eventId}`);
      return null;
    }

    const uuid = toUUID(sessionId);
    console.log(
      `[invoke] start session=${sessionTag} uuid=${uuid} prompt_bytes=${promptBytes}`
    );

    // Try --resume first
    let response = await runClaude(["--resume", uuid]);
    if (killed) return null;

    // Fall back to --session-id
    if (!response) {
      console.log(`[invoke] resume failed session=${sessionTag} — retrying with --session-id`);
      response = await runClaude(["--session-id", uuid]);
      if (killed) return null;
    }

    if (response) {
      console.log(
        `[invoke] response session=${sessionTag} chars=${response.length}`
      );
    } else {
      console.log(`[invoke] no response session=${sessionTag}`);
    }

    return response;
  })();

  async function runClaude(sessionArgs: string[]): Promise<string | null> {
    if (killed) return null;

    return new Promise<string | null>((resolve) => {
      const timeoutMs = invokeTimeoutMs();
      let proc: ChildProcess;
      try {
        proc = spawn(
          claudeBin(),
          [
            "--print",
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
            ...(MEMORIES_REAL_PATH ? ["--add-dir", MEMORIES_REAL_PATH] : []),
            "--append-system-prompt",
            systemPrompt,
            ...sessionArgs,
            prompt,
          ],
          {
            cwd: ROOT,
            stdio: ["ignore", "pipe", "inherit"],
            detached: true,
          }
        );
      } catch (err) {
        console.error(`[invoke] spawn failed:`, err);
        resolve(null);
        return;
      }

      currentProc = proc;
      console.log(
        `[invoke] spawn session=${sessionTag} pid=${proc.pid} args=${sessionArgs.join(",")}`
      );

      let output = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });

      const startedAt = Date.now();
      const timeoutTimer = setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null) {
          console.error(
            `[invoke] timeout session=${sessionTag} pid=${proc.pid} after=${timeoutMs}ms — tree-killing`
          );
          treeKill(proc, "SIGTERM");
          setTimeout(() => {
            if (proc.exitCode == null && proc.signalCode == null) {
              console.error(
                `[invoke] timeout grace expired session=${sessionTag} pid=${proc.pid} — SIGKILL`
              );
              treeKill(proc, "SIGKILL");
            }
          }, KILL_GRACE_MS);
        }
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (currentProc === proc) currentProc = null;
      };

      proc.on("error", (err) => {
        cleanup();
        console.error(
          `[invoke] error session=${sessionTag} pid=${proc.pid}:`,
          err
        );
        resolve(null);
      });

      proc.on("exit", (code, signal) => {
        cleanup();
        const durationMs = Date.now() - startedAt;
        console.log(
          `[invoke] exit session=${sessionTag} pid=${proc.pid} code=${code} signal=${signal} duration=${durationMs}ms output_bytes=${output.length}`
        );

        if (killed || signal) {
          resolve(null);
          return;
        }
        if (!output.trim()) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(output);
          resolve(parsed.result || null);
        } catch (err) {
          console.error(
            `[invoke] parse error session=${sessionTag} pid=${proc.pid}:`,
            err
          );
          resolve(null);
        }
      });
    });
  }

  return { promise, kill };
}
