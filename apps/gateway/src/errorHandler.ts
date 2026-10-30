import type { FastifyError, FastifyInstance } from "fastify";
import { AppError } from "./errors.js";

const errorShape = (code: string, message: string, requestId: string) => ({
  error: { code, message, request_id: requestId },
});

export function applyErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send(errorShape(err.code, err.message, req.id));
    }
    if (err.validation !== undefined) {
      return reply.status(400).send(errorShape("invalid_request", err.message, req.id));
    }
    if (err.statusCode === 404) {
      return reply.status(404).send(errorShape("not_found", "Route not found", req.id));
    }
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(400).send(errorShape("invalid_request", "Malformed request", req.id));
    }
    req.log.error({ err }, "Unhandled error");
    return reply.status(500).send(errorShape("internal", "Internal error", req.id));
  });

  app.setNotFoundHandler((req, reply) => {
    return reply.status(404).send(errorShape("not_found", "Route not found", req.id));
  });
}
