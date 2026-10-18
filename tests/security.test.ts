import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isCommandCodeHost,
  isCommandCodeRequest,
  isFreeModel,
  supportsChatCompletions,
  supportsVision,
  resolveStateDir,
  DISABLE_CONNECTION_CLOSE_FLAG,
} from "../src/hooks/resilience.ts";

describe("credential injection guard (isCommandCodeHost)", () => {
  test("accepts the real Command Code origin", () => {
    expect(isCommandCodeHost("https://api.commandcode.ai/provider/v1/chat/completions")).toBe(true);
    expect(isCommandCodeHost("https://api.commandcode.ai/alpha/whoami?limits=1")).toBe(true);
  });

  test("rejects lookalike and injected URLs (key-leak vectors)", () => {
    const hostile = [
      "https://attacker.example.com/provider/v1/chat/completions",
      "https://api.commandcode.ai.attacker.com/v1/chat",
      "https://attacker.com/api.commandcode.ai",
      "https://evil.com/?next=api.commandcode.ai",
      "https://evil.com/#api.commandcode.ai",
      "http://api.commandcode.ai.evil.local/",
      "https://notapi.commandcode.ai.evil.com/",
      "not-a-url",
      "",
    ];
    for (const url of hostile) {
      expect(isCommandCodeHost(url)).toBe(false);
    }
  });

  test("honours an explicit COMMANDCODE_ALLOWED_HOSTS opt-in", () => {
    process.env.COMMANDCODE_ALLOWED_HOSTS = "proxy.internal";
    try {
      expect(isCommandCodeHost("https://proxy.internal/v1/chat")).toBe(true);
    } finally {
      delete process.env.COMMANDCODE_ALLOWED_HOSTS;
    }
  });

  test("broad matcher stays permissive for payload repair only", () => {
    expect(isCommandCodeRequest("https://api.commandcode.ai/provider/v1/chat/completions")).toBe(true);
    expect(isCommandCodeRequest("https://proxy.example.com/provider/v1/chat/completions")).toBe(true);
    expect(isCommandCodeRequest("https://proxy.example.com/v1/messages")).toBe(false);
  });
});

describe("model classification", () => {
  test("flags every observed free/promo id shape", () => {
    expect(isFreeModel({ id: "stealth/glyph-cluster:free", name: "Glyph Cluster" })).toBe(true);
    expect(isFreeModel({ id: "stealth/cat-jam:free", name: "Cat Jam" })).toBe(true);
    expect(isFreeModel({ id: "reflection/beam:free", name: "Beam 1.0" })).toBe(true);
    // Regression: this one was missed by the old `:free`-only check.
    expect(isFreeModel({ id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1" })).toBe(true);
    expect(isFreeModel({ id: "x/model_free", name: "Model" })).toBe(true);
  });

  test("flags a free word in the display name", () => {
    expect(isFreeModel({ id: "vendor/model", name: "Ox Alpha Free" })).toBe(true);
    expect(isFreeModel({ id: "vendor/model", name: "Free Trial Model" })).toBe(true);
  });

  test("does not flag paid models", () => {
    expect(isFreeModel({ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" })).toBe(false);
    expect(isFreeModel({ id: "zai-org/GLM-5.2-Fast", name: "GLM 5.2 Fast" })).toBe(false);
  });

  test("filters Anthropic-only models out of the OpenAI-compatible transport", () => {
    expect(supportsChatCompletions({ supported_endpoints: ["/messages"] })).toBe(false);
    expect(
      supportsChatCompletions({ supported_endpoints: ["/chat/completions", "/responses"] })
    ).toBe(true);
    // Unknown metadata must not hide models.
    expect(supportsChatCompletions({})).toBe(true);
  });

  test("detects vision-capable models", () => {
    expect(supportsVision({ id: "deepseek/deepseek-v4-flash-vision-exp", name: "" })).toBe(true);
    expect(supportsVision({ id: "nvidia/nemotron-3.5-super-vl", name: "" })).toBe(true);
    expect(supportsVision({ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" })).toBe(false);
  });
});

describe("portability", () => {
  test("state dir defaults to a home-relative XDG path", () => {
    const dir = resolveStateDir();
    expect(dir.endsWith(join("state", "opencode"))).toBe(true);
    expect(dir.startsWith(homedir())).toBe(true);
  });

  test("state dir honours COMMANDCODE_STATE_DIR", () => {
    process.env.COMMANDCODE_STATE_DIR = "/tmp/opencode/cc-state";
    try {
      expect(resolveStateDir()).toBe("/tmp/opencode/cc-state");
    } finally {
      delete process.env.COMMANDCODE_STATE_DIR;
    }
  });

  test("kill-switch sentinel lives inside the plugin, not in a legacy hardcoded path", () => {
    expect(DISABLE_CONNECTION_CLOSE_FLAG).toContain("opencode-commandcode");
    expect(DISABLE_CONNECTION_CLOSE_FLAG.endsWith(".disable-connection-close")).toBe(true);
  });
});
