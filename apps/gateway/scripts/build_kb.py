import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

import psycopg2

BATCH_SIZE = 32
RETRIES = 4


def embed_request(base_url, api_key, model, dim, texts):
    body = json.dumps({"model": model, "input": texts, "dimensions": dim}).encode("utf-8")
    req = urllib.request.Request(
        base_url.rstrip("/") + "/embeddings",
        data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        payload = json.load(res)
    data = payload.get("data") or []
    vectors = [d.get("embedding") for d in data]
    if len(vectors) != len(texts) or any(v is None for v in vectors):
        raise RuntimeError(f"embedding count mismatch: got {len(vectors)}, expected {len(texts)}")
    for v in vectors:
        if len(v) != dim:
            raise RuntimeError(f"embedding dimension mismatch: got {len(v)}, expected {dim}. Adjust EMBED_DIM.")
    return vectors


def embed_with_backoff(cfg, texts):
    last_err = None
    for attempt in range(1, RETRIES + 1):
        try:
            return embed_request(cfg["base_url"], cfg["api_key"], cfg["model"], cfg["dim"], texts)
        except urllib.error.HTTPError as e:
            last_err = e
            retryable = e.code == 429 or e.code >= 500
            if not retryable or attempt == RETRIES:
                raise
            delay = 1.5 * (2 ** (attempt - 1))
            print(f"embed attempt {attempt} failed (http {e.code}); retrying in {delay:.0f}s", flush=True)
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, ConnectionError, RuntimeError) as e:
            last_err = e
            if attempt == RETRIES:
                raise
            delay = 1.5 * (2 ** (attempt - 1))
            print(f"embed attempt {attempt} failed ({e}); retrying in {delay:.0f}s", flush=True)
            time.sleep(delay)
    raise last_err


def main():
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "/data"

    cfg = {
        "base_url": os.environ.get("EMBED_BASE_URL", "").strip(),
        "api_key": os.environ.get("EMBED_API_KEY", "").strip(),
        "model": os.environ.get("EMBED_MODEL", "").strip(),
        "dim": int(os.environ.get("EMBED_DIM", "768")),
    }
    if not cfg["base_url"] or not cfg["api_key"] or not cfg["model"]:
        raise SystemExit("EMBED_BASE_URL, EMBED_API_KEY and EMBED_MODEL must be set (see .env.example)")

    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise SystemExit("DATABASE_URL must be set")

    with open(os.path.join(data_dir, "kb.json"), encoding="utf-8") as f:
        entries = json.load(f)["entries"]
    print(f"KB entries: {len(entries)}; embed model={cfg['model']} dim={cfg['dim']}", flush=True)

    cache_path = os.path.join(data_dir, "embeddings-cache.json")
    cache = {}
    if os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)

    def cache_key(text):
        return hashlib.sha256(f"{cfg['model']}:{cfg['dim']}:{text}".encode("utf-8")).hexdigest()

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
                embeddings = embed_with_backoff(cfg, [m[1] for m in missing])
                api_calls += 1
                for (j, text), vec in zip(missing, embeddings):
                    vectors[j] = vec
                    cache[cache_key(text)] = vec
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
