import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { Errors } from "../errors.js";

const idSchema = z.string().uuid();

export function requestRoutes(app: FastifyInstance, pool: Pool) {
  app.get("/v1/requests/:id", { preHandler: requireAuth(pool) }, async (req, reply) => {
    const parsed = idSchema.safeParse((req.params as { id: string }).id);
    if (!parsed.success) {
      throw Errors.invalidRequest("Request id must be a UUID");
    }
    const auth = req.auth!;
    const requestRow = (
      await pool.query("SELECT * FROM requests WHERE id = $1 AND tenant_id = $2", [parsed.data, auth.tenantId])
    ).rows[0];
    if (!requestRow) {
      return reply.status(404).send({
        error: { code: "not_found", message: "Request not found", request_id: req.id },
      });
    }
    const attempts = (
      await pool.query("SELECT attempt, backend, reason, outcome, latency_ms, error, created_at FROM routing_attempts WHERE request_id = $1 ORDER BY attempt", [
        parsed.data,
      ])
    ).rows;
    return { request: requestRow, routing_attempts: attempts };
  });
}
