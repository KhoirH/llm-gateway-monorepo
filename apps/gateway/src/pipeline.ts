import type { Pool } from "pg";
import { reserveTokens, reconcileQuota } from "./quota.js";
import { writeRequestRow, type Usage } from "./metering.js";
import type { ModelTier } from "./config/models.js";

export interface MeteredCallParams {
  tenantId: string;
  capability: string;
  tier: ModelTier;
  estimateTokens: number;
}

export interface MeteredCallResult<T> {
  value: T;
  usage: Usage;
  requestId: string | null;
}

export async function runMetered<T>(
  pool: Pool,
  params: MeteredCallParams,
  callModel: () => Promise<{ value: T; usage: Usage }>,
): Promise<MeteredCallResult<T>> {
  await reserveTokens(pool, params.tenantId, params.estimateTokens);

  let value: T;
  let usage: Usage;
  let outcome = "ok";
  try {
    const res = await callModel();
    value = res.value;
    usage = res.usage;
    const actual = usage.inputTokens + usage.outputTokens;
    await reconcileQuota(pool, params.tenantId, params.estimateTokens, actual);
  } catch (err) {
    outcome = "error";
    try {
      await reconcileQuota(pool, params.tenantId, params.estimateTokens, 0);
    } catch {}
    const requestId = await writeRequestRow(pool, params, null, outcome);
    throw new MeteredFailure(err, requestId);
  }
  const requestId = await writeRequestRow(pool, params, usage, outcome);
  return { value, usage, requestId };
}

export class MeteredFailure extends Error {
  constructor(
    public original: unknown,
    public requestId: string | null,
  ) {
    super("Model call failed");
    this.name = "MeteredFailure";
  }
}
