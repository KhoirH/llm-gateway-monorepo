import type { Pool } from "pg";
import type { BackendAdapter } from "./adapters/types.js";

export interface RetrievedEntry {
  id: string;
  question: string;
  answer: string;
  intent: string;
  similarity: number;
}

export async function retrieve(pool: Pool, embedAdapter: BackendAdapter, query: string, k = 4): Promise<RetrievedEntry[]> {
  if (!embedAdapter.embed) {
    throw new Error("Embedding adapter does not implement embed()");
  }
  const [vec] = await embedAdapter.embed([query]);
  const literal = `[${vec.join(",")}]`;
  const res = await pool.query<RetrievedEntry & { similarity: string }>(
    `SELECT id, question, answer, intent, 1 - (embedding <=> $1::vector) AS similarity
     FROM kb_entries
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [literal, k],
  );
  return res.rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
}
