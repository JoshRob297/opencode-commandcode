/**
 * Live integration tests. They hit the real Command Code API and consume a tiny
 * amount of quota, so they are opt-in:
 *
 *   COMMANDCODE_LIVE_TESTS=1 bun test tests/live.test.ts
 */
import { describe, expect, test } from "bun:test";
import { fetchDiscoveredModels, fetchQuotaData, readCachedModels } from "../src/client/api.ts";
import { formatQuotaReport } from "../src/tools/quota.ts";

const LIVE = process.env.COMMANDCODE_LIVE_TESTS === "1";

describe("live API (opt-in)", () => {
  test("catalog cache is readable offline", () => {
    const cached = readCachedModels();
    expect(Array.isArray(cached)).toBe(true);
  });

  test.if(LIVE)("fetches the model catalog from the live API", async () => {
    const models = await fetchDiscoveredModels({ forceRefresh: true, timeoutMs: 15000 });
    expect(models.length).toBeGreaterThan(50);
    expect(models.every((m) => typeof m.id === "string")).toBe(true);
  });

  test.if(LIVE)("fetches quota data from the live API", async () => {
    const quota = await fetchQuotaData({ timeoutMs: 15000 });
    expect(typeof quota.user).toBe("string");
    expect(quota.monthlyRemaining).toBeGreaterThanOrEqual(0);
  });

  test.if(LIVE)("renders a quota report", async () => {
    const quota = await fetchQuotaData({ timeoutMs: 15000 });
    const report = formatQuotaReport(quota);
    expect(report).toContain("COMMAND CODE QUOTA & USAGE");
    expect(report).toContain("VENTANAS DE RITMO");
  });

  test("timeouts are enforced instead of hanging", async () => {
    const started = Date.now();
    const result = await fetchDiscoveredModels({ forceRefresh: true, timeoutMs: 1 }).catch(() => []);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(Array.isArray(result)).toBe(true);
  });
});
