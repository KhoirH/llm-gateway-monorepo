import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { reserveTokens } from "../src/quota.js";
import { createTestPool, dbReady, ensureMigrated, seedTenant, tokensUsed, truncateAll } from "./helpers/db.js";

describe("50 parallel reserves never exceed quota", () => {
  let pool: Pool;
  let available: boolean;

  beforeAll(async () => {
    pool = createTestPool();
    available = await dbReady(pool);
    if (!available) return;
    await ensureMigrated(pool);
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("admits only floor(quota/estimate) of 50 concurrent reserves", async (ctx) => {
    if (!available) return ctx.skip();
    await seedTenant(pool, "p1", 1000);
    const N = 50;
    const ESTIMATE = 300;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => reserveTokens(pool, "p1", ESTIMATE)),
    );
    const successes = results.filter((r) => r.status === "fulfilled").length;
    const exhausted = results.filter(
      (r) => r.status === "rejected" && (r.reason as { code?: string }).code === "quota_exhausted",
    ).length;
    const otherFailures = results.filter((r) => r.status === "rejected" && (r.reason as { code?: string }).code !== "quota_exhausted").length;
    expect(successes).toBe(Math.floor(1000 / ESTIMATE));
    expect(exhausted).toBe(N - successes);
    expect(otherFailures).toBe(0);
    const used = await tokensUsed(pool, "p1");
    expect(used).toBe(successes * ESTIMATE);
    expect(used).toBeLessThanOrEqual(1000);
  });
});
