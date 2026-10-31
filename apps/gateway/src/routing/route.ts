import { Errors } from "../errors.js";
import { SUPPORT_FAST_MAX_INPUT_TOKENS, SUPPORT_FAST_SIMILARITY } from "../config/support.js";

export interface RouteInput {
  tenantId: string;
  allowedModels: string[];
  requestedModel?: string;
  capability: "chat" | "support";
  retrievalTopSimilarity?: number;
  inputTokens?: number;
}

export interface RouteStep {
  rule: string;
  detail: string;
}

export interface RoutingConfig {
  chaosTenantIds: string[];
  realTiers: string[];
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  chaosTenantIds: ["chaos"],
  realTiers: ["fast", "strong"],
};

export interface RouteResult {
  chain: string[];
  steps: RouteStep[];
}

export function route(input: RouteInput, cfg: RoutingConfig = DEFAULT_ROUTING_CONFIG): RouteResult {
  const steps: RouteStep[] = [];
  const allowed = input.allowedModels;
  if (allowed.length === 0) {
    throw Errors.modelNotAllowed("Tenant has no allowed models");
  }
  if (input.requestedModel && !allowed.includes(input.requestedModel)) {
    throw Errors.modelNotAllowed(`Model '${input.requestedModel}' is not allowed for this tenant`);
  }
  const primary =
    input.requestedModel ??
    (input.capability === "support"
      ? (input.retrievalTopSimilarity ?? 0) >= SUPPORT_FAST_SIMILARITY && (input.inputTokens ?? 0) < SUPPORT_FAST_MAX_INPUT_TOKENS
        ? "fast"
        : "strong"
      : allowed[0]);
  steps.push({
    rule: "tenant_policy",
    detail: `allowed=[${allowed.join(",")}] requested=${input.requestedModel ?? "(default)"} -> primary=${primary}`,
  });
  if (input.capability === "support" && !input.requestedModel) {
    steps.push({
      rule: "tier_selection",
      detail: `top1=${(input.retrievalTopSimilarity ?? 0).toFixed(3)} input_tokens=${input.inputTokens ?? 0} -> ${primary}`,
    });
  }

  const chain: string[] = [primary];
  if (cfg.chaosTenantIds.includes(input.tenantId) && primary !== "mock") {
    chain.unshift("mock");
    steps.push({ rule: "chaos_primary", detail: `tenant '${input.tenantId}' routes mock first to exercise fallback` });
  }
  const others = cfg.realTiers.filter((t) => !chain.includes(t) && allowed.includes(t));
  chain.push(...others);
  steps.push({ rule: "fallback_chain", detail: chain.join(" -> ") });

  return { chain, steps };
}
