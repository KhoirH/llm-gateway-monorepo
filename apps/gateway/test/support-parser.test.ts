import { describe, expect, it } from "vitest";
import { ChunkParser } from "../src/support/parser.js";
import { computeConfidence } from "../src/support/confidence.js";
import { route } from "../src/routing/route.js";

describe("ChunkParser", () => {
  it("parses header, skips separator, streams answer deltas", () => {
    const p = new ChunkParser();
    const r1 = p.push('{"intent": "reset_password", "confidence": 0.9}\n');
    expect(r1.badHeader).toBe(false);
    expect(r1.header).toEqual({ intent: "reset_password", confidence: 0.9 });
    expect(r1.deltas).toEqual([]);
    const r2 = p.push("---\nHere ");
    expect(r2.deltas).toEqual(["Here "]);
    const r3 = p.push("is the answer.");
    expect(r3.deltas).toEqual(["is the answer."]);
  });

  it("buffers until the header line is complete", () => {
    const p = new ChunkParser();
    const r1 = p.push('{"intent": "track_or');
    expect(r1.header).toBeNull();
    expect(r1.deltas).toEqual([]);
    const r2 = p.push('der", "confidence": 0.8}\n---\nAnswer');
    expect(r2.header).toEqual({ intent: "track_order", confidence: 0.8 });
    expect(r2.deltas).toEqual(["Answer"]);
  });

  it("marks bad header on invalid JSON", () => {
    const p = new ChunkParser();
    const r = p.push("not json at all\n---\nanswer");
    expect(r.badHeader).toBe(true);
    expect(r.header).toBeNull();
  });

  it("marks bad header when confidence is out of range", () => {
    const p = new ChunkParser();
    const r = p.push('{"intent": "x", "confidence": 1.7}\n---\nanswer');
    expect(r.badHeader).toBe(true);
  });

  it("tolerates a missing separator (treats the rest as the answer)", () => {
    const p = new ChunkParser();
    const r1 = p.push('{"intent": "x", "confidence": 0.5}\n');
    const r2 = p.push("plain answer without separator\n");
    expect(r2.deltas).toEqual(["plain answer without separator\n"]);
    expect(p.header).toEqual({ intent: "x", confidence: 0.5 });
    void r1;
  });

  it("skips blank lines right after the header", () => {
    const p = new ChunkParser();
    p.push('{"intent": "x", "confidence": 0.5}\n');
    const r = p.push("---\n\nAnswer line\n");
    expect(r.deltas).toEqual(["Answer line\n"]);
  });
});

describe("computeConfidence (fixed weights 0.4/0.3/0.3)", () => {
  it("combines the three components", () => {
    const r = computeConfidence(0.8, "reset_password", ["reset_password", "other", "other", "other"], 1.0);
    expect(r.components.intentAgreement).toBe(0.25);
    expect(r.value).toBeCloseTo(0.4 * 0.8 + 0.3 * 0.25 + 0.3 * 1.0, 8);
  });

  it("agreement is 0 when no entry matches the model intent", () => {
    const r = computeConfidence(0.9, "unknown_intent", ["a", "b"], 0.5);
    expect(r.components.intentAgreement).toBe(0);
    expect(r.value).toBeCloseTo(0.4 * 0.9 + 0.3 * 0 + 0.3 * 0.5, 8);
  });
});

describe("route() support tier selection", () => {
  it("chooses fast when top-1 similarity is high and input is short", () => {
    const { chain, steps } = route({
      tenantId: "sup",
      allowedModels: ["fast", "strong"],
      capability: "support",
      retrievalTopSimilarity: 0.85,
      inputTokens: 50,
    });
    expect(chain[0]).toBe("fast");
    expect(steps.some((s) => s.rule === "tier_selection")).toBe(true);
  });

  it("chooses strong when similarity is below the threshold", () => {
    const { chain } = route({
      tenantId: "sup",
      allowedModels: ["fast", "strong"],
      capability: "support",
      retrievalTopSimilarity: 0.5,
      inputTokens: 50,
    });
    expect(chain[0]).toBe("strong");
  });

  it("chooses strong when the input is long", () => {
    const { chain } = route({
      tenantId: "sup",
      allowedModels: ["fast", "strong"],
      capability: "support",
      retrievalTopSimilarity: 0.95,
      inputTokens: 500,
    });
    expect(chain[0]).toBe("strong");
  });
});
