/**
 * gate3_recover_probe.ts — measure the EXACT sourceUrl recovery rate for batch 1287
 * by matching each supporting quote's text against the batch corpus document
 * content (exact substring, then normalized-whitespace containment). READ-ONLY.
 */
import pg from "pg";
import { isPositiveVerdict } from "../lib/eligibility-flags.js";

const { Pool } = pg;

function norm(s: string): string {
  return s
    .normalize("NFKC")
    // smart single quotes / apostrophes → straight '
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4\u0060]/g, "'")
    // smart double quotes → straight "
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    // dashes (en/em/figure/minus/non-breaking hyphen) → hyphen
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    // ellipsis → ...
    .replace(/\u2026/g, "...")
    // bullets/middots → space (quotes vs corpus differ on bullet glyphs)
    .replace(/[\u2022\u2023\u25E6\u2043\u00B7\u2219\u25CF\u25CB\u25AA]/g, " ")
    // zero-width + non-breaking spaces → normal space
    .replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function main() {
  const batchId = parseInt(process.argv[2] || "1287", 10);
  const companyIds = Array.from({ length: 10 }, (_, i) => 9 + i);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 3 });

  // Load snapshot
  const snap = await pool.query(
    `SELECT id, results_data FROM analysis_results WHERE batch_id=$1 ORDER BY id DESC LIMIT 1`,
    [batchId],
  );
  const raw = snap.rows[0].results_data;
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;

  let totalQuotes = 0;
  let recoveredExact = 0;
  let recoveredNorm = 0;
  let unrecovered = 0;
  let positiveCells = 0;
  let cellsAllResolved = 0;
  const unrecoveredSamples: string[] = [];

  for (const co of data) {
    const companyId = Number(co.companyId);
    if (!companyIds.includes(companyId)) continue;

    // Load corpus docs for this company in this batch
    const docs = await pool.query(
      `SELECT d.url AS url, dc.content AS content
         FROM batch_corpus bc
         JOIN documents d ON d.id=bc.document_id
         LEFT JOIN document_content dc ON dc.id=d.content_id
        WHERE bc.batch_id=$1 AND bc.company_id=$2`,
      [batchId, companyId],
    );
    const corpus = docs.rows.map((r: any) => ({
      url: r.url as string | null,
      content: (r.content || "") as string,
      ncontent: norm(r.content || ""),
    }));

    const measures = co.measureScores ?? co.measures ?? [];
    for (const m of measures) {
      if (!isPositiveVerdict(String(m.verdict ?? ""))) continue;
      const quotes = (Array.isArray(m.quotes) ? m.quotes : []).filter(
        (q: any) => !String(q?.sourceUrl ?? "").startsWith("diag://"),
      );
      if (quotes.length === 0) continue;
      positiveCells++;
      let cellResolved = 0;
      for (const q of quotes) {
        const text = String(q?.text ?? "");
        if (!text.trim()) { unrecovered++; continue; }
        totalQuotes++;
        // exact substring
        let hit = corpus.find((c) => c.content.includes(text));
        if (hit && hit.url) { recoveredExact++; cellResolved++; continue; }
        // normalized whitespace containment
        const nt = norm(text);
        hit = corpus.find((c) => c.ncontent.includes(nt));
        if (hit && hit.url) { recoveredNorm++; cellResolved++; continue; }
        unrecovered++;
        if (unrecoveredSamples.length < 8) unrecoveredSamples.push(`[co${companyId} ${m.measureId}] ${text.slice(0, 90)}`);
      }
      if (cellResolved === quotes.length) cellsAllResolved++;
    }
  }

  const recovered = recoveredExact + recoveredNorm;
  console.log(JSON.stringify({
    batchId,
    positiveCells,
    cellsAllResolved,
    cellsAllResolvedPct: ((cellsAllResolved / positiveCells) * 100).toFixed(1) + "%",
    totalQuotes,
    recoveredExact,
    recoveredNorm,
    recovered,
    unrecovered,
    recoveryRate: ((recovered / totalQuotes) * 100).toFixed(2) + "%",
  }, null, 2));
  console.log("\nUnrecovered samples:");
  for (const s of unrecoveredSamples) console.log(" -", s);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
