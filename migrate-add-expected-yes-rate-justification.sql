-- Issue 4 — expected_yes_rate_justification (the single ADD COLUMN across the
-- builder-hardening fixes).
--
-- Captures the base-rate reasoning behind a measure's expected_yes_rate so an
-- extreme calibration (<0.10 or >0.80) is reviewable and regression-checkable
-- instead of reading as unjustified. Nullable and backward-compatible: existing
-- rows read NULL, and no existing column is dropped or renamed.
--
-- Idempotent: safe to run repeatedly. Also applied automatically by
-- `pnpm db:push` (drizzle-kit diffs shared/schema.ts); this file is the explicit,
-- reviewable plain-SQL form for environments that apply SQL migrations directly.

ALTER TABLE framework_measures
  ADD COLUMN IF NOT EXISTS expected_yes_rate_justification text;
