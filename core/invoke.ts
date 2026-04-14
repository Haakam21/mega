import {
  existsSync,
  readFileSync,
  appendFile,
  writeFileSync,
  unlinkSync,
  realpathSync,
} from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";
import { parsePositiveInt, parseString } from "./env";

const ROOT = join(import.meta.dir, "..");
const MEMORIES_SYMLINK = join(ROOT, "memories");

// Cap the dedup window. Webhook deduplication only needs to remember events
// for as long as a redelivery might arrive (seconds, occasionally minutes),
// so a generous fixed cap is more than enough — and bounded forever, unlike
// the previous unbounded grow-and-load-at-startup behavior.
const DEFAULT_MAX_SEEN_EVENTS = 10_000;
const maxSeenEvents = () =>
  parsePositiveInt("MEGA_MAX_SEEN_EVENTS", DEFAULT_MAX_SEEN_EVENTS);

// Test seam: lets unit tests redirect the dedup file to a temp path so they
// don't pollute the project's real .seen_events between runs.
const seenFilePath = () =>
  parseString("MEGA_SEEN_EVENTS_PATH", join(ROOT, ".seen_events"));

// Resolve the memories symlink to the real path (FUSE mount)
// Claude's tools don't follow symlinks into FUSE mounts, so we need --add-dir
const MEMORIES_REAL_PATH = existsSync(MEMORIES_SYMLINK)
  ? realpathSync(MEMORIES_SYMLINK)
  : null;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 2000;

// Read lazily so tests can override via env between calls.
const claudeBin = () => parseString("MEGA_CLAUDE_BIN", "claude");
const invokeTimeoutMs = () =>
  parsePositiveInt("MEGA_INVOKE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

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

// FIFO set with a hard cap. When the cap is exceeded, the oldest half is
// evicted in one O(cap) splice (rare — once per ~cap/2 inserts) and the
// caller is told what was dropped so it can reflect the same eviction in
// any out-of-band storage (e.g. the on-disk dedup log).
//
// Keeping the parallel `Set` and `list` mutations behind one `add()` method
// removes the drift risk that comes with maintaining them by hand. The cap
// is passed into `add` rather than captured at construction so the
// underlying env var override stays live (tests rely on this).
class BoundedFifoSet {
  private set: Set<string>;
  private list: string[];

  constructor(initial: string[], initialCap: number) {
    this.list = initial.slice(-initialCap);
    this.set = new Set(this.list);
  }

  has(item: string): boolean {
    return this.set.has(item);
  }

  /**
   * Insert `item` with a cap policy. Returns whether it was newly added,
   * plus any items evicted by the bounded-cap policy. `evicted` is
   * non-empty only on the rare rotation tick.
   */
  add(item: string, cap: number): { added: boolean; evicted: string[] } {
    if (this.set.has(item)) return { added: false, evicted: [] };
    this.set.add(item);
    this.list.push(item);
    if (this.list.length <= cap) return { added: true, evicted: [] };
    const dropCount = this.list.length - Math.floor(cap / 2);
    const evicted = this.list.splice(0, dropCount);
    for (const e of evicted) this.set.delete(e);
    return { added: true, evicted };
  }

  size(): number {
    return this.list.length;
  }

  toArray(): readonly string[] {
    return this.list;
  }

  clear(): void {
    this.set.clear();
    this.list = [];
  }
}

const initialSeen = (() => {
  const path = seenFilePath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean);
})();

const seen = new BoundedFifoSet(initialSeen, maxSeenEvents());

function isDuplicate(eventId: string): boolean {
  if (!eventId) return false;
  if (seen.has(eventId)) return true;
  const { evicted } = seen.add(eventId, maxSeenEvents());
  if (evicted.length > 0) {
    // Rotation: rewrite the whole file synchronously. Sync write avoids the
    // unordered-async race where two close-together rotations interleave on
    // disk; it's O(cap) but fires once per ~cap/2 inserts so amortized cost
    // is negligible.
    writeFileSync(seenFilePath(), seen.toArray().join("\n") + "\n");
  } else {
    appendFile(seenFilePath(), eventId + "\n", () => {});
  }
  return false;
}

// Test seams: not part of the public surface. Tests call these to reset and
// inspect the dedup state without going through the public invoke path.
export function __resetSeenEventsForTests(): void {
  seen.clear();
  const path = seenFilePath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best-effort
    }
  }
}

export function __seenEventsCountForTests(): number {
  return seen.size();
}

export function __isDuplicateForTests(eventId: string): boolean {
  return isDuplicate(eventId);
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
        `[invoke] start session=${sessionTag} pid=${proc.pid} prompt_bytes=${promptBytes} args=${sessionArgs.join(",")}`
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
