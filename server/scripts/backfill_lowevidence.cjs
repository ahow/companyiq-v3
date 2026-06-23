/**
 * Backfill: recompute fetchCoverage.lowEvidence with the corpus-aware definition
 * for every company currently flagged lowEvidence=true.
 *
 *   lowEvidence := fetchWeakness && (corpusChars < AUTO_REEXAM_MAX_CHARS)
 *
 * Read/update only — no pipeline run, no fetching, no scoring, no credits.
 * Also writes the new transparency fields (corpusChars, corpusThin, fetchWeakness).
 * Preserves all other discoveryDiagnostics keys. Idempotent.
 *
 * Usage:
 *   DATABASE_URL=... node backfill_lowevidence.cjs            # apply
 *   DATABASE_URL=... DRY_RUN=1 node backfill_lowevidence.cjs  # preview only
 */
const { Client } = require("pg");
const THIN = parseInt(process.env.AUTO_REEXAM_MAX_CHARS || "100000", 10);
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await c.connect();

  const q = await c.query(
    `SELECT id, name, discovery_diagnostics AS diag
       FROM companies
      WHERE (discovery_diagnostics->'fetchCoverage'->>'lowEvidence')='true'`
  );
  const ids = q.rows.map((r) => r.id);
  console.log(`flagged lowEvidence=true: ${q.rows.length}`);
  if (ids.length === 0) { await c.end(); return; }

  const stats = await c.query(
    `SELECT d.company_id id,
            COALESCE(SUM(length(COALESCE(dc.content,d.content))) FILTER (WHERE d.fetch_status='ok'),0) chars
       FROM documents d LEFT JOIN document_content dc ON dc.id=d.content_id
      WHERE d.company_id = ANY($1::int[])
      GROUP BY d.company_id`,
    [ids]
  );
  const cm = new Map(stats.rows.map((r) => [Number(r.id), Number(r.chars)]));

  let cleared = 0, kept = 0, updated = 0, failed = 0;
  for (const r of q.rows) {
    const diag = r.diag && typeof r.diag === "object" ? { ...r.diag } : {};
    const fc = { ...(diag.fetchCoverage || {}) };
    const fetchWeakness =
      fc.documentsFetched < 3 ||
      fc.fetchRatio < 0.5 ||
      (fc.deadPrimaryFiling && fc.fetchRatio < 0.7);
    const chars = cm.get(Number(r.id)) || 0;
    const corpusThin = chars < THIN;
    const newLow = !!(fetchWeakness && corpusThin);

    if (newLow) kept++; else cleared++;

    fc.corpusChars = chars;
    fc.corpusThin = corpusThin;
    fc.fetchWeakness = !!fetchWeakness;
    fc.lowEvidence = newLow;
    fc.lowEvidenceBackfilledAt = new Date().toISOString();
    diag.fetchCoverage = fc;

    if (DRY_RUN) continue;
    try {
      await c.query(`UPDATE companies SET discovery_diagnostics=$1, updated_at=NOW() WHERE id=$2`, [
        JSON.stringify(diag),
        r.id,
      ]);
      updated++;
    } catch (e) {
      failed++;
      console.error(`update failed id=${r.id} (${r.name}): ${e.message}`);
    }
  }

  console.log("──────────────────────────────────");
  console.log(`will-clear (corpus substantial) : ${cleared}`);
  console.log(`will-keep  (genuine thin+weak)  : ${kept}`);
  console.log(DRY_RUN ? "(DRY RUN — no writes)" : `updated rows: ${updated} (failed ${failed})`);
  await c.end();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
