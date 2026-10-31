import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../data");
const kbPath = path.join(DATA_DIR, "kb.json");
const heldoutPath = path.join(DATA_DIR, "heldout.json");

interface KbFile {
  count: number;
  entries: { question: string; answer: string; intent: string }[];
}

interface HeldoutFile {
  in_scope: { question: string; intent: string }[];
  out_of_scope: { question: string; intent: string }[];
}

describe("dataset split integrity", () => {
  const hasData = existsSync(kbPath) && existsSync(heldoutPath);

  it("has zero overlap between KB and held-out questions", (ctx) => {
    if (!hasData) return ctx.skip();
    const kb = JSON.parse(readFileSync(kbPath, "utf8")) as KbFile;
    const heldout = JSON.parse(readFileSync(heldoutPath, "utf8")) as HeldoutFile;
    const kbQuestions = new Set(kb.entries.map((e) => e.question));
    const heldQuestions = [...heldout.in_scope, ...heldout.out_of_scope].map((e) => e.question);
    const overlaps = heldQuestions.filter((q) => kbQuestions.has(q));
    expect(overlaps).toEqual([]);
  });

  it("meets slice sizes: 30 held-out in-scope, 5 out-of-scope, ~600 KB", (ctx) => {
    if (!hasData) return ctx.skip();
    const kb = JSON.parse(readFileSync(kbPath, "utf8")) as KbFile;
    const heldout = JSON.parse(readFileSync(heldoutPath, "utf8")) as HeldoutFile;
    expect(heldout.in_scope).toHaveLength(30);
    expect(heldout.out_of_scope).toHaveLength(5);
    expect(kb.entries.length).toBeGreaterThanOrEqual(500);
    expect(kb.entries.length).toBeLessThanOrEqual(700);
  });

  it("held-out intents are covered by the KB slice (stratification)", (ctx) => {
    if (!hasData) return ctx.skip();
    const kb = JSON.parse(readFileSync(kbPath, "utf8")) as KbFile;
    const heldout = JSON.parse(readFileSync(heldoutPath, "utf8")) as HeldoutFile;
    const kbIntents = new Set(kb.entries.map((e) => e.intent));
    const heldIntents = new Set(heldout.in_scope.map((e) => e.intent));
    const missing = [...heldIntents].filter((i) => !kbIntents.has(i));
    expect(missing).toEqual([]);
  });
});
