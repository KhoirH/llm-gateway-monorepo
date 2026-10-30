import { describe, expect, it } from "vitest";
import { route, DEFAULT_ROUTING_CONFIG } from "../src/routing/route.js";
import { AppError } from "../src/errors.js";

describe("route() rules", () => {
  it("tenant policy: requested model in allowlist becomes primary", () => {
    const { chain } = route({ tenantId: "acme", allowedModels: ["fast", "strong"], requestedModel: "strong" });
    expect(chain).toEqual(["strong", "fast"]);
  });

  it("tenant policy: no requested model defaults to first allowed", () => {
    const { chain } = route({ tenantId: "acme", allowedModels: ["strong", "fast"] });
    expect(chain).toEqual(["strong", "fast"]);
  });

  it("tenant policy: empty allowlist is rejected with 403 model_not_allowed", () => {
    expect(() => route({ tenantId: "nofix", allowedModels: [] })).toThrowError(AppError);
    try {
      route({ tenantId: "nofix", allowedModels: [] });
    } catch (err) {
      expect((err as AppError).status).toBe(403);
      expect((err as AppError).code).toBe("model_not_allowed");
    }
  });

  it("tenant policy: requested model outside allowlist is rejected with 403", () => {
    try {
      route({ tenantId: "globex", allowedModels: ["fast"], requestedModel: "strong" });
    } catch (err) {
      expect((err as AppError).code).toBe("model_not_allowed");
    }
    expect.assertions(1);
  });

  it("fallback chain: primary then the other real model", () => {
    const a = route({ tenantId: "acme", allowedModels: ["fast", "strong"], requestedModel: "fast" });
    expect(a.chain).toEqual(["fast", "strong"]);
    const b = route({ tenantId: "acme", allowedModels: ["fast", "strong"], requestedModel: "strong" });
    expect(b.chain).toEqual(["strong", "fast"]);
  });

  it("fallback chain: mock primary still falls back to real models", () => {
    const { chain } = route({ tenantId: "sse", allowedModels: ["mock", "fast"], requestedModel: "mock" });
    expect(chain).toEqual(["mock", "fast"]);
  });

  it("chaos rule: mock is routed first for chaos tenants", () => {
    const { chain } = route({ tenantId: "chaos", allowedModels: ["fast", "strong"] });
    expect(chain).toEqual(["mock", "fast", "strong"]);
  });

  it("fallback chain only includes allowed real models", () => {
    const { chain } = route({ tenantId: "globex", allowedModels: ["fast"] });
    expect(chain).toEqual(["fast"]);
  });

  it("records a step per rule", () => {
    const { steps } = route({ tenantId: "chaos", allowedModels: ["fast", "strong"] });
    expect(steps.map((s) => s.rule)).toEqual(["tenant_policy", "chaos_primary", "fallback_chain"]);
    expect(steps.every((s) => s.detail.length > 0)).toBe(true);
    expect(DEFAULT_ROUTING_CONFIG.realTiers).toEqual(["fast", "strong"]);
  });
});
