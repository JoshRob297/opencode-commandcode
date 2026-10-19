import { describe, expect, test } from "bun:test";
import {
  buildReleaseDate,
  compareVersions,
  detectFamily,
  familyRank,
  freeCostEntry,
  isFreeModel,
  modelName,
  parseVersion,
  versionScore,
} from "../src/catalog.ts";

describe("catalog classification", () => {
  test("strips the vendor prefix", () => {
    expect(modelName("deepseek/deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash");
    expect(modelName("gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });

  test("detects the family of a model id", () => {
    expect(detectFamily("gpt-6.1-sol")).toBe("gpt");
    expect(detectFamily("google/gemini-4-argon")).toBe("gemini");
    expect(detectFamily("deepseek/deepseek-v4.1-flash")).toBe("deepseek");
    expect(detectFamily("moonshotai/Kimi-K3")).toBe("kimi");
    expect(detectFamily("z-ai/glm-5.3-flash")).toBe("glm");
    expect(detectFamily("MiniMaxAI/MiniMax-M3.1")).toBe("minimax");
    expect(detectFamily("Qwen/Qwen3.8-Max")).toBe("qwen");
    expect(detectFamily("xai/grok-4.7")).toBe("grok");
    expect(detectFamily("stealth/glyph-cluster:free")).toBe("glyph");
  });

  test("family rank keeps the grouping order and unknown families last", () => {
    const gpt = familyRank("gpt-6.1-sol");
    const gemini = familyRank("google/gemini-4-argon");
    const deepseek = familyRank("deepseek/deepseek-v4.1-flash");
    expect(gpt).toBeLessThan(gemini);
    expect(gemini).toBeLessThan(deepseek);
    expect(familyRank("xai/grok-4.7")).toBeGreaterThan(gpt);
  });

  test("parses the version tuple", () => {
    expect(parseVersion("gpt-6.1-sol")).toEqual([6, 1]);
    expect(parseVersion("gpt-6-sol")).toEqual([6, 0]);
    expect(parseVersion("google/gemini-4-argon")).toEqual([4, 0]);
    expect(parseVersion("deepseek/deepseek-v4.1-flash")).toEqual([4, 1]);
    expect(parseVersion("Qwen/Qwen3.8-Max")).toEqual([3, 8]);
    expect(parseVersion("moonshotai/Kimi-K3")).toEqual([3, 0]);
    expect(parseVersion("stealth/cat-jam:free")).toEqual([]);
  });

  test("compares versions numerically, not lexicographically", () => {
    expect(compareVersions([6, 1], [6, 0])).toBeGreaterThan(0);
    expect(compareVersions([10, 0], [9, 9])).toBeGreaterThan(0);
    expect(compareVersions([5, 0], [5, 0])).toBe(0);
    expect(versionScore([6, 1])).toBeGreaterThan(versionScore([5, 6]));
  });
});

describe("release date encoding", () => {
  test("every model lands on a plausible 2026 date", () => {
    expect(new Date(buildReleaseDate("gpt-6.1-sol")).getUTCFullYear()).toBe(2026);
    expect(new Date(buildReleaseDate("stealth/cat-jam:free")).getUTCFullYear()).toBe(2026);
  });

  test("family grouping dominates the version", () => {
    const gpt = buildReleaseDate("gpt-6.1-sol");
    const gemini = buildReleaseDate("google/gemini-4-argon");
    const deepseek = buildReleaseDate("deepseek/deepseek-v4.1-flash");
    expect(gpt).toBeGreaterThan(gemini);
    expect(gemini).toBeGreaterThan(deepseek);
  });

  test("the newest model of each family comes first", () => {
    expect(buildReleaseDate("gpt-6.1-sol")).toBeGreaterThan(buildReleaseDate("gpt-6-sol"));
    expect(buildReleaseDate("gpt-6-sol")).toBeGreaterThan(buildReleaseDate("gpt-5.6-sol"));
    expect(buildReleaseDate("google/gemini-4-argon")).toBeGreaterThan(
      buildReleaseDate("google/gemini-3.8-flash")
    );
    expect(buildReleaseDate("deepseek/deepseek-v4.1-flash")).toBeGreaterThan(
      buildReleaseDate("deepseek/deepseek-v4-flash")
    );
  });

  test("is deterministic for models without a version", () => {
    expect(buildReleaseDate("stealth/cat-jam:free")).toBe(buildReleaseDate("stealth/cat-jam:free"));
  });
});

describe("free tier detection", () => {
  test("covers every id shape seen in the catalog", () => {
    expect(isFreeModel({ id: "stealth/glyph-cluster:free", name: "Glyph Cluster" })).toBe(true);
    expect(isFreeModel({ id: "stealth/cat-jam:free", name: "Cat Jam" })).toBe(true);
    expect(isFreeModel({ id: "reflection/beam:free", name: "Beam 1.0" })).toBe(true);
    expect(isFreeModel({ id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1" })).toBe(true);
    expect(isFreeModel({ id: "minimax/minimax-m3.1-flash-preview:free", name: "x" })).toBe(true);
  });

  test("does not flag paid models", () => {
    expect(isFreeModel({ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" })).toBe(false);
    expect(isFreeModel({ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" })).toBe(false);
  });

  test("the free cost entry has zeroed input and a non-empty array", () => {
    const cost = freeCostEntry();
    expect(cost.input).toBe(0);
    expect(cost.output).toBe(0);
    // The picker only grants the Free badge when the cost array is not empty.
    expect(Object.keys(cost).length).toBeGreaterThan(0);
  });
});
