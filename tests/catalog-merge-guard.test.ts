import { describe, expect, test } from "bun:test";
import { applyModelCatalog } from "../src/index.ts";

interface Sink {
  updated: Array<{ id: string; enabled?: boolean; name?: string }>;
}

function makeEditor(sink: Sink, existing: Array<{ id: string }> = []) {
  return {
    list: (providerID: string) => (providerID === "commandcode" ? existing : []),
    update: (providerID: string, id: string, mutate: (draft: any) => void) => {
      const draft: any = {};
      mutate(draft);
      sink.updated.push({ id, enabled: draft.enabled, name: draft.name });
    },
  } as any;
}

const CATALOG = [
  { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", supported_endpoints: ["/chat/completions"] },
  { id: "stealth/glyph-cluster:free", name: "Glyph Cluster", supported_endpoints: ["/chat/completions"] },
  // Anthropic-shaped: must never be registered on the OpenAI-compatible transport.
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", supported_endpoints: ["/messages"] },
];

describe("models.dev merge guard", () => {
  test("registers only the curated catalog", () => {
    const sink: Sink = { updated: [] };
    const stats = applyModelCatalog(makeEditor(sink), CATALOG as any);

    expect(stats.registered).toBe(2);
    expect(sink.updated.some((u) => u.id.startsWith("claude"))).toBe(false);
  });

  test("disables foreign models that models.dev merged into the provider", () => {
    const sink: Sink = { updated: [] };
    // models.dev publishes its own `commandcode` provider, which includes the
    // Anthropic-shaped claude models. They arrive through the merge, not through
    // our catalog, and have to be disabled explicitly.
    const merged = [
      { id: "deepseek/deepseek-v4.1-flash" },
      { id: "stealth/glyph-cluster:free" },
      { id: "claude-sonnet-5-5" },
      { id: "claude-opus-5" },
    ];
    const stats = applyModelCatalog(makeEditor(sink, merged), CATALOG as any);

    const disabled = sink.updated.filter((u) => u.enabled === false).map((u) => u.id);
    expect(disabled).toEqual(["claude-sonnet-5-5", "claude-opus-5"]);
    expect(stats.skipped).toBeGreaterThanOrEqual(2);
  });

  test("never disables a curated model", () => {
    const sink: Sink = { updated: [] };
    const merged = [{ id: "deepseek/deepseek-v4.1-flash" }, { id: "claude-opus-5" }];
    applyModelCatalog(makeEditor(sink, merged), CATALOG as any);
    expect(sink.updated.some((u) => u.id === "deepseek/deepseek-v4.1-flash" && u.enabled === false)).toBe(false);
  });

  test("is fail-open when the editor cannot list models", () => {
    const sink: Sink = { updated: [] };
    const editor = {
      update: (providerID: string, id: string, mutate: (draft: any) => void) => {
        const draft: any = {};
        mutate(draft);
        sink.updated.push({ id, enabled: draft.enabled });
      },
    } as any;
    expect(() => applyModelCatalog(editor, CATALOG as any)).not.toThrow();
    expect(sink.updated.length).toBe(2);
  });

  test("is fail-open when list() throws", () => {
    const sink: Sink = { updated: [] };
    const editor = {
      list: () => {
        throw new Error("boom");
      },
      update: (providerID: string, id: string, mutate: (draft: any) => void) => {
        const draft: any = {};
        mutate(draft);
        sink.updated.push({ id, enabled: draft.enabled });
      },
    } as any;
    expect(() => applyModelCatalog(editor, CATALOG as any)).not.toThrow();
    expect(sink.updated.length).toBe(2);
  });
});
