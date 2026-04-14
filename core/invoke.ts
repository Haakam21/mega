import { existsSync, readFileSync, appendFile, realpathSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";

const ROOT = join(import.meta.dir, "..");
const SEEN_FILE = join(ROOT, ".seen_events");
const MEMORIES_SYMLINK = join(ROOT, "memories");

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

// Load persisted seen events into memory
const seenEvents = new Set<string>(
  existsSync(SEEN_FILE)
    ? readFileSync(SEEN_FILE, "utf-8").split("\n").filter(Boolean)
    : []
);

function isDuplicate(eventId: string): boolean {
  if (!eventId) return false;
  if (seenEvents.has(eventId)) return true;
  seenEvents.add(eventId);
  appendFile(SEEN_FILE, eventId + "\n", () => {});
  return false;
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

  let killed = false;
  let currentProc: ChildProcess | null = null;

  const kill = () => {
    killed = true;
    if (currentProc && currentProc.pid) {
      const pid = currentProc.pid;
      console.log(`[invoke] kill requested — tree-killing claude pid=${pid}`);
      treeKill(currentProc, "SIGTERM");
      const proc = currentProc;
      setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null) {
          console.log(`[invoke] grace expired — SIGKILL claude pid=${pid}`);
          treeKill(proc, "SIGKILL");
        }
      }, KILL_GRACE_MS);
    }
  };

  const promise = (async (): Promise<string | null> => {
    if (eventId && isDuplicate(eventId)) {
      console.log(`Skipping duplicate event: ${eventId}`);
      return null;
    }

    const uuid = toUUID(sessionId);
    console.log(`Invoking Claude (session: ${sessionId} → ${uuid})...`);

    // Try --resume first
    let response = await runClaude(["--resume", uuid]);
    if (killed) return null;

    // Fall back to --session-id
    if (!response) {
      response = await runClaude(["--session-id", uuid]);
      if (killed) return null;
    }

    if (response) {
      console.log(`Claude responded (${response.length} chars)`);
    } else {
      console.log("No response from Claude.");
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
      console.log(`[invoke] claude started pid=${proc.pid}`);

      let output = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });

      const startedAt = Date.now();
      const timeoutTimer = setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null) {
          console.error(
            `[invoke] timeout after ${timeoutMs}ms — tree-killing claude pid=${proc.pid}`
          );
          treeKill(proc, "SIGTERM");
          setTimeout(() => {
            if (proc.exitCode == null && proc.signalCode == null) {
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
        console.error(`[invoke] claude error pid=${proc.pid}:`, err);
        resolve(null);
      });

      proc.on("exit", (code, signal) => {
        cleanup();
        const durationMs = Date.now() - startedAt;
        console.log(
          `[invoke] claude exited pid=${proc.pid} code=${code} signal=${signal} duration=${durationMs}ms`
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
          console.error(`[invoke] claude output parse error:`, err);
          resolve(null);
        }
      });
    });
  }

  return { promise, kill };
}
