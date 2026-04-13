import { describe, test, expect } from "bun:test";
import { buildPrompt } from "./channel";

describe("buildPrompt", () => {
  test("single message", () => {
    const result = buildPrompt("C123", "U456", "1234.5678", [
      { text: "hello" },
    ]);
    expect(result).toContain("From user: U456");
    expect(result).toContain("Channel: C123");
    expect(result).toContain("Thread: 1234.5678");
    expect(result).toContain("hello");
  });

  test("multiple messages combined with newlines", () => {
    const result = buildPrompt("C123", "U456", "1234.5678", [
      { text: "first message" },
      { text: "second message" },
      { text: "third message" },
    ]);
    expect(result).toContain("first message\nsecond message\nthird message");
  });

  test("messages with file attachments", () => {
    const result = buildPrompt("C123", "U456", "1234.5678", [
      {
        text: "check this out",
        files: [{ name: "screenshot.png" }, { name: "doc.pdf" }],
      },
    ]);
    expect(result).toContain("check this out");
    expect(result).toContain("attached 2 file(s)");
    expect(result).toContain("screenshot.png");
    expect(result).toContain("doc.pdf");
    expect(result).toContain("cannot view these yet");
  });

  test("message with no text", () => {
    const result = buildPrompt("C123", "U456", "1234.5678", [
      { files: [{ name: "image.png" }] },
    ]);
    expect(result).toContain("attached 1 file(s)");
    expect(result).not.toContain("undefined");
  });

  test("file with no name defaults to unknown", () => {
    const result = buildPrompt("C123", "U456", "1234.5678", [
      { text: "here", files: [{}] },
    ]);
    expect(result).toContain("unknown");
  });

  test("no files means no attachment note", () => {
    const result = buildPrompt("C123", "U456", "1234.5678", [
      { text: "just text" },
    ]);
    expect(result).not.toContain("attached");
    expect(result).not.toContain("file(s)");
  });

  test("thread history prepended when provided", () => {
    const history = "Thread history (earlier messages in this thread):\n[mega]: hey I have a proposal\n[U456]: sounds good\n\n---\n\n";
    const result = buildPrompt("C123", "U456", "1234.5678", [
      { text: "tell me more" },
    ], history);
    expect(result).toStartWith("Thread history");
    expect(result).toContain("[mega]: hey I have a proposal");
    expect(result).toContain("[U456]: sounds good");
    expect(result).toContain("tell me more");
  });

  test("no thread history means no prefix", () => {
    const result = buildPrompt("C123", "U456", "1234.5678", [
      { text: "hello" },
    ]);
    expect(result).toStartWith("New Slack message:");
  });

  test("empty thread history string treated as no history", () => {
    const result = buildPrompt("C123", "U456", "1234.5678", [
      { text: "hello" },
    ], "");
    expect(result).toStartWith("New Slack message:");
  });
});
