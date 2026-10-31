import json
import os
import random
import sys
import time
import urllib.parse
import urllib.request

import duckdb

DATASET_ID = "bitext/Bitext-customer-support-llm-chatbot-training-dataset"
HELD_OUT_TARGET = 30
KB_TARGET = 600

OUT_OF_SCOPE = [
    {"question": "What is the capital of France?", "answer": "", "intent": "out_of_scope"},
    {"question": "Can you write a poem about the sea?", "answer": "", "intent": "out_of_scope"},
    {"question": "Who won the football match last night?", "answer": "", "intent": "out_of_scope"},
    {"question": "How do I bake a chocolate cake?", "answer": "", "intent": "out_of_scope"},
    {"question": "What is the stock price of Apple today?", "answer": "", "intent": "out_of_scope"},
]


def fetch_json(url, retries=5):
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=60) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            last_err = e
            retryable = e.code == 429 or e.code >= 500
            if not retryable or attempt == retries:
                raise
            delay = 1.5 * (2 ** (attempt - 1))
            print(f"fetch failed (http {e.code}); retrying in {delay:.0f}s", flush=True)
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_err = e
            if attempt == retries:
                raise
            delay = 1.5 * (2 ** (attempt - 1))
            print(f"fetch failed ({e}); retrying in {delay:.0f}s", flush=True)
            time.sleep(delay)
    raise last_err


def download_file(url, dest, retries=5):
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=120) as res, open(dest, "wb") as f:
                while True:
                    chunk = res.read(1 << 20)
                    if not chunk:
                        return
                    f.write(chunk)
            return
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == retries:
                raise
            delay = 1.5 * (2 ** (attempt - 1))
            print(f"download failed ({e}); retrying in {delay:.0f}s", flush=True)
            time.sleep(delay)


def fetch_train_parquet_urls():
    payload = fetch_json(
        "https://datasets-server.huggingface.co/parquet?dataset=" + urllib.parse.quote(DATASET_ID, safe="")
    )
    files = payload.get("parquet_files") or []
    urls = [f["url"] for f in files if f.get("split") == "train" and f.get("config") == "default" and f.get("url")]
    if not urls:
        raise RuntimeError("no train parquet files listed by datasets-server")
    return urls


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "/data"
    tmp_dir = "/tmp/hf-parquet"
    os.makedirs(tmp_dir, exist_ok=True)

    print(f"Listing train parquet shards for {DATASET_ID} ...", flush=True)
    urls = fetch_train_parquet_urls()
    print(f"Shards: {len(urls)}", flush=True)

    local_files = []
    for i, url in enumerate(urls):
        dest = os.path.join(tmp_dir, f"train-{i}.parquet")
        print(f"Downloading shard {i + 1}/{len(urls)} ...", flush=True)
        download_file(url, dest)
        local_files.append(dest)

    con = duckdb.connect()
    rows = con.execute(
        "SELECT CAST(instruction AS VARCHAR), CAST(response AS VARCHAR), CAST(intent AS VARCHAR) "
        f"FROM read_parquet([{', '.join(repr(f) for f in local_files)}])"
    ).fetchall()

    seen = set()
    by_intent = {}
    for question, answer, intent in rows:
        question = (question or "").strip()
        answer = (answer or "").strip()
        intent = (intent or "").strip()
        if not question or not answer or not intent or question in seen:
            continue
        seen.add(question)
        by_intent.setdefault(intent, []).append({"question": question, "answer": answer, "intent": intent})
    print(f"Total unique rows: {len(seen)}", flush=True)

    intents = sorted(by_intent.keys())
    print(f"Distinct intents: {len(intents)}", flush=True)

    flattened = []
    for intent in intents:
        chunk = list(by_intent[intent])
        random.Random(len(intent) * 31 + 42).shuffle(chunk)
        flattened.extend(chunk)

    held_out = []
    kb = []
    held_taken = {intent: 0 for intent in intents}
    kb_taken = {intent: 0 for intent in intents}

    progressed = True
    while len(held_out) < HELD_OUT_TARGET and progressed:
        progressed = False
        for intent in intents:
            if len(held_out) >= HELD_OUT_TARGET:
                break
            pool = by_intent[intent]
            taken = held_taken[intent]
            if taken < len(pool):
                held_out.append(pool[taken])
                held_taken[intent] = taken + 1
                progressed = True

    progressed = True
    while len(kb) < KB_TARGET and progressed:
        progressed = False
        for intent in intents:
            if len(kb) >= KB_TARGET:
                break
            pool = by_intent[intent]
            taken = kb_taken[intent] + held_taken[intent]
            if taken < len(pool):
                kb.append(pool[taken])
                kb_taken[intent] = taken + 1
                progressed = True

    kb_questions = {r["question"] for r in kb}
    overlap = [r for r in held_out if r["question"] in kb_questions]
    if overlap:
        raise RuntimeError(f"overlap detected between held-out and KB: {len(overlap)} rows")

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "kb.json"), "w", encoding="utf-8") as f:
        json.dump({"source": DATASET_ID, "count": len(kb), "entries": kb}, f, indent=2, ensure_ascii=False)
    with open(os.path.join(out_dir, "heldout.json"), "w", encoding="utf-8") as f:
        json.dump(
            {"source": DATASET_ID, "in_scope": held_out, "out_of_scope": OUT_OF_SCOPE},
            f,
            indent=2,
            ensure_ascii=False,
        )

    kb_intents = {r["intent"] for r in kb}
    held_intents = {r["intent"] for r in held_out}
    print(f"KB slice: {len(kb)} entries across {len(kb_intents)} intents")
    print(f"Held-out: {len(held_out)} in-scope across {len(held_intents)} intents + {len(OUT_OF_SCOPE)} out-of-scope")
    print(f"Overlap check: {'PASS (zero overlap)' if not overlap else 'FAIL'}")
    print(f"Wrote {os.path.join(out_dir, 'kb.json')} and {os.path.join(out_dir, 'heldout.json')}")


if __name__ == "__main__":
    main()
