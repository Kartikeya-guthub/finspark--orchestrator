-- Fix simulation_runs mode CHECK to accept all simulator mode values
ALTER TABLE simulation_runs
  DROP CONSTRAINT IF EXISTS simulation_runs_mode_check;

ALTER TABLE simulation_runs
  ADD CONSTRAINT simulation_runs_mode_check
  CHECK (mode IN ('schema', 'dryrun', 'mock', 'schema_validation', 'dry_run'));