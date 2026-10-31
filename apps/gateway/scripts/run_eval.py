import json
import math
import os
import statistics
import sys
import time
import urllib.request

from openai import OpenAI

HELD_OUT_IN_SCOPE_TARGET = 25
THROTTLE_S = 1.5


def sse_request(url, api_key, message):
    body = json.dumps({"message": message}).encode("utf-8")
    req = urllib.request.Request(
        url.rstrip("/") + "/v1/capabilities/support/answer",
        data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
        method="POST",
    )
    started = time.monotonic()
    events = []
    with urllib.request.urlopen(req, timeout=120) as res:
        event = "message"
        data = ""
        raw = res.read().decode("utf-8", "replace")
    wall_ms = int((time.monotonic() - started) * 1000)
    for line in raw.split("\n"):
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data += line[5:].strip()
        elif line == "" and data:
            try:
                events.append({"event": event, "data": json.loads(data)})
            except json.JSONDecodeError:
                pass
            event = "message"
            data = ""
    if data:
        try:
            events.append({"event": event, "data": json.loads(data)})
        except json.JSONDecodeError:
            pass
    return events, wall_ms


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def percentile(values, p):
    if not values:
        return 0
    ordered = sorted(values)
    k = (len(ordered) - 1) * (p / 100.0)
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return ordered[lo]
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def run_config(label, gateway_url, api_key, in_scope_cases, oos_cases, embed_client, model, dim):
    results = []
    for case, is_oos in [(c, False) for c in in_scope_cases] + [(c, True) for c in oos_cases]:
        events, wall_ms = sse_request(gateway_url, api_key, case["question"])
        final = next((e["data"] for e in events if e["event"] == "final"), None)
        error = next((e["data"] for e in events if e["event"] == "error"), None)
        meta = next((e["data"] for e in events if e["event"] == "meta"), None)
        entry = {
            "question": case["question"],
            "expected_intent": None if is_oos else case.get("intent"),
            "expected_answer": None if is_oos else case.get("answer"),
            "meta_model": meta.get("model") if meta else None,
            "fallback_fired": bool(meta.get("fallback_fired")) if meta else None,
            "refused": bool(final.get("refused")) if final else None,
            "predicted_intent": final.get("intent") if final else None,
            "confidence": final.get("confidence") if final else None,
            "answer": final.get("answer") if final else None,
            "input_tokens": (final.get("usage") or {}).get("input_tokens") if final else None,
            "output_tokens": (final.get("usage") or {}).get("output_tokens") if final else None,
            "estimated_cost": (final.get("usage") or {}).get("estimated_cost") if final else None,
            "latency_ms": final.get("latency_ms") if final else wall_ms,
            "wall_ms": wall_ms,
            "error": error.get("code") if error else None,
        }
        results.append(entry)
        status = "refused" if entry["refused"] else (entry["error"] or (entry["predicted_intent"] or "?"))
        print(f"  [{label}] {case['question'][:48]:<48} -> {status}", flush=True)
        time.sleep(THROTTLE_S)

    in_scope = [r for r in results if r["expected_intent"] is not None]
    oos = [r for r in results if r["expected_intent"] is None]

    answered = [r for r in in_scope if not r["refused"] and not r["error"]]
    correct = [r for r in answered if r["predicted_intent"] == r["expected_intent"]]
    refusals_on_oos = [r for r in oos if r["refused"]]

    reference_embeddings = []
    answer_embeddings = []
    for r in in_scope:
        ref = r.get("expected_answer") or ""
        ans = r.get("answer") or ""
        if ref and ans and not r["refused"]:
            reference_embeddings.append((r, None))
    quality_scores = []
    for r in answered:
        ref = (r.get("expected_answer") or "").strip()
        ans = (r.get("answer") or "").strip()
        if not ref or not ans:
            continue
        try:
            vecs = embed_client.embeddings.create(model=model, input=[ref, ans], dimensions=dim).data
            quality_scores.append(cosine(vecs[0].embedding, vecs[1].embedding))
            time.sleep(0.5)
        except Exception as e:
            print(f"  scoring skipped for one case: {e}", flush=True)

    latencies = [r["latency_ms"] for r in results if r["latency_ms"] is not None]
    total_cost = sum(r["estimated_cost"] or 0 for r in results)
    total_in = sum(r["input_tokens"] or 0 for r in results)
    total_out = sum(r["output_tokens"] or 0 for r in results)

    return {
        "config": label,
        "gateway_url": gateway_url,
        "cases": len(results),
        "in_scope": len(in_scope),
        "out_of_scope": len(oos),
        "answered": len(answered),
        "intent_correct": len(correct),
        "intent_accuracy": round(len(correct) / len(answered), 4) if answered else 0,
        "refusals_on_oos": len(refusals_on_oos),
        "refusal_precision": round(len(refusals_on_oos) / len(oos), 4) if oos else 0,
        "answer_quality_cosine_mean": round(statistics.mean(quality_scores), 4) if quality_scores else None,
        "answer_quality_n": len(quality_scores),
        "latency_p50_ms": int(percentile(latencies, 50)),
        "latency_p95_ms": int(percentile(latencies, 95)),
        "total_input_tokens": total_in,
        "total_output_tokens": total_out,
        "total_estimated_cost": round(total_cost, 6),
        "estimated_cost_per_100_requests": round(total_cost / len(results) * 100, 6) if results else 0,
        "fallback_fired_count": sum(1 for r in results if r["fallback_fired"]),
        "results": results,
    }


def main():
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "/data"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "/out/eval-results"

    gateway_a = os.environ.get("GATEWAY_A_URL", "http://gateway-a:3000")
    gateway_b = os.environ.get("GATEWAY_B_URL", "http://gateway-b:3000")
    api_key = os.environ.get("GATEWAY_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("GATEWAY_API_KEY must be set")
    embed_base = os.environ.get("EMBED_BASE_URL", "").strip()
    embed_key = os.environ.get("EMBED_API_KEY", "").strip()
    embed_model = os.environ.get("EMBED_MODEL", "gemini-embedding-001")
    embed_dim = int(os.environ.get("EMBED_DIM", "768"))
    embed_client = OpenAI(base_url=embed_base, api_key=embed_key, timeout=60.0, max_retries=5)

    with open(os.path.join(data_dir, "heldout.json"), encoding="utf-8") as f:
        heldout = json.load(f)

    in_scope = heldout["in_scope"][:HELD_OUT_IN_SCOPE_TARGET]
    oos = heldout["out_of_scope"]
    print(f"Eval: {len(in_scope)} in-scope + {len(oos)} out-of-scope cases per config", flush=True)

    config_a = run_config("A (prompt v1 + fast)", gateway_a, api_key, in_scope, oos, embed_client, embed_model, embed_dim)
    config_b = run_config("B (prompt v2 few-shot + strong)", gateway_b, api_key, in_scope, oos, embed_client, embed_model, embed_dim)

    os.makedirs(out_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    with open(os.path.join(out_dir, f"eval-{stamp}.json"), "w", encoding="utf-8") as f:
        json.dump({"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "A": config_a, "B": config_b}, f, indent=2, ensure_ascii=False)

    def row(metric, fmt):
        return f"| {metric} | {fmt.format(**config_a) if isinstance(fmt, str) else fmt(config_a)} | {fmt.format(**config_b) if isinstance(fmt, str) else fmt(config_b)} |"

    lines = [
        "# Evaluation report — Config A vs Config B",
        "",
        f"Generated: {time.strftime('%Y-%m-%dT%H:%M:%SZ')} | Cases per config: {len(in_scope)} in-scope + {len(oos)} out-of-scope (held-out, zero overlap with KB).",
        "",
        "| Metric | Config A (prompt v1 + fast) | Config B (prompt v2 few-shot + strong) |",
        "|---|---|---|",
        f"| Intent accuracy (answered cases) | {config_a['intent_correct']}/{config_a['answered']} = {config_a['intent_accuracy']:.1%} | {config_b['intent_correct']}/{config_b['answered']} = {config_b['intent_accuracy']:.1%} |",
        f"| Refusal precision (out-of-scope) | {config_a['refusals_on_oos']}/{config_a['out_of_scope']} = {config_a['refusal_precision']:.1%} | {config_b['refusals_on_oos']}/{config_b['out_of_scope']} = {config_b['refusal_precision']:.1%} |",
        f"| Answer quality (cosine to reference, mean over n) | {config_a['answer_quality_cosine_mean']} (n={config_a['answer_quality_n']}) | {config_b['answer_quality_cosine_mean']} (n={config_b['answer_quality_n']}) |",
        f"| Latency p50 / p95 (ms) | {config_a['latency_p50_ms']} / {config_a['latency_p95_ms']} | {config_b['latency_p50_ms']} / {config_b['latency_p95_ms']} |",
        f"| Tokens total (in / out) | {config_a['total_input_tokens']} / {config_a['total_output_tokens']} | {config_b['total_input_tokens']} / {config_b['total_output_tokens']} |",
        f"| Estimated cost per 100 requests | ${config_a['estimated_cost_per_100_requests']:.4f} | ${config_b['estimated_cost_per_100_requests']:.4f} |",
        f"| Fallback fired | {config_a['fallback_fired_count']}x | {config_b['fallback_fired_count']}x |",
        "",
        "## Caveats",
        "",
        "- With ~25 in-scope cases the differences are noisy; treat them as directional, not significant. Counts are shown alongside percentages for that reason.",
        "- Answer quality = embedding cosine similarity between the generated answer and the reference answer (no LLM judge).",
        "- Estimated cost uses list prices from `config/models.ts`, even though free tiers were used.",
        f"- Config A served by: {config_a['gateway_url']}; Config B: {config_b['gateway_url']}. Throttled {THROTTLE_S}s between requests.",
        "",
        "## What more time would buy",
        "",
        "- More held-out cases per intent, an LLM-as-judge (different model from the generator, with stated bias), and multiple seeds per configuration.",
    ]
    with open(os.path.join(out_dir, f"eval-report-{stamp}.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print("\n=== SUMMARY ===", flush=True)
    for cfg in (config_a, config_b):
        print(
            f"{cfg['config']}: intent {cfg['intent_correct']}/{cfg['answered']} ({cfg['intent_accuracy']:.1%}), "
            f"refusal precision {cfg['refusal_precision']:.1%}, quality {cfg['answer_quality_cosine_mean']}, "
            f"p50 {cfg['latency_p50_ms']}ms, cost/100 ${cfg['estimated_cost_per_100_requests']:.4f}",
            flush=True,
        )
    print(f"Wrote {out_dir}/eval-{stamp}.json and eval-report-{stamp}.md", flush=True)


if __name__ == "__main__":
    main()
