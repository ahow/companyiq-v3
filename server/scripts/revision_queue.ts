/**
 * revision_queue.ts — revision-queue generator (Task G).
 *
 * READ-ONLY over the multi-run variability outputs in /home/ubuntu/var_out/*_run*.json.
 * NO database access, no ../lib imports (avoids DATABASE_URL dependency).
 *
 * Per measure it computes:
 *   - run-to-run verdict flip rate (adjacent-run changes within a company, averaged over companies)
 *   - inter-model disagreement rate (primary vs secondary verdict per run instance)
 *   - gate failure counts by reason (from any persisted llmResults[].gate — absent in legacy runs)
 *   - arbiter fire count + arbiter-overturn count (arbiter sided with the secondary model)
 * Measures are ranked by a composite instability score. For the top-ranked measures it drafts a
 * PROPOSED rule edit (an exclusion line for whatDoesNotConstituteEvidence targeting the dominant
 * adjacent-proxy pattern, or a tightened substantive-detail bar) and writes
 * /home/ubuntu/Revision_Queue.md for the user to accept or reject.
 *
 * Run:  node node_modules/tsx/dist/cli.mjs server/scripts/revision_queue.ts
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const VAR_OUT = "/home/ubuntu/var_out";
const MEASURES_PATH = "/home/ubuntu/var_measures.json";
const OUT_PATH = "/home/ubuntu/Revision_Queue.md";
const TOP_N = 8; // number of top-ranked measures to draft proposed edits for

// Composite instability weights (documented in the report header).
const W_FLIP = 0.4;
const W_DISAGREE = 0.3;
const W_ARBITER = 0.2;
const W_GATE = 0.1;

type Verdict = string;

interface Quote { text?: string; source?: string }
interface GateFailure { quoteText?: string; source?: string; reasons?: string[] }
interface Gate {
  quotesTotal?: number;
  quotesValid?: number;
  downgraded?: boolean;
  originalScore?: number;
  failures?: GateFailure[];
}
interface LlmResult {
  llm: string;
  score?: number;
  verdict?: Verdict;
  quotes?: Quote[];
  gate?: Gate;
}
interface Cascade {
  stage?: string;
  score?: number;
  verdict?: Verdict;
  arbiterFired?: boolean;
  arbiterSidedWith?: string;
}
interface Record {
  measureId: string;
  title?: string;
  category?: string;
  llmResults: LlmResult[];
  cascade: Cascade;
}
interface RunFile {
  meta: {
    companyId: number;
    companyName?: string;
    runIndex: number;
    cascade?: { primary?: string; secondary?: string; arbiter?: string };
  };
  records: Record[];
}

// ---- load run files (canonical <companyId>_run<N>.json only; skip _v2 / _lim variants) ----
const CANONICAL = /^(\d+)_run(\d+)\.json$/;
const allFiles = readdirSync(VAR_OUT).filter((f) => f.endsWith(".json"));
const canonicalFiles = allFiles.filter((f) => CANONICAL.test(f)).sort();
const skippedFiles = allFiles.filter((f) => /_run/.test(f) && !CANONICAL.test(f));

const runs: RunFile[] = [];
for (const f of canonicalFiles) {
  try {
    const parsed = JSON.parse(readFileSync(join(VAR_OUT, f), "utf8")) as RunFile;
    if (parsed && parsed.meta && Array.isArray(parsed.records)) runs.push(parsed);
  } catch (e) {
    skippedFiles.push(`${f} (parse error)`);
  }
}

// ---- load measures ----
interface Measure {
  measureId: string;
  title?: string;
  category?: string;
  scoringGuidance?: string;
  substantiveDefinition?: string;
  whatDoesNotConstituteEvidence?: string;
  negativeExamples?: string[];
  evidenceKeywords?: string[];
}
const measures: Measure[] = JSON.parse(readFileSync(MEASURES_PATH, "utf8"));
const measureById = new Map<string, Measure>();
for (const m of measures) measureById.set(m.measureId, m);

// ---- aggregate per measure ----
interface CompanyRunPoint { companyId: number; runIndex: number; rec: Record; file: RunFile }
interface MeasureAgg {
  measureId: string;
  title: string;
  category: string;
  points: CompanyRunPoint[];
  gateFailureCounts: Map<string, number>;
  gateFailuresPresent: boolean;
}
const agg = new Map<string, MeasureAgg>();

for (const rf of runs) {
  for (const rec of rf.records) {
    let a = agg.get(rec.measureId);
    if (!a) {
      a = {
        measureId: rec.measureId,
        title: rec.title || measureById.get(rec.measureId)?.title || rec.measureId,
        category: rec.category || measureById.get(rec.measureId)?.category || "",
        points: [],
        gateFailureCounts: new Map(),
        gateFailuresPresent: false,
      };
      agg.set(rec.measureId, a);
    }
    a.points.push({ companyId: rf.meta.companyId, runIndex: rf.meta.runIndex, rec, file: rf });
    for (const lr of rec.llmResults || []) {
      const g = lr.gate;
      if (g && Array.isArray(g.failures)) {
        a.gateFailuresPresent = true;
        for (const fl of g.failures) {
          for (const reason of fl.reasons || []) {
            a.gateFailureCounts.set(reason, (a.gateFailureCounts.get(reason) || 0) + 1);
          }
        }
      }
    }
  }
}

// ---- metric helpers ----
function primarySecondary(rf: RunFile): { primary: string; secondary: string } {
  return {
    primary: rf.meta.cascade?.primary || "deepseek",
    secondary: rf.meta.cascade?.secondary || "glm-4.6-zai",
  };
}
function verdictOf(rec: Record): string {
  return (rec.cascade?.verdict || "").trim();
}
function llmVerdict(rec: Record, llm: string): string | undefined {
  const lr = (rec.llmResults || []).find((x) => x.llm === llm);
  return lr?.verdict?.trim();
}

interface MeasureMetrics {
  measureId: string;
  title: string;
  category: string;
  nInstances: number;         // total (company,run) points
  nCompanies: number;
  flipRate: number;           // avg adjacent-run flip rate across companies
  disagreementRate: number;   // primary vs secondary verdict mismatch fraction
  arbiterFired: number;
  arbiterOverturns: number;   // arbiter sided with secondary
  arbiterFireRate: number;
  gateFailureCounts: Map<string, number>;
  gateFailuresPresent: boolean;
  gateFailRate: number;       // gate downgrades / instances (0 when absent)
  composite: number;
}

function computeMetrics(a: MeasureAgg): MeasureMetrics {
  // group points by company
  const byCompany = new Map<number, CompanyRunPoint[]>();
  for (const p of a.points) {
    if (!byCompany.has(p.companyId)) byCompany.set(p.companyId, []);
    byCompany.get(p.companyId)!.push(p);
  }

  // flip rate: per company, adjacent verdict changes / (runs-1); average over companies with >=2 runs
  const flipRates: number[] = [];
  for (const [, pts] of byCompany) {
    const ordered = pts.slice().sort((x, y) => x.runIndex - y.runIndex);
    if (ordered.length < 2) continue;
    let flips = 0;
    for (let i = 1; i < ordered.length; i++) {
      if (verdictOf(ordered[i].rec) !== verdictOf(ordered[i - 1].rec)) flips++;
    }
    flipRates.push(flips / (ordered.length - 1));
  }
  const flipRate = flipRates.length ? flipRates.reduce((s, x) => s + x, 0) / flipRates.length : 0;

  // disagreement + arbiter + gate-downgrade rates over all instances
  let disagree = 0;
  let arbiterFired = 0;
  let arbiterOverturns = 0;
  let gateDowngrades = 0;
  for (const p of a.points) {
    const { primary, secondary } = primarySecondary(p.file);
    const pv = llmVerdict(p.rec, primary);
    const sv = llmVerdict(p.rec, secondary);
    if (pv !== undefined && sv !== undefined && pv !== sv) disagree++;
    if (p.rec.cascade?.arbiterFired) {
      arbiterFired++;
      if (p.rec.cascade?.arbiterSidedWith === secondary) arbiterOverturns++;
    }
    for (const lr of p.rec.llmResults || []) {
      if (lr.gate?.downgraded) { gateDowngrades++; break; }
    }
  }
  const n = a.points.length || 1;
  const disagreementRate = disagree / n;
  const arbiterFireRate = arbiterFired / n;
  const gateFailRate = gateDowngrades / n;

  const composite =
    W_FLIP * flipRate +
    W_DISAGREE * disagreementRate +
    W_ARBITER * arbiterFireRate +
    W_GATE * gateFailRate;

  return {
    measureId: a.measureId,
    title: a.title,
    category: a.category,
    nInstances: a.points.length,
    nCompanies: byCompany.size,
    flipRate,
    disagreementRate,
    arbiterFired,
    arbiterOverturns,
    arbiterFireRate,
    gateFailureCounts: a.gateFailureCounts,
    gateFailuresPresent: a.gateFailuresPresent,
    gateFailRate,
    composite,
  };
}

const metrics = Array.from(agg.values()).map(computeMetrics);
metrics.sort((x, y) => y.composite - x.composite);

// ---- adjacent-proxy pattern detection for the proposed edit ----
// Families of adjacent-proxy language that commonly cause false Yes on nature/biodiversity measures.
const PROXY_FAMILIES: { name: string; terms: string[] }[] = [
  { name: "climate / carbon / emissions", terms: ["climate", "carbon", "emission", "ghg", "greenhouse", "net zero", "net-zero", "decarboni", "scope 1", "scope 2", "scope 3"] },
  { name: "generic environmental / sustainability", terms: ["environmental", "sustainability", "esg", "sustainable development"] },
  { name: "energy / renewables", terms: ["energy", "renewable", "solar", "electricity", "power consumption"] },
  { name: "water / effluent", terms: ["water", "effluent", "wastewater", "discharge"] },
  { name: "waste / circularity", terms: ["waste", "recycl", "circular"] },
];

function detectProxy(a: MeasureAgg): { family: string; hits: number; sample: string } | null {
  // Gather quotes from instances whose final verdict = Yes (evidence that drove a positive)
  // to surface which adjacent-proxy language dominates the unstable positives.
  const texts: string[] = [];
  for (const p of a.points) {
    if (verdictOf(p.rec) !== "Yes") continue;
    for (const lr of p.rec.llmResults || []) {
      for (const q of lr.quotes || []) if (q.text) texts.push(q.text.toLowerCase());
    }
  }
  if (texts.length === 0) {
    // fall back to all quotes
    for (const p of a.points)
      for (const lr of p.rec.llmResults || [])
        for (const q of lr.quotes || []) if (q.text) texts.push(q.text.toLowerCase());
  }
  const blob = texts.join(" \u0001 ");
  let best: { family: string; hits: number; sample: string } | null = null;
  for (const fam of PROXY_FAMILIES) {
    let hits = 0;
    let sample = "";
    for (const t of fam.terms) {
      const idx = blob.indexOf(t);
      if (idx >= 0) {
        // count occurrences
        let c = 0, from = 0;
        while (true) {
          const k = blob.indexOf(t, from);
          if (k < 0) break;
          c++; from = k + t.length;
        }
        hits += c;
        if (!sample) {
          const seg = texts.find((x) => x.includes(t)) || "";
          sample = seg.slice(0, 160);
        }
      }
    }
    if (hits > 0 && (!best || hits > best.hits)) best = { family: fam.name, hits, sample };
  }
  return best;
}

// ---- proposed edit drafting ----
function proposeEdit(m: MeasureMetrics): { kind: string; text: string } {
  const meas = measureById.get(m.measureId);
  const a = agg.get(m.measureId)!;
  const proxy = detectProxy(a);
  const target = meas?.title || m.title;

  if (proxy) {
    const exclusion =
      `Statements that establish only ${proxy.family} activity (rather than nature/biodiversity ` +
      `specifically) do NOT constitute evidence for "${target}". A quote that discusses ` +
      `${proxy.family} without an explicit, substantive link to nature or biodiversity must be ` +
      `treated as an adjacent proxy and scored NO.`;
    return {
      kind: "exclusion-line → whatDoesNotConstituteEvidence",
      text: exclusion,
    };
  }
  // fallback: tighten the substantive-detail bar
  return {
    kind: "tightened substantive-detail bar → scoringGuidance",
    text:
      `Award YES only when the disclosure names a specific, verifiable nature/biodiversity ` +
      `mechanism, metric, or commitment tied to "${target}". Generic or aspirational statements ` +
      `without a concrete, measurable detail must be scored NO.`,
  };
}

// ---- build markdown ----
function pct(x: number): string { return (x * 100).toFixed(0) + "%"; }
function num(x: number): string { return x.toFixed(3); }

const lines: string[] = [];
lines.push("# Revision Queue");
lines.push("");
lines.push("_Auto-generated by `server/scripts/revision_queue.ts` (Task G). Read-only over the");
lines.push("multi-run variability outputs; no database access. Each proposed edit below is a");
lines.push("DRAFT for the user to accept or reject — nothing has been written to any measure._");
lines.push("");
lines.push("## Inputs");
lines.push("");
lines.push(`- Run files analysed (canonical \`<companyId>_run<N>.json\`): **${canonicalFiles.length}**`);
lines.push(`- Companies: **${new Set(runs.map((r) => r.meta.companyId)).size}**, measures: **${agg.size}**`);
if (skippedFiles.length) {
  lines.push(`- Skipped non-canonical files (variant / partial): ${skippedFiles.map((f) => "`" + f + "`").join(", ")}`);
}
const anyGate = metrics.some((m) => m.gateFailuresPresent);
lines.push(`- Persisted gate results present in run files: **${anyGate ? "yes" : "no (legacy runs predate the gate; gate-failure counts are 0)"}**`);
lines.push("");
lines.push("## Composite instability score");
lines.push("");
lines.push("`composite = 0.4·flipRate + 0.3·disagreementRate + 0.2·arbiterFireRate + 0.1·gateDowngradeRate`");
lines.push("");
lines.push("- **flipRate** — mean adjacent run-to-run verdict change within a company (0–1)");
lines.push("- **disagreementRate** — fraction of run instances where the two primary models disagree");
lines.push("- **arbiterFireRate** — fraction of run instances where the arbiter fired");
lines.push("- **arbiterOverturns** — of those, how often the arbiter sided with the secondary model");
lines.push("- **gateDowngradeRate** — fraction of instances with a gate downgrade (0 for legacy runs)");
lines.push("");

// ranking table
lines.push("## Ranking (all measures, most unstable first)");
lines.push("");
lines.push("| # | Measure | Category | Composite | Flip | Disagree | Arb fired | Arb overturn | Gate fails |");
lines.push("|---|---------|----------|-----------|------|----------|-----------|--------------|-----------|");
metrics.forEach((m, i) => {
  const gateTotal = Array.from(m.gateFailureCounts.values()).reduce((s, x) => s + x, 0);
  lines.push(
    `| ${i + 1} | ${m.measureId} | ${m.category} | ${num(m.composite)} | ${pct(m.flipRate)} | ${pct(m.disagreementRate)} | ${m.arbiterFired} | ${m.arbiterOverturns} | ${gateTotal} |`
  );
});
lines.push("");

// detailed top-N with proposed edits
lines.push(`## Proposed edits — top ${Math.min(TOP_N, metrics.length)} most unstable measures`);
lines.push("");
metrics.slice(0, TOP_N).forEach((m, i) => {
  const meas = measureById.get(m.measureId);
  const a = agg.get(m.measureId)!;
  const proxy = detectProxy(a);
  const edit = proposeEdit(m);
  const gateTotal = Array.from(m.gateFailureCounts.values()).reduce((s, x) => s + x, 0);

  lines.push(`### ${i + 1}. ${m.measureId} — ${m.title}`);
  lines.push("");
  lines.push(`- **Category:** ${m.category}`);
  lines.push(`- **Instances analysed:** ${m.nInstances} (${m.nCompanies} companies)`);
  lines.push(`- **Composite instability:** ${num(m.composite)}`);
  lines.push(`- **Run-to-run flip rate:** ${pct(m.flipRate)}`);
  lines.push(`- **Inter-model disagreement rate:** ${pct(m.disagreementRate)}`);
  lines.push(`- **Arbiter fired:** ${m.arbiterFired} / ${m.nInstances} (overturned primary ${m.arbiterOverturns}×)`);
  if (gateTotal > 0) {
    const parts = Array.from(m.gateFailureCounts.entries()).map(([r, c]) => `${r}: ${c}`);
    lines.push(`- **Gate failures by reason:** ${parts.join(", ")}`);
  } else {
    lines.push(`- **Gate failures by reason:** none recorded in these run files`);
  }
  lines.push("");
  lines.push("**Observed failure pattern:**");
  if (proxy) {
    lines.push("");
    lines.push(`Unstable positives lean on **${proxy.family}** language (${proxy.hits} matching term occurrences across cited quotes) rather than nature/biodiversity-specific evidence. Example fragment:`);
    lines.push("");
    lines.push(`> ${proxy.sample.replace(/\n/g, " ").trim()}…`);
  } else {
    lines.push("");
    lines.push("No dominant adjacent-proxy family detected in the cited quotes; instability appears driven by borderline substantive-detail judgements rather than a single proxy theme.");
  }
  lines.push("");
  lines.push(`**Proposed edit (${edit.kind}):**`);
  lines.push("");
  lines.push("```");
  lines.push(edit.text);
  lines.push("```");
  lines.push("");
  if (meas?.whatDoesNotConstituteEvidence) {
    lines.push("<details><summary>Current whatDoesNotConstituteEvidence (for reference)</summary>");
    lines.push("");
    lines.push("> " + meas.whatDoesNotConstituteEvidence.replace(/\n/g, "\n> "));
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  lines.push("---");
  lines.push("");
});

writeFileSync(OUT_PATH, lines.join("\n"), "utf8");

// ---- console summary (numbers only, from computed data) ----
console.log(`revision_queue: analysed ${canonicalFiles.length} run files across ${agg.size} measures`);
if (skippedFiles.length) console.log(`  skipped non-canonical: ${skippedFiles.join(", ")}`);
console.log(`  gate results present: ${anyGate ? "yes" : "no (legacy runs)"}`);
console.log(`  top ${Math.min(TOP_N, metrics.length)} by composite instability:`);
metrics.slice(0, TOP_N).forEach((m, i) => {
  console.log(
    `   ${i + 1}. ${m.measureId}  composite=${num(m.composite)}  flip=${pct(m.flipRate)}  disagree=${pct(m.disagreementRate)}  arbFired=${m.arbiterFired}  arbOverturn=${m.arbiterOverturns}`
  );
});
console.log(`  wrote ${OUT_PATH}`);
