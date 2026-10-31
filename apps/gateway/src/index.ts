import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { loadEnv } from "./env.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { applyErrorHandler } from "./errorHandler.js";
import { healthRoutes } from "./routes/health.js";
import { usageRoutes } from "./routes/usage.js";
import { chatRoutes } from "./routes/chat.js";
import { requestRoutes } from "./routes/requests.js";
import { supportRoutes } from "./routes/support.js";
import { defaultAdapters } from "./adapters/index.js";
import type { BackendAdapter } from "./adapters/types.js";

export function buildApp(
  env = loadEnv(),
  pool = createPool(env.DATABASE_URL),
  loggerOptions?: { stream?: NodeJS.WritableStream },
  adapters: Record<string, BackendAdapter> = defaultAdapters(env),
) {
  const app = Fastify({
    logger: loggerOptions?.stream
      ? { level: env.LOG_LEVEL, stream: loggerOptions.stream, redact: ["req.headers.authorization"] }
      : { level: env.LOG_LEVEL, redact: ["req.headers.authorization"] },
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 1_048_576,
  });

  applyErrorHandler(app);
  app.register(healthRoutes);
  app.register((instance) => usageRoutes(instance, pool));
  app.register((instance) => requestRoutes(instance, pool));
  app.register((instance) => chatRoutes(instance, pool, adapters, env));
  app.register((instance) => supportRoutes(instance, pool, adapters, env));

  return app;
}

async function main() {
  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL);
  const applied = await runMigrations(pool);
  if (applied.length > 0) console.log(`Migrations applied: ${applied.join(", ")}`);
  const app = buildApp(env, pool);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.close().finally(() => pool.end().finally(() => process.exit(0)));
    });
  }

  try {
    await app.listen({ host: env.GATEWAY_HOST, port: env.GATEWAY_PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (!process.env.VERCEL && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}