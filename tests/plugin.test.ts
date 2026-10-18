import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import plugin, { applyModelCatalog } from "../src/index.ts";
import { sanitizeCommandCodeMessages } from "../src/hooks/resilience.ts";

interface CapturedHooks {
  "http.request": ((event: any) => Promise<void>)[];
  "http.response": ((event: any) => Promise<void>)[];
  retry: ((event: any) => Promise<void>)[];
}

function makeCtx() {
  const hooks: CapturedHooks = { "http.request": [], "http.response": [], retry: [] };
  const tools: any[] = [];
  const commands: any[] = [];
  const modelUpdates: any[] = [];

  const ctx: any = {
    session: {
      hook: async (name: any, cb: any) => {
        (hooks as any)[name]?.push(cb);
        return { dispose: async () => {} };
      },
      synthetic: async () => ({}),
    },
    model: {
      transform: async (cb: any) => {
        cb({
          update: (provider: string, id: string, mutate: (d: any) => void) => {
            const draft: any = {};
            mutate(draft);
            modelUpdates.push({ provider, id, name: draft.name });
          },
        });
      },
    },
    tool: { transform: async (cb: any) => cb({ add: (t: any) => tools.push(t) }) },
    command: { transform: async (cb: any) => cb({ add: (c: any) => commands.push(c) }) },
  };

  return { ctx, hooks, tools, commands, modelUpdates };
}

async function runRequestHook(hooks: CapturedHooks, request: Request, sessionID = "ses_test") {
  const event: any = { request, sessionID };
  for (const cb of hooks["http.request"]) {
    await cb(event);
  }
  return event.request as Request;
}

describe("plugin registration", () => {
  test("exposes the v2 setup and v1 server entrypoints", () => {
    expect(plugin.id).toBe("opencode-commandcode");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });

  test("registers hooks, tool and command exactly once", async () => {
    const { ctx, hooks, tools, commands } = makeCtx();
    await plugin.setup(ctx);

    expect(hooks["http.request"].length).toBe(1);
    expect(hooks["http.response"].length).toBe(1);
    expect(hooks.retry.length).toBe(1);
    expect(tools.map((t) => t.name)).toEqual(["commandcode_quota"]);
    expect(commands.map((c) => c.name)).toEqual(["commandcode-quota"]);
  });

  test("v1 server() exposes the quota tool", async () => {
    const server: any = await plugin.server();
    expect(typeof server.tool.commandcode_quota.execute).toBe("function");
  });
});

describe("http.request hook behavior", () => {
  let harness: ReturnType<typeof makeCtx>;
  const MANAGED_KEY = "cc_test_key_1234567890";

  beforeEach(async () => {
    // Deterministic credential so the hook tests never depend on the host setup.
    process.env.COMMAND_CODE_API_KEY = MANAGED_KEY;
    harness = makeCtx();
    await plugin.setup(harness.ctx);
  });

  afterEach(() => {
    delete process.env.COMMAND_CODE_API_KEY;
  });

  test("injects the API key only for the real Command Code origin", async () => {
    const ok = new Request("https://api.commandcode.ai/provider/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    const sent = await runRequestHook(harness.hooks, ok, "ses_auth_ok");
    expect(sent.headers.get("authorization")?.startsWith("Bearer ")).toBe(true);

    const hostile = new Request("https://attacker.example.com/provider/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    const untouched = await runRequestHook(harness.hooks, hostile, "ses_auth_bad");
    expect(untouched.headers.get("authorization")).toBeNull();
  });

  test("does not overwrite an existing authorization header", async () => {
    const req = new Request("https://api.commandcode.ai/provider/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer explicit_key" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    const sent = await runRequestHook(harness.hooks, req, "ses_explicit");
    expect(sent.headers.get("authorization")).toBe("Bearer explicit_key");
  });

  test("leaves unrelated hosts completely untouched", async () => {
    const req = new Request("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    const sent = await runRequestHook(harness.hooks, req, "ses_other");
    expect(sent).toBe(req);
    expect(sent.headers.get("connection")).toBeNull();
  });

  test("repairs an orphan tool response in flight", async () => {
    const payload = {
      model: "deepseek/deepseek-v4.1-flash",
      messages: [
        { role: "tool", tool_call_id: "orphan", content: "stale" },
        { role: "user", content: "continue" },
      ],
    };
    const req = new Request("https://api.commandcode.ai/provider/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const sent = await runRequestHook(harness.hooks, req, "ses_sanitize");
    const body = JSON.parse(await sent.clone().text());
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].role).toBe("user");
  });

  test("passes a clean payload through without rebuilding the request", async () => {
    const payload = { model: "m", messages: [{ role: "user", content: "hello" }] };
    const req = new Request("https://api.commandcode.ai/provider/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const sent = await runRequestHook(harness.hooks, req, "ses_clean");
    const body = JSON.parse(await sent.clone().text());
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].content).toBe("hello");
  });

  test("ignores GET requests and malformed bodies", async () => {
    const get = new Request("https://api.commandcode.ai/alpha/whoami?limits=1");
    const sentGet = await runRequestHook(harness.hooks, get, "ses_get");
    expect(sentGet.method).toBe("GET");

    const bad = new Request("https://api.commandcode.ai/provider/v1/chat/completions", {
      method: "POST",
      body: "not json at all",
    });
    const sentBad = await runRequestHook(harness.hooks, bad, "ses_bad_body");
    expect(await sentBad.clone().text()).toBe("not json at all");
  });
});

describe("http.response watchdog wiring", () => {
  test("wraps Command Code SSE streams and leaves JSON responses alone", async () => {
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);

    const sseResponse = new Response("data: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const sseEvent: any = {
      request: new Request("https://api.commandcode.ai/provider/v1/chat/completions"),
      response: sseResponse,
      sessionID: "ses_sse",
    };
    for (const cb of hooks["http.response"]) await cb(sseEvent);
    expect(sseEvent.response).not.toBe(sseResponse);

    const jsonResponse = new Response("{}", { headers: { "content-type": "application/json" } });
    const jsonEvent: any = {
      request: new Request("https://api.commandcode.ai/provider/v1/chat/completions"),
      response: jsonResponse,
      sessionID: "ses_json",
    };
    for (const cb of hooks["http.response"]) await cb(jsonEvent);
    expect(jsonEvent.response).toBe(jsonResponse);
  });

  test("ignores responses from unrelated providers", async () => {
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);

    const res = new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    const event: any = {
      request: new Request("https://api.openai.com/v1/chat/completions"),
      response: res,
      sessionID: "ses_other",
    };
    for (const cb of hooks["http.response"]) await cb(event);
    expect(event.response).toBe(res);
  });
});

describe("sanitizer contract used by the hook", () => {
  test("modified flag is false for clean input so no request is rebuilt", () => {
    const clean = [{ role: "user", content: "hi" }];
    expect(sanitizeCommandCodeMessages(clean as any).modified).toBe(false);
  });

  test("modified flag is true for a repairable payload", () => {
    const dirty = [{ role: "tool", tool_call_id: "x", content: "y" }];
    expect(sanitizeCommandCodeMessages(dirty as any).modified).toBe(true);
  });
});

describe("catalog application is defensive", () => {
  test("a throwing editor never breaks setup", () => {
    const editor = {
      update() {
        throw new Error("editor exploded");
      },
    } as any;
    const stats = applyModelCatalog(editor, [{ id: "a/b", supported_endpoints: ["/chat/completions"] }] as any);
    expect(stats.registered).toBe(0);
    expect(stats.skipped).toBe(1);
  });
});
