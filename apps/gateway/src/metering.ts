import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { estimateCost, type ModelTier } from "./config/models.js";
import type { RouteStep } from "./routing/route.js";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  usageEstimated: boolean;
  modelUsed: string;
  ttftMs: number | null;
  latencyMs: number;
}

export interface MeteringParams {
  tenantId: string;
  capability: string;
  fallbackFired?: boolean;
  routeSteps?: RouteStep[];
}

export interface MeteredOutcome {
  outcome: string;
  usage: Usage | null;
}

export async function writeRequestRow(pool: Pool, params: MeteringParams, usage: Usage | null, outcome: string, requestId?: string): Promise<string | null> {
  const id = requestId ?? randomUUID();
  try {
    const cost = usage ? estimateCost(usage.modelUsed as ModelTier, usage.inputTokens, usage.outputTokens) : 0;
    const res = await pool.query<{ id: string }>(
      `INSERT INTO requests
         (id, tenant_id, capability, model_used, input_tokens, output_tokens, usage_estimated, latency_ms, ttft_ms, estimated_cost, outcome, fallback_fired, route_steps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       RETURNING id`,
      [
        id,
        params.tenantId,
        params.capability,
        usage?.modelUsed ?? null,
        usage?.inputTokens ?? 0,
        usage?.outputTokens ?? 0,
        usage?.usageEstimated ?? false,
        usage?.latencyMs ?? null,
        usage?.ttftMs ?? null,
        cost,
        outcome,
        params.fallbackFired ?? false,
        JSON.stringify(params.routeSteps ?? []),
      ],
    );
    return res.rows[0]?.id ?? null;
  } catch (err) {
    return null;
  }
}

export async function writeRoutingAttempt(
  pool: Pool,
  requestId: string,
  attempt: { attempt: number; backend: string; reason: string; outcome: string; latencyMs?: number | null; error?: string | null },
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO routing_attempts (request_id, attempt, backend, reason, outcome, latency_ms, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [requestId, attempt.attempt, attempt.backend, attempt.reason, attempt.outcome, attempt.latencyMs ?? null, attempt.error ?? null],
    );
  } catch (err) {
    void err;
  }
}
