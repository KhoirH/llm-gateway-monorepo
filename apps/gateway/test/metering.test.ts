import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMetered, MeteredFailure } from "../src/pipeline.js";
import { createTestPool, dbReady, ensureMigrated, seedTenant, tokensUsed, truncateAll } from "./helpers/db.js";

describe("metering rows on success and failure", () => {
  let pool: Pool;
  let available: boolean;

  beforeAll(async () => {
    pool = createTestPool();
    available = await dbReady(pool);
    if (!available) return;
    await ensureMigrated(pool);
    await truncateAll(pool);
    await seedTenant(pool, "acme", 100_000);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("writes a success row with usage, cost and reconciled quota", async (ctx) => {
    if (!available) return ctx.skip();
    await runMetered(
      pool,
      { tenantId: "acme", capability: "chat", tier: "fast", estimateTokens: 500 },
      async () => ({
        value: "done",
        usage: { inputTokens: 100, outputTokens: 50, usageEstimated: false, modelUsed: "fast", ttftMs: 12, latencyMs: 400 },
      }),
    );
    const row = (await pool.query<Record<string, string>>("SELECT * FROM requests WHERE tenant_id = 'acme'")).rows[0];
    expect(row.outcome).toBe("ok");
    expect(Number(row.input_tokens)).toBe(100);
    expect(Number(row.output_tokens)).toBe(50);
    expect(row.usage_estimated).toBe(false);
    expect(Number(row.ttft_ms)).toBe(12);
    expect(Number(row.latency_ms)).toBe(400);
    expect(Number(row.estimated_cost)).toBeCloseTo(0.000009, 8);
    expect(Number(row.fallback_fired)).toBe(0);
    expect(await tokensUsed(pool, "acme")).toBe(150);
  });

  it("writes an error row with full refund when the model call fails", async (ctx) => {
    if (!available) return ctx.skip();
    await seedTenant(pool, "acme", 100_000);
    await expect(
      runMetered(
        pool,
        { tenantId: "acme", capability: "chat", tier: "fast", estimateTokens: 400 },
        async () => {
          throw new Error("backend exploded");
        },
      ),
    ).rejects.toBeInstanceOf(MeteredFailure);
    const row = (
      await pool.query<Record<string, string>>("SELECT * FROM requests WHERE tenant_id = 'acme' ORDER BY created_at DESC LIMIT 1")
    ).rows[0];
    expect(row.outcome).toBe("error");
    expect(row.model_used).toBeNull();
    expect(await tokensUsed(pool, "acme")).toBe(0);
  });
});
