import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { Errors, AppError } from "../errors.js";
import { reserveTokens, reconcileQuota } from "../quota.js";
import { writeRequestRow, writeRoutingAttempt, type Usage } from "../metering.js";
import { retrieve, type RetrievedEntry } from "../retrieval.js";
import { AdapterError, type BackendAdapter, type ChatRequest } from "../adapters/types.js";
import { route, type RouteStep } from "../routing/route.js";
import { MAX_CONSECUTIVE_RETRIES, errorMessage, is4xxFailure, mapAdapterError, shouldRetry } from "../retry.js";
import { estimateCost, type ModelTier } from "../config/models.js";
import { ChunkParser } from "../support/parser.js";
import { computeConfidence } from "../support/confidence.js";
import { buildPrompt, buildRepairSuffix } from "../support/prompts.js";
import {
  CONFIDENCE_THRESHOLD,
  REFUSAL_MESSAGE,
  SUPPORT_MAX_TOKENS,
  SUPPORT_PROMPT_PAD_TOKENS,
  SUPPORT_TOP_K,
} from "../config/support.js";
import type { Env } from "../env.js";

const supportBodySchema = z.object({
  message: z.string().min(1).max(4000),
  model: z.string().min(1).optional(),
});

function buildFullPrompt(message: string, entries: RetrievedEntry[], repair: boolean, promptVersion: "v1" | "v2"): string {
  return repair ? buildPrompt(message, entries, promptVersion) + buildRepairSuffix() : buildPrompt(message, entries, promptVersion);
}

interface AttemptRow {
  attempt: number;
  backend: string;
  reason: string;
  outcome: string;
  latencyMs: number | null;
  error: string | null;
}

export function supportRoutes(app: FastifyInstance, pool: Pool, adapters: Record<string, BackendAdapter>, env: Env) {
  app.post("/v1/capabilities/support/answer", { preHandler: requireAuth(pool) }, async (req: FastifyRequest, reply) => {
    const auth = req.auth!;
    const parsed = supportBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw Errors.invalidRequest(detail);
    }
    const body = parsed.data;
    const embedAdapter = adapters.embed;
    if (!embedAdapter?.embed) {
      throw Errors.allBackendsFailed("No embedding backend configured");
    }

    const estimate = Math.ceil(body.message.length / 4) + SUPPORT_PROMPT_PAD_TOKENS + SUPPORT_MAX_TOKENS;
    await reserveTokens(pool, auth.tenantId, estimate);

    let entries: RetrievedEntry[];
    try {
      entries = await retrieve(pool, embedAdapter, body.message, SUPPORT_TOP_K);
    } catch (err) {
      await reconcileQuota(pool, auth.tenantId, estimate, 0);
      await writeRequestRow(pool, { tenantId: auth.tenantId, capability: "support", routeSteps: [] }, null, "error", req.id);
      const mapped = mapAdapterError(err);
      throw new AppError(mapped.status, mapped.code, `Retrieval failed: ${mapped.message}`);
    }

    const inputTokens = Math.ceil(body.message.length / 4);
    const { chain, steps } = route({
      tenantId: auth.tenantId,
      allowedModels: auth.allowedModels,
      requestedModel: env.SUPPORT_MODEL_OVERRIDE ?? body.model,
      capability: "support",
      retrievalTopSimilarity: entries[0]?.similarity ?? 0,
      inputTokens,
    });
    if (env.SUPPORT_MODEL_OVERRIDE) {
      steps.push({ rule: "model_override", detail: `SUPPORT_MODEL_OVERRIDE=${env.SUPPORT_MODEL_OVERRIDE} (eval configuration)` });
    }
    if (chain.some((t) => !adapters[t])) {
      await reconcileQuota(pool, auth.tenantId, estimate, 0);
      await writeRequestRow(pool, { tenantId: auth.tenantId, capability: "support", routeSteps: steps }, null, "error", req.id);
      throw Errors.allBackendsFailed(`No backend configured for chain '${chain.join(",")}'`);
    }

    reply.hijack();
    const raw = reply.raw;
    const started = Date.now();
    const chatReqFor = (prompt: string): ChatRequest => ({
      messages: [{ role: "user", content: prompt }],
      maxTokens: SUPPORT_MAX_TOKENS,
    });

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
    let preEventsFlushed = false;
    let firstTokenAt: number | null = null;
    let answer = "";
    let servedTier: string | null = null;
    let servedIntent: string | null = null;
    let confidenceValue = 0;
    let confidenceComponents: { topSimilarity: number; intentAgreement: number; selfReported: number } | null = null;
    let outcome = "ok";
    let refused = false;
    let finalUsage: Usage | null = null;
    let attemptsMade = 0;
    const bufferedAttempts: AttemptRow[] = [];

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
    const sse = (event: string, obj: unknown) => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
    };
    const flushPreEvents = (tier: string, fallbackFired: boolean) => {
      if (preEventsFlushed) return;
      preEventsFlushed = true;
      writeHeadOnce(tier, fallbackFired);
      sse("meta", { request_id: req.id, model: tier, fallback_fired: fallbackFired });
      sse("retrieval", {
        entries: entries.map((e) => ({ question: e.question, answer: e.answer, intent: e.intent, similarity: e.similarity })),
      });
    };
    const sendJsonError = (mapped: { status: number; code: string; message: string }) => {
      raw.writeHead(mapped.status, { "content-type": "application/json", "x-request-id": req.id });
      raw.end(JSON.stringify({ error: { code: mapped.code, message: mapped.message, request_id: req.id } }));
    };
    const sendSseError = (code: string, message: string, partial: boolean) => {
      flushPreEvents(servedTier ?? chain[0], attemptsMade > 1);
      sse("error", { code, message, request_id: req.id, partial });
      try {
        raw.end();
      } catch {}
    };
    const sendFinal = (refusedFlag: boolean) => {
      sse("final", {
        answer: refusedFlag ? "" : answer,
        intent: servedIntent,
        confidence: confidenceValue,
        confidence_components: confidenceComponents,
        entries: entries.map((e) => ({ question: e.question, intent: e.intent, similarity: e.similarity })),
        refused: refusedFlag,
        ...(refusedFlag ? { refusal_message: REFUSAL_MESSAGE } : {}),
        usage: finalUsage
          ? {
              input_tokens: finalUsage.inputTokens,
              output_tokens: finalUsage.outputTokens,
              usage_estimated: finalUsage.usageEstimated,
              estimated_cost: estimateCost(finalUsage.modelUsed as ModelTier, finalUsage.inputTokens, finalUsage.outputTokens),
            }
          : null,
        latency_ms: Date.now() - started,
      });
      raw.end();
    };

    const maxAttempts = Math.max(chain.length, MAX_CONSECUTIVE_RETRIES);
    let consecutiveFailures = 0;
    attemptLoop: for (let i = 0; i < maxAttempts; i++) {
      const tier = chain[i % chain.length];
      const adapter = adapters[tier];
      const fallbackFired = i > 0;
      attemptsMade = i + 1;
      const attemptStart = Date.now();
      let repair = false;

      const attemptController = new AbortController();
      const onClientAbort = () => attemptController.abort(new Error("client aborted"));
      clientController.signal.addEventListener("abort", onClientAbort, { once: true });
      let ttftFired = false;
      const ttftTimer = setTimeout(() => {
        ttftFired = true;
        attemptController.abort(new Error("ttft timeout"));
      }, env.TTFT_TIMEOUT_MS);
      ttftTimer.unref?.();

      const attemptError = (rowOutcome: string, err: unknown) => {
        bufferedAttempts.push({
          attempt: i + 1,
          backend: tier,
          reason: i >= chain.length ? "retry" : fallbackFired ? "fallback" : repair ? "repair" : "primary",
          outcome: rowOutcome,
          latencyMs: Date.now() - attemptStart,
          error: err instanceof Error ? err.message : null,
        });
      };

      try {
        for (;;) {
          const parser = new ChunkParser();
          let attemptUsage: Usage | null = null;
          let anyToken = false;
          let lowConfidence = false;

          try {
            for await (const chunk of adapter.stream(chatReqFor(buildFullPrompt(body.message, entries, repair, env.SUPPORT_PROMPT_VERSION)), {
              signal: attemptController.signal,
            })) {
              if (chunk.kind === "usage") {
                attemptUsage = {
                  inputTokens: chunk.inputTokens,
                  outputTokens: chunk.outputTokens,
                  usageEstimated: chunk.usageEstimated,
                  modelUsed: tier,
                  ttftMs: firstTokenAt !== null ? firstTokenAt - started : null,
                  latencyMs: Date.now() - started,
                };
                continue;
              }
              if (!anyToken) {
                anyToken = true;
                clearTimeout(ttftTimer);
              }
              if (firstTokenAt === null) {
                firstTokenAt = Date.now();
              }
              if (chunk.kind === "reasoning") {
                continue;
              }
              flushPreEvents(tier, fallbackFired);
              const push = parser.push(chunk.text);
              if (push.badHeader) {
                break;
              }
              if (push.header && confidenceComponents === null && !lowConfidence && servedIntent === null) {
                const conf = computeConfidence(
                  entries[0]?.similarity ?? 0,
                  push.header.intent,
                  entries.map((e) => e.intent),
                  push.header.confidence,
                );
                confidenceValue = conf.value;
                confidenceComponents = conf.components;
                if (conf.value < CONFIDENCE_THRESHOLD) {
                  lowConfidence = true;
                }
              }
              if (lowConfidence) {
                servedTier = tier;
                servedIntent = parser.header!.intent;
                refused = true;
                outcome = "refused";
                attemptError("aborted", null);
                attemptController.abort(new Error("low confidence refusal"));
                break;
              }
              for (const d of push.deltas) {
                answer += d;
                sse("delta", { content: d });
              }
            }
          } catch (err) {
            if (lowConfidence) {
              break attemptLoop;
            }
            throw err;
          }

          if (lowConfidence) {
            flushPreEvents(tier, fallbackFired);
            sendFinal(true);
            break attemptLoop;
          }

          if (parser.badHeader || !parser.header) {
            attemptError("bad_output", new Error(parser.badHeader ? "unparsable header" : "stream ended before header"));
            if (!repair) {
              repair = true;
              continue;
            }
            outcome = "bad_output";
            sendSseError("bad_output", "Model produced unusable output", false);
            break attemptLoop;
          }

          servedTier = tier;
          servedIntent = parser.header.intent;
          outcome = "ok";
          attemptError(repair ? "repaired" : "ok", null);
          finalUsage = attemptUsage ?? {
            inputTokens: inputTokens + SUPPORT_PROMPT_PAD_TOKENS,
            outputTokens: Math.ceil(answer.length / 4),
            usageEstimated: true,
            modelUsed: tier,
            ttftMs: firstTokenAt !== null ? firstTokenAt - started : null,
            latencyMs: Date.now() - started,
          };
          sendFinal(false);
          break attemptLoop;
        }
      } catch (err) {
        clearTimeout(ttftTimer);
        clientController.signal.removeEventListener("abort", onClientAbort);
        consecutiveFailures += 1;
        req.log.warn(
          {
            attempt: i + 1,
            backend: tier,
            kind: err instanceof AdapterError ? err.kind : "unknown",
            is_4xx: is4xxFailure(err),
            consecutive_failures: consecutiveFailures,
            message: errorMessage(err),
            ttft_fired: ttftFired,
            total_timed_out: totalTimedOut,
            client_gone: clientGone,
          },
          "support attempt failed",
        );
        if (headWritten && answer.length > 0) {
          outcome = "partial_failure";
          attemptError("partial_failure", err);
          const mapped = mapAdapterError(err);
          sendSseError(mapped.code, errorMessage(err), true);
          break attemptLoop;
        }
        if (totalTimedOut || clientGone) {
          outcome = "error";
          attemptError("error", err);
          sendJsonError(totalTimedOut ? { status: 504, code: "timeout", message: "Upstream timed out" } : mapAdapterError(err));
          break attemptLoop;
        }
        outcome = "error";
        attemptError("error", err);
        if (!shouldRetry(err, consecutiveFailures)) {
          sendJsonError(mapAdapterError(err));
          break attemptLoop;
        }
        continue attemptLoop;
      } finally {
        clearTimeout(ttftTimer);
        clientController.signal.removeEventListener("abort", onClientAbort);
      }
    }

    clearTimeout(totalTimer);
    closeTarget.off("close", onClose);

    const resolvedUsage: Usage | null =
      finalUsage ??
      (headWritten
        ? {
            inputTokens: inputTokens + SUPPORT_PROMPT_PAD_TOKENS,
            outputTokens: Math.ceil(answer.length / 4),
            usageEstimated: true,
            modelUsed: servedTier ?? chain[0],
            ttftMs: firstTokenAt !== null ? firstTokenAt - started : null,
            latencyMs: Date.now() - started,
          }
        : null);
    const actual = resolvedUsage ? resolvedUsage.inputTokens + resolvedUsage.outputTokens : 0;
    try {
      await reconcileQuota(pool, auth.tenantId, estimate, actual);
      const requestId = await writeRequestRow(
        pool,
        { tenantId: auth.tenantId, capability: "support", fallbackFired: attemptsMade > 1, routeSteps: steps as RouteStep[] },
        resolvedUsage,
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
