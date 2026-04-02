-- Convert dag_nodes.condition from TEXT to JSONB for proper JSON storage and querying.
-- The column was originally TEXT but always stored JSON-serialized condition arrays.
-- A USING clause handles existing rows: NULL stays NULL, empty string becomes NULL,
-- and invalid legacy JSON is safely coerced to NULL instead of aborting the migration.

CREATE OR REPLACE FUNCTION _tmp_try_parse_jsonb(input_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN input_text::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

ALTER TABLE dag_nodes
  ALTER COLUMN condition TYPE JSONB
  USING CASE
    WHEN condition IS NULL OR btrim(condition) = '' OR lower(btrim(condition)) = 'null' THEN NULL
    ELSE _tmp_try_parse_jsonb(condition)
  END;

DROP FUNCTION _tmp_try_parse_jsonb(TEXT);

COMMENT ON COLUMN dag_nodes.condition IS
  'JSON array of requirement conditions that must be met before this node executes.';
