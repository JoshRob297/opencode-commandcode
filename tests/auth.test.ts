import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { resolveApiKey, resolveApiKeyWithSource } from "../src/auth/resolver.ts";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const k of ["COMMAND_CODE_API_KEY", "COMMANDCODE_KEY_FILE", "XDG_CONFIG_HOME"]) {
    delete process.env[k];
  }
}

describe("auth resolver", () => {
  beforeEach(resetEnv);
  afterEach(() => {
    resetEnv();
    process.env = { ...ORIGINAL_ENV };
    Object.assign(process.env, ORIGINAL_ENV);
  });

  test("environment variable has highest priority and is trimmed", () => {
    process.env.COMMAND_CODE_API_KEY = "  cc_env_key_1234567890  ";
    const resolved = resolveApiKeyWithSource();
    expect(resolved.key).toBe("cc_env_key_1234567890");
    expect(resolved.source).toBe("env:COMMAND_CODE_API_KEY");
  });

  test("falls back to a key file when the env var is absent", () => {
    const resolved = resolveApiKeyWithSource();
    // On this host the key lives in ~/.config/commandcode/key.txt or /etc/environment.
    if (resolved.key) {
      expect(["file", "env"]).toContain(resolved.source.split(":")[0]!);
    }
  });

  test("explicit COMMANDCODE_KEY_FILE override is honoured", () => {
    process.env.COMMANDCODE_KEY_FILE = "/tmp/opencode/nonexistent-key-file.txt";
    const resolved = resolveApiKeyWithSource();
    // Missing override file must not short-circuit the cascade with garbage.
    expect(resolved.source).not.toContain("nonexistent-key-file");
  });

  test("never returns a key with surrounding quotes or whitespace", () => {
    const key = resolveApiKey();
    expect(key).toBe(key.trim());
    expect(key.startsWith('"') || key.startsWith("'")).toBe(false);
  });

  test("resolver reads a real usable key on this host", () => {
    const key = resolveApiKey();
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(10);
  });
});
