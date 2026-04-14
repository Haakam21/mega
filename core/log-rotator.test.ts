import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeFileSync,
  statSync,
  existsSync,
  unlinkSync,
} from "fs";
import { rotateLogIfNeeded, startLogRotator } from "./log-rotator";

const TEST_LOG = join(tmpdir(), `mega-test-log-${process.pid}.log`);

beforeEach(() => {
  if (existsSync(TEST_LOG)) unlinkSync(TEST_LOG);
});

afterEach(() => {
  if (existsSync(TEST_LOG)) unlinkSync(TEST_LOG);
});

describe("rotateLogIfNeeded", () => {
  test("returns 0 when the file does not exist", () => {
    expect(rotateLogIfNeeded("/nonexistent/path/abc.log", 100)).toBe(0);
  });

  test("returns 0 when the file is under the cap", () => {
    writeFileSync(TEST_LOG, "x".repeat(50));
    expect(rotateLogIfNeeded(TEST_LOG, 100)).toBe(0);
    expect(statSync(TEST_LOG).size).toBe(50);
  });

  test("truncates and returns the prior size when the file is over the cap", () => {
    writeFileSync(TEST_LOG, "x".repeat(150));
    const dropped = rotateLogIfNeeded(TEST_LOG, 100);
    expect(dropped).toBe(150);
    expect(statSync(TEST_LOG).size).toBe(0);
  });

  test("truncates exactly when the file is at cap+1 byte", () => {
    writeFileSync(TEST_LOG, "x".repeat(101));
    const dropped = rotateLogIfNeeded(TEST_LOG, 100);
    expect(dropped).toBe(101);
    expect(statSync(TEST_LOG).size).toBe(0);
  });

  test("does not truncate when the file is exactly at cap", () => {
    writeFileSync(TEST_LOG, "x".repeat(100));
    expect(rotateLogIfNeeded(TEST_LOG, 100)).toBe(0);
    expect(statSync(TEST_LOG).size).toBe(100);
  });
});

describe("startLogRotator", () => {
  const originalEnv: Record<string, string | undefined> = {};
  const keys = ["MEGA_LOG_PATH", "MEGA_LOG_MAX_BYTES", "MEGA_LOG_ROTATE_INTERVAL_MS"];

  beforeEach(() => {
    for (const k of keys) originalEnv[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of keys) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  test("returns a stoppable handle", () => {
    process.env.MEGA_LOG_PATH = TEST_LOG;
    process.env.MEGA_LOG_MAX_BYTES = "1000000";
    process.env.MEGA_LOG_ROTATE_INTERVAL_MS = "60000";
    const handle = startLogRotator();
    expect(typeof handle.stop).toBe("function");
    handle.stop();
  });

  test("initial tick rotates a stale-large file before the first interval fires", () => {
    process.env.MEGA_LOG_PATH = TEST_LOG;
    process.env.MEGA_LOG_MAX_BYTES = "100";
    process.env.MEGA_LOG_ROTATE_INTERVAL_MS = "60000";
    writeFileSync(TEST_LOG, "x".repeat(500));
    const handle = startLogRotator();
    handle.stop();
    expect(statSync(TEST_LOG).size).toBe(0);
  });
});
