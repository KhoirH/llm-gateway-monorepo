import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { requireAuth } from "../auth/middleware.js";

export function usageRoutes(app: FastifyInstance, pool: Pool) {
  app.get("/v1/usage", { preHandler: requireAuth(pool) }, async (req) => {
    const auth = req.auth!;
    const [aggRes, tenantRes] = await Promise.all([
      pool.query<{ requests: string; input_tokens: string; output_tokens: string; cost: string }>(
        `SELECT COUNT(*)::text AS requests,
                COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
                COALESCE(SUM(estimated_cost), 0)::text AS cost
         FROM requests WHERE tenant_id = $1`,
        [auth.tenantId],
      ),
      pool.query<{ daily_token_quota: string; tokens_used: string }>(
        `SELECT daily_token_quota::text AS daily_token_quota, tokens_used::text AS tokens_used
         FROM tenants WHERE id = $1`,
        [auth.tenantId],
      ),
    ]);
    const agg = aggRes.rows[0];
    const tenant = tenantRes.rows[0];
    const dailyQuota = Number(tenant.daily_token_quota);
    const tokensUsed = Number(tenant.tokens_used);
    return {
      tenant_id: auth.tenantId,
      tenant_name: auth.tenantName,
      requests: Number(agg.requests),
      input_tokens: Number(agg.input_tokens),
      output_tokens: Number(agg.output_tokens),
      estimated_cost: Number(agg.cost),
      quota: {
        daily_token_quota: dailyQuota,
        tokens_used: tokensUsed,
        remaining: Math.max(0, dailyQuota - tokensUsed),
      },
    };
  });
}
