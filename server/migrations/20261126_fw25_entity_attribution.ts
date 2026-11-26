/**
 * Migration: FW25 (Framework 25 — "Physical Climate Resilience and Business
 * Continuity v3.1") entity-attribution config — Phase A / WS1 DATA.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Track-A migration (20261125_fw25_track_a_config.ts) seeded
 *   related_listed_companies = {"Hyundai Glovis": ["Hyundai Motor Company"]}
 * as entity NAMES only. The exclusion logic at the time matched issuer evidence by
 * web DOMAIN, so a Hyundai Motor Company report served on hyundai.com (e.g.
 * .../hmc-2026-sustainability-report-en.pdf) was never recognised as foreign and was
 * wrongly attributed to Hyundai Glovis (company_id 124, measure U3 scored Yes on
 * HMC's report in batch 2741). The name→domain relationship was never bridged.
 *
 * Phase A / WS1 adds a GENERIC, framework-agnostic entity-attribution exclusion
 * (server/lib/provenance.ts classifyEntityAttribution + the pipeline acceptance
 * gate) that matches a related listed entity by NAME, ALIASES and DOMAINS. This
 * migration upgrades FW25's related_listed_companies value from the names-only shape
 * to the richer DESCRIPTOR shape carrying Hyundai Motor Company's aliases AND
 * domains, so the specific Glovis→HMC leak closes. The matcher stays generic; the
 * company-specific values live ONLY here, in DATA.
 *
 * DESCRIPTOR SHAPE (read by resolvePerCompanyEntities in scoring-fix-flags.ts):
 *   { "<companyName>": [ { name, aliases: string[], domains: string[] }, ... ] }
 * The reader also still accepts the plain names-only array shape, so this change is
 * backward compatible with any framework not migrated.
 *
 * SCOPE / SAFETY
 * --------------
 *   - Updates ONLY related_listed_companies WHERE id = 25. It deliberately does NOT
 *     touch the other Track-A columns (required_for_tracks, per_company_doc_cap,
 *     recency_window_years, subsidiary_domains) set by 20261125 — those keep their
 *     values. parent_entities / subsidiary_entities are left undeclared for FW25
 *     (no known parent/subsidiary relationships to seed) ⇒ fail-open.
 *   - IDEMPOTENT: a plain UPDATE of a fixed value scoped by framework id; re-running
 *     sets the same value again. Safe to run any number of times.
 *   - SCOPED by framework id (25), never by row ids. FRAMEWORK_ID is DATA identifying
 *     which framework to configure, not a branch in scoring logic.
 *
 * Usage (reads DATABASE_URL from the environment, like the other server scripts):
 *   DATABASE_URL=... node --import tsx server/migrations/20261126_fw25_entity_attribution.ts
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";

const FRAMEWORK_ID = 25;

// Per-company map: the exclusion applies only to the named company. Hyundai Glovis
// must NEVER be attributed evidence about the separately-listed Hyundai Motor
// Company. The descriptor carries HMC's aliases AND the domains it publishes on, so
// a report on hyundai.com (or a hmc-* report path) is recognised as foreign even
// when it lands on a shared/ambiguous host.
const RELATED_LISTED_COMPANIES: Record<
  string,
  Array<{ name: string; aliases: string[]; domains: string[] }>
> = {
  "Hyundai Glovis": [
    {
      name: "Hyundai Motor Company",
      aliases: ["Hyundai Motor", "HMC"],
      domains: ["hyundai.com"],
    },
  ],
};

export async function applyFw25EntityAttribution(): Promise<{ rowsUpdated: number }> {
  const res: any = await db.execute(sql`
    UPDATE frameworks
       SET related_listed_companies = ${JSON.stringify(RELATED_LISTED_COMPANIES)}::jsonb
     WHERE id = ${FRAMEWORK_ID}
  `);
  return { rowsUpdated: res?.rowCount ?? 0 };
}

// Run standalone: `node --import tsx server/migrations/20261126_fw25_entity_attribution.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  applyFw25EntityAttribution()
    .then(({ rowsUpdated }) => {
      console.log(
        `[migration 20261126_fw25_entity_attribution] framework_id=${FRAMEWORK_ID} ` +
        `rows updated=${rowsUpdated} ` +
        `(related_listed_companies=${JSON.stringify(RELATED_LISTED_COMPANIES)})`
      );
    })
    .catch((err) => {
      console.error("[migration 20261126_fw25_entity_attribution] FAILED:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
