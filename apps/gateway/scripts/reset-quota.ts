import { createPool } from "../src/db/pool.js";
import { loadEnv } from "../src/env.js";
import { resetQuota } from "../src/quota.js";

async function main() {
  const env = loadEnv(process.env);
  const pool = createPool(env.DATABASE_URL);
  const tenantId = process.argv[2];
  try {
    if (tenantId) {
      await resetQuota(pool, tenantId);
      console.log(`Quota reset for tenant: ${tenantId}`);
    } else {
      await pool.query("UPDATE tenants SET tokens_used = 0");
      console.log("Quota reset for all tenants");
    }
  } finally {
    await pool.end();
  }
}

main();
