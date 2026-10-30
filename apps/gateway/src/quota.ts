import type { Pool } from "pg";
import { Errors } from "./errors.js";

export interface TenantRow {
  id: string;
  name: string;
  allowed_models: string[];
  daily_token_quota: string | number;
  tokens_used: string | number;
}

export async function getTenant(pool: Pool, tenantId: string): Promise<TenantRow | null> {
  const res = await pool.query<TenantRow>("SELECT id, name, allowed_models, daily_token_quota, tokens_used FROM tenants WHERE id = $1", [tenantId]);
  return res.rows[0] ?? null;
}

export interface ReserveResult {
  tokensUsed: number;
}

export async function reserveTokens(pool: Pool, tenantId: string, estimate: number): Promise<ReserveResult> {
  try {
    const res = await pool.query<{ tokens_used: string }>(
      `UPDATE tenants SET tokens_used = tokens_used + $2
       WHERE id = $1 AND tokens_used + $2 <= daily_token_quota
       RETURNING tokens_used`,
      [tenantId, estimate],
    );
    if (res.rowCount === 0) {
      throw Errors.quotaExhausted();
    }
    return { tokensUsed: Number(res.rows[0].tokens_used) };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw Errors.quotaUnavailable(`Quota reserve failed: ${describeDbError(err)}`);
  }
}

export async function reconcileQuota(pool: Pool, tenantId: string, reserved: number, actualTokens: number): Promise<number> {
  try {
    const res = await pool.query<{ tokens_used: string }>(
      `UPDATE tenants SET tokens_used = GREATEST(0, tokens_used + $3 - $2)
       WHERE id = $1
       RETURNING tokens_used`,
      [tenantId, reserved, actualTokens],
    );
    return Number(res.rows[0].tokens_used);
  } catch (err) {
    throw Errors.quotaUnavailable(`Quota reconcile failed: ${describeDbError(err)}`);
  }
}

export async function resetQuota(pool: Pool, tenantId: string): Promise<void> {
  await pool.query("UPDATE tenants SET tokens_used = 0 WHERE id = $1", [tenantId]);
}

function isAppError(err: unknown): boolean {
  return err instanceof Error && err.name === "AppError";
}

function describeDbError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "unknown";
  const message = err instanceof Error ? err.message : String(err);
  return `${code}: ${message}`;
}
