import { Errors } from "../errors.js";

export interface RouteInput {
  tenantId: string;
  allowedModels: string[];
  requestedModel?: string;
  capability: "chat" | "support";
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
  const primary = input.requestedModel ?? allowed[0];
  steps.push({
    rule: "tenant_policy",
    detail: `allowed=[${allowed.join(",")}] requested=${input.requestedModel ?? "(default)"} -> primary=${primary}`,
  });

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
