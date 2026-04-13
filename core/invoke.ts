import { existsSync, readFileSync, appendFile, realpathSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SEEN_FILE = join(ROOT, ".seen_events");
const MEMORIES_SYMLINK = join(ROOT, "memories");

// Resolve the memories symlink to the real path (FUSE mount)
// Claude's tools don't follow symlinks into FUSE mounts, so we need --add-dir
const MEMORIES_REAL_PATH = existsSync(MEMORIES_SYMLINK)
  ? realpathSync(MEMORIES_SYMLINK)
  : null;

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
  let currentProc: ReturnType<typeof Bun.spawn> | null = null;

  const kill = () => {
    killed = true;
    currentProc?.kill();
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
    try {
      currentProc = Bun.spawn(
        [
          "claude",
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
        { stdin: "ignore", stdout: "pipe", stderr: "ignore", cwd: ROOT }
      );

      const output = await new Response(currentProc.stdout).text();
      await currentProc.exited;
      currentProc = null;

      if (killed) return null;
      if (!output.trim()) return null;

      const parsed = JSON.parse(output);
      return parsed.result || null;
    } catch {
      currentProc = null;
      return null;
    }
  }

  return { promise, kill };
}
