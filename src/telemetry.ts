/**
 * Telemetry helpers for Command Code.
 *
 * The OpenCode v2 `retry` hook delivers an event shaped like:
 *
 *   {
 *     sessionID, agent,
 *     model: { id, providerID },
 *     error: { type, message, status },
 *     attempt: number,
 *     decision: { retry: boolean, delay: number }
 *   }
 *
 * Note that the model is exposed as `model.id` / `model.providerID`. There is no
 * `modelID` field, so reading `event.modelID` yields undefined and every retry
 * would be logged without attribution.
 */

export interface RetryEventLike {
  sessionID?: string;
  agent?: string;
  model?: { id?: string; providerID?: string; modelID?: string } | string;
  modelID?: string;
  providerID?: string;
  error?: { type?: string; message?: string; status?: number };
  type?: string;
  status?: number;
  message?: string;
  attempt?: number;
  decision?: { retry?: boolean; delay?: number };
}

export interface RetryTelemetry {
  at: string;
  sessionID?: string;
  agent?: string;
  providerID?: string;
  modelID?: string;
  type?: string;
  status?: number;
  attempt?: number;
  retry?: boolean;
  delayMs?: number;
  message?: string;
}

/** Extracts the model id from any of the shapes OpenCode may deliver. */
export function extractModelId(event: RetryEventLike): string | undefined {
  if (typeof event?.model === "string") return event.model;
  return event?.model?.id ?? event?.model?.modelID ?? event?.modelID;
}

/** Extracts the provider id from any of the shapes OpenCode may deliver. */
export function extractProviderId(event: RetryEventLike): string | undefined {
  if (typeof event?.model === "string") return event?.providerID;
  return event?.model?.providerID ?? event?.providerID;
}

/** Normalizes a raw retry hook event into the telemetry line we persist. */
export function describeRetryEvent(event: RetryEventLike, at: string = new Date().toISOString()): RetryTelemetry {
  const message = event?.error?.message ?? event?.message;
  return {
    at,
    sessionID: event?.sessionID,
    agent: event?.agent,
    providerID: extractProviderId(event),
    modelID: extractModelId(event),
    type: event?.error?.type ?? event?.type,
    status: event?.error?.status ?? event?.status,
    attempt: event?.attempt,
    retry: event?.decision?.retry,
    delayMs: event?.decision?.delay,
    message: typeof message === "string" ? message.slice(0, 400) : undefined,
  };
}
