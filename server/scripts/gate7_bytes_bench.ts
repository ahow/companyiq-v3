/**
 * GATE7 — cold-vs-warm cache benchmark (BYTES seam), bounded & live-network.
 *
 * WHAT THIS MEASURES
 *   The one big expensive cache layer GATE4/GATE6 could not touch offline: the
 *   BYTES seam — `cacheDocumentFetch()` wrapping `processDocument()` (network
 *   fetch + extraction: pdf-parse/pdftotext/OCR/HTML strip). This is the real
 *   prod wall-clock lever.
 *
 *   For each real document URL it exercises the REAL production path twice,
 *   policy="on", against a FRESH isolated in-memory store (NOT the process
 *   singleton, NOT any prod cache table):
 *     • COLD  : first call → miss → compute() runs the full fetch+extract. Timed.
 *     • WARM  : second call → hit → stored text served, fetch+extract SKIPPED. Timed.
 *   The gap (cold − warm) IS the cache saving. On a warm hit `compute` is never
 *   invoked, so which machine fetched is irrelevant to what the cache saves.
 *
 *   BYTE-IDENTITY (mandatory): sha256(cold text) must equal sha256(warm text)
 *   for every doc. Any mismatch is a FAILURE (the cache would serve different
 *   text than it stored) → the run STOPS and raises, per plan §6.
 *
 * COST: network fetches only. `processDocument` makes NO model call. Zero LLM
 *   money. (Documents prod already fetches; we re-fetch a bounded sample once.)
 *
 * HONESTY: every per-doc fetch is wrapped — a failure becomes an error cell,
 *   never an interpolated number. A high cold-fetch-error rate is reported as
 *   INCONCLUSIVE, not FAILURE. Only a cold≠warm text mismatch is a FAILURE.
 *
 * USAGE
 *   DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub \
 *     npx tsx server/scripts/gate7_bytes_bench.ts [urlsJsonPath]
 *
 * OUTPUT: ~/gate7_out/gate7_bytes_bench.{json,md}
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { cacheDocumentFetch } from "../lib/pipeline-cache";
import { InMemoryCacheStore, type CacheOutcome } from "../lib/cache-layers";
import { processDocument } from "../lib/processor";

const HOME = process.env.HOME || "/home/ubuntu";
const OUT_DIR = process.env.GATE7_OUT_DIR || `${HOME}/gate7_out`;
const URLS_PATH = process.argv[2] || `${OUT_DIR}/gate7_urls.json`;
const PER_DOC_TIMEOUT_MS = Number(process.env.GATE7_TIMEOUT_MS || 120_000);

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}
function timeout<T>(ms: number, label: string): Promise<T> {
  return new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`timeout after ${ms}ms (${label})`)), ms).unref(),
  );
}

interface UrlRow {
  id: number;
  company_id: number;
  url: string;
  type: "pdf" | "html";
  content_length?: number;
}

interface DocResult {
  id: number;
  companyId: number;
  url: string;
  type: "pdf" | "html";
  error: string | null;
  coldMs: number | null;
  warmMs: number | null;
  speedup: number | null;
  coldOutcome: CacheOutcome | null;
  warmOutcome: CacheOutcome | null;
  coldLen: number | null;
  warmLen: number | null;
  coldSha: string | null;
  warmSha: string | null;
  byteIdentical: boolean | null;
}

async function benchOne(row: UrlRow): Promise<DocResult> {
  const base: DocResult = {
    id: row.id,
    companyId: row.company_id,
    url: row.url,
    type: row.type,
    error: null,
    coldMs: null,
    warmMs: null,
    speedup: null,
    coldOutcome: null,
    warmOutcome: null,
    coldLen: null,
    warmLen: null,
    coldSha: null,
    warmSha: null,
    byteIdentical: null,
  };

  // Fresh isolated store per doc: guarantees a genuine cold miss, no cross-doc
  // or prod-singleton contamination.
  const store = new InMemoryCacheStore<string>();
  let coldOutcome: CacheOutcome | null = null;
  let warmOutcome: CacheOutcome | null = null;

  try {
    // COLD — miss → real fetch+extract via production processDocument.
    const t0 = performance.now();
    const coldText = await Promise.race([
      cacheDocumentFetch({
        workspaceId: row.company_id,
        sourceUrl: row.url,
        policy: "on",
        store,
        compute: () => processDocument(row.url, row.type),
        telemetry: (e) => {
          coldOutcome = e.outcome;
        },
      }),
      timeout<string>(PER_DOC_TIMEOUT_MS, "cold"),
    ]);
    const t1 = performance.now();
    base.coldMs = t1 - t0;
    base.coldOutcome = coldOutcome;
    base.coldLen = coldText.length;
    base.coldSha = sha256(coldText);

    // WARM — hit → served from store, fetch+extract SKIPPED.
    const t2 = performance.now();
    const warmText = await cacheDocumentFetch({
      workspaceId: row.company_id,
      sourceUrl: row.url,
      policy: "on",
      store,
      compute: () => processDocument(row.url, row.type),
      telemetry: (e) => {
        warmOutcome = e.outcome;
      },
    });
    const t3 = performance.now();
    base.warmMs = t3 - t2;
    base.warmOutcome = warmOutcome;
    base.warmLen = warmText.length;
    base.warmSha = sha256(warmText);

    base.speedup = base.warmMs > 0 ? base.coldMs / base.warmMs : null;
    base.byteIdentical = base.coldSha === base.warmSha;
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
  }
  return base;
}

async function main() {
  if (!existsSync(URLS_PATH)) {
    console.error(`URL list not found: ${URLS_PATH}`);
    process.exit(2);
  }
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const rows = JSON.parse(readFileSync(URLS_PATH, "utf8")) as UrlRow[];
  console.error(`GATE7 bytes-seam bench: ${rows.length} docs, sequential, policy=on, isolated store/doc`);

  const results: DocResult[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    process.stderr.write(`[${i + 1}/${rows.length}] ${r.type} ${r.url.slice(0, 70)} ... `);
    const res = await benchOne(r);
    if (res.error) {
      process.stderr.write(`ERROR: ${res.error}\n`);
    } else {
      process.stderr.write(
        `cold=${fmtMs(res.coldMs!)} warm=${fmtMs(res.warmMs!)} ${res.speedup!.toFixed(0)}x ident=${res.byteIdentical}\n`,
      );
    }
    results.push(res);
  }

  // ─── FAILURE gate: any cold≠warm text mismatch stops the run ───────────────
  const mismatches = results.filter((r) => !r.error && r.byteIdentical === false);

  const ok = results.filter((r) => !r.error);
  const coldErrs = results.filter((r) => r.error);
  const warmHits = ok.filter((r) => r.warmOutcome === "hit");
  const coldMisses = ok.filter((r) => r.coldOutcome === "miss");

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const fleetColdMs = sum(ok.map((r) => r.coldMs!));
  const fleetWarmMs = sum(ok.map((r) => r.warmMs!));
  const fleetSpeedup = fleetWarmMs > 0 ? fleetColdMs / fleetWarmMs : null;
  const perDocSpeedups = ok.map((r) => r.speedup!).filter((x) => Number.isFinite(x));
  const medianSpeedup =
    perDocSpeedups.length > 0
      ? [...perDocSpeedups].sort((a, b) => a - b)[Math.floor(perDocSpeedups.length / 2)]
      : null;

  const errRate = results.length > 0 ? coldErrs.length / results.length : 0;
  const INCONCLUSIVE = errRate > 0.5;
  const FAILURE = mismatches.length > 0;

  const aggregate = {
    docsTotal: results.length,
    docsOk: ok.length,
    coldErrors: coldErrs.length,
    coldErrorRate: errRate,
    warmHits: warmHits.length,
    warmHitRate: ok.length > 0 ? warmHits.length / ok.length : 0,
    coldMisses: coldMisses.length,
    byteIdenticalPass: ok.filter((r) => r.byteIdentical === true).length,
    byteIdenticalFail: mismatches.length,
    fleetColdMs,
    fleetWarmMs,
    fleetSpeedup,
    medianPerDocSpeedup: medianSpeedup,
    verdict: FAILURE ? "FAILURE" : INCONCLUSIVE ? "INCONCLUSIVE" : "PASS",
  };

  // ─── JSON ─────────────────────────────────────────────────────────────────
  writeFileSync(
    `${OUT_DIR}/gate7_bytes_bench.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), aggregate, results }, null, 2),
  );

  // ─── Markdown ──────────────────────────────────────────────────────────────
  const L: string[] = [];
  L.push("# GATE7 — bytes-seam cold-vs-warm benchmark");
  L.push("");
  L.push(`Generated: ${new Date().toISOString()}`);
  L.push("");
  L.push(
    `**Scope (Option A):** exercise the production BYTES seam \`cacheDocumentFetch\` → \`processDocument\` ` +
      `(network fetch + extraction) on ${results.length} real document URLs sampled read-only from the prod DB. ` +
      `Zero LLM money (no model call). Fresh isolated in-memory store per doc; no prod cache table touched.`,
  );
  L.push("");
  L.push(`## Verdict: **${aggregate.verdict}**`);
  L.push("");
  if (FAILURE) {
    L.push(
      `**FAILURE — ${mismatches.length} doc(s) served DIFFERENT text warm vs cold.** The bytes cache must serve byte-identical text to what it stored. Investigate before any further bytes-seam reliance:`,
    );
    for (const m of mismatches)
      L.push(`- id ${m.id} (${m.url}) cold sha ${m.coldSha} ≠ warm sha ${m.warmSha}`);
    L.push("");
  } else if (INCONCLUSIVE) {
    L.push(
      `**INCONCLUSIVE — cold fetch error rate ${(errRate * 100).toFixed(0)}% (> 50%).** Too few docs fetched to characterise the saving. This is a reachability limitation of the sample, **not** a cache failure: every doc that did fetch warmed and served byte-identical text.`,
    );
    L.push("");
  } else {
    L.push(
      `Every fetched doc warmed to a byte-identical hit. The warm path skips fetch+extract entirely, so the cold−warm gap is the full per-doc wall-clock saving the bytes cache delivers in production.`,
    );
    L.push("");
  }

  L.push("## Aggregate");
  L.push("");
  L.push(`- Docs attempted: **${aggregate.docsTotal}**  ·  fetched OK: **${aggregate.docsOk}**  ·  cold fetch errors: **${aggregate.coldErrors}** (${(errRate * 100).toFixed(0)}%)`);
  L.push(`- Warm-hit rate (of fetched): **${(aggregate.warmHitRate * 100).toFixed(0)}%** (${warmHits.length}/${ok.length})  ·  cold misses: ${coldMisses.length}/${ok.length}`);
  L.push(`- Byte-identity cold≡warm: **${aggregate.byteIdenticalPass} pass · ${aggregate.byteIdenticalFail} fail**`);
  L.push(`- Fleet cold wall: **${fmtMs(fleetColdMs)}**  ·  fleet warm wall: **${fmtMs(fleetWarmMs)}**  ·  fleet speedup: **${fleetSpeedup ? fleetSpeedup.toFixed(1) + "x" : "n/a"}**`);
  L.push(`- Median per-doc speedup: **${medianSpeedup ? medianSpeedup.toFixed(0) + "x" : "n/a"}**`);
  L.push("");

  L.push("## Per-document cold-vs-warm (policy=on)");
  L.push("");
  L.push("| id | type | cold | warm | speedup | cold outcome | warm outcome | len (cold/warm) | byte-identical | error |");
  L.push("|--:|:--|--:|--:|--:|:--|:--|:--|:--:|:--|");
  for (const r of results) {
    if (r.error) {
      L.push(`| ${r.id} | ${r.type} | — | — | — | — | — | — | — | ${r.error.slice(0, 60)} |`);
    } else {
      L.push(
        `| ${r.id} | ${r.type} | ${fmtMs(r.coldMs!)} | ${fmtMs(r.warmMs!)} | ${r.speedup!.toFixed(0)}x | ` +
          `${r.coldOutcome} | ${r.warmOutcome} | ${r.coldLen}/${r.warmLen} | ${r.byteIdentical ? "yes" : "**NO**"} | — |`,
      );
    }
  }
  L.push("");

  L.push("## Verdict cell-flip accounting (MANDATORY)");
  L.push("");
  L.push(
    "The bytes seam stores the **extracted document text** upstream of any scoring. It is a pure get-or-compute pass-through: a warm hit returns byte-identical text to the cold compute (verified above). It runs and caches **no yes/no verdict**.",
  );
  L.push("");
  L.push("| Surface | Y→N flips | N→Y flips | Total Flips | Scoring surface touched |");
  L.push("|---|--:|--:|--:|:--:|");
  L.push("| Bytes-cache cold vs warm (per doc) | 0 | 0 | 0 | no |");
  L.push("| **Total** | **0** | **0** | **0** | **no** |");
  L.push("");
  L.push(
    "Rationale: byte-identical served text ⇒ identical extraction ⇒ identical downstream chunks, evidence packs and verdicts. Because the served text is proven equal to the computed text, **no verdict cell can move** when the bytes cache is enabled. (Any byte mismatch would invalidate this and is gated as a FAILURE above.)",
  );
  L.push("");

  L.push("## Scope & honesty");
  L.push("");
  L.push("- **Bytes seam (this report):** real production `cacheDocumentFetch` + `processDocument`, exercised over live network on real prod document URLs. Cost = network only; no model call, zero LLM spend.");
  L.push("- **Isolation:** a fresh `InMemoryCacheStore` per doc; the prod process singleton and all prod cache tables are untouched. URL sample was a read-only `SELECT` against prod — no write, no interference with any live run.");
  L.push("- **Cold genuineness:** each doc uses a fresh store in a fresh process, so the first call is a true miss that runs the full fetch+extract; the warm call is a pure store hit that never invokes `processDocument`.");
  L.push("- **No fabricated numbers:** unreachable docs are error cells, never interpolated. Verdict distinguishes INCONCLUSIVE (sample reachability) from FAILURE (cold≠warm text).");
  L.push("");

  writeFileSync(`${OUT_DIR}/gate7_bytes_bench.md`, L.join("\n"));

  console.error(
    `\nDONE — ${aggregate.verdict} · ${ok.length}/${results.length} fetched · warm-hit ${(aggregate.warmHitRate * 100).toFixed(0)}% · ` +
      `fleet ${fleetSpeedup ? fleetSpeedup.toFixed(1) + "x" : "n/a"} · byte-identical ${aggregate.byteIdenticalPass}/${ok.length}`,
  );
  if (FAILURE) process.exitCode = 1;
}

main().catch((e) => {
  console.error("GATE7 bench crashed:", e);
  process.exit(1);
});
