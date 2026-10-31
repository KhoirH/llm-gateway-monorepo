import json
import os
import sys
import urllib.request

import psycopg2

QUERIES = [
    "how do I reset my password",
    "where is my order",
    "I want to cancel my subscription",
    "my payment method was declined",
    "how do I get a refund",
    "I cannot log into my account",
    "do you ship internationally",
    "how do I change my billing address",
    "the app keeps crashing when I open it",
    "I want to speak to a human agent",
]


def embed_one(cfg, text):
    body = json.dumps({"model": cfg["model"], "input": [text], "dimensions": cfg["dim"]}).encode("utf-8")
    req = urllib.request.Request(
        cfg["base_url"].rstrip("/") + "/embeddings",
        data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {cfg['api_key']}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        payload = json.load(res)
    return payload["data"][0]["embedding"]


def main():
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

    conn = psycopg2.connect(database_url)
    try:
        with conn.cursor() as cur:
            for q in QUERIES:
                vec = embed_one(cfg, q)
                literal = "[" + ",".join(repr(x) for x in vec) + "]"
                cur.execute(
                    "SELECT question, answer, intent, 1 - (embedding <=> %s::vector) AS similarity "
                    "FROM kb_entries ORDER BY embedding <=> %s::vector LIMIT 4",
                    (literal, literal),
                )
                rows = cur.fetchall()
                if not rows:
                    print(f"Q: {q}\n   (no rows in kb_entries)", flush=True)
                    continue
                t1, t2 = rows[0], rows[1]
                print(f"Q: {q}", flush=True)
                print(f"   top1 [{t1[2]}] sim={t1[3]:.4f} :: {t1[0][:80]}", flush=True)
                print(f"   top2 [{t2[2]}] sim={t2[3]:.4f} :: {t2[0][:70]}", flush=True)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
