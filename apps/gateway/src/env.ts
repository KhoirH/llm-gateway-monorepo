import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

function loadDotenv(): void {
  const candidates = [path.resolve(".env"), path.resolve("../../.env")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

const envSchema = z.object({
  GATEWAY_HOST: z.string().default("127.0.0.1"),
  GATEWAY_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default("postgres://gateway:gateway@localhost:5432/gateway"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  FAST_API_KEY: z.string().default(""),
  FAST_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  FAST_MODEL: z.string().default("llama-3.1-8b-instant"),
  STRONG_API_KEY: z.string().default(""),
  STRONG_BASE_URL: z.string().default("https://generativelanguage.googleapis.com/v1beta/openai/"),
  STRONG_MODEL: z.string().default("gemini-2.0-flash"),
  TTFT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  MOCK_FAIL_MODE: z.enum(["error5xx", "429", "hang", "midStream"]).optional(),
  EMBED_BASE_URL: z.string().optional(),
  EMBED_API_KEY: z.string().optional(),
  EMBED_MODEL: z.string().default("gemini-embedding-001"),
  EMBED_DIM: z.coerce.number().int().positive().default(768),
  SUPPORT_PROMPT_VERSION: z.enum(["v1", "v2"]).default("v1"),
  SUPPORT_MODEL_OVERRIDE: z.enum(["fast", "strong"]).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env) {
    loadDotenv();
  }
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
