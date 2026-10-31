CREATE TABLE IF NOT EXISTS kb_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  intent TEXT NOT NULL,
  embedding vector(768)
);

CREATE INDEX IF NOT EXISTS kb_entries_embedding_idx ON kb_entries USING hnsw (embedding vector_cosine_ops);
