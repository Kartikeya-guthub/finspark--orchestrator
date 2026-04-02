ALTER TABLE documents
ADD COLUMN IF NOT EXISTS structured_content JSONB;
