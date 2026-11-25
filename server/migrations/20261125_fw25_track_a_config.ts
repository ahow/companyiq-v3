/**
 * Migration: FW25 (Framework 25 — "Physical Climate Resilience and Business
 * Continuity v3.1") Track-A scoring-correctness configuration, written as
 * framework-level DATA.
 *
 * This populates the five nullable framework columns added for Track A (defined in
 * shared/schema.ts, created with ADD COLUMN IF NOT EXISTS in server/db.ts) with
 * FW25's approved values. The CODE that reads these columns is fully generic and
 * FAILS OPEN when a framework does not declare them — this migration is the only
 * place FW25's specific values live, exactly as the governing design rule requires
 * (no company/framework/measure names baked into logic).
 *
 * Columns set on frameworks WHERE id = 25:
 *   - required_for_tracks      = ["physical_climate"]   (JSONB string[])
 *   - per_company_doc_cap      = 50                      (integer)
 *   - recency_window_years     = 4                       (integer)
 *   - subsidiary_domains       = []                      (JSONB; declarable, empty OK)
 *   - related_listed_companies = {"Hyundai Glovis": ["Hyundai Motor Company"]}
 *                                                        (JSONB per-company map)
 *
 * Properties (matching the idempotent convention of the other migrations):
 *   - IDEMPOTENT: a plain UPDATE of fixed values scoped by framework id; re-running
 *     sets the same values again (no-op in effect). Safe to run any number of times.
 *   - SCOPED by framework id (25), never by row ids.
 *   - FRAMEWORK_ID = 25 is DATA identifying which framework to configure — it is not
 *     a branch in scoring logic (precedent: 20260911_p2_std_clauses_fw5.ts uses
 *     FRAMEWORK_ID = 5 the same way).
 *
 * NOTE: the related_listed_companies value uses the per-company MAP shape
 * ({ "<companyName>": ["<relatedListedEntity>", ...] }) so the exclusion is applied
 * only to the named company; the reader (resolvePerCompanyList in
 * server/lib/scoring-fix-flags.ts) also accepts a flat array shape that applies to
 * every company under the framework.
 *
 * Usage (reads DATABASE_URL from the environment, like the other server scripts):
 *   DATABASE_URL=... node --import tsx server/migrations/20261125_fw25_track_a_config.ts
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";

const FRAMEWORK_ID = 25;

const REQUIRED_FOR_TRACKS = ["physical_climate"];
const PER_COMPANY_DOC_CAP = 50;
const RECENCY_WINDOW_YEARS = 4;
// Declarable data — empty is acceptable (no known Hyundai Glovis subsidiary domains
// seeded here). Reader falls back to [] / fail-open when empty.
const SUBSIDIARY_DOMAINS: string[] = [];
// Per-company map: exclusion applies only to the named company. Worked example:
// Hyundai Glovis must NEVER be attributed evidence about the separately-listed
// Hyundai Motor Company (HARD REJECT even on a name-mention).
const RELATED_LISTED_COMPANIES: Record<string, string[]> = {
  "Hyundai Glovis": ["Hyundai Motor Company"],
};

export async function applyFw25TrackAConfig(): Promise<{ rowsUpdated: number }> {
  const res: any = await db.execute(sql`
    UPDATE frameworks
       SET required_for_tracks      = ${JSON.stringify(REQUIRED_FOR_TRACKS)}::jsonb,
           per_company_doc_cap      = ${PER_COMPANY_DOC_CAP},
           recency_window_years     = ${RECENCY_WINDOW_YEARS},
           subsidiary_domains       = ${JSON.stringify(SUBSIDIARY_DOMAINS)}::jsonb,
           related_listed_companies = ${JSON.stringify(RELATED_LISTED_COMPANIES)}::jsonb
     WHERE id = ${FRAMEWORK_ID}
  `);
  return { rowsUpdated: res?.rowCount ?? 0 };
}

// Run standalone: `node --import tsx server/migrations/20261125_fw25_track_a_config.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  applyFw25TrackAConfig()
    .then(({ rowsUpdated }) => {
      console.log(
        `[migration 20261125_fw25_track_a_config] framework_id=${FRAMEWORK_ID} ` +
        `rows updated=${rowsUpdated} ` +
        `(required_for_tracks=${JSON.stringify(REQUIRED_FOR_TRACKS)}, ` +
        `per_company_doc_cap=${PER_COMPANY_DOC_CAP}, ` +
        `recency_window_years=${RECENCY_WINDOW_YEARS}, ` +
        `subsidiary_domains=${JSON.stringify(SUBSIDIARY_DOMAINS)}, ` +
        `related_listed_companies=${JSON.stringify(RELATED_LISTED_COMPANIES)})`
      );
    })
    .catch((err) => {
      console.error("[migration 20261125_fw25_track_a_config] FAILED:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
