/**
 * Actionable Command Code errors.
 *
 * The Provider API answers failures with a JSON envelope such as
 *
 *   {"error":{"message":"You have insufficient credits...","type":"...","code":"..."}}
 *
 * OpenCode surfaces that message verbatim, which leaves the user without the
 * one thing that matters: what to do next. This module keeps the status and the
 * envelope but appends a short, provider-specific resolution hint.
 *
 * Only JSON error bodies are touched. SSE streams, successful responses and
 * non-JSON payloads keep their bytes untouched, and the status code is never
 * rewritten: OpenCode's retry classification depends on it.
 */

export interface DecoratedError {
  body: string;
  status: number;
  code?: string;
  message: string;
  hint: string;
}

function messageOf(data: any): string {
  return String(data?.error?.message ?? data?.message ?? "");
}

function codeOf(data: any): string | undefined {
  const code = data?.error?.code ?? data?.code;
  return typeof code === "string" ? code : undefined;
}

/** Resolution hint for a status/code/message combination, or an empty string. */
export function errorHint(status: number, message: string, code?: string): string {
  const text = message.toLowerCase();
  if (status === 402 || text.includes("insufficient credits")) {
    return "add credits at commandcode.ai or add another account to COMMANDCODE_API_KEYS";
  }
  if (text.includes("model_not_in_plan") || text.includes("available in pro and above")) {
    return "this model is not in your plan; pick another model or upgrade the plan";
  }
  if (status === 401) {
    return "the key was rejected; replace it in the key file or rotate the pool";
  }
  if (status === 403) {
    return "the key is not entitled to this request; check the plan or the key permissions";
  }
  if (status === 429 || text.includes("rate limit") || text.includes("window")) {
    return "rate limit or plan window reached; wait for the reset or rotate to another key";
  }
  if (text.includes("unsupported_model")) {
    return "this model is Anthropic-shaped and only served on /messages, not /chat/completions";
  }
  return "";
}

/**
 * Decorates a JSON error envelope. Returns null when the body is not a
 * recognizable error (the caller then leaves the response untouched).
 */
export function decorateErrorBody(raw: string, status: number): DecoratedError | null {
  if (!raw) return null;
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const message = messageOf(data);
  if (!message) return null;

  const code = codeOf(data);
  const hint = errorHint(status, message, code);
  if (!hint) return null;

  if (data.error && typeof data.error === "object") {
    data.error.message = `${message} (${hint})`;
  } else {
    data.message = `${message} (${hint})`;
  }

  return { body: JSON.stringify(data), status, code, message, hint };
}
