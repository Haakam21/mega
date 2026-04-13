import { describe, test, expect } from "bun:test";
import { toUUID } from "./invoke";
import { join } from "path";

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
