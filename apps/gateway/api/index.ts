import type { FastifyInstance } from "fastify";
import { loadEnv } from "../src/env.js";
import { createPool } from "../src/db/pool.js";
import { buildApp } from "../src/index.js";

type VercelRequest = Parameters<FastifyInstance["routing"]>[0];
type VercelResponse = Parameters<FastifyInstance["routing"]>[1];

let appPromise: Promise<FastifyInstance> | undefined;

function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      const env = loadEnv();
      const pool = createPool(env.DATABASE_URL);
      const app = buildApp(env, pool);
      await app.ready();
      return app;
    })();
  }
  return appPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const app = await getApp();
  app.routing(req, res);
}