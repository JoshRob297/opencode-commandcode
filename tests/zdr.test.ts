import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import plugin from "../src/index.ts";
import { applyZdrHeader, isZdrEnabled, ZDR_HEADER } from "../src/hooks/zdr.ts";

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

async function runHook(hooks: Record<string, ((event: any) => Promise<void>)[]>, request: Request) {
  const event: any = { request, sessionID: "ses_test" };
  for (const cb of hooks["http.request"] ?? []) {
    await cb(event);
  }
  return event.request as Request;
}

describe("isZdrEnabled", () => {
  test("only the documented opt-in value enables ZDR", () => {
    expect(isZdrEnabled({ CMD_ZDR: "1" })).toBe(true);
    expect(isZdrEnabled({ CMD_ZDR: "0" })).toBe(false);
    expect(isZdrEnabled({ CMD_ZDR: "true" })).toBe(false);
    expect(isZdrEnabled({})).toBe(false);
  });
});

describe("applyZdrHeader", () => {
  test("sets the header when opted in", () => {
    const headers = new Headers();
    applyZdrHeader(headers, { CMD_ZDR: "1" });
    expect(headers.get(ZDR_HEADER)).toBe("1");
  });

  test("strips a caller-supplied header when not opted in", () => {
    const headers = new Headers({ "x-cmd-zdr": "1" });
    applyZdrHeader(headers, {});
    expect(headers.get(ZDR_HEADER)).toBeNull();
  });

  test("strips any casing of the header when not opted in", () => {
    const headers = new Headers({ "X-CMD-ZDR": "1" });
    applyZdrHeader(headers, { CMD_ZDR: "0" });
    expect(headers.get(ZDR_HEADER)).toBeNull();
  });

  test("keeps exactly one header value when opted in", () => {
    const headers = new Headers();
    headers.set("x-cmd-zdr", "0");
    applyZdrHeader(headers, { CMD_ZDR: "1" });
    expect(headers.get(ZDR_HEADER)).toBe("1");
  });
});

describe("plugin ZDR hook", () => {
  const previous = process.env.CMD_ZDR;

  afterEach(() => {
    if (previous === undefined) delete process.env.CMD_ZDR;
    else process.env.CMD_ZDR = previous;
  });

  test("emits x-cmd-zdr on Command Code requests when CMD_ZDR=1", async () => {
    process.env.CMD_ZDR = "1";
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);

    const request = new Request(URL_CC, { method: "POST", body: "{}" });
    const outgoing = await runHook(hooks, request);
    expect(outgoing.headers.get(ZDR_HEADER)).toBe("1");
  });

  test("strips a spoofed header when CMD_ZDR is not set", async () => {
    delete process.env.CMD_ZDR;
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);

    const request = new Request(URL_CC, {
      method: "POST",
      body: "{}",
      headers: { "x-cmd-zdr": "1" },
    });
    const outgoing = await runHook(hooks, request);
    expect(outgoing.headers.get(ZDR_HEADER)).toBeNull();
  });

  test("never touches a lookalike host that only shares the path", async () => {
    process.env.CMD_ZDR = "1";
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);

    const request = new Request("https://api.commandcode.ai.evil.com/provider/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    const outgoing = await runHook(hooks, request);
    expect(outgoing.headers.get(ZDR_HEADER)).toBeNull();
  });
});
