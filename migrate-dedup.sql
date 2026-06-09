-- Content Deduplication Migration
-- This script migrates existing inline content from documents table
-- into the deduplicated document_content table.
--
-- Strategy:
-- 1. For each unique URL that has content, insert ONE row into document_content
--    using the SHA-256 hash of the normalized URL as the unique key.
-- 2. Update all documents rows to point to the corresponding document_content row.
-- 3. NULL out the inline content column on migrated rows to free space.
--
-- This is done in batches to avoid locking the entire table.

-- Phase 1: Populate document_content with distinct URL content
-- We use DISTINCT ON (url) to pick one representative content per URL.
-- The most recently fetched version wins (ORDER BY fetched_at DESC NULLS LAST).

BEGIN;

-- Insert distinct content (one per unique URL, picking the longest content version)
INSERT INTO document_content (url_hash, url, content, content_length, created_at, updated_at)
SELECT
  encode(sha256(lower(trim(trailing '/' from trim(url)))::bytea), 'hex') AS url_hash,
  url,
  content,
  length(content) AS content_length,
  NOW(),
  NOW()
FROM (
  SELECT DISTINCT ON (lower(trim(trailing '/' from trim(url))))
    url,
    content
  FROM documents
  WHERE content IS NOT NULL AND content != ''
  ORDER BY lower(trim(trailing '/' from trim(url))), length(content) DESC, fetched_at DESC NULLS LAST
) AS distinct_docs
ON CONFLICT (url_hash) DO NOTHING;

COMMIT;

-- Report what was inserted
SELECT 
  COUNT(*) as content_rows_created,
  pg_size_pretty(SUM(content_length)::bigint) as total_unique_content
FROM document_content;
