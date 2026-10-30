import { createPool } from "../src/db/pool.js";
import { loadEnv } from "../src/env.js";
import { generateApiKey, hashApiKey, keyPrefix } from "../src/auth/keys.js";
import type { Pool } from "pg";
import type { ModelTier } from "../src/config/models.js";

interface SeedTenant {
  id: string;
  name: string;
  allowedModels: ModelTier[];
  dailyTokenQuota: number;
}

const TENANTS: SeedTenant[] = [
  { id: "acme", name: "Acme Inc", allowedModels: ["fast", "strong", "mock"], dailyTokenQuota: 200_000 },
  { id: "globex", name: "Globex Corp", allowedModels: ["fast"], dailyTokenQuota: 500 },
  { id: "chaos", name: "Chaos Labs", allowedModels: ["fast", "strong"], dailyTokenQuota: 200_000 },
];

export async function upsertTenant(pool: Pool, t: SeedTenant): Promise<void> {
  await pool.query(
    `INSERT INTO tenants (id, name, allowed_models, daily_token_quota, tokens_used)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, allowed_models = EXCLUDED.allowed_models, daily_token_quota = EXCLUDED.daily_token_quota`,
    [t.id, t.name, t.allowedModels, t.dailyTokenQuota],
  );
}

export async function createTenantKey(pool: Pool, tenantId: string): Promise<{ key: string; prefix: string }> {
  const key = generateApiKey();
  const hash = hashApiKey(key);
  const prefix = keyPrefix(key);
  await pool.query("UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL", [tenantId]);
  await pool.query("INSERT INTO api_keys (tenant_id, key_hash, prefix) VALUES ($1, $2, $3)", [tenantId, hash, prefix]);
  return { key, prefix };
}

async function main() {
  const env = loadEnv(process.env);
  const pool = createPool(env.DATABASE_URL);
  try {
    for (const t of TENANTS) {
      await upsertTenant(pool, t);
      const { key } = await createTenantKey(pool, t.id);
      console.log(`${t.id}\t${key}`);
    }
    console.log("Seed done. Keys above are shown once; only hashes are stored.");
  } finally {
    await pool.end();
  }
}

main();
