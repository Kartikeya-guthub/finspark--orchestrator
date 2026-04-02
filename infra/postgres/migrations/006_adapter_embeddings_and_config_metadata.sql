CREATE TABLE IF NOT EXISTS adapter_embeddings (
  adapter_id UUID PRIMARY KEY REFERENCES adapters(id) ON DELETE CASCADE,
  embedding_model TEXT NOT NULL,
  embedding JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenant_config_versions
ADD COLUMN IF NOT EXISTS source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS generator_model TEXT,
ADD COLUMN IF NOT EXISTS match_results JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_adapter_embeddings_embedding_model ON adapter_embeddings (embedding_model);
