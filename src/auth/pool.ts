/**
 * Multi-key pool with per-key cooldowns.
 *
 * A Command Code plan can hold several API keys (one per account). When the
 * current key is dead for a while - insufficient credits, a rate-limit window -
 * the next request should try the next account instead of failing the turn.
 *
 * Activation is opt-in and additive: the pool only exists when at least two
 * keys are configured, either as
 *
 *   COMMANDCODE_API_KEYS="key1,key2"          (comma or whitespace separated)
 *   COMMANDCODE_KEYS_FILE=/path/to/keys.txt   (one `label=key` or bare key per line)
 *   ~/.config/commandcode/keys.txt            (default pool file)
 *
 * With a single key (or no pool) the plugin keeps its previous behaviour: the
 * resolved key from `auth/resolver.ts` is injected only when the host did not
 * already send an Authorization header.
 *
 * Cooldown policy (recorded per key label in the state file):
 *
 *   402 insufficient_credits -> 24h
 *   401 / 403                -> 24h  (invalid key, revoked, not entitled)
 *   429 rate limited         -> Retry-After when present and <= 6h, else 5m
 *   5xx / network            -> no cooldown (not the key's fault)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStateDir } from "../hooks/resilience.ts";

export interface PoolKey {
  /** Stable identifier used in the state file. Never the secret itself. */
  label: string;
  /** The API key. Never logged. */
  key: string;
}

export interface KeyCooldown {
  until: number;
  reason: string;
  status: number;
  at: number;
}

export interface PoolState {
  version: 1;
  keys: Record<string, KeyCooldown>;
}

export const COOLDOWN_DAY_MS = 24 * 60 * 60 * 1000;
export const COOLDOWN_RATE_LIMIT_MS = 5 * 60 * 1000;
export const COOLDOWN_RATE_LIMIT_CAP_MS = 6 * 60 * 60 * 1000;

const STATE_FILE = "commandcode-keys-state.json";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^["']|["']$/g, "") : "";
}

function readFileSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Short non-reversible label so the state file never stores a key. */
export function keyLabel(key: string, index: number): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const suffix = (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
  return `key${index + 1}-${suffix}`;
}

/** Parses the `label=key` / bare-key line format. Comments and blanks are skipped. */
export function parseKeysFile(raw: string | null): PoolKey[] {
  if (!raw) return [];
  const keys: PoolKey[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    const label = eq > 0 ? clean(trimmed.slice(0, eq)) : "";
    const key = clean(eq > 0 ? trimmed.slice(eq + 1) : trimmed);
    if (!key) continue;
    keys.push({ label: label || keyLabel(key, keys.length), key });
  }
  return dedupe(keys);
}

function dedupe(keys: PoolKey[]): PoolKey[] {
  const seen = new Set<string>();
  const out: PoolKey[] = [];
  for (const entry of keys) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push(entry);
  }
  return out;
}

function poolFileCandidates(): string[] {
  const explicit = clean(process.env.COMMANDCODE_KEYS_FILE);
  if (explicit) return [explicit];
  const configHome = clean(process.env.XDG_CONFIG_HOME) || join(homedir(), ".config");
  return [join(configHome, "commandcode", "keys.txt")];
}

/**
 * Loads the pool. Returns an empty array when rotation is not configured, which
 * keeps the single-key path untouched.
 */
export function loadKeyPool(env: Record<string, string | undefined> = process.env): PoolKey[] {
  const inline = clean(env.COMMANDCODE_API_KEYS);
  if (inline) {
    const keys = inline
      .split(/[,\s]+/)
      .map((key, index) => ({ label: keyLabel(key, index), key }))
      .filter((entry) => entry.key.length > 0);
    const deduped = dedupe(keys);
    if (deduped.length > 0) return deduped;
  }

  const explicitFile = clean(env.COMMANDCODE_KEYS_FILE);
  const candidates = explicitFile
    ? [explicitFile]
    : [join(clean(env.XDG_CONFIG_HOME) || join(homedir(), ".config"), "commandcode", "keys.txt")];
  for (const candidate of candidates) {
    const parsed = parseKeysFile(readFileSafe(candidate));
    if (parsed.length > 0) return parsed;
  }
  return [];
}

export function statePath(): string {
  return join(resolveStateDir(), STATE_FILE);
}

export function loadPoolState(path: string = statePath()): PoolState {
  const raw = readFileSafe(path);
  if (!raw) return { version: 1, keys: {} };
  try {
    const data = JSON.parse(raw);
    if (data && data.version === 1 && data.keys && typeof data.keys === "object") {
      return data as PoolState;
    }
  } catch {
    // corrupt state must never break a request
  }
  return { version: 1, keys: {} };
}

export function savePoolState(state: PoolState, path: string = statePath()): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // best effort: a failed write only costs a retry on the same key
  }
}

function cooldownIndex(state: PoolState) {
  return state.keys ?? {};
}

/**
 * Picks the first key that is not cooling down. When every key is cooling down
 * the one that recovers first wins, so the request still has a chance instead
 * of failing before it reaches upstream.
 */
export function selectKey(keys: PoolKey[], state: PoolState, now: number = Date.now()): PoolKey | null {
  if (keys.length === 0) return null;
  const index = cooldownIndex(state);
  const available = keys.find((entry) => (index[entry.label]?.until ?? 0) <= now);
  if (available) return available;
  return [...keys].sort(
    (a, b) => (index[a.label]?.until ?? 0) - (index[b.label]?.until ?? 0)
  )[0] ?? null;
}

/** Parses Retry-After (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

/**
 * Maps a response status to a cooldown. Returns null when the key is healthy or
 * the failure is not attributable to it.
 */
export function cooldownForStatus(
  status: number,
  retryAfter: string | null,
  now: number = Date.now()
): KeyCooldown | null {
  if (status === 402) {
    return { until: now + COOLDOWN_DAY_MS, reason: "insufficient credits", status, at: now };
  }
  if (status === 401 || status === 403) {
    return { until: now + COOLDOWN_DAY_MS, reason: "key rejected", status, at: now };
  }
  if (status === 429) {
    const fromHeader = retryAfterMs(retryAfter, now);
    const wait =
      fromHeader !== null && fromHeader <= COOLDOWN_RATE_LIMIT_CAP_MS
        ? Math.max(fromHeader, 1000)
        : COOLDOWN_RATE_LIMIT_MS;
    return { until: now + wait, reason: "rate limited", status, at: now };
  }
  return null;
}

/** Records the cooldown for a key label, if the status deserves one. */
export function recordResponse(
  state: PoolState,
  label: string,
  status: number,
  retryAfter: string | null,
  now: number = Date.now(),
  path: string = statePath()
): KeyCooldown | null {
  const cooldown = cooldownForStatus(status, retryAfter, now);
  if (!cooldown) return null;
  state.keys = state.keys ?? {};
  state.keys[label] = cooldown;
  savePoolState(state, path);
  return cooldown;
}

/** True when the label's cooldown has expired; used to prune on read. */
export function isCoolingDown(state: PoolState, label: string, now: number = Date.now()): boolean {
  return (state.keys?.[label]?.until ?? 0) > now;
}
