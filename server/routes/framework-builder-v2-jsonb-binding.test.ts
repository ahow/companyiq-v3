/**
 * Regression test for the "cannot cast type record to text[]" runtime error in
 * the Framework Builder v2 apply-edits path (framework-level additive updates:
 * add_synonyms / add_adjacent_topics / add_anchor_frameworks).
 *
 * Root cause: interpolating a JS string array into a drizzle `sql` template as
 * `unnest(${arr}::text[])` binds the array as an EXPANDED parameter list
 * `($1, $2, $3)`, which Postgres parses as a ROW/record — casting record → text[]
 * throws. The fix binds the array as a SINGLE jsonb text parameter via
 * `jsonb_array_elements_text(${JSON.stringify(arr)}::jsonb)`.
 *
 * These tests assert the query-building behaviour only — no DB connection is
 * needed. They are intentionally generic (no framework/measure/company names).
 *
 * node:test — run with:
 *   DATABASE_URL=... npx tsx --test server/routes/framework-builder-v2-jsonb-binding.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();
const SAMPLE = ["alpha", "beta", "gamma"];

test("fixed pattern binds the array as a single jsonb parameter (no record cast)", () => {
  // Mirror of the additive-append fragment used in framework-builder-v2.ts.
  const frag = sql`SELECT jsonb_array_elements_text(${JSON.stringify(SAMPLE)}::jsonb) AS term`;
  const { sql: text, params } = dialect.sqlToQuery(frag);

  // Exactly one bound parameter — the whole array serialised as a jsonb literal.
  assert.equal(params.length, 1, "expected a single bound parameter");
  assert.equal(params[0], JSON.stringify(SAMPLE));

  // Bound as $1::jsonb and expanded with jsonb_array_elements_text.
  assert.match(text, /\$1::jsonb/);
  assert.match(text, /jsonb_array_elements_text/);

  // The record-cast anti-pattern must NOT appear.
  assert.doesNotMatch(text, /::text\[\]/);
  assert.doesNotMatch(text, /unnest/);
  // No parameter-list expansion like ($1, $2, ...) that Postgres reads as a record.
  assert.doesNotMatch(text, /\(\$1,\s*\$2/);
});

test("legacy unnest(array::text[]) pattern expands to a record (documents the bug)", () => {
  // This is the pattern that caused the runtime error; kept as a guard so the
  // difference in binding is explicit and cannot silently regress.
  const frag = sql`SELECT unnest(${SAMPLE}::text[]) AS term`;
  const { sql: text, params } = dialect.sqlToQuery(frag);

  // The array is expanded into one parameter PER element ...
  assert.equal(params.length, SAMPLE.length);
  // ... and interpolated as a parenthesised list, which Postgres treats as a
  // ROW/record — `(...)::text[]` is the cast that throws at runtime.
  assert.match(text, /\(\$1,\s*\$2,\s*\$3\)::text\[\]/);
});
