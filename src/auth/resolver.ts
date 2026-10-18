/**
 * Multi-source credential resolution for Command Code.
 *
 * The official CLI stores its key in `~/.commandcode/auth.json`; OpenCode users
 * typically keep a bare key file. Resolution order (first hit wins):
 *
 *   1. process.env.COMMAND_CODE_API_KEY
 *   2. COMMANDCODE_KEY_FILE (explicit override)
 *   3. $XDG_CONFIG_HOME/commandcode/key.txt  (default ~/.config/commandcode/key.txt)
 *   4. /etc/environment  -> COMMAND_CODE_API_KEY
 *   5. ~/.commandcode/auth.json        -> { apiKey }
 *   6. ~/.commandcode/credentials.json -> { apiKey | token | accessToken }
 *
 * All paths are home-relative so the plugin is portable (no hardcoded /root).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolvedKey {
  key: string;
  source: string;
}

function readFileSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^["']|["']$/g, "") : "";
}

function readJsonKeyFields(path: string): string {
  const raw = readFileSafe(path);
  if (!raw) return "";
  try {
    const data = JSON.parse(raw);
    return (
      clean(data.apiKey) ||
      clean(data.api_key) ||
      clean(data.token) ||
      clean(data.accessToken) ||
      clean(data.access_token)
    );
  } catch {
    return "";
  }
}

export function resolveApiKeyWithSource(): ResolvedKey {
  // 1. Environment
  const fromEnv = clean(process.env.COMMAND_CODE_API_KEY);
  if (fromEnv) return { key: fromEnv, source: "env:COMMAND_CODE_API_KEY" };

  // 2. Explicit override
  const override = clean(process.env.COMMANDCODE_KEY_FILE);
  if (override) {
    const raw = clean(readFileSafe(override) ?? "");
    if (raw) return { key: raw, source: `file:${override}` };
  }

  // 3. XDG config key file
  const configHome = clean(process.env.XDG_CONFIG_HOME) || join(homedir(), ".config");
  const keyFile = join(configHome, "commandcode", "key.txt");
  const fromKeyFile = clean(readFileSafe(keyFile) ?? "");
  if (fromKeyFile) return { key: fromKeyFile, source: `file:${keyFile}` };

  // 4. /etc/environment
  const etcEnv = readFileSafe("/etc/environment");
  if (etcEnv) {
    const match = etcEnv.match(/COMMAND_CODE_API_KEY=["']?([^"'\n]+)["']?/);
    const value = clean(match?.[1]);
    if (value) return { key: value, source: "file:/etc/environment" };
  }

  // 5 + 6. Official CLI credential stores
  for (const candidate of ["auth.json", "credentials.json", "config.json"]) {
    const path = join(homedir(), ".commandcode", candidate);
    const value = readJsonKeyFields(path);
    if (value) return { key: value, source: `file:${path}` };
  }

  return { key: "", source: "none" };
}

export function resolveApiKey(): string {
  return resolveApiKeyWithSource().key;
}
