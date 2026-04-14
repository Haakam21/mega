import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parsePositiveInt, parseNonNegativeInt, parseString } from "./env";

const TEST_VAR = "MEGA_TEST_ENV_VAR_XYZ";

beforeEach(() => {
  delete process.env[TEST_VAR];
});

afterEach(() => {
  delete process.env[TEST_VAR];
});

describe("parsePositiveInt", () => {
  test("returns the parsed int when the env var is a positive integer", () => {
    process.env[TEST_VAR] = "42";
    expect(parsePositiveInt(TEST_VAR, 99)).toBe(42);
  });

  test("returns the fallback when the env var is unset", () => {
    expect(parsePositiveInt(TEST_VAR, 99)).toBe(99);
  });

  test("returns the fallback when the env var is empty string", () => {
    process.env[TEST_VAR] = "";
    expect(parsePositiveInt(TEST_VAR, 99)).toBe(99);
  });

  test("returns the fallback when the env var is non-numeric", () => {
    process.env[TEST_VAR] = "garbage";
    expect(parsePositiveInt(TEST_VAR, 99)).toBe(99);
  });

  test("returns the fallback for 0 — the bug fix that motivated extraction", () => {
    process.env[TEST_VAR] = "0";
    expect(parsePositiveInt(TEST_VAR, 99)).toBe(99);
  });

  test("returns the fallback for negative integers", () => {
    process.env[TEST_VAR] = "-5";
    expect(parsePositiveInt(TEST_VAR, 99)).toBe(99);
  });

  test("parseInt-style trailing garbage is accepted (consistent with parseInt)", () => {
    process.env[TEST_VAR] = "42abc";
    expect(parsePositiveInt(TEST_VAR, 99)).toBe(42);
  });
});

describe("parseNonNegativeInt", () => {
  test("accepts 0 (the difference from parsePositiveInt)", () => {
    process.env[TEST_VAR] = "0";
    expect(parseNonNegativeInt(TEST_VAR, 99)).toBe(0);
  });

  test("accepts positive integers", () => {
    process.env[TEST_VAR] = "5";
    expect(parseNonNegativeInt(TEST_VAR, 99)).toBe(5);
  });

  test("rejects negatives", () => {
    process.env[TEST_VAR] = "-1";
    expect(parseNonNegativeInt(TEST_VAR, 99)).toBe(99);
  });

  test("returns fallback when unset", () => {
    expect(parseNonNegativeInt(TEST_VAR, 99)).toBe(99);
  });
});

describe("parseString", () => {
  test("returns the value when the env var is set to a non-empty string", () => {
    process.env[TEST_VAR] = "hello";
    expect(parseString(TEST_VAR, "default")).toBe("hello");
  });

  test("returns the fallback when the env var is unset", () => {
    expect(parseString(TEST_VAR, "default")).toBe("default");
  });

  test("returns the fallback when the env var is empty string (treats '' as unset)", () => {
    process.env[TEST_VAR] = "";
    expect(parseString(TEST_VAR, "default")).toBe("default");
  });

  test("preserves whitespace-only values (caller's problem to trim)", () => {
    process.env[TEST_VAR] = "   ";
    expect(parseString(TEST_VAR, "default")).toBe("   ");
  });
});
