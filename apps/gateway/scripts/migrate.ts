import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadEnv } from "../src/env.js";

const env = loadEnv(process.env);
const pool = createPool(env.DATABASE_URL);
try {
  const applied = await runMigrations(pool);
  console.log(applied.length === 0 ? "Migrations up to date" : `Applied: ${applied.join(", ")}`);
} finally {
  await pool.end();
}
