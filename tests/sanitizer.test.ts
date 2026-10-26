import { describe, expect, test } from "bun:test";
import { sanitizeCommandCodeMessages, capExcessiveSleepCommand } from "../src/hooks/resilience.ts";

describe("sanitizeCommandCodeMessages", () => {
  test("leaves a valid history untouched", () => {
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "test_tool", arguments: '{"foo":"bar"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"result":"ok"}' },
    ];

    const res = sanitizeCommandCodeMessages(messages as any);
    expect(res.modified).toBe(false);
    expect(res.messages.length).toBe(3);
    expect(res.fixes.length).toBe(0);
  });

  test("does not mutate the caller payload", () => {
    const original = [
      { role: "tool", tool_call_id: "orphan", content: "x" },
      { role: "user", content: "hi" },
    ];
    const snapshot = JSON.stringify(original);
    sanitizeCommandCodeMessages(original as any);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  test("drops a leading orphan tool response (truncated slice trigger)", () => {
    const messages = [
      { role: "tool", tool_call_id: "orphan_call", content: "orphan" },
      { role: "user", content: "continue" },
    ];

    const res = sanitizeCommandCodeMessages(messages as any);
    expect(res.modified).toBe(true);
    expect(res.messages.length).toBe(1);
    expect(res.messages[0]!.role).toBe("user");
    expect(res.fixes[0]).toContain("Removed orphan/unordered tool response");
  });

  test("drops a tool response that appears BEFORE its declaring call (order-sensitive)", () => {
    const messages = [
      { role: "tool", tool_call_id: "call_late", content: "early result" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_late", type: "function", function: { name: "t", arguments: "{}" } },
        ],
      },
    ];

    const res = sanitizeCommandCodeMessages(messages as any);
    const toolMessages = res.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(1);
    // The early one was dropped; the injected synthetic answer replaces it.
    expect(res.fixes.some((f) => f.includes("Removed orphan/unordered"))).toBe(true);
    expect(res.fixes.some((f) => f.includes("Injected synthetic response"))).toBe(true);
  });

  test("normalizes null and empty tool content", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_null", type: "function", function: { name: "t", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_null", content: null },
    ];

    const res = sanitizeCommandCodeMessages(messages as any);
    expect(res.modified).toBe(true);
    const toolMsg = res.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toBe("{}");
    expect(res.fixes.some((f) => f.includes("Normalized null/empty content"))).toBe(true);
  });

  test("injects synthetic response for a dangling tool call", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_unanswered", type: "function", function: { name: "t", arguments: "{}" } },
        ],
      },
    ];

    const res = sanitizeCommandCodeMessages(messages as any);
    expect(res.modified).toBe(true);
    expect(res.messages.length).toBe(2);
    expect(res.messages[1]!.role).toBe("tool");
    expect(res.messages[1]!.tool_call_id).toBe("call_unanswered");
  });

  test("does not inject a synthetic answer when the block already answers the call", () => {
    const messages = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_ok", type: "function", function: { name: "t", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_ok", content: '{"ok":true}' },
      { role: "assistant", content: "done" },
    ];

    const res = sanitizeCommandCodeMessages(messages as any);
    expect(res.modified).toBe(false);
    expect(res.messages.filter((m) => m.role === "tool").length).toBe(1);
  });

  test("stringifies non-string function arguments", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_obj", type: "function", function: { name: "t", arguments: { raw: "val" } as any } },
        ],
      },
      { role: "tool", tool_call_id: "call_obj", content: "{}" },
    ];

    const res = sanitizeCommandCodeMessages(messages as any);
    expect(res.modified).toBe(true);
    expect(typeof res.messages[0]!.tool_calls![0]!.function!.arguments).toBe("string");
    expect(JSON.parse(res.messages[0]!.tool_calls![0]!.function!.arguments as string)).toEqual({ raw: "val" });
  });

  test("adds a missing tool_call id", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ type: "function", function: { name: "t", arguments: "{}" } }],
      },
    ];

    const res = sanitizeCommandCodeMessages(messages as any);
    const id = res.messages[0]!.tool_calls![0]!.id!;
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(res.fixes.some((f) => f.includes("Added missing tool_call.id"))).toBe(true);
  });

  test("deduplicates repeated tool_call ids", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "dup", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "dup", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      },
    ];

    const res = sanitizeCommandCodeMessages(messages as any);
    const ids = res.messages[0]!.tool_calls!.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(res.fixes.some((f) => f.includes("Deduplicated tool_call.id"))).toBe(true);
  });

  test("removes malformed tool_call entries without crashing", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [null as any, { id: "keep", type: "function", function: { name: "t", arguments: "{}" } }],
      },
    ];

    const res = sanitizeCommandCodeMessages(messages as any);
    expect(res.messages[0]!.tool_calls!.length).toBe(1);
    expect(res.fixes.some((f) => f.includes("Removed malformed tool_call"))).toBe(true);
  });

  test("handles empty and non-array input safely", () => {
    expect(sanitizeCommandCodeMessages([]).modified).toBe(false);
    expect(sanitizeCommandCodeMessages(undefined as any).messages).toEqual([]);
  });
});

describe("capExcessiveSleepCommand (unwired helper, kept for a future tool hook)", () => {
  test("caps seconds above the limit", () => {
    const res = capExcessiveSleepCommand("sleep 620 && echo done", 30);
    expect(res.capped).toBe(true);
    expect(res.command).toContain("sleep 30");
  });

  test("converts minutes and hours before capping", () => {
    expect(capExcessiveSleepCommand("sleep 5m", 30).capped).toBe(true);
    expect(capExcessiveSleepCommand("sleep 1h", 30).capped).toBe(true);
  });

  test("leaves compliant commands untouched", () => {
    const res = capExcessiveSleepCommand("sleep 10 && ls", 30);
    expect(res.capped).toBe(false);
    expect(res.command).toBe("sleep 10 && ls");
  });
});

  test("injects synthetic reasoning_content on assistant messages when targetModel is reflection/beam", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "I am assistant" },
      { role: "user", content: "ping" },
    ];
    const res = sanitizeCommandCodeMessages(messages as any, "reflection/beam:free");
    expect(res.modified).toBe(true);
    expect(res.messages[1]?.reasoning_content).toBe("Thought: I am assistant");
    expect(res.fixes.some((f) => f.includes("Injected missing reasoning_content"))).toBe(true);
  });

  test("does not inject reasoning_content when model is not reasoning-dependent", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "I am assistant" },
      { role: "user", content: "ping" },
    ];
    const res = sanitizeCommandCodeMessages(messages as any, "deepseek/deepseek-v4.1-flash");
    expect(res.modified).toBe(false);
    expect(res.messages[1]?.reasoning_content).toBeUndefined();
  });
