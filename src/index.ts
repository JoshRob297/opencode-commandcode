import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveApiKey } from "./auth/resolver.ts";
import { fetchDiscoveredModels } from "./client/api.ts";
import {
  isCommandCodeHost,
  isCommandCodeRequest,
  isConnectionCloseDisabled,
  isFreeModel,
  sanitizeCommandCodeMessages,
  createInactivityWatchdogStream,
  resolveStateDir,
  supportsChatCompletions,
  supportsVision,
} from "./hooks/resilience.ts";
import { getQuotaReport } from "./tools/quota.ts";
import { describeRetryEvent } from "./telemetry.ts";
import { buildReleaseDate, freeCostEntry } from "./catalog.ts";

export const PROVIDER_ID = "commandcode";

/**
 * Max completion tokens declared for every Command Code model.
 *
 * OpenCode forwards `limit.output` as `max_completion_tokens`, so this value caps
 * every response. The catalog API only exposes the context window, but every model
 * in models.dev's commandcode provider declares an output limit of at least 32,768
 * (the minimum is exactly that, for Qwen3.8-27B and Ling 3.1 Flash), so 32,768 is
 * the highest value that is safe across the whole catalog.
 *
 * Override with COMMANDCODE_OUTPUT_TOKENS when a specific model needs more (the
 * DeepSeek V4.1 Flash 1017 build supports 393,216).
 */
function outputLimit(): number {
  const raw = Number(process.env.COMMANDCODE_OUTPUT_TOKENS);
  if (Number.isFinite(raw) && raw >= 1024) return Math.floor(raw);
  return 32768;
}
const WATCHDOG_TIMEOUT_MS = 60_000;

function logPath(name: string): string {
  return join(resolveStateDir(), name);
}

async function appendEvent(path: string, obj: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(obj) + "\n", "utf8");
  } catch {
    // telemetry must never break a session
  }
}

function retryProviderId(event: any): string {
  return String(
    event?.providerID ??
      event?.provider?.providerID ??
      event?.provider?.id ??
      ""
  );
}

/**
 * Model catalog transform: registers every Command Code model that the
 * OpenAI-compatible transport can actually serve, and tags free/promo tiers.
 */
function applyModelCatalog(editor: any, models: any[]): { registered: number; skipped: number; free: string[] } {
  let registered = 0;
  let skipped = 0;
  const free: string[] = [];
  const keptIds: string[] = [];

  for (const model of models) {
    if (!model?.id) continue;

    // Anthropic-shaped models respond 400 unsupported_model on /chat/completions.
    if (!supportsChatCompletions(model)) {
      skipped++;
      continue;
    }

    const freeTier = isFreeModel(model);
    const baseName = model.name || model.id;
    const displayName = freeTier
      ? `${baseName} [FREE PROMO] (Command Code)`
      : `${baseName} (Command Code)`;

    const inputs = ["text"];
    if (supportsVision(model)) inputs.push("image");

    // The picker sorts by (Free badge, release date, title). The release date
    // encodes the family group and the version recency, so the catalog shows the
    // promo models first and then each family from the newest model to the oldest.
    const released = buildReleaseDate(model.id);

    try {
      editor.update(PROVIDER_ID, model.id, (draft: any) => {
        draft.name = displayName;
        draft.status = "active";
        draft.enabled = true;
        draft.limit = {
          context: model.context_length || 200000,
          output: outputLimit(),
        };
        draft.capabilities = {
          tools: true,
          input: inputs,
          output: ["text"],
        };
        draft.time = { released };
        if (freeTier) {
          // Non-empty cost with zeroed input: renders the "Free" badge, sorts
          // the model first and reports its real cost as zero.
          draft.cost = [freeCostEntry()];
        }
      });
      registered++;
      keptIds.push(model.id);
      if (freeTier) free.push(displayName);
    } catch {
      skipped++;
    }
  }

  // OpenCode merges the provider definition with the models.dev catalog of the
  // same provider id. models.dev publishes its own "commandcode" provider, which
  // includes Anthropic-shaped claude-* models that answer 400 unsupported_model
  // on our OpenAI-compatible transport. Disable anything that is not in the set
  // we just curated, so the merge cannot reintroduce unusable entries.
  try {
    const listFn = (editor as any).list;
    if (typeof listFn === "function") {
      const curated = new Set(keptIds);
      for (const existing of listFn.call(editor, PROVIDER_ID) ?? []) {
        if (!existing?.id || curated.has(existing.id)) continue;
        editor.update(PROVIDER_ID, existing.id, (draft: any) => {
          draft.enabled = false;
        });
        skipped++;
      }
    }
  } catch {
    // fail-open: a merge we cannot inspect must not break registration
  }

  return { registered, skipped, free };
}

export default {
  id: "opencode-commandcode",

  async setup(ctx: any) {
    // ---------------------------------------------------------------- 1. Hooks
    if (ctx?.session && typeof ctx.session.hook === "function") {
      await ctx.session.hook("http.request", async (event: any) => {
        const req = event?.request;
        const url = req?.url || "";
        if (!req || !isCommandCodeRequest(url)) return;

        // A. Connection hygiene (Bun keep-alive vs Cloudflare idle close).
        if (!isConnectionCloseDisabled()) {
          try {
            req.headers.set("connection", "close");
          } catch {
            // immutable headers in this runtime
          }
        }

        // B. Credential injection, STRICT origin only (no lookalike hosts,
        //    no path-based matching: this is where the API key travels).
        if (isCommandCodeHost(url) && !req.headers.has("authorization")) {
          const key = resolveApiKey();
          if (key) {
            try {
              req.headers.set("authorization", `Bearer ${key}`);
            } catch {
              // ignore
            }
          }
        }

        // C. Payload sanitizer (no credentials involved).
        try {
          const method = String(req.method || "GET").toUpperCase();
          if (method === "GET" || method === "HEAD") return;

          const bodyText = await req.clone().text();
          if (!bodyText) return;

          let json: any;
          try {
            json = JSON.parse(bodyText);
          } catch {
            return;
          }
          if (!Array.isArray(json.messages)) return;

          const targetModel = typeof json.model === "string" ? json.model : undefined;
          const { messages, modified, fixes } = sanitizeCommandCodeMessages(json.messages, targetModel);
          if (!modified) return;

          json.messages = messages;
          const newBody = JSON.stringify(json);
          const headers = new Headers(req.headers);
          headers.delete("content-length");

          event.request = new Request(req.url, {
            method: req.method,
            headers,
            body: newBody,
            signal: req.signal,
          });

          await appendEvent(logPath("commandcode-sanitizer.log"), {
            at: new Date().toISOString(),
            sessionID: event.sessionID,
            kind: "sanitizer.repair",
            bodyBytes: Buffer.byteLength(newBody),
            fixes,
          });
        } catch {
          // fail-open
        }
      });

      await ctx.session.hook("http.response", async (event: any) => {
        const url = event?.request?.url || "";
        if (!isCommandCodeRequest(url)) return;

        const res = event.response;
        if (!res || !res.body) return;

        const contentType = res.headers?.get?.("content-type") || "";
        if (!contentType.includes("text/event-stream")) return;

        const watchedBody = createInactivityWatchdogStream(res.body, WATCHDOG_TIMEOUT_MS, () => {
          void appendEvent(logPath("commandcode-watchdog.log"), {
            at: new Date().toISOString(),
            sessionID: event.sessionID,
            kind: "watchdog.timeout",
            url,
          });
        });

        event.response = new Response(watchedBody, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      });

      try {
        await ctx.session.hook("retry", async (event: any) => {
          const providerID = retryProviderId(event);
          // Keep the log meaningful: only Command Code retries belong here.
          if (providerID && !providerID.includes(PROVIDER_ID)) return;

          const telemetry = describeRetryEvent(event);
          await appendEvent(logPath("commandcode-retries.log"), {
            at: telemetry.at,
            sessionID: telemetry.sessionID,
            agent: telemetry.agent,
            providerID: telemetry.providerID || undefined,
            modelID: telemetry.modelID,
            type: telemetry.type,
            status: telemetry.status,
            attempt: telemetry.attempt,
            retry: telemetry.retry,
            delayMs: telemetry.delayMs,
            message: telemetry.message,
          });
        });
      } catch {
        // retry hook unsupported in this build
      }
    }

    // ------------------------------------------------- 2. Model discovery
    if (ctx?.model && typeof ctx.model.transform === "function") {
      try {
        const discovered = await fetchDiscoveredModels();
        if (discovered.length > 0) {
          await ctx.model.transform((editor: any) => {
            applyModelCatalog(editor, discovered);
          });
        }
      } catch {
        // never block startup on discovery
      }
    }

    // ---------------------------------------------------------- 3. Tool
    if (ctx?.tool && typeof ctx.tool.transform === "function") {
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "commandcode_quota",
          description: "Check Command Code quota, balance, 5h and weekly rate limit windows",
          input: { type: "object", properties: {} },
          execute: async () => ({ content: await getQuotaReport() }),
        });
      });
    }

    // ------------------------------------------------------- 4. Command
    if (ctx?.command && typeof ctx.command.transform === "function") {
      await ctx.command.transform((editor: any) => {
        editor.add({
          name: "commandcode-quota",
          description: "Check Command Code quota and rate limit status",
          execute: async (inv: any) => {
            const report = await getQuotaReport();
            if (inv?.sessionID && ctx.session && typeof ctx.session.synthetic === "function") {
              await ctx.session.synthetic({ sessionID: inv.sessionID, text: report });
            }
          },
        });
      });
    }
  },

  // ------------------------------------------------- OpenCode v1 compatibility
  async server() {
    return {
      tool: {
        commandcode_quota: {
          description: "Check Command Code quota, balance, 5h and weekly rate limit windows",
          args: {},
          async execute() {
            return await getQuotaReport();
          },
        },
      },
    };
  },
};

export { applyModelCatalog };
