/**
 * Command Code API client.
 *
 * Endpoints used:
 *   GET /provider/v1/models      -> catalog (id, name, context_length, supported_endpoints)
 *   GET /alpha/whoami?limits=1   -> account identity
 *   GET /alpha/billing/credits   -> balance + 5h/weekly rate-limit windows
 *   GET /alpha/billing/subscriptions
 *   GET /alpha/usage/summary     -> cycle usage counters
 *
 * The catalog is cached on disk so a Command Code outage (or an offline start)
 * never blocks OpenCode startup with the full curated catalog missing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveApiKey, resolveApiKeyWithSource } from "../auth/resolver.ts";
import { resolveStateDir } from "../hooks/resilience.ts";

export const API_BASE = "https://api.commandcode.ai";
export const CLI_VERSION = "1.73.4";

const DEFAULT_TIMEOUT_MS = 10_000;
const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

export interface CommandCodeModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_endpoints?: string[];
  owned_by?: string;
  [key: string]: unknown;
}

export interface QuotaWindow {
  cap: number;
  used: number;
  resetAt?: number;
}

export interface QuotaData {
  user: string;
  plan: string;
  status: string;
  periodEnd: string;
  monthlyRemaining: number;
  purchasedCredits: number;
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
  summary?: {
    totalCount: number;
    completedCount: number;
    failedCount: number;
    totalTokens: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCost: number;
  };
}

export interface FetchOptions {
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function catalogCachePath(): string {
  return join(resolveStateDir(), "commandcode-models-cache.json");
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "cli",
    "x-command-code-version": CLI_VERSION,
    "x-cli-environment": "terminal",
  };
}

async function requestJson(endpoint: string, apiKey: string, opts: FetchOptions = {}): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: buildHeaders(apiKey),
    signal,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} al consultar ${endpoint}`);
  }

  return await res.json();
}

/** Last known good catalog, cached on disk. */
export function readCachedModels(): CommandCodeModel[] {
  const path = catalogCachePath();
  try {
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const models = raw?.models;
    return Array.isArray(models) ? (models as CommandCodeModel[]) : [];
  } catch {
    return [];
  }
}

function writeCachedModels(models: CommandCodeModel[]): void {
  const path = catalogCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), models }), "utf8");
  } catch {
    // cache is best-effort
  }
}

/**
 * Live catalog with disk fallback.
 * Returns [] only when the API fails AND no cache exists.
 */
export async function fetchDiscoveredModels(opts: FetchOptions & { forceRefresh?: boolean } = {}): Promise<CommandCodeModel[]> {
  const key = opts.apiKey || resolveApiKey();
  const cached = readCachedModels();

  if (!key) return cached;

  const path = catalogCachePath();
  if (!opts.forceRefresh) {
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        const at = raw?.at ? Date.parse(raw.at) : NaN;
        if (Number.isFinite(at) && Date.now() - at < CATALOG_TTL_MS && cached.length > 0) {
          return cached;
        }
      }
    } catch {
      // fall through to network
    }
  }

  try {
    const data = await requestJson("/provider/v1/models", key, opts);
    const models = ((data?.data ?? data?.models ?? []) as CommandCodeModel[]).filter(
      (m) => m && typeof m.id === "string" && m.id.length > 0
    );
    if (models.length > 0) {
      writeCachedModels(models);
      return models;
    }
    return cached;
  } catch {
    return cached;
  }
}

export async function fetchQuotaData(opts: FetchOptions = {}): Promise<QuotaData> {
  const resolution = resolveApiKeyWithSource();
  const key = opts.apiKey || resolution.key;
  if (!key) {
    throw new Error("No se encontro COMMAND_CODE_API_KEY (env, key.txt, /etc/environment ni ~/.commandcode).");
  }

  const [whoami, credits, sub, summary] = await Promise.all([
    requestJson("/alpha/whoami?limits=1", key, opts).catch(() => ({})),
    requestJson("/alpha/billing/credits", key, opts).catch(() => ({})),
    requestJson("/alpha/billing/subscriptions", key, opts).catch(() => ({})),
    requestJson("/alpha/usage/summary", key, opts).catch(() => null),
  ]);

  const user = whoami?.user?.userName || whoami?.user?.email || "Usuario";
  const plan = sub?.data?.planId || "Desconocido";
  const status = sub?.data?.status || "Inactivo";
  const periodEnd = sub?.data?.currentPeriodEnd
    ? new Date(sub.data.currentPeriodEnd).toLocaleDateString()
    : "N/A";

  const monthlyRemaining = credits?.credits?.monthlyCredits ?? 0;
  const purchasedCredits = credits?.credits?.purchasedCredits ?? 0;

  return {
    user,
    plan,
    status,
    periodEnd,
    monthlyRemaining,
    purchasedCredits,
    fiveHour: credits?.windowLimits?.fiveHour,
    weekly: credits?.windowLimits?.weekly,
    summary: summary
      ? {
          totalCount: summary.totalCount ?? 0,
          completedCount: summary.completedCount ?? 0,
          failedCount: summary.failedCount ?? 0,
          totalTokens: summary.totalTokens ?? 0,
          totalTokensIn: summary.totalTokensIn ?? 0,
          totalTokensOut: summary.totalTokensOut ?? 0,
          totalCost: summary.totalCost ?? 0,
        }
      : undefined,
  };
}
