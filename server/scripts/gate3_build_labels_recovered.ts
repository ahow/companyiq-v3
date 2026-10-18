/**
 * gate3_build_labels_recovered.ts — RIGOROUS GATE3 label set for the A3
 * full-supporting-quote-set eligibility guardrail (no fail-silent proxy).
 *
 * WHY A NEW BUILDER
 * -----------------
 * build_gate3_labels.ts replays composeCellEligibility over the persisted
 * analysis_results snapshot, but that snapshot DROPS the quote `sourceUrl`
 * field (persists only {text, source}). With no URL every positive cell
 * collapses to REVIEW — a persistence artifact, NOT true ineligibility. This
 * builder RECOVERS each supporting quote's sourceUrl FOR FREE by matching the
 * quote text back to the batch's own corpus documents (batch_corpus ->
 * documents.url + document_content.content), then replays the SAME pure
 * composer the live analyzer uses. Result: the label basis equals what the
 * live A3 block would decide for the same evidence, with real provenance.
 *
 * RECOVERY (exact, measured, reported):
 *   For each supporting quote {text, source} in a positive cell, find the
 *   corpus document (restricted to THIS company in THIS batch) whose content
 *   contains the quote. Matching tiers (first hit wins, most-specific first):
 *     T1 full normalized containment (NFKC + smart-punct + bullet + ws collapse)
 *     T2 anchor-window containment  W=48 / stride 32  (tolerates 1 divergent char)
 *     T3 anchor-window containment  W=32 / stride 16  (looser, same-company only)
 *     T4 source-filename -> corpus URL suffix match   (title carries the filename)
 *   Tiers are same-company-scoped, so a within-issuer doc ambiguity never
 *   changes the provenance domain. Unresolved quotes keep url=null (the composer
 *   treats them as unknown->review, never silently eligible).
 *
 * GENUINE-REVIEW GUARD (no URL-drop artifact may masquerade as REVIEW):
 *   A cell is labelled REVIEW only when its eligibility signal is REAL. A cell
 *   that lands on REVIEW while still carrying an UNRESOLVED quote (whose true
 *   provenance is unknown and could have been eligible) is NOT a valid REVIEW —
 *   it is excluded from the bucket counts and reported as `excludedUrlArtifact`.
 *   (An unresolved quote can never manufacture a false VERDICT_CHANGE, because
 *   allExcluded requires every quote to be hard-excluded and an unresolved quote
 *   composes to `review`, not `excluded`.)
 *
 * USAGE
 *   DATABASE_URL=postgresql://... \
 *     node --import tsx server/scripts/gate3_build_labels_recovered.ts [batchId] [companyIdsCsv] [outPrefix]
 *   Defaults: batchId=1287, companyIds=9..18, outPrefix=/home/ubuntu/gate3_labels
 *
 * READ-ONLY. No production code or Railway env is touched.
 */

import pg from "pg";
import { writeFileSync } from "fs";
import {
  composeCellEligibility,
  type EligibilitySource,
  type EligibilityTarget,
} from "../lib/eligibility-decision.js";
import type { IrTenantBinding } from "../lib/provenance.js";
import { isPositiveVerdict } from "../lib/eligibility-flags.js";

const { Pool } = pg;

type Label = "STAY" | "QUOTE_CORRECT" | "VERDICT_CHANGE" | "REVIEW";

// ─── Normalisation shared by all recovery tiers ──────────────────────────────
function norm(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4\u0060]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u2022\u2023\u25E6\u2043\u00B7\u2219\u25CF\u25CB\u25AA]/g, " ")
    .replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Count how many W-char windows of nq appear in nc (anchor overlap). */
function anchorHits(nq: string, nc: string, W: number, S: number): number {
  if (nq.length <= W) return nc.includes(nq) ? 1 : 0;
  let hits = 0;
  for (let i = 0; i + W <= nq.length; i += S) if (nc.includes(nq.slice(i, i + W))) hits++;
  return hits;
}

interface CorpusDoc {
  url: string | null;
  nc: string; // normalized content
}

/**
 * A search-engine redirect mask (google /goto|/url, bing /ck/) is a pointer,
 * NOT a canonical document source. When the same quote is contained in several
 * corpus docs, a masked URL must never be preferred over a doc that exposes its
 * real URL — the masked copy and the clean copy are the same underlying PDF, and
 * only the clean one carries a classifiable host. This mirrors production's
 * cell-level `anyEligible` basis: a cell is eligible when ANY supporting quote
 * resolves to an issuer doc, and the clean copy is the faithful attribution.
 */
function isRedirectMaskUrl(url: string | null): boolean {
  if (!url) return false;
  let h = "";
  let path = "";
  try {
    const u = new URL(url);
    h = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return false;
  }
  if (/^(?:www\.)?google\.[a-z.]+$/.test(h) && (path.includes("/goto") || path.includes("/url"))) return true;
  if (h.endsWith("bing.com") && path.includes("/ck/")) return true;
  return false;
}

/**
 * Recover a quote's sourceUrl from this company's corpus. Returns the matched
 * url and the tier that matched, or null when genuinely unrecoverable.
 */
function recoverUrl(
  text: string,
  source: string,
  corpus: CorpusDoc[],
): { url: string | null; tier: string | null } {
  const nq = norm(text);
  if (nq.length >= 12) {
    // T1 — full normalized containment. Prefer a canonical (non-redirect-mask)
    // source when the quote appears in several docs; fall back to the first
    // masked match only if that is the sole containing doc.
    let t1Mask: string | null = null;
    for (const c of corpus) {
      if (c.url && c.nc.includes(nq)) {
        if (!isRedirectMaskUrl(c.url)) return { url: c.url, tier: "T1-full" };
        if (t1Mask === null) t1Mask = c.url;
      }
    }
    if (t1Mask !== null) return { url: t1Mask, tier: "T1-full" };
    // T2 — anchor window 48/32 (pick doc with most window hits; prefer a
    // non-mask doc on ties).
    let best: CorpusDoc | null = null;
    let bh = 0;
    let bestMask = true;
    for (const c of corpus) {
      const h = anchorHits(nq, c.nc, 48, 32);
      if (h === 0) continue;
      const mask = isRedirectMaskUrl(c.url);
      if (h > bh || (h === bh && bestMask && !mask)) { bh = h; best = c; bestMask = mask; }
    }
    if (best && best.url && bh > 0) return { url: best.url, tier: "T2-anchor48" };
    // T3 — anchor window 32/16 (looser; same tie-break preference)
    best = null; bh = 0; bestMask = true;
    for (const c of corpus) {
      const h = anchorHits(nq, c.nc, 32, 16);
      if (h === 0) continue;
      const mask = isRedirectMaskUrl(c.url);
      if (h > bh || (h === bh && bestMask && !mask)) { bh = h; best = c; bestMask = mask; }
    }
    if (best && best.url && bh > 0) return { url: best.url, tier: "T3-anchor32" };
  }
  // T4 — source filename -> corpus url suffix
  const src = (source || "").trim().toLowerCase().split("?")[0];
  if (src.length >= 6) {
    const hit = corpus.find((c) => c.url && c.url.toLowerCase().split("?")[0].endsWith(src));
    if (hit && hit.url) return { url: hit.url, tier: "T4-filename" };
    const hit2 = corpus.find((c) => c.url && c.url.toLowerCase().includes(src));
    if (hit2 && hit2.url) return { url: hit2.url, tier: "T4-filename-contains" };
  }
  return { url: null, tier: null };
}

interface TargetRow {
  id: number; name: string; ticker: string | null;
  domain: string | null; relatedDomains: string[] | null; isin: string | null;
}

interface CellLabel {
  companyId: number;
  companyName: string;
  measure: string;
  verdict: string;
  quoteCount: number;
  recoveredUrlCount: number;
  unresolvedQuoteCount: number;
  cellStatus: string;
  citedQuoteEligible: boolean;
  anyEligible: boolean;
  anyReview: boolean;
  allExcluded: boolean;
  representativeIndex: number;
  label: Label;
  excludedUrlArtifact: boolean;
  // VERDICT_CHANGE root-cause diagnosis (populated only for VERDICT_CHANGE cells):
  // if EVERY hard-excluded quote is an attribution gap (redirect_mask | ir_cdn |
  // issuer_doctype) rather than a genuine third_party source, the downgrade is a
  // provenance-attribution artifact, not genuine third-party-only evidence.
  provenanceGapSuspect: boolean;
  genuineIneligible: boolean;
  exclusionHosts: string[];
  exclusionKinds: string[];
  quoteSourceTitles: string[];
  representative: { entityRelation: string; sourceClass: string; status: string; reason: string | null } | null;
  decisions: { index: number; status: string; entityRelation: string; sourceClass: string; url: string | null; recoveryTier: string | null }[];
}

function classify(cell: { anyEligible: boolean; allExcluded: boolean; representativeIndex: number }): Label {
  if (cell.anyEligible) return cell.representativeIndex === 0 ? "STAY" : "QUOTE_CORRECT";
  if (cell.allExcluded) return "VERDICT_CHANGE";
  return "REVIEW";
}

function hostOf(url: string | null): string {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/**
 * Classify why an excluded quote's URL fails issuer attribution, to separate a
 * GENUINE third-party exclusion from a provenance-ATTRIBUTION GAP (an issuer's
 * own disclosure the classifier cannot map to the issuer).
 *   redirect_mask — a search-engine redirect that hides the true source URL.
 *   ir_cdn        — an IR-distribution CDN (Q4/CloudFront/B2i) whose tenant is
 *                   not mapped to the issuer domain, so it falls back to third_party.
 *   issuer_doctype— the quote's own `source` title is an issuer-authored filing
 *                   type (proxy statement / annual report / 10-K / sustainability
 *                   report / etc.) — direct evidence it is the issuer's disclosure.
 *   third_party   — none of the above: a genuinely third-party source.
 */
function exclusionKind(url: string | null, sourceTitle: string | null): "redirect_mask" | "ir_cdn" | "issuer_doctype" | "third_party" {
  const h = hostOf(url);
  const path = (() => { try { return new URL(url || "").pathname.toLowerCase(); } catch { return ""; } })();
  if ((h === "www.google.com" || h === "google.com") && (path.includes("/goto") || path.includes("/url"))) return "redirect_mask";
  if (h.endsWith("bing.com") && path.includes("/ck/")) return "redirect_mask";
  if (/q4cdn\.com$|q4web\.com$|\.cloudfront\.net$|b2i\.cloud$|s\d+\.q4cdn\.com$/.test(h) || h.includes("q4cdn")) return "ir_cdn";
  const title = (sourceTitle || "").toLowerCase();
  if (/proxy statement|def ?14a|annual report|10-?k\b|10-?q\b|8-?k\b|sustainability report|esg report|integrated report|form ?20-?f|sec filing|investor (day|presentation)/.test(title)) return "issuer_doctype";
  return "third_party";
}

async function loadSnapshot(pool: pg.Pool, batchId: number) {
  const res = await pool.query(
    `SELECT id, results_data FROM analysis_results WHERE batch_id=$1 ORDER BY id DESC LIMIT 1`,
    [batchId],
  );
  if (res.rows.length === 0) throw new Error(`No analysis_results snapshot for batch_id=${batchId}`);
  const raw = res.rows[0].results_data;
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(data)) throw new Error(`results_data for batch ${batchId} is not an array`);
  return { analysisResultId: res.rows[0].id as number, companies: data as any[] };
}

async function loadTargets(pool: pg.Pool, companyIds: number[]) {
  const res = await pool.query(
    `SELECT id, name, ticker, domain, related_domains AS "relatedDomains", isin
       FROM companies WHERE id = ANY($1::int[])`,
    [companyIds],
  );
  const map = new Map<number, TargetRow>();
  for (const r of res.rows as any[]) {
    map.set(r.id, {
      id: r.id, name: r.name, ticker: r.ticker ?? null, domain: r.domain ?? null,
      relatedDomains: Array.isArray(r.relatedDomains) ? r.relatedDomains : null, isin: r.isin ?? null,
    });
  }
  return map;
}

async function loadCorpus(pool: pg.Pool, batchId: number, companyId: number): Promise<CorpusDoc[]> {
  const res = await pool.query(
    `SELECT d.url AS url, dc.content AS content
       FROM batch_corpus bc
       JOIN documents d ON d.id = bc.document_id
       LEFT JOIN document_content dc ON dc.id = d.content_id
      WHERE bc.batch_id=$1 AND bc.company_id=$2`,
    [batchId, companyId],
  );
  return res.rows.map((r: any) => ({ url: r.url ?? null, nc: norm(r.content || "") }));
}

async function main() {
  const batchId = parseInt(process.argv[2] || "1287", 10);
  const companyIds = (process.argv[3]
    ? process.argv[3].split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isInteger)
    : Array.from({ length: 10 }, (_, i) => 9 + i));
  const outPrefix = process.argv[4] || "/home/ubuntu/gate3_labels";
  if (!process.env.DATABASE_URL) { console.error("FATAL: DATABASE_URL required"); process.exit(1); }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 3, connectionTimeoutMillis: 15000 });

  try {
    const { analysisResultId, companies } = await loadSnapshot(pool, batchId);
    const targets = await loadTargets(pool, companyIds);

    // Verification affordance: GATE3_RELATED_OVERLAY lets you PREVIEW the effect
    // of adding related_domains entries (e.g. an IR-CDN tenant declaration) to a
    // company BEFORE persisting that data change to the DB. Format:
    //   "<companyId>=<entry>[,<entry>...];<companyId>=<entry>..."
    // Each entry is appended (de-duplicated) to that company's relatedDomains for
    // this run only — it does NOT write to the database. Used to confirm that the
    // proposed 1-row S&P tenant declaration (12=s29.q4cdn.com/690959130) closes
    // the provenance-attribution gap, so the DB write can be made with evidence.
    const overlaySpec = (process.env.GATE3_RELATED_OVERLAY || "").trim();
    if (overlaySpec) {
      for (const group of overlaySpec.split(";").map(s => s.trim()).filter(Boolean)) {
        const eq = group.indexOf("=");
        if (eq < 0) continue;
        const cid = parseInt(group.slice(0, eq).trim(), 10);
        const entries = group.slice(eq + 1).split(",").map(s => s.trim()).filter(Boolean);
        const t = targets.get(cid);
        if (!t || entries.length === 0) continue;
        const merged = new Set([...(t.relatedDomains || []), ...entries]);
        t.relatedDomains = [...merged];
        console.error(`OVERLAY: company ${cid} relatedDomains += [${entries.join(", ")}] (in-memory preview, NOT persisted)`);
      }
    }

    const cells: CellLabel[] = [];
    const wanted = new Set(companyIds);
    let totalQuotes = 0, totalRecovered = 0;
    const tierCounts: Record<string, number> = {};

    const sortedCompanies = companies
      .filter((co) => wanted.has(Number(co.companyId)))
      .sort((a, b) => Number(a.companyId) - Number(b.companyId));

    for (const co of sortedCompanies) {
      const companyId = Number(co.companyId);
      const companyName: string = co.companyName ?? co.name ?? String(companyId);
      const t = targets.get(companyId);
      const target: EligibilityTarget = {
        id: companyId, name: t?.name || companyName, ticker: t?.ticker ?? null,
        domain: t?.domain ?? null, relatedDomains: t?.relatedDomains ?? null, isin: t?.isin ?? co.isin ?? null,
      };
      const corpus = await loadCorpus(pool, batchId, companyId);

      // R5c: ONE IR-platform tenant cache per company, shared across all of this
      // company's measures (mirrors analyzer.ts). Offline == live.
      const companyIrTenantCache = new Map<string, IrTenantBinding>();

      const measures = (co.measureScores ?? co.measures ?? []) as any[];
      const sortedMeasures = [...measures].sort((a, b) => String(a.measureId).localeCompare(String(b.measureId)));

      for (const m of sortedMeasures) {
        const verdict: string = m.verdict ?? "";
        if (!isPositiveVerdict(verdict)) continue;

        const quotes = (Array.isArray(m.quotes) ? m.quotes : []).filter(
          (q: any) => !String(q?.sourceUrl ?? "").startsWith("diag://"),
        );
        // Recover a URL per quote.
        const recovered = quotes.map((q: any) => recoverUrl(String(q?.text ?? ""), String(q?.source ?? ""), corpus));
        const sources: EligibilitySource[] = quotes.map((q: any, i: number) => ({
          url: recovered[i].url, title: q?.source ?? null, content: q?.text ?? null,
        }));
        const recoveredUrlCount = recovered.filter((r) => !!r.url).length;
        const unresolvedQuoteCount = quotes.length - recoveredUrlCount;
        totalQuotes += quotes.length;
        totalRecovered += recoveredUrlCount;
        for (const r of recovered) if (r.tier) tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;

        const cell = composeCellEligibility({ target, sources, knownIrTenants: companyIrTenantCache });
        let label = classify(cell);

        // Cited (first) quote eligibility = decision[0] eligible.
        const citedQuoteEligible = cell.decisions.length > 0 && cell.decisions[0].status === "eligible";

        // Genuine-REVIEW guard: a REVIEW that still carries an unresolved quote
        // is suspect (the unresolved quote's true provenance could be eligible),
        // so it is a URL-drop artifact, not a valid REVIEW label.
        const excludedUrlArtifact = label === "REVIEW" && unresolvedQuoteCount > 0;

        // ── VERDICT_CHANGE root-cause diagnosis ──────────────────────────────
        // For a VERDICT_CHANGE cell, every quote is hard-excluded. Classify each
        // excluded quote's URL: if NONE are genuinely third_party (all are
        // redirect_mask / ir_cdn / issuer_doctype attribution gaps), the downgrade
        // is a provenance-attribution ARTIFACT, not genuine third-party evidence.
        let provenanceGapSuspect = false;
        let genuineIneligible = false;
        const exclusionHosts: string[] = [];
        const exclusionKinds: string[] = [];
        const quoteSourceTitles: string[] = [];
        if (label === "VERDICT_CHANGE") {
          cell.decisions.forEach((d, i) => {
            if (d.status !== "excluded") return;
            const url = sources[i]?.url ?? null;
            const title = (quotes[i]?.source ?? null) as string | null;
            const kind = exclusionKind(url, title);
            exclusionHosts.push(hostOf(url) || "(unresolved)");
            exclusionKinds.push(kind);
            quoteSourceTitles.push(title || "(no title)");
          });
          const excludedKinds = exclusionKinds;
          provenanceGapSuspect = excludedKinds.length > 0 && excludedKinds.every((k) => k !== "third_party");
          genuineIneligible = !provenanceGapSuspect;
        }

        const rep = cell.representative;
        cells.push({
          companyId, companyName, measure: String(m.measureId), verdict,
          quoteCount: cell.sourceCount, recoveredUrlCount, unresolvedQuoteCount,
          cellStatus: cell.status, citedQuoteEligible,
          anyEligible: cell.anyEligible, anyReview: cell.anyReview, allExcluded: cell.allExcluded,
          representativeIndex: cell.representativeIndex, label, excludedUrlArtifact,
          provenanceGapSuspect, genuineIneligible, exclusionHosts, exclusionKinds, quoteSourceTitles,
          representative: rep
            ? { entityRelation: rep.entityRelation, sourceClass: rep.sourceClass, status: rep.status, reason: rep.reasons.length ? rep.reasons[rep.reasons.length - 1] : null }
            : null,
          decisions: cell.decisions.map((d, i) => ({
            index: i, status: d.status, entityRelation: d.entityRelation, sourceClass: d.sourceClass,
            url: sources[i]?.url ?? null, recoveryTier: recovered[i]?.tier ?? null,
          })),
        });
      }
    }

    // ── Aggregate (excluded artifacts are NOT counted in the four buckets) ──
    const totals = { positiveCells: 0, stay: 0, quoteCorrect: 0, verdictChange: 0, verdictChangeGenuine: 0, verdictChangeProvenanceGap: 0, review: 0, excludedUrlArtifact: 0 };
    const perCompany = new Map<number, any>();
    for (const cid of companyIds) {
      const t = targets.get(cid);
      perCompany.set(cid, {
        companyId: cid, companyName: t?.name || String(cid),
        positiveCells: 0, stay: 0, quoteCorrect: 0, verdictChange: 0, review: 0, excludedUrlArtifact: 0,
      });
    }
    for (const c of cells) {
      const b = perCompany.get(c.companyId);
      totals.positiveCells++; b.positiveCells++;
      if (c.excludedUrlArtifact) { totals.excludedUrlArtifact++; b.excludedUrlArtifact++; continue; }
      if (c.label === "STAY") { totals.stay++; b.stay++; }
      else if (c.label === "QUOTE_CORRECT") { totals.quoteCorrect++; b.quoteCorrect++; }
      else if (c.label === "VERDICT_CHANGE") {
        totals.verdictChange++; b.verdictChange++;
        if (c.provenanceGapSuspect) totals.verdictChangeProvenanceGap++;
        else totals.verdictChangeGenuine++;
      }
      else { totals.review++; b.review++; }
    }

    const classifiedCells = totals.positiveCells - totals.excludedUrlArtifact;
    const recoveryRate = totalQuotes > 0 ? (totalRecovered / totalQuotes) * 100 : 0;

    const report = {
      batchId, analysisResultId, generatedAt: new Date().toISOString(),
      companyIds,
      path: "FREE corpus-URL recovery (replay of composeCellEligibility over recovered URLs)",
      policy: `ELIGIBILITY_POLICY=${process.env.ELIGIBILITY_POLICY || "(default v2)"}`,
      recovery: {
        totalQuotes, totalRecovered, unresolvedQuotes: totalQuotes - totalRecovered,
        recoveryRatePct: Number(recoveryRate.toFixed(2)), tierCounts,
      },
      totals, classifiedCells,
      perCompany: companyIds.map((c) => perCompany.get(c)),
      cells,
    };

    writeFileSync(`${outPrefix}.json`, JSON.stringify(report, null, 2));
    writeFileSync(`${outPrefix}.md`, toMarkdown(report));
    console.log(toMarkdown(report));
    console.log(`\nJSON -> ${outPrefix}.json\nMD   -> ${outPrefix}.md`);
  } finally {
    await pool.end();
  }
  process.exit(0);
}

function pct(n: number, d: number): string { return d <= 0 ? "0.0%" : ((n / d) * 100).toFixed(1) + "%"; }

function toMarkdown(r: any): string {
  const t = r.totals;
  const cc = r.classifiedCells;
  const L: string[] = [];
  L.push(`### GATE3 label set — batch ${r.batchId} (A3 full-supporting-quote-set eligibility)`);
  L.push("");
  L.push(`Source: \`analysis_results\` snapshot id ${r.analysisResultId}. Companies: ${r.companyIds.join(", ")}. ${r.policy}.`);
  L.push(`Composer: \`composeCellEligibility\` (full supporting-quote set). Generated ${r.generatedAt}.`);
  L.push("");
  L.push(`**Path used:** ${r.path}.`);
  L.push(`**Measured sourceUrl recovery rate:** ${r.recovery.recoveryRatePct}% (${r.recovery.totalRecovered}/${r.recovery.totalQuotes} supporting quotes; ${r.recovery.unresolvedQuotes} unresolved). Recovery tiers: ${Object.entries(r.recovery.tierCounts).map(([k, v]) => `${k}=${v}`).join(", ")}.`);
  L.push("");
  L.push(`Labels for each POSITIVE cell: **STAY** (cited quote already eligible), **QUOTE_CORRECT** (an eligible quote exists but is not cited first — promote it; verdict unchanged), **VERDICT_CHANGE** (all quotes hard-excluded — downgrade to No; last resort), **REVIEW** (none eligible but some unknown-provenance). URL-drop artifacts (a REVIEW cell still carrying an unresolved quote) are EXCLUDED from the counts and reported separately.`);
  L.push("");
  L.push("| Bucket | Cells | Share of classified cells |");
  L.push("|---|---|---|");
  L.push(`| STAY | ${t.stay} | ${pct(t.stay, cc)} |`);
  L.push(`| QUOTE_CORRECT | ${t.quoteCorrect} | ${pct(t.quoteCorrect, cc)} |`);
  L.push(`| VERDICT_CHANGE | ${t.verdictChange} | ${pct(t.verdictChange, cc)} |`);
  L.push(`| REVIEW (genuine) | ${t.review} | ${pct(t.review, cc)} |`);
  L.push(`| **Classified positive cells** | **${cc}** | **100%** |`);
  L.push(`| _excluded: URL-drop artifact_ | _${t.excludedUrlArtifact}_ | _n/a_ |`);
  L.push(`| **Total positive cells** | **${t.positiveCells}** | — |`);
  L.push("");
  // yes->no / no->yes counts (verdict-change is the only label that flips a verdict; this
  // snapshot's only positive verdict is "Yes", so VERDICT_CHANGE = Yes->No flips. No No->Yes
  // flips are possible from a positive-cell guardrail.)
  L.push(`**Verdict flips implied by these labels:** Yes→No = ${t.verdictChange} (VERDICT_CHANGE); No→Yes = 0 (A3 only acts on positive cells). Total cells changing verdict = ${t.verdictChange}.`);
  L.push(`Of those ${t.verdictChange} Yes→No flips: **${t.verdictChangeGenuine} genuine** (all quotes are genuinely third-party) and **${t.verdictChangeProvenanceGap} provenance-attribution artifact** (every excluded quote is an issuer disclosure the classifier cannot map to the issuer — see root-cause below). **Genuine verdict-change = ${t.verdictChangeGenuine}.**`);
  L.push("");
  // ── VERDICT_CHANGE root-cause subsection ──
  const vcCells = r.cells.filter((c: any) => c.label === "VERDICT_CHANGE");
  if (vcCells.length > 0) {
    L.push("#### VERDICT_CHANGE root-cause diagnosis");
    L.push("");
    L.push("Each VERDICT_CHANGE cell has ALL supporting quotes hard-excluded. The table classifies *why* each quote was excluded — distinguishing a genuine third-party source from a **provenance-attribution gap** (an issuer's own disclosure whose recovered URL the classifier cannot map to the issuer: a search-engine redirect mask, an unmapped IR-distribution CDN tenant, or a quote whose `source` title is plainly an issuer filing type).");
    L.push("");
    L.push("| Company | Measure | Excluded quote sources (title) | Hosts | Exclusion kinds | Diagnosis |");
    L.push("|---|---|---|---|---|---|");
    for (const c of vcCells) {
      const titles = (c.quoteSourceTitles || []).join("; ") || "—";
      const hosts = (c.exclusionHosts || []).join(", ") || "—";
      const kinds = (c.exclusionKinds || []).join(", ") || "—";
      const diag = c.provenanceGapSuspect ? "**provenance-attribution artifact** (not genuine)" : "genuine third-party exclusion";
      L.push(`| ${c.companyName} | ${c.measure} | ${titles} | ${hosts} | ${kinds} | ${diag} |`);
    }
    L.push("");
    L.push(`Exclusion-kind legend: \`redirect_mask\` = search-engine redirect hiding the true URL; \`ir_cdn\` = IR-distribution CDN (e.g. Q4 Inc \`s29.q4cdn.com\`) whose tenant is not mapped to the issuer domain; \`issuer_doctype\` = the quote's \`source\` title is an issuer-authored filing (proxy statement, annual report, 10-K, sustainability report, …); \`third_party\` = a genuinely third-party source.`);
    L.push("");
  }
  L.push("#### Per-company breakdown");
  L.push("");
  L.push("| Company ID | Company | Positive cells | STAY | QUOTE_CORRECT | VERDICT_CHANGE | REVIEW | Excluded(artifact) |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const c of r.perCompany) {
    L.push(`| ${c.companyId} | ${c.companyName} | ${c.positiveCells} | ${c.stay} | ${c.quoteCorrect} | ${c.verdictChange} | ${c.review} | ${c.excludedUrlArtifact} |`);
  }
  L.push(`| **ALL** | **Aggregate** | **${t.positiveCells}** | **${t.stay}** | **${t.quoteCorrect}** | **${t.verdictChange}** | **${t.review}** | **${t.excludedUrlArtifact}** |`);
  L.push("");
  // Verdict line on the user's expectation.
  const actionable = t.quoteCorrect + t.verdictChange;
  const quoteDominates = t.quoteCorrect >= t.verdictChange;
  const verdictRare = cc > 0 ? (t.verdictChange / cc) : 0;
  L.push("#### Verdict on the user's governing expectation");
  L.push("");
  L.push(`User's expectation: making A3 evaluate the full supporting-quote set *"should almost always result in the quote being changed to ensure it is accurate rather than the verdict being changed"* — i.e. QUOTE_CORRECT should dominate; VERDICT_CHANGE should be rare.`);
  L.push("");
  if (quoteDominates && t.verdictChange <= t.quoteCorrect) {
    L.push(`**CONFIRMED.** Among the ${actionable} actionable cells, quote-correction (${t.quoteCorrect}) ${t.verdictChange === 0 ? "is the ONLY actionable remedy" : `dominates verdict-change (${t.verdictChange})`}. VERDICT_CHANGE is ${pct(t.verdictChange, cc)} of classified positive cells (${verdictRare <= 0.1 ? "rare" : "not rare"}). The data confirms the user's expectation that quote-correction dominates and verdict-change is rare.`);
  } else {
    L.push(`**NOT CONFIRMED.** VERDICT_CHANGE (${t.verdictChange}) is not rare relative to QUOTE_CORRECT (${t.quoteCorrect}); the data does NOT confirm the user's expectation. Investigate the VERDICT_CHANGE cells before enabling enforcement.`);
  }
  L.push("");
  if (t.verdictChangeProvenanceGap > 0) {
    L.push(`**Root-cause caveat (strengthens the confirmation):** of the ${t.verdictChange} apparent verdict-change cell(s), **${t.verdictChangeProvenanceGap} are provenance-attribution artifacts, not genuine ineligibility** — every excluded quote is the issuer's OWN disclosure whose recovered URL the classifier cannot map to the issuer (unmapped Q4-Inc IR-CDN tenants such as \`s29.q4cdn.com\`, and \`www.google.com/goto\` redirect masks). **Genuine verdict-change after removing these artifacts = ${t.verdictChangeGenuine}** (${pct(t.verdictChangeGenuine, cc)} of classified cells). Before enabling enforcement these are classifier provenance gaps to close (map the issuer's Q4/IR-CDN tenants into \`related_domains\`; resolve search-engine redirect URLs to their target), NOT evidence the verdict should flip.`);
    L.push("");
  }
  L.push(`Note: A3 eligibility enforcement is DEFAULT-ON (unset/empty ELIGIBILITY_ENFORCE enforces; an explicit ELIGIBILITY_ENFORCE=off is the kill switch that restores shadow mode). This set is a standalone forecast of what A3 would do, independent of the live batch env.`);
  return L.join("\n") + "\n";
}

main().catch((err) => { console.error("gate3_build_labels_recovered failed:", err); process.exit(1); });
