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

/**
 * One in-flight Claude invocation. Holds the killable state (the current
 * child process + a `killed` flag) so the orchestration in `invokeWithHandle`
 * doesn't need to track them via closures and so each step is a short method
 * that's easy to skim.
 */
class InvocationContext {
  private killed = false;
  private currentProc: ChildProcess | null = null;
  readonly sessionTag: string;
  readonly promptBytes: number;

  constructor(readonly options: InvokeOptions) {
    this.sessionTag =
      options.sessionId.length > 24
        ? options.sessionId.slice(0, 24) + "…"
        : options.sessionId;
    this.promptBytes = Buffer.byteLength(options.prompt, "utf-8");
  }

  /** Tree-kill the current claude process (if any). Idempotent. */
  kill(): void {
    this.killed = true;
    const proc = this.currentProc;
    if (!proc?.pid) return;
    console.log(`[invoke] kill session=${this.sessionTag} pid=${proc.pid} — tree-killing`);
    this.treeKillWithGrace(proc, "kill", false);
  }

  /**
   * The full invocation flow: dedup → try `--resume` → fall back to
   * `--session-id`. Bails immediately if the context is killed at any
   * suspension point.
   */
  async run(): Promise<string | null> {
    const { eventId, sessionId } = this.options;
    if (eventId && isDuplicate(eventId)) {
      console.log(`[invoke] skip duplicate session=${this.sessionTag} event=${eventId}`);
      return null;
    }

    const uuid = toUUID(sessionId);

    let response = await this.runClaude(["--resume", uuid]);
    if (this.killed) return null;

    if (!response) {
      console.log(`[invoke] resume failed session=${this.sessionTag} — retrying with --session-id`);
      response = await this.runClaude(["--session-id", uuid]);
      if (this.killed) return null;
    }

    if (response) {
      console.log(`[invoke] response session=${this.sessionTag} chars=${response.length}`);
    } else {
      console.log(`[invoke] no response session=${this.sessionTag}`);
    }
    return response;
  }

  /**
   * Spawn one `claude` subprocess, set the timeout, capture stdout, and
   * resolve with the parsed result (or null on any failure). Each spawn is
   * detached so its process group can be tree-killed by `kill()` or by the
   * timeout handler — see core/invoke.ts top-of-file `treeKill` for why.
   */
  private async runClaude(sessionArgs: string[]): Promise<string | null> {
    if (this.killed) return null;
    const proc = this.spawnClaude(sessionArgs);
    if (!proc) return null;

    return new Promise<string | null>((resolve) => {
      this.currentProc = proc;
      console.log(
        `[invoke] start session=${this.sessionTag} pid=${proc.pid} prompt_bytes=${this.promptBytes} args=${sessionArgs.join(",")}`
      );

      let output = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });

      const startedAt = Date.now();
      const timeoutTimer = this.armTimeout(proc);

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (this.currentProc === proc) this.currentProc = null;
      };

      proc.on("error", (err) => {
        cleanup();
        console.error(`[invoke] error session=${this.sessionTag} pid=${proc.pid}:`, err);
        resolve(null);
      });

      proc.on("exit", (code, signal) => {
        cleanup();
        const durationMs = Date.now() - startedAt;
        console.log(
          `[invoke] exit session=${this.sessionTag} pid=${proc.pid} code=${code} signal=${signal} duration=${durationMs}ms output_bytes=${output.length}`
        );
        resolve(this.parseOutput(output, proc));
      });
    });
  }

  private spawnClaude(sessionArgs: string[]): ChildProcess | null {
    try {
      return spawn(
        claudeBin(),
        [
          "--print",
          "--output-format",
          "json",
          "--dangerously-skip-permissions",
          ...(MEMORIES_REAL_PATH ? ["--add-dir", MEMORIES_REAL_PATH] : []),
          "--append-system-prompt",
          this.options.systemPrompt,
          ...sessionArgs,
          this.options.prompt,
        ],
        {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "inherit"],
          detached: true,
        }
      );
    } catch (err) {
      console.error(`[invoke] spawn failed session=${this.sessionTag}:`, err);
      return null;
    }
  }

  /**
   * Schedule a SIGTERM tree-kill if the proc hasn't exited within
   * `MEGA_INVOKE_TIMEOUT_MS`. Schedules a SIGKILL `KILL_GRACE_MS` after that
   * if the proc still hasn't exited.
   */
  private armTimeout(proc: ChildProcess): NodeJS.Timeout {
    const timeoutMs = invokeTimeoutMs();
    return setTimeout(() => {
      if (proc.exitCode != null || proc.signalCode != null) return;
      console.error(
        `[invoke] timeout session=${this.sessionTag} pid=${proc.pid} after=${timeoutMs}ms — tree-killing`
      );
      this.treeKillWithGrace(proc, "timeout", true);
    }, timeoutMs);
  }

  /**
   * SIGTERM the process group, then SIGKILL it after `KILL_GRACE_MS` if it
   * still hasn't exited. Used by both `kill()` and the timeout handler in
   * `armTimeout()` — they only differ in the log prefix and severity.
   *
   * The caller is responsible for emitting the initial log line; this
   * helper only logs the grace-expired SIGKILL line if it has to fire.
   */
  private treeKillWithGrace(
    proc: ChildProcess,
    reason: "kill" | "timeout",
    asError: boolean
  ): void {
    treeKill(proc, "SIGTERM");
    setTimeout(() => {
      if (proc.exitCode != null || proc.signalCode != null) return;
      const log = asError ? console.error : console.log;
      log(
        `[invoke] ${reason} grace expired session=${this.sessionTag} pid=${proc.pid} — SIGKILL`
      );
      treeKill(proc, "SIGKILL");
    }, KILL_GRACE_MS);
  }

  /**
   * Convert raw claude stdout to the result string. Returns null if the
   * process was killed (proc.signalCode is the same `signal` field the exit
   * handler sees, just read off the proc object), the output is empty, or
   * the JSON failed to parse. Parse errors are logged but never thrown.
   */
  private parseOutput(output: string, proc: ChildProcess): string | null {
    if (this.killed || proc.signalCode) return null;
    if (!output.trim()) return null;
    try {
      const parsed = JSON.parse(output);
      return parsed.result || null;
    } catch (err) {
      console.error(
        `[invoke] parse error session=${this.sessionTag} pid=${proc.pid}:`,
        err
      );
      return null;
    }
  }
}

/** Invoke claude with a killable handle. Used by every channel. */
export function invokeWithHandle(options: InvokeOptions): InvokeHandle {
  const ctx = new InvocationContext(options);
  return {
    promise: ctx.run(),
    kill: () => ctx.kill(),
  };
}
