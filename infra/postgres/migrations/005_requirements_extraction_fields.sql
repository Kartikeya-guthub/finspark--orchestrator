ALTER TABLE requirements
ADD COLUMN IF NOT EXISTS requirement_id TEXT,
ADD COLUMN IF NOT EXISTS provider_hint TEXT,
ADD COLUMN IF NOT EXISTS fields_needed JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS api_action TEXT,
ADD COLUMN IF NOT EXISTS notes TEXT,
ADD COLUMN IF NOT EXISTS extraction_attempt INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_requirements_document_id ON requirements (document_id);
CREATE INDEX IF NOT EXISTS idx_requirements_requirement_id ON requirements (requirement_id);
