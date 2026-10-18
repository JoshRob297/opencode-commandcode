import { describe, expect, test } from "bun:test";
import { applyModelCatalog } from "../src/index.ts";

interface Captured {
  provider: string;
  id: string;
  name: string;
  limit: any;
  capabilities: any;
}

function makeEditor(sink: Captured[]) {
  return {
    update(provider: string, id: string, mutate: (draft: any) => void) {
      const draft: any = {};
      mutate(draft);
      sink.push({ provider, id, name: draft.name, limit: draft.limit, capabilities: draft.capabilities });
    },
  } as any;
}

const FIXTURE = [
  { id: "stealth/glyph-cluster:free", name: "Glyph Cluster", context_length: 256000, supported_endpoints: ["/chat/completions", "/responses"] },
  { id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1", context_length: 256000, supported_endpoints: ["/chat/completions"] },
  { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 200000, supported_endpoints: ["/chat/completions"] },
  { id: "deepseek/deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision", context_length: 128000, supported_endpoints: ["/chat/completions"] },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 1000000, supported_endpoints: ["/messages"] },
];

describe("model catalog transform", () => {
  test("registers only OpenAI-compatible models", () => {
    const sink: Captured[] = [];
    const stats = applyModelCatalog(makeEditor(sink), FIXTURE as any);

    const ids = sink.map((s) => s.id);
    expect(ids).not.toContain("claude-sonnet-5");
    expect(stats.skipped).toBe(1);
    expect(stats.registered).toBe(4);
  });

  test("tags free/promo models with the FREE PROMO badge", () => {
    const sink: Captured[] = [];
    const stats = applyModelCatalog(makeEditor(sink), FIXTURE as any);

    const glyph = sink.find((s) => s.id === "stealth/glyph-cluster:free")!;
    const laguna = sink.find((s) => s.id === "poolside/laguna-s-2.1-free")!;
    const paid = sink.find((s) => s.id === "deepseek/deepseek-v4.1-flash")!;

    expect(glyph.name).toBe("Glyph Cluster [FREE PROMO] (Command Code)");
    expect(laguna.name).toBe("Laguna S 2.1 [FREE PROMO] (Command Code)");
    expect(paid.name).toBe("DeepSeek V4.1 Flash (Command Code)");
    expect(stats.free.length).toBe(2);
  });

  test("always registers under the commandcode provider", () => {
    const sink: Captured[] = [];
    applyModelCatalog(makeEditor(sink), FIXTURE as any);
    expect(sink.every((s) => s.provider === "commandcode")).toBe(true);
  });

  test("keeps the advertised context window and marks vision models", () => {
    const sink: Captured[] = [];
    applyModelCatalog(makeEditor(sink), FIXTURE as any);

    const glyph = sink.find((s) => s.id === "stealth/glyph-cluster:free")!;
    expect(glyph.limit.context).toBe(256000);
    expect(glyph.limit.output).toBeGreaterThan(0);
    expect(glyph.capabilities.tools).toBe(true);

    const vision = sink.find((s) => s.id === "deepseek/deepseek-v4-flash-vision-exp")!;
    expect(vision.capabilities.input).toContain("image");

    const textOnly = sink.find((s) => s.id === "deepseek/deepseek-v4.1-flash")!;
    expect(textOnly.capabilities.input).toEqual(["text"]);
  });

  test("survives a malformed catalog entry", () => {
    const sink: Captured[] = [];
    const stats = applyModelCatalog(makeEditor(sink), [null, { name: "no id" }, ...FIXTURE] as any);
    expect(stats.registered).toBe(4);
  });
});
