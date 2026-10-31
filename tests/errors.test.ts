import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/index.ts";
import { decorateErrorBody, errorHint } from "../src/hooks/errors.ts";

const URL_CC = "https://api.commandcode.ai/provider/v1/chat/completions";

function envelope(message: string, code?: string) {
  return JSON.stringify({ error: { message, type: "authentication_error", ...(code ? { code } : {}) } });
}

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

async function runResponse(hooks: Record<string, ((event: any) => Promise<void>)[]>, response: Response) {
  const event: any = {
    request: new Request(URL_CC, { method: "POST", body: "{}" }),
    sessionID: "ses_err",
    response,
  };
  for (const cb of hooks["http.response"] ?? []) await cb(event);
  return event.response as Response;
}

describe("errorHint", () => {
  test("maps the actionable failures", () => {
    expect(errorHint(402, "You have insufficient credits")).toContain("COMMANDCODE_API_KEYS");
    expect(errorHint(401, "Invalid 'Authorization' header")).toContain("key was rejected");
    expect(errorHint(403, "Forbidden")).toContain("not entitled");
    expect(errorHint(429, "rate limited")).toContain("rate limit");
    expect(errorHint(400, "MODEL_NOT_IN_PLAN: GPT-5.5 available in Pro")).toContain("not in your plan");
    expect(errorHint(400, "unsupported_model")).toContain("/messages");
  });

  test("leaves unrelated failures alone", () => {
    expect(errorHint(500, "internal error")).toBe("");
    expect(errorHint(400, "invalid request error")).toBe("");
  });
});

describe("decorateErrorBody", () => {
  test("keeps the envelope and appends the hint", () => {
    const decorated = decorateErrorBody(envelope("You have insufficient credits", "UNAUTHORIZED"), 402)!;
    const parsed = JSON.parse(decorated.body);
    expect(decorated.status).toBe(402);
    expect(decorated.code).toBe("UNAUTHORIZED");
    expect(parsed.error.message).toContain("You have insufficient credits");
    expect(parsed.error.message).toContain("add credits");
    expect(parsed.error.type).toBe("authentication_error");
  });

  test("handles a flat message envelope", () => {
    const decorated = decorateErrorBody(JSON.stringify({ message: "rate limited" }), 429)!;
    expect(JSON.parse(decorated.body).message).toContain("rate limit or plan window");
  });

  test("returns null for anything it cannot improve", () => {
    expect(decorateErrorBody("", 402)).toBeNull();
    expect(decorateErrorBody("not json", 402)).toBeNull();
    expect(decorateErrorBody(JSON.stringify({ ok: true }), 402)).toBeNull();
    expect(decorateErrorBody(envelope("internal error"), 500)).toBeNull();
    expect(decorateErrorBody(JSON.stringify({ error: { message: "invalid request error" } }), 400)).toBeNull();
  });
});

describe("plugin error decoration", () => {
  let stateDir: string;
  const previous = process.env.COMMANDCODE_STATE_DIR;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "cc-err-"));
    process.env.COMMANDCODE_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.COMMANDCODE_STATE_DIR;
    else process.env.COMMANDCODE_STATE_DIR = previous;
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  });

  test("rewrites a JSON 402 with a hint and records it", async () => {
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);

    const response = new Response(envelope("You have insufficient credits", "UNAUTHORIZED"), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
    const outgoing = await runResponse(hooks, response);

    expect(outgoing.status).toBe(402);
    const body = JSON.parse(await outgoing.text());
    expect(body.error.message).toContain("add credits");

    const log = readFileSync(join(stateDir, "commandcode-errors.log"), "utf8");
    expect(log).toContain("insufficient credits");
  });

  test("never rewrites a successful JSON body", async () => {
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);
    const payload = JSON.stringify({ choices: [{ message: { content: "ok" } }] });
    const response = new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
    const outgoing = await runResponse(hooks, response);
    expect(await outgoing.text()).toBe(payload);
  });

  test("never rewrites an SSE stream", async () => {
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);
    const response = new Response("data: {}\n\n", {
      status: 429,
      headers: { "content-type": "text/event-stream" },
    });
    const outgoing = await runResponse(hooks, response);
    const text = await outgoing.text();
    expect(text).toBe("data: {}\n\n");
  });
});
