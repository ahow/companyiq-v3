/**
 * Migration: standardised STD-EXCL-v1 + STD-BAR-v1 clauses for Framework 5 measures.
 *
 * Promotes the one-off /home/ubuntu/apply_p2_framework_rules.py (P2 / Q3 framework-rule
 * changes) into a committed, repeatable migration that lives with the codebase.
 *
 * What it does (two independent, additive appends):
 *   1. STD-BAR-v1  -> framework_measures.scoring_guidance
 *   2. STD-EXCL-v1 -> framework_measures.what_does_not_constitute_evidence
 *
 * Properties (matching the idempotent UPDATE convention used in server/db.ts
 * initializeDatabase — scoped by framework_id, guarded so re-runs are no-ops):
 *   - ADDITIVE: the clause text is appended to whatever the column already holds
 *     (rtrim of the existing value, then the clause, whose stored form begins with a
 *     single leading space) — nothing existing is overwritten or removed.
 *   - IDEMPOTENT: each column is updated only where its marker ([STD-BAR-v1] /
 *     [STD-EXCL-v1]) is not already present, so running the migration any number of
 *     times appends each clause at most once. The two appends are independent, so a
 *     partially-applied state self-heals.
 *   - SCOPED by framework id, NOT by hardcoded row ids: WHERE framework_id = 5
 *     targets exactly the Framework 5 (nature & biodiversity) measure set.
 *
 * The clause text below is preserved byte-for-byte from the source script (note the
 * em-dash U+2014 characters and the leading space on each constant). It is passed to
 * Postgres as a bound parameter, so no SQL-quoting is applied to it.
 *
 * Usage (reads DATABASE_URL from the environment, like the other server scripts):
 *   DATABASE_URL=... node --import tsx server/migrations/20260911_p2_std_clauses_fw5.ts
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";

const FRAMEWORK_ID = 5;

// Appended to what_does_not_constitute_evidence. Idempotency marker: [STD-EXCL-v1].
const STD_EXCL_V1 =
  " [STD-EXCL-v1] Standardised exclusion: evidence attributed to " +
  "climate/GHG targets, or to a third-party framework, rating, index, or " +
  "questionnaire response, does not satisfy this measure unless the same " +
  "evidence explicitly names nature or biodiversity (or a direct synonym: " +
  "ecosystems, natural capital, ecosystem services, species, or habitats).";

// Appended to scoring_guidance. Idempotency marker: [STD-BAR-v1].
const STD_BAR_V1 =
  " [STD-BAR-v1] Substantive bar (testable): a YES requires the cited " +
  "evidence to contain at least one concrete anchor \u2014 one of (a) a named " +
  "geography or operating site, (b) a named biome, ecosystem, species, or " +
  "habitat, (c) a quantified figure or dated/time-bound target, or (d) a named " +
  "strategy, policy, or framework document \u2014 together with explicit " +
  "nature/biodiversity attribution. Evidence that is generic or aspirational " +
  "and contains none of these anchors scores NO (Partial counts as 0).";

const EXCL_MARK = "[STD-EXCL-v1]";
const BAR_MARK = "[STD-BAR-v1]";

/**
 * Apply the two standardised clauses to every Framework 5 measure that does not
 * already carry them. Returns the number of rows updated per clause.
 */
export async function applyP2StdClausesFw5(): Promise<{ barUpdated: number; exclUpdated: number }> {
  // STD-BAR-v1 -> scoring_guidance (append once, per-column marker guard)
  const barRes: any = await db.execute(sql`
    UPDATE framework_measures
       SET scoring_guidance = rtrim(coalesce(scoring_guidance, '')) || ${STD_BAR_V1}
     WHERE framework_id = ${FRAMEWORK_ID}
       AND position(${BAR_MARK} in coalesce(scoring_guidance, '')) = 0
  `);

  // STD-EXCL-v1 -> what_does_not_constitute_evidence (append once, per-column marker guard)
  const exclRes: any = await db.execute(sql`
    UPDATE framework_measures
       SET what_does_not_constitute_evidence =
             rtrim(coalesce(what_does_not_constitute_evidence, '')) || ${STD_EXCL_V1}
     WHERE framework_id = ${FRAMEWORK_ID}
       AND position(${EXCL_MARK} in coalesce(what_does_not_constitute_evidence, '')) = 0
  `);

  return { barUpdated: barRes?.rowCount ?? 0, exclUpdated: exclRes?.rowCount ?? 0 };
}

// Run standalone: `node --import tsx server/migrations/20260911_p2_std_clauses_fw5.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  applyP2StdClausesFw5()
    .then(({ barUpdated, exclUpdated }) => {
      console.log(
        `[migration 20260911_p2_std_clauses_fw5] framework_id=${FRAMEWORK_ID} ` +
        `scoring_guidance(STD-BAR-v1) rows updated=${barUpdated}, ` +
        `what_does_not_constitute_evidence(STD-EXCL-v1) rows updated=${exclUpdated}`
      );
    })
    .catch((err) => {
      console.error("[migration 20260911_p2_std_clauses_fw5] FAILED:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
