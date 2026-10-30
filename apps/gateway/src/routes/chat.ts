import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { Errors, AppError } from "../errors.js";
import { reserveTokens, reconcileQuota } from "../quota.js";
import { writeRequestRow, writeRoutingAttempt, type Usage } from "../metering.js";
import { AdapterError, type BackendAdapter, type ChatRequest } from "../adapters/types.js";
import { route, type RouteStep } from "../routing/route.js";
import type { Env } from "../env.js";
import type { ModelTier } from "../config/models.js";

const chatBodySchema = z.object({
  model: z.string().min(1).optional(),
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().min(1) }))
    .min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(8192).optional(),
  stream: z.boolean().default(false),
});

export type ChatBody = z.infer<typeof chatBodySchema>;

function inputChars(body: ChatBody): number {
  return body.messages.reduce((n, m) => n + m.content.length, 0);
}

function estimatedUsage(body: ChatBody, outChars: number, tier: string, started: number, firstTokenAt: number | null): Usage {
  return {
    inputTokens: Math.ceil(inputChars(body) / 4),
    outputTokens: Math.ceil(outChars / 4),
    usageEstimated: true,
    modelUsed: tier,
    ttftMs: firstTokenAt !== null ? firstTokenAt - started : null,
    latencyMs: Date.now() - started,
  };
}

function mapAdapterError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  if (err instanceof AdapterError) {
    if (err.kind === "timeout") {
      return { status: 504, code: "timeout", message: "Upstream timed out" };
    }
    if (err.kind === "http") {
      if (err.status !== undefined && err.status < 500 && err.status !== 429) {
        return { status: 400, code: "invalid_request", message: err.message };
      }
      return { status: 502, code: "all_backends_failed", message: "Backend request failed" };
    }
    return { status: 502, code: "all_backends_failed", message: "Backend connection failed" };
  }
  return { status: 500, code: "internal", message: "Internal error" };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function isFailFast(err: unknown): boolean {
  return err instanceof AdapterError && err.kind === "http" && err.status !== undefined && err.status < 500 && err.status !== 429;
}

interface AttemptContext {
  pool: Pool;
  env: Env;
  adapters: Record<string, BackendAdapter>;
  auth: { tenantId: string };
  chatReq: ChatRequest;
  clientController: AbortController;
  clientGone: () => boolean;
  totalTimedOut: () => boolean;
  totalTimer: NodeJS.Timeout;
}

export function chatRoutes(app: FastifyInstance, pool: Pool, adapters: Record<string, BackendAdapter>, env: Env) {
  app.post("/v1/chat/completions", { preHandler: requireAuth(pool) }, async (req: FastifyRequest, reply) => {
    const auth = req.auth!;
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw Errors.invalidRequest(detail);
    }
    const body = parsed.data;
    const { chain, steps } = route({
      tenantId: auth.tenantId,
      allowedModels: auth.allowedModels,
      requestedModel: body.model,
      capability: "chat",
    });
    if (chain.some((t) => !adapters[t])) {
      throw Errors.allBackendsFailed(`No backend configured for chain '${chain.join(",")}'`);
    }

    const estimate = Math.ceil(inputChars(body) / 4) + (body.max_tokens ?? 256);
    await reserveTokens(pool, auth.tenantId, estimate);

    reply.hijack();
    const raw = reply.raw;
    const started = Date.now();
    const streaming = body.stream;
    const chatReq: ChatRequest = {
      messages: body.messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    };

    const clientController = new AbortController();
    let clientGone = false;
    let totalTimedOut = false;
    const onClose = () => {
      if (!raw.writableEnded) {
        clientGone = true;
        clientController.abort(new Error("client aborted"));
      }
    };
    const closeTarget = req.raw.socket ?? req.raw;
    closeTarget.on("close", onClose);
    const totalTimer = setTimeout(() => {
      totalTimedOut = true;
      clientController.abort(new Error("total timeout"));
    }, env.TOTAL_TIMEOUT_MS);
    totalTimer.unref?.();

    let headWritten = false;
    let outChars = 0;
    let text = "";
    let reasoning = "";
    let usage: Usage | null = null;
    let firstTokenAt: number | null = null;
    let outcome = "ok";
    let servedTier: string | null = null;
    let midStreamFailure = false;
    let attemptsMade = 0;
    const bufferedAttempts: { attempt: number; backend: string; reason: string; outcome: string; latencyMs: number | null; error: string | null }[] = [];

    const writeHeadOnce = (tier: string, fallbackFired: boolean) => {
      if (headWritten) return;
      headWritten = true;
      raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-request-id": req.id,
        "x-model-used": tier,
        "x-fallback-fired": String(fallbackFired),
      });
    };
    const sse = (obj: unknown) => {
      raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const sendJsonError = (mapped: { status: number; code: string; message: string }) => {
      raw.writeHead(mapped.status, { "content-type": "application/json", "x-request-id": req.id });
      raw.end(JSON.stringify({ error: { code: mapped.code, message: mapped.message, request_id: req.id } }));
    };

    for (let i = 0; i < chain.length; i++) {
      const tier = chain[i];
      const adapter = adapters[tier];
      const fallbackFired = i > 0;
      attemptsMade = i + 1;
      const attemptStart = Date.now();

      const attemptController = new AbortController();
      const onClientAbort = () => attemptController.abort(new Error("client aborted"));
      clientController.signal.addEventListener("abort", onClientAbort, { once: true });
      let ttftFired = false;
      let firstTokenSeen = false;
      const ttftTimer = setTimeout(() => {
        ttftFired = true;
        attemptController.abort(new Error("ttft timeout"));
      }, env.TTFT_TIMEOUT_MS);
      ttftTimer.unref?.();

      const attemptError = (outcome: string, err: unknown) => {
        bufferedAttempts.push({
          attempt: i + 1,
          backend: tier,
          reason: fallbackFired ? "fallback" : "primary",
          outcome,
          latencyMs: Date.now() - attemptStart,
          error: err instanceof Error ? err.message : null,
        });
      };

      try {
        for await (const chunk of adapter.stream(chatReq, { signal: attemptController.signal })) {
          if (chunk.kind === "usage") {
            usage = {
              inputTokens: chunk.inputTokens,
              outputTokens: chunk.outputTokens,
              usageEstimated: chunk.usageEstimated,
              modelUsed: tier,
              ttftMs: firstTokenAt !== null ? firstTokenAt - started : null,
              latencyMs: Date.now() - started,
            };
            continue;
          }
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            clearTimeout(ttftTimer);
          }
          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
          }
          if (chunk.kind === "delta") {
            outChars += chunk.text.length;
            if (streaming) {
              writeHeadOnce(tier, fallbackFired);
              sse({
                id: req.id,
                object: "chat.completion.chunk",
                model: tier,
                choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
              });
            } else {
              text += chunk.text;
            }
          } else {
            if (streaming) {
              writeHeadOnce(tier, fallbackFired);
              sse({
                id: req.id,
                object: "chat.completion.chunk",
                model: tier,
                choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }],
              });
            } else {
              reasoning += chunk.text;
            }
          }
        }
        if (streaming && !headWritten) {
          throw new AdapterError("conn", "backend produced no tokens");
        }
        servedTier = tier;
        outcome = "ok";
        attemptError("ok", null);
        const final = usage ?? estimatedUsage(body, outChars, tier, started, firstTokenAt);
        if (streaming) {
          sse({
            id: req.id,
            object: "chat.completion.chunk",
            model: tier,
            choices: [],
            usage: {
              prompt_tokens: final.inputTokens,
              completion_tokens: final.outputTokens,
              usage_estimated: final.usageEstimated,
            },
          });
          raw.write("data: [DONE]\n\n");
          raw.end();
        } else {
          raw.writeHead(200, {
            "content-type": "application/json",
            "x-request-id": req.id,
            "x-model-used": tier,
            "x-fallback-fired": String(fallbackFired),
          });
          raw.end(
            JSON.stringify({
              id: req.id,
              object: "chat.completion",
              model: tier,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: final.inputTokens,
                completion_tokens: final.outputTokens,
                usage_estimated: final.usageEstimated,
              },
            }),
          );
        }
        break;
      } catch (err) {
        clearTimeout(ttftTimer);
        clientController.signal.removeEventListener("abort", onClientAbort);
        req.log.warn(
          {
            attempt: i + 1,
            backend: tier,
            kind: err instanceof AdapterError ? err.kind : "unknown",
            message: errorMessage(err),
            ttft_fired: ttftFired,
            total_timed_out: totalTimedOut,
            client_gone: clientGone,
          },
          "chat attempt failed",
        );
        if (headWritten) {
          midStreamFailure = !clientGone;
          outcome = clientGone ? "error" : "partial_failure";
          attemptError(clientGone ? "aborted" : "partial_failure", err);
          const mapped = mapAdapterError(err);
          sse({ error: { code: mapped.code, message: errorMessage(err), request_id: req.id, partial: true } });
          try {
            raw.end();
          } catch {}
          break;
        }
        if (isFailFast(err)) {
          outcome = "error";
          attemptError("error", err);
          sendJsonError(mapAdapterError(err));
          break;
        }
        if (totalTimedOut || clientGone || i === chain.length - 1) {
          outcome = "error";
          attemptError("error", err);
          sendJsonError(totalTimedOut ? { status: 504, code: "timeout", message: "Upstream timed out" } : mapAdapterError(err));
          break;
        }
        outcome = "error";
        attemptError("error", err);
      } finally {
        clearTimeout(ttftTimer);
        clientController.signal.removeEventListener("abort", onClientAbort);
      }
    }

    clearTimeout(totalTimer);
    closeTarget.off("close", onClose);

    const finalUsage = usage ?? (headWritten ? estimatedUsage(body, outChars, servedTier ?? chain[0], started, firstTokenAt) : null);
    const actual = finalUsage ? finalUsage.inputTokens + finalUsage.outputTokens : 0;
    try {
      await reconcileQuota(pool, auth.tenantId, estimate, actual);
      const requestId = await writeRequestRow(
        pool,
        { tenantId: auth.tenantId, capability: "chat", fallbackFired: attemptsMade > 1, routeSteps: steps as RouteStep[] },
        finalUsage,
        outcome,
        req.id,
      );
      if (requestId) {
        for (const a of bufferedAttempts) {
          await writeRoutingAttempt(pool, requestId, a);
        }
      }
    } catch {}
  });
}
