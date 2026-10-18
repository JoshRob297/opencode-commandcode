import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiKey, resolveApiKeyWithSource } from "../src/auth/resolver.ts";

const MANAGED_VARS = ["COMMAND_CODE_API_KEY", "COMMANDCODE_KEY_FILE", "XDG_CONFIG_HOME"] as const;
const ORIGINAL = new Map<string, string | undefined>(MANAGED_VARS.map((k) => [k, process.env[k]]));

let scratch = "";

function clearManagedVars() {
  for (const k of MANAGED_VARS) delete process.env[k];
}

beforeEach(() => {
  clearManagedVars();
  scratch = mkdtempSync(join(tmpdir(), "cc-auth-test-"));
});

afterEach(() => {
  clearManagedVars();
  for (const [k, v] of ORIGINAL) {
    if (v !== undefined) process.env[k] = v;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("auth resolver", () => {
  test("environment variable has the highest priority and is trimmed", () => {
    process.env.COMMAND_CODE_API_KEY = "  cc_env_key_1234567890  ";
    const resolved = resolveApiKeyWithSource();
    expect(resolved.key).toBe("cc_env_key_1234567890");
    expect(resolved.source).toBe("env:COMMAND_CODE_API_KEY");
  });

  test("strips surrounding quotes from the environment variable", () => {
    process.env.COMMAND_CODE_API_KEY = '"cc_quoted_key"';
    expect(resolveApiKey()).toBe("cc_quoted_key");

    process.env.COMMAND_CODE_API_KEY = "'cc_single_quoted'";
    expect(resolveApiKey()).toBe("cc_single_quoted");
  });

  test("explicit COMMANDCODE_KEY_FILE is used when it points at a real file", () => {
    const keyFile = join(scratch, "key.txt");
    writeFileSync(keyFile, "cc_file_key_abcdefghij\n", "utf8");

    process.env.COMMANDCODE_KEY_FILE = keyFile;
    const resolved = resolveApiKeyWithSource();
    expect(resolved.key).toBe("cc_file_key_abcdefghij");
    expect(resolved.source).toBe(`file:${keyFile}`);
  });

  test("the environment variable wins over a key file", () => {
    const keyFile = join(scratch, "key.txt");
    writeFileSync(keyFile, "cc_file_key", "utf8");

    process.env.COMMANDCODE_KEY_FILE = keyFile;
    process.env.COMMAND_CODE_API_KEY = "cc_env_wins";
    expect(resolveApiKey()).toBe("cc_env_wins");
  });

  test("a missing or empty override file does not short-circuit the cascade", () => {
    process.env.COMMANDCODE_KEY_FILE = join(scratch, "does-not-exist.txt");
    const missing = resolveApiKeyWithSource();
    expect(missing.source).not.toContain("does-not-exist.txt");

    const emptyFile = join(scratch, "empty.txt");
    writeFileSync(emptyFile, "   \n", "utf8");
    process.env.COMMANDCODE_KEY_FILE = emptyFile;
    const empty = resolveApiKeyWithSource();
    expect(empty.source).not.toBe(`file:${emptyFile}`);
  });

  test("reads the XDG config key file when the higher-priority stores are absent", () => {
    const nested = join(scratch, "commandcode");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "key.txt"), "cc_xdg_key_zyxwvutsrq", "utf8");
    process.env.XDG_CONFIG_HOME = scratch;

    const resolved = resolveApiKeyWithSource();
    expect(resolved.key).toBe("cc_xdg_key_zyxwvutsrq");
    expect(resolved.source).toBe(`file:${join(nested, "key.txt")}`);
  });

  test("never returns a key with surrounding whitespace or quotes", () => {
    process.env.COMMAND_CODE_API_KEY = '  "cc_padded"  ';
    const key = resolveApiKey();
    expect(key).toBe(key.trim());
    expect(key.startsWith('"') || key.startsWith("'")).toBe(false);
  });

  test("reports a source identifier for every resolution outcome", () => {
    process.env.COMMAND_CODE_API_KEY = "cc_source_key";
    expect(resolveApiKeyWithSource().source.length).toBeGreaterThan(0);
    delete process.env.COMMAND_CODE_API_KEY;
    expect(resolveApiKeyWithSource().source.length).toBeGreaterThan(0);
  });
});
