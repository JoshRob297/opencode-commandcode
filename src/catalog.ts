/**
 * Catalog classification and ordering.
 *
 * The OpenCode model picker sorts the entries of a provider with this comparator
 * (verified in the v2.0.32 TUI):
 *
 *   1. provider grouping (opencode-go and opencode last, then provider name)
 *   2. entries whose `footer` is "Free" come first
 *   3. `time.released` descending
 *   4. `title` ascending
 *
 * "Free" is granted by the picker when `cost` is a non-empty array whose entries
 * all have `input === 0`. `time.released` is the release timestamp in epoch ms.
 *
 * Both are writable from a plugin through the model editor, so the whole order
 * of the Command Code catalog can be driven from here:
 *
 *   - free / promo models get `cost` with zeroed input, which also renders the
 *     "Free" badge and reports their real cost as zero
 *   - every model gets a release timestamp that encodes (family rank, version
 *     recency), so families stay grouped and the newest model of each family
 *     comes first
 */

export interface CatalogModel {
  id: string;
  name?: string;
  supported_endpoints?: string[];
}

/** Ordered list of model families. The position in this list is the group order. */
const FAMILY_ORDER: Array<{ match: RegExp; family: string }> = [
  { match: /^claude/i, family: "claude" },
  { match: /^gpt/i, family: "gpt" },
  { match: /^gemini/i, family: "gemini" },
  { match: /^deepseek/i, family: "deepseek" },
  { match: /kimi/i, family: "kimi" },
  { match: /^(glm|zai|z-ai)/i, family: "glm" },
  { match: /^minimax/i, family: "minimax" },
  { match: /^qwen/i, family: "qwen" },
  { match: /^grok/i, family: "grok" },
  { match: /mistral/i, family: "mistral" },
  { match: /nemotron/i, family: "nemotron" },
  { match: /mimo/i, family: "mimo" },
  { match: /muse/i, family: "muse" },
  { match: /inkling/i, family: "inkling" },
  { match: /^step/i, family: "step" },
  { match: /^(hy|hunyuan)/i, family: "hunyuan" },
  { match: /ling/i, family: "ling" },
  { match: /longcat/i, family: "longcat" },
  { match: /laguna/i, family: "laguna" },
  { match: /fugu/i, family: "fugu" },
  { match: /beam/i, family: "beam" },
  { match: /cat-jam/i, family: "cat-jam" },
  { match: /glyph/i, family: "glyph" },
  { match: /fable/i, family: "fable" },
];

const FAMILY_RANK = new Map(FAMILY_ORDER.map((f, i) => [f.family, i]));
const UNKNOWN_FAMILY_RANK = FAMILY_ORDER.length;

/** Strips the vendor prefix: "deepseek/deepseek-v4.1-flash" -> "deepseek-v4.1-flash". */
export function modelName(id: string): string {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? id : id.slice(idx + 1);
}

/** Detects the family of a model id. Unknown families sort last, before the promo tier. */
export function detectFamily(id: string): string {
  const name = modelName(id);
  for (const { match, family } of FAMILY_ORDER) {
    if (match.test(name)) return family;
  }
  const vendor = id.includes("/") ? id.split("/")[0]!.toLowerCase() : "";
  return vendor || "other";
}

/** Numeric rank of a family inside the group order. */
export function familyRank(id: string): number {
  const family = detectFamily(id);
  return FAMILY_RANK.get(family) ?? UNKNOWN_FAMILY_RANK;
}

/**
 * Extracts the version tuple of a model id, e.g. "gpt-6.1-sol" -> [6, 1],
 * "deepseek-v4.1-flash" -> [4, 1], "cat-jam" -> [].
 */
export function parseVersion(id: string): number[] {
  const name = modelName(id);
  // Drop the family token so digits inside the family name are not read as a version
  // ("qwen3.8-max" must yield [3, 8] and not be confused with the family prefix).
  const withoutFamily = name.replace(
    new RegExp(`^(${FAMILY_ORDER.map((f) => f.family).join("|")})[-_]?`, "i"),
    ""
  );
  const match = withoutFamily.match(/(\d+)(?:\.(\d+))?/);
  if (!match) return [];
  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  return [major, minor];
}

/** Compares two version tuples numerically. Missing components count as zero. */
export function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length, 2);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Sorts a version tuple into a single comparable score. */
export function versionScore(version: number[]): number {
  const [major = 0, minor = 0] = version;
  return major * 1000 + minor;
}

/**
 * Encodes the group order into a release timestamp.
 *
 * The picker only knows one descending number, so the family rank has to dominate
 * and the version only breaks ties inside a family. The result is a date inside
 * 2026 that grows with the group and with the version, which keeps the value
 * plausible if the UI ever renders it.
 */
const BASE_DATE = Date.parse("2026-01-01");
const GROUP_STRIDE_MS = 7 * 24 * 60 * 60 * 1000;

export function buildReleaseDate(id: string): number {
  const rank = familyRank(id);
  const invertedRank = UNKNOWN_FAMILY_RANK - rank;
  const score = versionScore(parseVersion(id));
  return BASE_DATE + invertedRank * GROUP_STRIDE_MS + score * 1000;
}

/** True for models currently offered on a free or promo tier. */
export function isFreeModel(model: { id?: string; name?: string }): boolean {
  const id = (model?.id ?? "").toLowerCase();
  const name = (model?.name ?? "").toLowerCase();
  if (/(:free|-free|_free|\.free)$/.test(id) || id.includes(":free")) return true;
  return /\b(free|promo|promotional|trial)\b/.test(name);
}

/** Cost entry that makes the picker render the "Free" badge for a promo model. */
export function freeCostEntry() {
  return {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  };
}
