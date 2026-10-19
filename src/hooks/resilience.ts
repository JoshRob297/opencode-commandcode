/**
 * Command Code Resilience Hooks
 *
 * Pure helpers (no I/O beyond a sentinel file check) shared by the plugin:
 *
 * 1. isCommandCodeHost      - STRICT origin check. Used before injecting the API key.
 * 2. isCommandCodeRequest   - broader matcher (host or provider path). Used for
 *                             sanitizer / watchdog only; never for credential injection.
 * 3. sanitizeCommandCodeMessages - repairs history slices that Command Code rejects
 *                             with HTTP 400 "invalid request error".
 * 4. createInactivityWatchdogStream - aborts silently dropped SSE streams.
 * 5. isFreeModel / supportsChatCompletions - model catalog classification.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const COMMAND_CODE_HOST = "api.commandcode.ai";

/** Sentinel that disables the `Connection: close` injection at runtime. */
export const DISABLE_CONNECTION_CLOSE_FLAG = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".disable-connection-close"
);

/** Hosts allowed to receive the API key. Extra hosts can be opted in via env. */
export function allowedCommandCodeHosts(): string[] {
  const extra = (process.env.COMMANDCODE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [COMMAND_CODE_HOST, ...extra];
}

/**
 * Strict origin check. Parsing the URL (instead of substring matching) prevents
 * credential leakage to lookalike hosts such as `api.commandcode.ai.evil.com`,
 * `evil.com/?next=api.commandcode.ai` or `evil.com/provider/v1/chat/completions`.
 */
export function isCommandCodeHost(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedCommandCodeHosts().includes(host);
}

/** Broad matcher for payload repair. Carries no credentials, so it stays permissive. */
export function isCommandCodeRequest(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  if (isCommandCodeHost(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.pathname.includes("/provider/v1/chat/completions");
  } catch {
    return false;
  }
}

export function isConnectionCloseDisabled(): boolean {
  if (process.env.CC_NO_CONNECTION_CLOSE === "1") return true;
  try {
    return existsSync(DISABLE_CONNECTION_CLOSE_FLAG);
  } catch {
    return false;
  }
}

export interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}

export interface Message {
  role: string;
  content?: string | any[] | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
  [key: string]: any;
}

export interface SanitizeResult {
  messages: Message[];
  modified: boolean;
  fixes: string[];
}

/**
 * Repairs the outgoing message history so Command Code does not answer
 * HTTP 400 "invalid request error". Fixes applied, in order:
 *
 * 1. Missing / duplicate assistant `tool_call.id` -> deterministic new id.
 * 2. Non-string `function.arguments` -> JSON stringified.
 * 3. `tool` responses with no declaring tool_call BEFORE them -> dropped
 *    (the reproduced trigger: a truncated slice starting mid tool-group).
 * 4. `null` / empty tool response content -> normalized to "{}".
 * 5. Assistant tool_calls with no answer in their block -> synthetic response.
 */
export function sanitizeCommandCodeMessages(messages: Message[]): SanitizeResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: Array.isArray(messages) ? messages : [], modified: false, fixes: [] };
  }

  const fixes: string[] = [];
  let modified = false;
  let syntheticCounter = 0;

  // Shallow clone so the caller's payload is never mutated in place.
  const working: Message[] = messages.map((m) => ({ ...m }));

  // 1 + 2. Normalize assistant tool calls.
  const seenCallIds = new Set<string>();
  for (let i = 0; i < working.length; i++) {
    const msg = working[i]!;
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;

    const cleanCalls: ToolCall[] = [];
    for (let j = 0; j < msg.tool_calls.length; j++) {
      const call = msg.tool_calls[j];
      if (!call || typeof call !== "object") {
        fixes.push(`Removed malformed tool_call at message ${i}`);
        modified = true;
        continue;
      }

      const tc: ToolCall = { ...call };

      if (!tc.id) {
        tc.id = `call_synthetic_${i}_${j}`;
        fixes.push(`Added missing tool_call.id at message ${i}`);
        modified = true;
      } else if (seenCallIds.has(tc.id)) {
        const newId = `${tc.id}_dup_${j}`;
        fixes.push(`Deduplicated tool_call.id ${tc.id} -> ${newId}`);
        tc.id = newId;
        modified = true;
      }
      seenCallIds.add(tc.id!);

      if (tc.function) {
        const fn = { ...tc.function };
        if (typeof fn.arguments !== "string") {
          fn.arguments = JSON.stringify(fn.arguments ?? {});
          fixes.push(`Stringified non-string function arguments at message ${i}`);
          modified = true;
        }
        tc.function = fn;
      }

      cleanCalls.push(tc);
    }
    msg.tool_calls = cleanCalls;
  }

  // 3 + 4. Drop orphan/unordered tool responses, normalize null content.
  const filtered: Message[] = [];
  const declaredSoFar = new Set<string>();
  for (let i = 0; i < working.length; i++) {
    const msg = working[i]!;

    if (msg.role === "assistant") {
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc?.id) declaredSoFar.add(tc.id);
        }
      }
      filtered.push(msg);
      continue;
    }

    if (msg.role === "tool") {
      const callId = msg.tool_call_id;
      if (!callId || !declaredSoFar.has(callId)) {
        fixes.push(`Removed orphan/unordered tool response (tool_call_id=${callId}) at index ${i}`);
        modified = true;
        continue;
      }
      if (msg.content === null || msg.content === undefined || msg.content === "") {
        msg.content = "{}";
        fixes.push(`Normalized null/empty content on tool response ${callId}`);
        modified = true;
      }
    }

    filtered.push(msg);
  }

  // 5. Inject synthetic answers for dangling tool calls (checked per block).
  const finalMessages: Message[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const msg = filtered[i]!;
    finalMessages.push(msg);

    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      continue;
    }

    const answeredInBlock = new Set<string>();
    let k = i + 1;
    while (k < filtered.length && filtered[k]!.role === "tool") {
      const id = filtered[k]!.tool_call_id;
      if (id) answeredInBlock.add(id);
      k++;
    }

    for (const tc of msg.tool_calls) {
      if (!tc?.id || answeredInBlock.has(tc.id)) continue;
      finalMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: "[Tool execution was interrupted or completed without recorded output]",
      });
      fixes.push(`Injected synthetic response for dangling tool_call ${tc.id}`);
      modified = true;
      syntheticCounter++;
    }
  }

  void syntheticCounter;
  return { messages: finalMessages, modified, fixes };
}

/**
 * Wraps an SSE stream and errors it out when no chunk arrives within `timeoutMs`
 * AFTER the first chunk. Prevents indefinite UI freezes when the upstream drops
 * the connection silently. The window before the first chunk is left to
 * OpenCode's own provider timeout (models may legitimately think for a while).
 */
export function createInactivityWatchdogStream(
  originalStream: ReadableStream<Uint8Array>,
  timeoutMs: number = 60_000,
  onTimeout?: () => void
): ReadableStream<Uint8Array> {
  const reader = originalStream.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearWatchdog(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function armWatchdog(controller: ReadableStreamDefaultController<Uint8Array>): void {
    clearWatchdog();
    timer = setTimeout(() => {
      try {
        if (onTimeout) onTimeout();
      } catch {
        // logging must never mask the abort
      }
      try {
        controller.error(
          new Error(
            `[CommandCode Watchdog] SSE stream stalled: ${timeoutMs}ms without a chunk after streaming began. Aborting dead connection.`
          )
        );
      } catch {
        // stream already closed/errored
      }
      try {
        void reader.cancel();
      } catch {
        // ignore
      }
    }, timeoutMs);
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            clearWatchdog();
            controller.close();
            break;
          }
          armWatchdog(controller);
          controller.enqueue(value);
        }
      } catch (err) {
        clearWatchdog();
        try {
          controller.error(err);
        } catch {
          // already closed
        }
      }
    },
    cancel(reason) {
      clearWatchdog();
      return reader.cancel(reason);
    },
  });
}

/** True for models currently offered on a free/promo tier. Single source of truth. */
export { isFreeModel } from "../catalog.ts";

/**
 * The provider is registered as OpenAI-compatible, so only models that advertise
 * `/chat/completions` are usable. Anthropic-shaped models (the `claude-*` line)
 * only expose `/messages` and return HTTP 400 `unsupported_model` here.
 */
export function supportsChatCompletions(model: { supported_endpoints?: string[] }): boolean {
  const endpoints = model?.supported_endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) return true;
  return endpoints.includes("/chat/completions");
}

/** Vision-capable detection for capability metadata. */
export function supportsVision(model: { id?: string; name?: string; supported_endpoints?: string[] }): boolean {
  const haystack = `${model?.id ?? ""} ${model?.name ?? ""}`.toLowerCase();
  return /(vision|-vl\b|vl-|omni|image)/.test(haystack);
}

/** State directory for plugin logs (portable: env > XDG > ~/.local/state). */
export function resolveStateDir(): string {
  const fromEnv = process.env.COMMANDCODE_STATE_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.trim()) return join(xdg.trim(), "opencode");
  return join(homedir(), ".local", "state", "opencode");
}

/**
 * Caps excessive sleep commands in shell tool invocations.
 *
 * STATUS: not wired to the runtime. `session.hook("tool.before")` registers
 * without error on OpenCode v2 but never fires for tool execution, so a hard cap
 * cannot be enforced from a plugin. Kept (with tests) for a future tool hook.
 * The active mitigation is the AGENTS.md rule (no `sleep` > 30s).
 */
export function capExcessiveSleepCommand(
  command: string,
  maxSeconds: number = 30
): { command: string; capped: boolean } {
  if (typeof command !== "string" || !command.includes("sleep")) {
    return { command, capped: false };
  }

  let capped = false;
  const newCommand = command.replace(/\bsleep\s+(\d+)([smh]?)\b/g, (match, valStr, unit) => {
    const val = parseInt(valStr, 10);
    let totalSec = val;
    if (unit === "m") totalSec = val * 60;
    else if (unit === "h") totalSec = val * 3600;

    if (totalSec > maxSeconds) {
      capped = true;
      return `sleep ${maxSeconds} # [Auto-capped from ${match} to prevent session hang]`;
    }
    return match;
  });

  return { command: newCommand, capped };
}
