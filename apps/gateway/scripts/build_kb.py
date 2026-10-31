import hashlib
import json
import os
import sys
import time

import psycopg2
from openai import OpenAI

BATCH_SIZE = 64
BATCH_DELAY_S = 6


def main():
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "/data"

    base_url = os.environ.get("EMBED_BASE_URL", "").strip()
    api_key = os.environ.get("EMBED_API_KEY", "").strip()
    model = os.environ.get("EMBED_MODEL", "").strip()
    dim = int(os.environ.get("EMBED_DIM", "768"))
    if not base_url or not api_key or not model:
        raise SystemExit("EMBED_BASE_URL, EMBED_API_KEY and EMBED_MODEL must be set (see .env.example)")
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise SystemExit("DATABASE_URL must be set")

    client = OpenAI(base_url=base_url, api_key=api_key, timeout=60.0, max_retries=5)

    with open(os.path.join(data_dir, "kb.json"), encoding="utf-8") as f:
        entries = json.load(f)["entries"]
    print(f"KB entries: {len(entries)}; embed model={model} dim={dim}", flush=True)

    cache_path = os.path.join(data_dir, "embeddings-cache.json")
    cache = {}
    if os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)

    def cache_key(text):
        return hashlib.sha256(f"{model}:{dim}:{text}".encode("utf-8")).hexdigest()

    def embed(texts):
        res = client.embeddings.create(model=model, input=texts, dimensions=dim)
        vectors = [d.embedding for d in res.data]
        if len(vectors) != len(texts):
            raise RuntimeError(f"embedding count mismatch: got {len(vectors)}, expected {len(texts)}")
        for v in vectors:
            if len(v) != dim:
                raise RuntimeError(f"embedding dimension mismatch: got {len(v)}, expected {dim}. Adjust EMBED_DIM.")
        return vectors

    conn = psycopg2.connect(database_url)
    try:
        cache_hits = 0
        api_calls = 0
        inserted = 0
        with conn:
            with conn.cursor() as cur:
                cur.execute("TRUNCATE kb_entries")
        for start in range(0, len(entries), BATCH_SIZE):
            batch = entries[start : start + BATCH_SIZE]
            vectors = [None] * len(batch)
            missing = []
            for j, e in enumerate(batch):
                key = cache_key(e["question"])
                if key in cache:
                    vectors[j] = cache[key]
                    cache_hits += 1
                else:
                    missing.append((j, e["question"]))
            if missing:
                embeddings = embed([m[1] for m in missing])
                api_calls += 1
                for (j, text), vec in zip(missing, embeddings):
                    vectors[j] = vec
                    cache[cache_key(text)] = vec
                time.sleep(BATCH_DELAY_S)
            with conn:
                with conn.cursor() as cur:
                    for e, vec in zip(batch, vectors):
                        cur.execute(
                            "INSERT INTO kb_entries (question, answer, intent, embedding) VALUES (%s, %s, %s, %s::vector)",
                            (e["question"], e["answer"], e["intent"], "[" + ",".join(repr(x) for x in vec) + "]"),
                        )
                        inserted += 1
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(cache, f)
            done = min(start + BATCH_SIZE, len(entries))
            print(f"batch {start // BATCH_SIZE + 1}/{-(-len(entries) // BATCH_SIZE)} inserted (total {done})", flush=True)
        print(f"Done. inserted: {inserted}, cache hits: {cache_hits}, api calls: {api_calls}", flush=True)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
