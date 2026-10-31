import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/index.ts";
import {
  COOLDOWN_DAY_MS,
  COOLDOWN_RATE_LIMIT_MS,
  cooldownForStatus,
  isCoolingDown,
  keyLabel,
  loadKeyPool,
  loadPoolState,
  parseKeysFile,
  retryAfterMs,
  selectKey,
} from "../src/auth/pool.ts";

const URL_CC = "https://api.commandcode.ai/provider/v1/chat/completions";

function makeCtx() {
  const hooks: Record<string, ((event: any) => Promise<void>)[]> = {
    "http.request": [],
    "http.response": [],
    retry: [],
  };
  const ctx: any = {
    session: {
      hook: async (name: any, cb: any) => {
        hooks[name]?.push(cb);
        return { dispose: async () => {} };
      },
      synthetic: async () => ({}),
    },
    model: { transform: async () => {} },
    tool: { transform: async () => {} },
    command: { transform: async () => {} },
  };
  return { ctx, hooks };
}

async function runRequest(hooks: Record<string, ((event: any) => Promise<void>)[]>, request: Request) {
  const event: any = { request, sessionID: "ses_pool" };
  for (const cb of hooks["http.request"] ?? []) await cb(event);
  return event;
}

async function runResponse(
  hooks: Record<string, ((event: any) => Promise<void>)[]>,
  event: any,
  response: Response
) {
  const next: any = { ...event, response };
  for (const cb of hooks["http.response"] ?? []) await cb(next);
  return next;
}

describe("keyLabel", () => {
  test("is stable and never contains the key", () => {
    const a = keyLabel("user_alpha", 0);
    const b = keyLabel("user_alpha", 0);
    const c = keyLabel("user_beta", 1);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("user_alpha");
  });
});

describe("parseKeysFile", () => {
  test("parses bare keys, labelled keys, comments and blanks", () => {
    const keys = parseKeysFile("# pool\n\nuser_a\nmain=user_b\n  # trailing comment\nuser_c\n");
    expect(keys.map((k) => k.key)).toEqual(["user_a", "user_b", "user_c"]);
    expect(keys[1]!.label).toBe("main");
  });

  test("dedupes repeated keys", () => {
    const keys = parseKeysFile("user_a\nuser_a\nuser_b\n");
    expect(keys.map((k) => k.key)).toEqual(["user_a", "user_b"]);
  });

  test("returns an empty pool for empty input", () => {
    expect(parseKeysFile(null)).toEqual([]);
    expect(parseKeysFile("  \n# only comments\n")).toEqual([]);
  });
});

describe("loadKeyPool", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-pool-"));
    file = join(dir, "keys.txt");
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("reads COMMANDCODE_API_KEYS before files", () => {
    writeFileSync(file, "file_key\n");
    const keys = loadKeyPool({
      COMMANDCODE_API_KEYS: "k1, k2\nk3",
      COMMANDCODE_KEYS_FILE: file,
    });
    expect(keys.map((k) => k.key)).toEqual(["k1", "k2", "k3"]);
  });

  test("falls back to COMMANDCODE_KEYS_FILE", () => {
    writeFileSync(file, "main=file_key\nsecond=file_key_2\n");
    const keys = loadKeyPool({ COMMANDCODE_KEYS_FILE: file });
    expect(keys.map((k) => k.label)).toEqual(["main", "second"]);
  });

  test("returns an empty pool when nothing is configured", () => {
    expect(loadKeyPool({ COMMANDCODE_KEYS_FILE: join(dir, "missing.txt") })).toEqual([]);
  });
});

describe("selectKey", () => {
  const keys = [
    { label: "a", key: "ka" },
    { label: "b", key: "kb" },
  ];

  test("prefers the first key that is not cooling down", () => {
    const now = 1_000;
    const state = { version: 1 as const, keys: { a: { until: now + 1, reason: "x", status: 402, at: now } } };
    expect(selectKey(keys, state, now)?.label).toBe("b");
  });

  test("fails open with the soonest-recovering key when all are cooling down", () => {
    const now = 1_000;
    const state = {
      version: 1 as const,
      keys: {
        a: { until: now + 500, reason: "x", status: 402, at: now },
        b: { until: now + 100, reason: "x", status: 429, at: now },
      },
    };
    expect(selectKey(keys, state, now)?.label).toBe("b");
  });

  test("returns null for an empty pool", () => {
    expect(selectKey([], { version: 1, keys: {} }, 0)).toBeNull();
  });
});

describe("cooldownForStatus", () => {
  const now = 10_000;

  test("402 blocks the key for a day", () => {
    const c = cooldownForStatus(402, null, now)!;
    expect(c.until).toBe(now + COOLDOWN_DAY_MS);
    expect(c.reason).toBe("insufficient credits");
  });

  test("401 and 403 block the key for a day", () => {
    expect(cooldownForStatus(401, null, now)!.until).toBe(now + COOLDOWN_DAY_MS);
    expect(cooldownForStatus(403, null, now)!.until).toBe(now + COOLDOWN_DAY_MS);
  });

  test("429 honours Retry-After within the cap", () => {
    const c = cooldownForStatus(429, "60", now)!;
    expect(c.until).toBe(now + 60_000);
  });

  test("429 falls back to five minutes without Retry-After", () => {
    const c = cooldownForStatus(429, null, now)!;
    expect(c.until).toBe(now + COOLDOWN_RATE_LIMIT_MS);
  });

  test("429 ignores an absurd Retry-After", () => {
    const c = cooldownForStatus(429, "999999", now)!;
    expect(c.until).toBe(now + COOLDOWN_RATE_LIMIT_MS);
  });

  test("5xx is not the key's fault", () => {
    expect(cooldownForStatus(500, null, now)).toBeNull();
    expect(cooldownForStatus(503, null, now)).toBeNull();
  });
});

describe("retryAfterMs", () => {
  test("parses seconds", () => {
    expect(retryAfterMs("30", 0)).toBe(30_000);
  });

  test("parses an HTTP date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs("Thu, 01 Jan 2026 00:01:00 GMT", now)).toBe(60_000);
  });

  test("rejects garbage", () => {
    expect(retryAfterMs("soon", 0)).toBeNull();
    expect(retryAfterMs(null, 0)).toBeNull();
  });
});

describe("plugin key rotation", () => {
  let stateDir: string;
  const previous = {
    keys: process.env.COMMANDCODE_API_KEYS,
    state: process.env.COMMANDCODE_STATE_DIR,
    key: process.env.COMMAND_CODE_API_KEY,
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "cc-rot-"));
    process.env.COMMANDCODE_STATE_DIR = stateDir;
    process.env.COMMANDCODE_API_KEYS = "key_one,key_two";
    delete process.env.COMMAND_CODE_API_KEY;
  });

  afterEach(() => {
    for (const [name, value] of [
      ["COMMANDCODE_API_KEYS", previous.keys],
      ["COMMANDCODE_STATE_DIR", previous.state],
      ["COMMAND_CODE_API_KEY", previous.key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  });

  test("first request uses the first key and overrides the host-injected one", async () => {
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);
    const request = new Request(URL_CC, {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer host_config_key" },
    });
    const event = await runRequest(hooks, request);
    expect(event.request.headers.get("authorization")).toBe("Bearer key_one");
  });

  test("a 402 cools the first key down and the next request uses the second", async () => {
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);

    const first = await runRequest(hooks, new Request(URL_CC, { method: "POST", body: "{}" }));
    expect(first.request.headers.get("authorization")).toBe("Bearer key_one");

    await runResponse(hooks, first, new Response(null, { status: 402 }));

    const state = loadPoolState();
    const cooled = Object.values(state.keys);
    expect(cooled).toHaveLength(1);
    expect(cooled[0]!.reason).toBe("insufficient credits");

    const second = await runRequest(hooks, new Request(URL_CC, { method: "POST", body: "{}" }));
    expect(second.request.headers.get("authorization")).toBe("Bearer key_two");
  });

  test("a 429 cools the key down using Retry-After", async () => {
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);
    const first = await runRequest(hooks, new Request(URL_CC, { method: "POST", body: "{}" }));
    await runResponse(hooks, first, new Response(null, { status: 429, headers: { "retry-after": "90" } }));
    const state = loadPoolState();
    const cooled = Object.values(state.keys)[0]!;
    expect(cooled.reason).toBe("rate limited");
    const remaining = cooled.until - Date.now();
    expect(remaining).toBeGreaterThan(80_000);
    expect(remaining).toBeLessThanOrEqual(91_000);
  });

  test("logs rotation events without the secret", async () => {
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);
    const first = await runRequest(hooks, new Request(URL_CC, { method: "POST", body: "{}" }));
    await runResponse(hooks, first, new Response(null, { status: 402 }));
    const log = readFileSync(join(stateDir, "commandcode-rotation.log"), "utf8");
    expect(log).toContain("insufficient credits");
    expect(log).not.toContain("key_one");
    expect(log).not.toContain("key_two");
  });

  test("a single key keeps the previous behaviour and never overrides the host header", async () => {
    process.env.COMMANDCODE_API_KEYS = "only_key";
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);
    const request = new Request(URL_CC, {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer host_config_key" },
    });
    const event = await runRequest(hooks, request);
    expect(event.request.headers.get("authorization")).toBe("Bearer host_config_key");
  });

  test("never touches a lookalike host", async () => {
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);
    const request = new Request("https://api.commandcode.ai.evil.com/provider/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    const event = await runRequest(hooks, request);
    expect(event.request.headers.get("authorization")).toBeNull();
  });

  test("prunes expired cooldowns on read", () => {
    const now = 1_000;
    const state = {
      version: 1 as const,
      keys: { a: { until: now - 1, reason: "x", status: 402, at: now } },
    };
    expect(isCoolingDown(state, "a", now)).toBe(false);
  });
});
