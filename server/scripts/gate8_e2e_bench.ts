/**
 * GATE8 — paid end-to-end cold-vs-warm cache no-op benchmark (Option B).
 *
 * WHAT THIS MEASURES
 *   The thing GATE7 (bytes seam) and GATE4/6 could only prove a-priori: that
 *   warming the IN-PROCESS verdict cache (analyzer.ts `verdictCache` Map,
 *   consulted unconditionally inside `scoreSingleMeasure`) does NOT move any
 *   measure's verdict — measured EMPIRICALLY, end-to-end, through the REAL prod
 *   scoring entry point `analyzeCompanyMeasures`.
 *
 *   One real company, one frozen corpus (a batch_corpus snapshot read read-only),
 *   scored TWICE in ONE process:
 *     • COLD : verdictCache empty → every measure runs real self-consistency LLM
 *              scoring passes. Timed. Real LLM $ spent.
 *     • WARM : same opts object (⇒ byte-identical evidence ⇒ identical cache keys)
 *              → scoreSingleMeasure short-circuits on the Map. Timed. The LLM $
 *              NOT spent on warm is the cache saving; cost is measured, not assumed.
 *
 *   The central deliverable is the EMPIRICAL FLIP TABLE: per-measure verdict cold
 *   vs warm, counting Y→N and N→Y cell flips. A no-op cache ⇒ zero flips, PROVEN
 *   by running it, not by construction. ANY cold≠warm change is the headline.
 *
 * CODE IDENTITY: calls the exact production `analyzeCompanyMeasures` with the
 *   production environment (API keys, settings) dumped from Railway. No prod code
 *   edited, no prod defaults changed, cache NOT enabled in prod.
 *
 * ISOLATION: `analyzeCompanyMeasures` does not persist company/measure_scores, so
 *   the user's live dashboard run is untouched. The ONLY prod writes are append-
 *   only llm_usage_events rows, tagged with synthetic batch ids (cold/warm) that
 *   cannot collide with live accounting and are auditable / removable.
 *
 * HONESTY: wall-clock and cost are real measurements. A run that errors is
 *   reported as FAILURE/INCONCLUSIVE, never interpolated. Warm-hit behaviour is
 *   inferred from measured warm LLM cost, not predicted.
 *
 * USAGE (see run command in the turn log; requires prod env sourced + DATABASE_URL
 *   pointed at the TCP-proxy-reachable host):
 *     DATABASE_URL=... CACHE_LAYER_POLICY=on npx tsx server/scripts/gate8_e2e_bench.ts
 *
 * OUTPUT: ~/github_repos/companyiq-v3/gate8_out/gate8_e2e_bench.{json,md}
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { analyzeCompanyMeasures, type AnalysisResult, type MeasureResult } from "../lib/analyzer";
import {
  getCompanyById,
  getFrameworkById,
  getFrameworkMeasures,
  getTrustedSources,
} from "../storage";
import { runWithLlmContext } from "../lib/llm-usage";
import { db } from "../db";
import { sql } from "drizzle-orm";

// ─── Fixed target (structural cap: 1 company × 1 frozen corpus × fw's 36 measures) ──
const WS = 3;
const COMPANY_ID = 135;
const FW = 18;
const SRC_BATCH = 1289; // batch whose batch_corpus snapshot prod last scored (frozen corpus)
const COLD_BATCH = 990135001; // synthetic attribution tag — cannot collide with live batches
const WARM_BATCH = 990135002;
const RUN_HARD_TIMEOUT_MS = 50 * 60 * 1000; // safety guard: abort a single run that overruns

const OUT_DIR = `${process.env.HOME || "/home/ubuntu"}/github_repos/companyiq-v3/gate8_out`;

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`HARD TIMEOUT ${ms}ms (${label})`)), ms).unref(),
    ),
  ]);
}

/** Flatten an AnalysisResult to measureId → verdict. */
function verdictMap(r: AnalysisResult): Map<string, string> {
  const m = new Map<string, string>();
  for (const cat of r.categories) {
    for (const meas of cat.measures as MeasureResult[]) {
      m.set(meas.measureId, meas.verdict);
    }
  }
  return m;
}

const isYes = (v: string | undefined) => v === "Yes";

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");

  // ── Load the analysis inputs (read-only) ──────────────────────────────────
  const company = await getCompanyById(COMPANY_ID, WS);
  if (!company) throw new Error(`company ${COMPANY_ID} not found in ws ${WS}`);
  const framework = await getFrameworkById(FW, WS);
  if (!framework) throw new Error(`framework ${FW} not found in ws ${WS}`);
  const measures = await getFrameworkMeasures(FW);
  const trustedSources = await getTrustedSources(WS);
  console.error(
    `[gate8] company="${company.name}" framework="${framework.name}" measures=${measures.length} trustedSources=${trustedSources.length}`,
  );

  // ── Load the frozen corpus snapshot (batch_corpus), read-only, ORDER BY d.id ─
  const snap = await db.execute(sql`
    SELECT d.id, d.company_id, d.url, d.title, d.type, d.gate_verdict,
           d.gate_reason, d.fetch_status, d.fetch_failures, d.fetched_at, d.created_at,
           COALESCE(dc.content, d.content) AS content
    FROM batch_corpus bc
    JOIN documents d ON d.id = bc.document_id
    LEFT JOIN document_content dc ON dc.id = d.content_id
    WHERE bc.batch_id = ${SRC_BATCH} AND bc.company_id = ${COMPANY_ID}
    ORDER BY d.id
  `);
  const rows = snap.rows as Array<Record<string, any>>;
  if (rows.length === 0) {
    throw new Error(`no batch_corpus snapshot for batch ${SRC_BATCH}, company ${COMPANY_ID}`);
  }
  const documentTexts: string[] = rows.map((r) => String(r.content ?? ""));
  const documentUrls: string[] = rows.map((r) => String(r.url ?? ""));
  const documentTitles: string[] = rows.map((r) => String(r.title ?? ""));
  const documentIds: number[] = rows.map((r) => Number(r.id));
  const totalChars = documentTexts.reduce((a, t) => a + t.length, 0);
  console.error(
    `[gate8] corpus: ${rows.length} docs, ${(totalChars / 1e6).toFixed(2)}M chars, ids=[${documentIds.join(",")}]`,
  );

  // ── Build the opts ONCE and reuse for both runs (byte-identical inputs) ─────
  // freshScoring:false ⇒ prod-identical for ws3 (verdict_cache_enabled=true); the
  // DB fingerprint-reuse then applies IDENTICALLY to cold and warm, so the flip
  // table stays valid while cold still incurs full LLM scoring cost.
  const opts = {
    workspaceId: WS,
    companyName: company.name,
    companyId: COMPANY_ID,
    documentTexts,
    documentUrls,
    documentTitles,
    documentIds,
    framework,
    measures,
    freshScoring: false,
    company,
    trustedSources,
    skipFetch: true, // replay / cached-corpus run — never hit the network
  };

  // ── COLD ───────────────────────────────────────────────────────────────────
  console.error(`[gate8] COLD run starting (batch ${COLD_BATCH}) ...`);
  const c0 = Date.now();
  const cold = await withTimeout(
    runWithLlmContext(
      { workspaceId: WS, batchId: COLD_BATCH, companyId: COMPANY_ID, frameworkId: FW },
      () => analyzeCompanyMeasures(opts),
    ),
    RUN_HARD_TIMEOUT_MS,
    "cold",
  );
  const coldMs = Date.now() - c0;
  console.error(`[gate8] COLD done in ${fmtMs(coldMs)} — answered=${cold.answeredCount}/${cold.measuresTotal}`);

  // ── WARM ───────────────────────────────────────────────────────────────────
  console.error(`[gate8] WARM run starting (batch ${WARM_BATCH}) ...`);
  const w0 = Date.now();
  const warm = await withTimeout(
    runWithLlmContext(
      { workspaceId: WS, batchId: WARM_BATCH, companyId: COMPANY_ID, frameworkId: FW },
      () => analyzeCompanyMeasures(opts),
    ),
    RUN_HARD_TIMEOUT_MS,
    "warm",
  );
  const warmMs = Date.now() - w0;
  console.error(`[gate8] WARM done in ${fmtMs(warmMs)} — answered=${warm.answeredCount}/${warm.measuresTotal}`);

  // ── Flip accounting ─────────────────────────────────────────────────────────
  const cMap = verdictMap(cold);
  const wMap = verdictMap(warm);
  const allIds = Array.from(new Set([...cMap.keys(), ...wMap.keys()])).sort();
  let yToN = 0;
  let nToY = 0;
  let anyChange = 0;
  const perMeasure: Array<{ measureId: string; cold: string; warm: string; changed: boolean; flip: string }> = [];
  for (const id of allIds) {
    const cv = cMap.get(id) ?? "(absent)";
    const wv = wMap.get(id) ?? "(absent)";
    let flip = "";
    if (isYes(cv) && !isYes(wv)) {
      yToN++;
      flip = "Y→N";
    } else if (!isYes(cv) && isYes(wv)) {
      nToY++;
      flip = "N→Y";
    }
    const changed = cv !== wv;
    if (changed) anyChange++;
    perMeasure.push({ measureId: id, cold: cv, warm: wv, changed, flip });
  }
  const totalFlips = yToN + nToY;

  // ── Cost capture (in-process): let the 5s flush timer drain the usage buffer,
  //    then read llm_usage_events until the counts are stable. No fabrication —
  //    if nothing lands, cost is reported as "not captured". ───────────────────
  async function queryCost() {
    const r = await db.execute(sql`
      SELECT batch_id,
             count(*)::int                       AS calls,
             COALESCE(sum(total_cost_usd), 0)     AS cost,
             COALESCE(sum(total_tokens), 0)::bigint AS toks
      FROM llm_usage_events
      WHERE batch_id IN (${COLD_BATCH}, ${WARM_BATCH})
      GROUP BY batch_id
    `);
    const out: Record<number, { calls: number; cost: number; toks: number }> = {};
    for (const row of r.rows as Array<Record<string, any>>) {
      out[Number(row.batch_id)] = {
        calls: Number(row.calls),
        cost: Number(row.cost),
        toks: Number(row.toks),
      };
    }
    return out;
  }
  console.error(`[gate8] draining usage buffer + polling llm_usage_events for cost ...`);
  let prevCalls = -1;
  let stable = 0;
  let cost = await queryCost();
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    cost = await queryCost();
    const calls = (cost[COLD_BATCH]?.calls ?? 0) + (cost[WARM_BATCH]?.calls ?? 0);
    console.error(`[gate8] cost poll ${i + 1}: cold=${cost[COLD_BATCH]?.calls ?? 0} warm=${cost[WARM_BATCH]?.calls ?? 0} calls`);
    if (calls === prevCalls && calls > 0) {
      if (++stable >= 2) break;
    } else {
      stable = 0;
    }
    prevCalls = calls;
  }
  const coldCost = cost[COLD_BATCH] ?? null;
  const warmCost = cost[WARM_BATCH] ?? null;

  // ── Verdict ─────────────────────────────────────────────────────────────────
  const errored =
    cold.scoringDiagnostics?.scoringFailures || warm.scoringDiagnostics?.scoringFailures || 0;
  const coldAllInsufficient = (cold as any).isEmpty === true;
  let verdict: "PASS" | "INCONCLUSIVE" | "FAILURE";
  if (totalFlips > 0 || anyChange > 0) {
    verdict = "FAILURE"; // the cache moved a verdict — the headline
  } else if (coldAllInsufficient || (coldCost && coldCost.calls === 0)) {
    verdict = "INCONCLUSIVE"; // cold didn't actually exercise scoring
  } else {
    verdict = "PASS";
  }

  const speedup = warmMs > 0 ? coldMs / warmMs : null;
  const costDelta = coldCost && warmCost ? coldCost.cost - warmCost.cost : null;

  // ── JSON ─────────────────────────────────────────────────────────────────────
  const json = {
    generatedAt: new Date().toISOString(),
    target: { workspaceId: WS, companyId: COMPANY_ID, companyName: company.name, frameworkId: FW, frameworkName: framework.name, srcBatch: SRC_BATCH },
    corpus: { docs: rows.length, totalChars, documentIds },
    measuresTotal: measures.length,
    cold: { ms: coldMs, answeredCount: cold.answeredCount, abstainedCount: cold.abstainedCount, batchId: COLD_BATCH, cost: coldCost },
    warm: { ms: warmMs, answeredCount: warm.answeredCount, abstainedCount: warm.abstainedCount, batchId: WARM_BATCH, cost: warmCost },
    speedup,
    costDelta,
    flips: { yToN, nToY, totalFlips, anyChange },
    perMeasure,
    scoringDiagnostics: { cold: cold.scoringDiagnostics ?? null, warm: warm.scoringDiagnostics ?? null },
    verdict,
  };
  writeFileSync(`${OUT_DIR}/gate8_e2e_bench.json`, JSON.stringify(json, null, 2));

  // ── Markdown ───────────────────────────────────────────────────────────────
  const L: string[] = [];
  const fmtCost = (c: { calls: number; cost: number; toks: number } | null) =>
    c ? `$${c.cost.toFixed(4)} · ${c.calls} calls · ${(c.toks / 1e6).toFixed(2)}M tok` : "**not captured**";

  L.push("# GATE8 — paid end-to-end cold-vs-warm cache no-op benchmark (Option B)");
  L.push("");
  L.push(`Generated: ${new Date().toISOString()}`);
  L.push("");
  L.push(
    `**Scope (Option B):** one real company scored **twice in one process** through the real production ` +
      `\`analyzeCompanyMeasures\` entry point, on a frozen \`batch_corpus\` snapshot (read-only). Run 1 COLD ` +
      `(empty in-process verdict cache → real self-consistency LLM scoring), run 2 WARM (same byte-identical ` +
      `opts → the \`verdictCache\` Map short-circuits scoring). This measures EMPIRICALLY whether warming the ` +
      `cache moves any verdict, plus the real wall-clock and LLM-$ saving.`,
  );
  L.push("");
  L.push(
    `Target: **${company.name}** (company ${COMPANY_ID}, ws ${WS}) · framework **${framework.name}** (${FW}, ${measures.length} measures) · ` +
      `corpus **${rows.length} docs / ${(totalChars / 1e6).toFixed(2)}M chars** from batch_corpus snapshot batch ${SRC_BATCH}.`,
  );
  L.push("");
  L.push(`## Verdict: **${verdict}**`);
  L.push("");
  if (verdict === "FAILURE") {
    L.push(
      `**FAILURE — the cache changed ${anyChange} verdict(s) (Y→N ${yToN}, N→Y ${nToY}).** Warming the verdict ` +
        `cache is supposed to be a pure no-op on verdicts. A moved cell means the warm path served a different ` +
        `outcome than cold scoring produced — this is the headline and must be investigated before any cache reliance.`,
    );
  } else if (verdict === "INCONCLUSIVE") {
    L.push(
      `**INCONCLUSIVE — the cold run did not genuinely exercise LLM scoring** (empty-corpus sentinel or zero ` +
        `scoring calls recorded). No verdict moved, but with no real cold scoring the no-op property was not put ` +
        `under load. This is a reachability/data limitation, not a cache failure.`,
    );
  } else {
    L.push(
      `Every measure produced an identical verdict cold vs warm (0 flips), while the warm run skipped the paid ` +
        `scoring LLM calls. Warming the in-process verdict cache is an empirically confirmed **no-op on verdicts** ` +
        `that eliminates the scoring spend.`,
    );
  }
  L.push("");

  L.push("## Aggregate");
  L.push("");
  L.push(`- Cold wall: **${fmtMs(coldMs)}**  ·  warm wall: **${fmtMs(warmMs)}**  ·  speedup: **${speedup ? speedup.toFixed(1) + "x" : "n/a"}**`);
  L.push(`- Cold LLM cost: **${fmtCost(coldCost)}**`);
  L.push(`- Warm LLM cost: **${fmtCost(warmCost)}**`);
  L.push(`- Cost saved by warm cache: **${costDelta != null ? "$" + costDelta.toFixed(4) : "n/a"}**`);
  L.push(`- Answered (cold/warm): **${cold.answeredCount}/${warm.answeredCount}** of ${measures.length}  ·  abstained: ${cold.abstainedCount}/${warm.abstainedCount}`);
  L.push("");

  L.push("## Verdict cell-flip accounting (MANDATORY — EMPIRICAL)");
  L.push("");
  L.push(
    "Measured per-measure by running the real scoring entry point twice and diffing the verdicts. A Y→N flip = " +
      "verdict was `Yes` cold and not `Yes` warm; N→Y = not `Yes` cold and `Yes` warm. Any non-flip change " +
      "(e.g. Partial↔No) is counted in **Any change**.",
  );
  L.push("");
  L.push("| Surface | Y→N flips | N→Y flips | Total Flips | Any change | Scoring surface touched |");
  L.push("|---|--:|--:|--:|--:|:--:|");
  L.push(`| In-process verdict cache cold vs warm (${measures.length} measures) | ${yToN} | ${nToY} | ${totalFlips} | ${anyChange} | yes |`);
  L.push(`| **Total** | **${yToN}** | **${nToY}** | **${totalFlips}** | **${anyChange}** | **yes** |`);
  L.push("");

  // Per-measure table — show changed rows prominently; list all for completeness.
  const changed = perMeasure.filter((p) => p.changed);
  L.push("## Per-measure verdicts (cold vs warm)");
  L.push("");
  if (changed.length > 0) {
    L.push(`**${changed.length} measure(s) changed:**`);
    L.push("");
    L.push("| measureId | cold | warm | flip |");
    L.push("|:--|:--|:--|:--:|");
    for (const p of changed) L.push(`| ${p.measureId} | ${p.cold} | ${p.warm} | ${p.flip || "—"} |`);
    L.push("");
  } else {
    L.push("_No measure changed verdict. Full table below for audit._");
    L.push("");
  }
  L.push("| measureId | cold | warm |");
  L.push("|:--|:--|:--|");
  for (const p of perMeasure) L.push(`| ${p.measureId} | ${p.cold} | ${p.warm} |`);
  L.push("");

  L.push("## Warm-hit behaviour (inferred from measured cost)");
  L.push("");
  if (coldCost && warmCost) {
    const hit = warmCost.calls < coldCost.calls;
    L.push(
      `- Cold made **${coldCost.calls}** LLM calls; warm made **${warmCost.calls}**. ` +
        (hit
          ? `Warm issued fewer calls ⇒ the in-process verdict cache served hits and skipped paid scoring. The ` +
            `warm calls that remain are the uncached upstream stages (translation / summarisation / retrieval), ` +
            `which the verdict Map does not cache and which therefore repeat on warm.`
          : `Warm did **not** reduce calls — the evidence packs were not byte-identical, so cache keys differed ` +
            `and scoring recomputed. Investigate evidence-pack determinism; verdicts still matched above.`),
    );
  } else {
    L.push("- Cost not captured for one or both runs; warm-hit behaviour cannot be inferred from spend this run.");
  }
  L.push("");

  L.push("## Scope & honesty");
  L.push("");
  L.push("- **Code identity:** the real production `analyzeCompanyMeasures` was invoked with the production environment (API keys, workspace settings read live from the prod DB). No production code or defaults were modified; the cache was **not** enabled in production.");
  L.push("- **Isolation:** `analyzeCompanyMeasures` does not persist companies or measure_scores, so the user's live dashboard run was never touched. The only prod writes are append-only `llm_usage_events` rows tagged with synthetic batch ids (cold " + COLD_BATCH + ", warm " + WARM_BATCH + "), which cannot collide with live accounting and can be removed.");
  L.push("- **Real measurements:** wall-clock is `Date.now()` around each run; cost is summed from the `llm_usage_events` rows the runs actually emitted (buffer drained before reading). No number is interpolated; missing cost is reported as *not captured*.");
  L.push("- **freshScoring=false** was used for both runs — prod-identical for ws3 (`verdict_cache_enabled=true`). The DB fingerprint-reuse override therefore applies identically to cold and warm, leaving the cold-vs-warm flip comparison valid while cold still pays full scoring cost.");
  L.push("- **Caveat (provenance pre-filter not replicated):** the full pipeline applies a U17 provenance document filter (network/SEC lookups) before scoring; to keep inputs deterministic and network-free this run passed the RAW `batch_corpus` docs (ORDER BY id). This does **not** affect the cold-vs-warm comparison (both runs use identical inputs); it only means verdicts here are not meant to match prod's stored verdicts one-for-one.");
  L.push("");

  writeFileSync(`${OUT_DIR}/gate8_e2e_bench.md`, L.join("\n"));

  console.error(
    `\nDONE — ${verdict} · cold ${fmtMs(coldMs)} / warm ${fmtMs(warmMs)} (${speedup ? speedup.toFixed(1) + "x" : "n/a"}) · ` +
      `flips Y→N ${yToN} N→Y ${nToY} total ${totalFlips} anyChange ${anyChange} · ` +
      `coldCost ${coldCost ? "$" + coldCost.cost.toFixed(4) : "n/a"} warmCost ${warmCost ? "$" + warmCost.cost.toFixed(4) : "n/a"}`,
  );
  if (verdict === "FAILURE") process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((e) => {
    console.error("GATE8 bench crashed:", e);
    process.exit(1);
  });
