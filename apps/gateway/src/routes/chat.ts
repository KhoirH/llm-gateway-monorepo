import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { Errors, AppError } from "../errors.js";
import { reserveTokens, reconcileQuota } from "../quota.js";
import { writeRequestRow, type Usage } from "../metering.js";
import { AdapterError, type BackendAdapter, type ChatRequest } from "../adapters/types.js";
import { TOTAL_TIMEOUT_MS, CHARS_PER_TOKEN } from "../config/runtime.js";
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
    inputTokens: Math.ceil(inputChars(body) / CHARS_PER_TOKEN),
    outputTokens: Math.ceil(outChars / CHARS_PER_TOKEN),
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

export function chatRoutes(app: FastifyInstance, pool: Pool, adapters: Record<string, BackendAdapter>) {
  app.post("/v1/chat/completions", { preHandler: requireAuth(pool) }, async (req: FastifyRequest, reply) => {
    const auth = req.auth!;
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw Errors.invalidRequest(detail);
    }
    const body = parsed.data;
    const allowed = auth.allowedModels;
    if (allowed.length === 0) {
      throw Errors.modelNotAllowed("Tenant has no allowed models");
    }
    const tier = body.model ?? allowed[0];
    if (!allowed.includes(tier)) {
      throw Errors.modelNotAllowed(`Model '${tier}' is not allowed for this tenant`);
    }
    const adapter = adapters[tier];
    if (!adapter) {
      throw Errors.allBackendsFailed(`No backend configured for model '${tier}'`);
    }

    const estimate = Math.ceil(inputChars(body) / CHARS_PER_TOKEN) + (body.max_tokens ?? 256);
    await reserveTokens(pool, auth.tenantId, estimate);

    reply.hijack();
    const raw = reply.raw;
    const started = Date.now();
    const controller = new AbortController();
    let clientGone = false;
    let firstTokenAt: number | null = null;
    let headWritten = false;
    let outChars = 0;
    let outcome = "ok";
    let usage: Usage | null = null;

    const onClose = () => {
      if (!raw.writableEnded) {
        clientGone = true;
        controller.abort(new Error("client aborted"));
      }
    };
    const closeTarget = req.raw.socket ?? req.raw;
    closeTarget.on("close", onClose);
    const totalTimer = setTimeout(() => {
      if (!raw.writableEnded) {
        controller.abort(new Error("total timeout"));
      }
    }, TOTAL_TIMEOUT_MS);
    totalTimer.unref?.();

    const writeHeadOnce = () => {
      if (headWritten) return;
      headWritten = true;
      raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-request-id": req.id,
        "x-model-used": tier,
        "x-fallback-fired": "false",
      });
    };
    const sse = (obj: unknown) => {
      raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const chatReq: ChatRequest = {
      messages: body.messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    };
    const streaming = body.stream;
    let text = "";
    let reasoning = "";

    try {
      for await (const chunk of adapter.stream(chatReq, { signal: controller.signal })) {
        if (chunk.kind === "delta") {
          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
          }
          outChars += chunk.text.length;
          if (streaming) {
            writeHeadOnce();
            sse({
              id: req.id,
              object: "chat.completion.chunk",
              model: tier,
              choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
            });
          } else {
            text += chunk.text;
          }
        } else if (chunk.kind === "reasoning") {
          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
          }
          if (streaming) {
            writeHeadOnce();
            sse({
              id: req.id,
              object: "chat.completion.chunk",
              model: tier,
              choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }],
            });
          } else {
            reasoning += chunk.text;
          }
        } else {
          usage = {
            inputTokens: chunk.inputTokens,
            outputTokens: chunk.outputTokens,
            usageEstimated: chunk.usageEstimated,
            modelUsed: tier,
            ttftMs: firstTokenAt !== null ? firstTokenAt - started : null,
            latencyMs: Date.now() - started,
          };
        }
      }
      const final = usage ?? estimatedUsage(body, outChars, tier, started, firstTokenAt);
      if (streaming) {
        if (!headWritten) {
          throw new AdapterError("conn", "backend produced no tokens");
        }
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
          "x-fallback-fired": "false",
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
    } catch (err) {
      req.log.warn(
        {
          kind: err instanceof AdapterError ? err.kind : "unknown",
          message: errorMessage(err),
          client_gone: clientGone,
          streamed: headWritten,
        },
        "chat upstream error",
      );
      if (headWritten) {
        outcome = clientGone ? "error" : "partial_failure";
        if (!clientGone) {
          const mapped = mapAdapterError(err);
          sse({ error: { code: mapped.code, message: errorMessage(err), request_id: req.id, partial: true } });
        }
        try {
          raw.end();
        } catch {}
      } else {
        outcome = "error";
        const mapped = mapAdapterError(err);
        raw.writeHead(mapped.status, { "content-type": "application/json", "x-request-id": req.id });
        raw.end(JSON.stringify({ error: { code: mapped.code, message: mapped.message, request_id: req.id } }));
      }
    } finally {
      clearTimeout(totalTimer);
      closeTarget.off("close", onClose);
      const finalUsage = usage ?? (headWritten ? estimatedUsage(body, outChars, tier, started, firstTokenAt) : null);
      const actual = finalUsage ? finalUsage.inputTokens + finalUsage.outputTokens : 0;
      try {
        await reconcileQuota(pool, auth.tenantId, estimate, actual);
        await writeRequestRow(pool, { tenantId: auth.tenantId, capability: "chat", fallbackFired: false }, finalUsage, outcome);
      } catch {}
    }
  });
}
