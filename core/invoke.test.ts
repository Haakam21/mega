import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

// Point dedup state at a per-pid temp file so tests don't pollute the real
// project's .seen_events between runs. Must be set before importing the
// module (constants are captured at module load).
process.env.MEGA_SEEN_EVENTS_PATH = join(
  tmpdir(),
  `mega-test-seen-${process.pid}.txt`
);

import {
  toUUID,
  treeKill,
  invokeWithHandle,
  __isDuplicateForTests as isDuplicate,
  __resetSeenEventsForTests,
  __seenEventsCountForTests,
} from "./invoke";
import { spawn } from "child_process";
import { readFileSync, unlinkSync, existsSync } from "fs";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 50
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
};

describe("toUUID", () => {
  test("produces valid UUID format", () => {
    const uuid = toUUID("test-input");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[a-f][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test("is deterministic", () => {
    const a = toUUID("same-input");
    const b = toUUID("same-input");
    expect(a).toBe(b);
  });

  test("different inputs produce different UUIDs", () => {
    const a = toUUID("input-1");
    const b = toUUID("input-2");
    expect(a).not.toBe(b);
  });

  test("handles Slack-style session IDs", () => {
    const uuid = toUUID("slack-D0AS9T5CP4K-1776075293.516059");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[a-f][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test("handles AgentMail thread UUIDs (pass-through format)", () => {
    const uuid = toUUID("a8ff62a5-b4d2-46e4-ab7d-676f55559b51");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[a-f][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

describe("invokeWithHandle", () => {
  const mockClaude = join(import.meta.dir, "..", "test", "mock-claude.sh");
  const slowClaude = join(import.meta.dir, "..", "test", "slow-claude.sh");

  test("mock claude produces valid JSON", async () => {
    const proc = Bun.spawn(
      ["bash", mockClaude, "--print", "--output-format", "json", "--session-id", "test", "hello"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
    );
    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) console.error("mock-claude stderr:", stderr);
    const parsed = JSON.parse(output);
    expect(parsed.result).toContain("mock response to:");
  });

  test("kill terminates a slow process", async () => {
    const proc = Bun.spawn([slowClaude], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });

    setTimeout(() => proc.kill(), 100);

    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
  });
});

describe("isDuplicate / .seen_events rotation", () => {
  const originalCap = process.env.MEGA_MAX_SEEN_EVENTS;

  beforeEach(() => {
    __resetSeenEventsForTests();
    process.env.MEGA_MAX_SEEN_EVENTS = "20";
  });

  afterEach(() => {
    __resetSeenEventsForTests();
    if (originalCap === undefined) delete process.env.MEGA_MAX_SEEN_EVENTS;
    else process.env.MEGA_MAX_SEEN_EVENTS = originalCap;
  });

  test("returns false for unseen event ids and true for repeats", () => {
    expect(isDuplicate("evt-1")).toBe(false);
    expect(isDuplicate("evt-1")).toBe(true);
    expect(isDuplicate("evt-2")).toBe(false);
  });

  test("returns false for empty event id (dedup is opt-in)", () => {
    expect(isDuplicate("")).toBe(false);
    expect(isDuplicate("")).toBe(false);
  });

  test("rotates when the cap is exceeded, dropping the oldest half", () => {
    // Cap is 20 in this test env. Push 21 distinct events and verify the
    // set now holds Math.floor(cap/2) = 10 entries (the most recent 10).
    for (let i = 0; i < 21; i++) {
      isDuplicate(`evt-${i}`);
    }
    expect(__seenEventsCountForTests()).toBe(10);
    // The oldest 11 should now be considered "unseen" (evicted), so a
    // re-add returns false.
    expect(isDuplicate("evt-0")).toBe(false);
    expect(isDuplicate("evt-10")).toBe(false);
    // The newest 10 should still be considered seen.
    expect(isDuplicate("evt-20")).toBe(true);
    expect(isDuplicate("evt-15")).toBe(true);
  });

  test("repeated rotations keep the set bounded indefinitely", () => {
    for (let i = 0; i < 200; i++) {
      isDuplicate(`evt-${i}`);
    }
    // Set should never exceed the cap (20). Worst case it sits between
    // cap/2+1 and cap.
    expect(__seenEventsCountForTests()).toBeLessThanOrEqual(20);
    expect(__seenEventsCountForTests()).toBeGreaterThan(0);
  });
});

describe("treeKill", () => {
  const treeClaude = join(import.meta.dir, "..", "test", "tree-claude.sh");

  test("kills child processes via process group", async () => {
    const childPidFile = join(tmpdir(), `mega-tree-kill-${Date.now()}.pid`);
    if (existsSync(childPidFile)) unlinkSync(childPidFile);

    const proc = spawn("bash", [treeClaude], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
      env: { ...process.env, TREE_CHILD_PID_FILE: childPidFile },
    });

    // Wait for the child process to be spawned and recorded.
    const recorded = await waitUntil(() => existsSync(childPidFile), 3000);
    expect(recorded).toBe(true);
    const childPid = parseInt(readFileSync(childPidFile, "utf-8").trim(), 10);
    expect(Number.isFinite(childPid)).toBe(true);

    // Child should be alive before the kill.
    expect(isAlive(childPid)).toBe(true);

    const sent = treeKill(proc, "SIGKILL");
    expect(sent).toBe(true);

    const reaped = await waitUntil(() => !isAlive(childPid), 2000);
    expect(reaped).toBe(true);

    unlinkSync(childPidFile);
  });
});

describe("invokeWithHandle integration", () => {
  const slowClaude = join(import.meta.dir, "..", "test", "slow-claude.sh");
  const treeClaude = join(import.meta.dir, "..", "test", "tree-claude.sh");
  const mockClaude = join(import.meta.dir, "..", "test", "mock-claude.sh");

  const withEnv = async <T>(
    overrides: Record<string, string | undefined>,
    fn: () => Promise<T>
  ): Promise<T> => {
    const previous: Record<string, string | undefined> = {};
    for (const key of Object.keys(overrides)) previous[key] = process.env[key];
    try {
      for (const [key, val] of Object.entries(overrides)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
      return await fn();
    } finally {
      for (const [key, val] of Object.entries(previous)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    }
  };

  test(
    "returns mock claude's JSON result",
    async () => {
      const result = await withEnv(
        {
          MEGA_CLAUDE_BIN: mockClaude,
          MEGA_INVOKE_TIMEOUT_MS: "5000",
        },
        () =>
          invokeWithHandle({
            sessionId: `test-mock-${Date.now()}`,
            prompt: "hello from test",
            systemPrompt: "test",
          }).promise
      );

      expect(result).toContain("mock response to:");
    },
    10000
  );

  test(
    "times out and kills a hung claude process",
    async () => {
      const started = Date.now();
      const result = await withEnv(
        {
          MEGA_CLAUDE_BIN: slowClaude,
          MEGA_INVOKE_TIMEOUT_MS: "300",
        },
        () =>
          invokeWithHandle({
            sessionId: `test-timeout-${Date.now()}`,
            prompt: "hello",
            systemPrompt: "test",
          }).promise
      );
      const elapsed = Date.now() - started;

      // Timeout fires → runClaude returns null → fallback --session-id path
      // runs and also times out → whole invocation yields null.
      expect(result).toBeNull();
      // Should be well under slow-claude's 10s sleep, even counting both
      // timeouts + grace periods.
      expect(elapsed).toBeLessThan(8000);
    },
    15000
  );

  test(
    "handle.kill() terminates an in-flight invocation quickly",
    async () => {
      await withEnv(
        {
          MEGA_CLAUDE_BIN: slowClaude,
          MEGA_INVOKE_TIMEOUT_MS: "60000",
        },
        async () => {
          const handle = invokeWithHandle({
            sessionId: `test-kill-${Date.now()}`,
            prompt: "hello",
            systemPrompt: "test",
          });
          // Let the spawn happen.
          await new Promise((r) => setTimeout(r, 250));
          const started = Date.now();
          handle.kill();
          const result = await handle.promise;
          const elapsed = Date.now() - started;
          expect(result).toBeNull();
          // Should be nowhere near slow-claude's 10s sleep.
          expect(elapsed).toBeLessThan(4000);
        }
      );
    },
    15000
  );

  test(
    "handle.kill() tree-kills claude's child subprocesses",
    async () => {
      const childPidFile = join(
        tmpdir(),
        `mega-invoke-tree-kill-${Date.now()}.pid`
      );
      if (existsSync(childPidFile)) unlinkSync(childPidFile);

      await withEnv(
        {
          MEGA_CLAUDE_BIN: treeClaude,
          MEGA_INVOKE_TIMEOUT_MS: "60000",
          TREE_CHILD_PID_FILE: childPidFile,
        },
        async () => {
          const handle = invokeWithHandle({
            sessionId: `test-tree-${Date.now()}`,
            prompt: "hello",
            systemPrompt: "test",
          });

          // Wait for the grandchild PID to be recorded by the mock.
          const recorded = await waitUntil(
            () => existsSync(childPidFile),
            3000
          );
          expect(recorded).toBe(true);
          const childPid = parseInt(
            readFileSync(childPidFile, "utf-8").trim(),
            10
          );
          expect(isAlive(childPid)).toBe(true);

          handle.kill();
          const result = await handle.promise;
          expect(result).toBeNull();

          // Grandchild (sleep 300) should be reaped by the group kill.
          const reaped = await waitUntil(() => !isAlive(childPid), 3000);
          expect(reaped).toBe(true);
        }
      );

      if (existsSync(childPidFile)) unlinkSync(childPidFile);
    },
    15000
  );
});
