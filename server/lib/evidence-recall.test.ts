/**
 * evidence-recall.test.ts — A5 / WP06 committed test suite (RT01–RT06).
 *
 * Proves the retrieval & evidence-pack recall invariants that A5 adds on top of
 * the already-working BM25 retrieval + bounded deep-read second pass. The concern
 * A5 closes is DECISIVE-PASSAGE RECALL AT THE ACTUAL PROMPT BUDGET, and closing a
 * MEASURED miss with a BOUNDED, A3-composing, append-only expansion — not a new
 * retriever. These tests exercise the guardrail directly and deterministically
 * (no DB, no network, no LLM).
 *
 * Mirrors the A2/A3 suite style: plain tsx script, node:assert/strict, a local
 * test() harness with pass/fail counters.
 *
 *   RT01 — synonym / sector language: a decisive passage that uses a measure's
 *          evidenceKeyword (not the exact title words) is still marked decisive
 *          and, once it reaches the pack, counts as recalled.
 *   RT02 — low-frequency / late-report / table evidence: a single rare phrase hit
 *          (e.g. a table cell) is decisive even below the distinct-token bar, and
 *          a bounded expansion can carry it into the input.
 *   RT03 — negative / contradictory evidence is NOT suppressed: a passage that
 *          negates / contradicts is decisive on the same signal and is recalled /
 *          expandable like any other.
 *   RT04 — expansion recovers a miss WITHOUT reintroducing A3-excluded material:
 *          an injected eligibility predicate that excludes one miss guarantees it
 *          never appears in the added set, while an eligible miss is recovered.
 *   RT05 — deterministic stable identity + order: shuffling the input chunk order
 *          yields identical passage ids and identical oracle / plan ordering.
 *   RT06 — trimming / dedup preserves qualifiers + negation + unique links: dedup
 *          only drops a passage when it adds no new decisive token AND its link is
 *          already covered AND it is not a phrase hit.
 *
 * Run: DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub \
 *        npx tsx server/lib/evidence-recall.test.ts
 */

import assert from "node:assert/strict";
import {
  stablePassageId,
  decisiveSignal,
  passageDecisiveHits,
  computeDecisivePassages,
  measurePackRecall,
  planBoundedExpansion,
  formatExpansionAppend,
  resolveRecallExpansionPolicy,
  isRecallExpansionEnforced,
  DEFAULT_RECALL_EXPANSION_POLICY,
  type DecisivePassage,
} from "./evidence-recall.js";
import type { Chunk } from "./passage-retrieval.js";
import type { FrameworkMeasure } from "../../shared/schema.js";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`\u2713 ${name}`);
  } catch (err) {
    fail++;
    console.log(`\u2717 ${name}`);
    console.log(`    ${(err as Error)?.message ?? err}`);
  }
}

// ─── Fixtures (framework-level only; no company/topic hardcoding) ──────────────

// A framework measure whose decisive signal is "board oversight of climate risk".
// evidenceKeywords carry the sector/synonym language the title does not spell out.
const MEASURE: Pick<FrameworkMeasure, "title" | "evidenceKeywords"> = {
  title: "Board oversight of climate-related risk",
  evidenceKeywords: [
    "board oversight",
    "climate risk",
    "scope 3 emissions",
    "greenhouse gas",
    "remuneration committee",
  ] as any,
};

let seq = 0;
function chunk(text: string, docUrl: string, docTitle: string): Chunk {
  return { text, docIndex: 0, docUrl, docTitle, seqInDoc: seq++ };
}

// ─── RT01 ──────────────────────────────────────────────────────────────────
// Synonym / sector language: a passage that does NOT repeat the title words but
// does use the measure's own evidenceKeywords must be marked decisive, and once it
// is in the pack it must count as recalled.
test("RT01: synonym/sector language passage is decisive and recalled at the budget", () => {
  const passages = [
    chunk(
      "The remuneration committee reviews scope 3 emissions and greenhouse gas " +
        "targets as part of executive pay, with board oversight each quarter.",
      "https://issuer.example/sustainability-2025",
      "Sustainability Report 2025",
    ),
    chunk(
      "Our products are sold in forty markets and customer satisfaction rose.",
      "https://i.ytimg.com/vi/FL0KLfOLA5E/maxresdefault.jpg",
      "Marketing Brochure",
    ),
  ];
  const decisive = computeDecisivePassages({ measure: MEASURE, chunks: passages });
  assert.equal(decisive.length, 1, "exactly the sector-language passage is decisive");
  assert.equal(decisive[0].docUrl, "https://issuer.example/sustainability-2025");
  assert.ok(decisive[0].distinctTokens >= 2, "multiple decisive tokens detected");

  // It reached the pack → recall is perfect.
  const packIds = passages.map(stablePassageId);
  const recall = measurePackRecall({ decisive, packPassageIds: packIds });
  assert.equal(recall.recall, 1, "decisive passage present in pack → recall 1.0");
  assert.equal(recall.misses.length, 0);
});

// ─── RT02 ──────────────────────────────────────────────────────────────────
// Low-frequency / late-report / table evidence: a single verbatim phrase hit (a
// rare table cell) is decisive even though it clears neither a high token count
// nor appears early, and a bounded expansion carries it into the input when it was
// crowded out of the budgeted pack.
test("RT02: a low-frequency phrase-hit (table cell) is decisive and recoverable by bounded expansion", () => {
  seq = 0;
  const tableCell = chunk(
    "Scope 3 emissions | 1,240,000 tCO2e | assured",
    "https://issuer.example/annual-2025#table-42",
    "Annual Report 2025 (data tables)",
  );
  const crowd: Chunk[] = [];
  for (let i = 0; i < 5; i++) {
    crowd.push(
      chunk(
        "The board oversight framework and climate risk governance are described " +
          "in detail with greenhouse gas commentary and remuneration committee notes.",
        `https://issuer.example/governance-${i}`,
        `Governance narrative ${i}`,
      ),
    );
  }
  const allChunks = [...crowd, tableCell];
  const decisive = computeDecisivePassages({ measure: MEASURE, chunks: allChunks });
  const tableId = stablePassageId(tableCell);
  const tableDecisive = decisive.find((d) => d.id === tableId);
  assert.ok(tableDecisive, "the rare table-cell phrase hit is in the decisive set");
  assert.equal(tableDecisive!.phraseHit, true, "it qualifies via a verbatim phrase, not token density");

  // Simulate a budgeted pack that admitted only the narrative chunks (table cell
  // crowded out). Recall is < 1 and the table cell is the miss.
  const packChunks = crowd;
  const packIds = packChunks.map(stablePassageId);
  const recall = measurePackRecall({ decisive, packPassageIds: packIds });
  assert.ok(recall.misses.some((m) => m.id === tableId), "table cell is a measured miss");

  // Bounded expansion recovers it (append-only).
  const plan = planBoundedExpansion({
    misses: recall.misses,
    chunks: allChunks,
    packPassageIds: packIds,
    packChunks,
  });
  assert.equal(plan.fired, true, "expansion fires on demonstrated insufficiency");
  assert.ok(plan.added.some((a) => a.id === tableId), "the decisive table cell is recovered");
});

// ─── RT03 ──────────────────────────────────────────────────────────────────
// Negative / contradictory evidence is NOT suppressed: a passage that explicitly
// NEGATES the measure (no board oversight, no scope 3 reporting) is decisive on the
// same framework signal and is recalled / expandable like supporting evidence.
test("RT03: negative/contradictory evidence is decisive and never suppressed", () => {
  seq = 0;
  const negative = chunk(
    "The company has NO board oversight of climate risk and does not report " +
      "scope 3 emissions or greenhouse gas data.",
    "https://issuer.example/gap-disclosure",
    "Governance Gap Note",
  );
  const positive = chunk(
    "Board oversight of climate risk is exercised; scope 3 emissions and " +
      "greenhouse gas targets are reviewed by the remuneration committee.",
    "https://issuer.example/strong",
    "Strong Governance",
  );
  const decisive = computeDecisivePassages({ measure: MEASURE, chunks: [negative, positive] });
  const negId = stablePassageId(negative);
  assert.ok(decisive.some((d) => d.id === negId), "the negating passage is decisive, not filtered out");

  // If the negative passage is crowded out, expansion recovers it (contradictory
  // evidence must reach the scorer).
  const packIds = [stablePassageId(positive)];
  const recall = measurePackRecall({ decisive, packPassageIds: packIds });
  assert.ok(recall.misses.some((m) => m.id === negId), "negative passage is the miss");
  const plan = planBoundedExpansion({
    misses: recall.misses,
    chunks: [negative, positive],
    packPassageIds: packIds,
    packChunks: [positive],
  });
  assert.ok(plan.added.some((a) => a.id === negId), "negative/contradictory passage is recovered");
});

// ─── RT04 ──────────────────────────────────────────────────────────────────
// Expansion recovers a miss WITHOUT reintroducing A3-excluded material. Two
// decisive misses: one eligible, one that the injected A3 predicate excludes (e.g.
// an analyst third-party source). Expansion must add the eligible one and NEVER
// the excluded one, no matter how decisive it is.
test("RT04: bounded expansion composes with A3 — excluded material is never reintroduced", () => {
  seq = 0;
  const excludedThirdParty = chunk(
    "Analyst note: board oversight of climate risk looks weak; scope 3 emissions " +
      "and greenhouse gas disclosure appear incomplete per our remuneration review.",
    "https://thirdparty.example/analyst-coverage",
    "Analyst Coverage (excluded source)",
  );
  const eligibleIssuer = chunk(
    "Issuer filing: board oversight of climate risk with scope 3 emissions and " +
      "greenhouse gas targets set by the remuneration committee.",
    "https://issuer.example/10k",
    "10-K (eligible issuer source)",
  );
  const inPack = chunk(
    "General governance overview with board oversight and climate risk mention.",
    "https://issuer.example/overview",
    "Overview",
  );
  const all = [excludedThirdParty, eligibleIssuer, inPack];
  const decisive = computeDecisivePassages({ measure: MEASURE, chunks: all });
  const packIds = [stablePassageId(inPack)];
  const recall = measurePackRecall({ decisive, packPassageIds: packIds });

  const excludedId = stablePassageId(excludedThirdParty);
  const eligibleId = stablePassageId(eligibleIssuer);
  // A3-composing predicate: exclude the third-party source (mirrors status==="excluded").
  const isEligible = (c: Chunk) => (c.docUrl || "").indexOf("thirdparty.example") === -1;

  const plan = planBoundedExpansion({
    misses: recall.misses,
    chunks: all,
    packPassageIds: packIds,
    isEligible,
    packChunks: [inPack],
  });
  assert.ok(
    plan.added.every((a) => a.id !== excludedId),
    "A3-excluded third-party passage is NEVER reintroduced by expansion",
  );
  assert.ok(plan.added.some((a) => a.id === eligibleId), "the eligible issuer miss IS recovered");
  assert.ok(plan.droppedExcluded >= 1, "the exclusion is accounted for in droppedExcluded");

  // And with EVERYTHING excluded, expansion must not fire at all.
  const planAllExcluded = planBoundedExpansion({
    misses: recall.misses,
    chunks: all,
    packPassageIds: packIds,
    isEligible: () => false,
    packChunks: [inPack],
  });
  assert.equal(planAllExcluded.fired, false, "no eligible miss → expansion does not fire");
  assert.equal(planAllExcluded.added.length, 0);
});

// ─── RT05 ──────────────────────────────────────────────────────────────────
// Deterministic stable identity + order. Shuffling the input chunk order must not
// change any passage id, nor the oracle ordering, nor the expansion plan ordering.
test("RT05: stable passage identity and deterministic ordering under input shuffling", () => {
  seq = 0;
  const a = chunk(
    "Board oversight of climate risk and scope 3 emissions with greenhouse gas data.",
    "https://issuer.example/a",
    "Doc A",
  );
  const b = chunk(
    "Remuneration committee reviews greenhouse gas and scope 3 emissions targets.",
    "https://issuer.example/b",
    "Doc B",
  );
  const c = chunk(
    "Climate risk governance and board oversight across the group's operations.",
    "https://issuer.example/c",
    "Doc C",
  );

  // Identity is content-stable: same text/url/seq → same id regardless of position.
  const idA1 = stablePassageId(a);
  const idA2 = stablePassageId({ text: a.text, docUrl: a.docUrl, seqInDoc: a.seqInDoc, docIndex: 99 });
  assert.equal(idA1, idA2, "id does not depend on positional docIndex when seqInDoc present");

  const forward = [a, b, c];
  const shuffled = [c, a, b];
  const decF = computeDecisivePassages({ measure: MEASURE, chunks: forward });
  const decS = computeDecisivePassages({ measure: MEASURE, chunks: shuffled });
  assert.deepEqual(
    decF.map((d) => d.id),
    decS.map((d) => d.id),
    "oracle ordering is identical regardless of input order",
  );

  // Plan ordering is stable too: miss set in oracle order, dedup/caps deterministic.
  const packIds: string[] = [];
  const planF = planBoundedExpansion({ misses: decF, chunks: forward, packPassageIds: packIds });
  const planS = planBoundedExpansion({ misses: decS, chunks: shuffled, packPassageIds: packIds });
  assert.deepEqual(
    planF.added.map((x) => x.id),
    planS.added.map((x) => x.id),
    "expansion plan ordering is identical regardless of input order",
  );
});

// ─── RT06 ──────────────────────────────────────────────────────────────────
// Trimming / dedup preserves qualifiers + negation + unique links. A pure
// duplicate (same link, no new decisive token, not a phrase hit) is dropped, but a
// passage carrying a NEW decisive token, or a NEW source link, or a phrase hit is
// ALWAYS kept — so every unique decisive fact and source link stays recoverable.
test("RT06: dedup drops only pure duplicates; unique facts/links/negation are preserved", () => {
  seq = 0;
  // Two passages from the SAME source link. The first carries the core tokens; the
  // second adds a NEW qualifier/negation ("without" + a distinct phrase). Dedup
  // must keep BOTH because the second adds a new decisive phrase.
  const first = chunk(
    "Board oversight of climate risk with scope 3 emissions reported.",
    "https://issuer.example/report",
    "Report",
  );
  const secondSameLinkNewFact = chunk(
    "However, greenhouse gas assurance was withdrawn; remuneration committee flagged a gap.",
    "https://issuer.example/report",
    "Report",
  );
  // A true duplicate: same link, tokens already covered, no phrase, no new link.
  const pureDup = chunk(
    "Board oversight and climate risk noted again.",
    "https://issuer.example/report",
    "Report",
  );

  const all = [first, secondSameLinkNewFact, pureDup];
  const decisive = computeDecisivePassages({ measure: MEASURE, chunks: all });

  // Nothing in the pack yet → all decisive passages are misses.
  const plan = planBoundedExpansion({
    misses: decisive,
    chunks: all,
    packPassageIds: [],
    packChunks: [],
  });

  const keptIds = new Set(plan.added.map((a) => a.id));
  assert.ok(keptIds.has(stablePassageId(first)), "first passage kept");
  assert.ok(
    keptIds.has(stablePassageId(secondSameLinkNewFact)),
    "new-qualifier/negation passage on same link is KEPT (unique decisive fact preserved)",
  );

  // Construct an explicit pure duplicate scenario: seed the pack with `first`, then
  // offer only `pureDup` (same link, subset tokens, no phrase) → dropped as redundant.
  seq = 100;
  const seedFirst = chunk(
    "Board oversight of climate risk with scope 3 emissions and greenhouse gas data.",
    "https://issuer.example/seed",
    "Seed",
  );
  // Subset tokens only ("oversight", "risk") and crucially NO decisive phrase
  // ("board oversight" / "climate risk" never appear verbatim) → pure duplicate.
  const redundant = chunk(
    "Oversight of that risk was also noted elsewhere.",
    "https://issuer.example/seed",
    "Seed",
  );
  const all2 = [seedFirst, redundant];
  const dec2 = computeDecisivePassages({ measure: MEASURE, chunks: all2, minDistinct: 1 });
  const packIds2 = [stablePassageId(seedFirst)];
  const recall2 = measurePackRecall({ decisive: dec2, packPassageIds: packIds2 });
  const plan2 = planBoundedExpansion({
    misses: recall2.misses,
    chunks: all2,
    packPassageIds: packIds2,
    packChunks: [seedFirst],
    measure: MEASURE, // pack-aware dedup: seed covered decisive tokens from the pack
  });
  assert.ok(
    plan2.added.every((a) => a.id !== stablePassageId(redundant)),
    "a pure duplicate (same link, no new token, no phrase) is dropped",
  );
  assert.ok(plan2.droppedDuplicate >= 1, "the dropped duplicate is accounted for");
});

// ─── Kill-switch default (standing production behaviour post-GATE5) ────────────
test("kill-switch default is 'on' (post-GATE5 prod behaviour) and env fully overrides", () => {
  const saved = process.env.RECALL_EXPANSION_POLICY;
  delete process.env.RECALL_EXPANSION_POLICY;
  try {
    // Default is now "on": unset env resolves to on and enforces expansion.
    assert.equal(DEFAULT_RECALL_EXPANSION_POLICY, "on");
    assert.equal(resolveRecallExpansionPolicy(), "on", "no env → on (post-GATE5 prod default)");
    assert.equal(isRecallExpansionEnforced(), true, "default now applies the bounded expansion");
    // Unrecognised / typo values fail safe to the shipped default ("on").
    process.env.RECALL_EXPANSION_POLICY = "garbage";
    assert.equal(resolveRecallExpansionPolicy(), "on", "unrecognised value fails safe to default on");
    // Kill-switch still fully overrides without a redeploy: =off restores pre-A5 pack.
    process.env.RECALL_EXPANSION_POLICY = "off";
    assert.equal(resolveRecallExpansionPolicy(), "off", "env off overrides to restore pre-A5 pack");
    assert.equal(isRecallExpansionEnforced(), false, "env off never changes the pack");
    // =shadow overrides to telemetry-only (verdict-invariant).
    process.env.RECALL_EXPANSION_POLICY = "shadow";
    assert.equal(resolveRecallExpansionPolicy(), "shadow", "env shadow overrides to telemetry-only");
    assert.equal(isRecallExpansionEnforced(), false, "shadow never changes the pack");
    // Explicit arg wins over env in every direction.
    assert.equal(resolveRecallExpansionPolicy("off"), "off", "explicit off arg wins over env");
    process.env.RECALL_EXPANSION_POLICY = "off";
    assert.equal(resolveRecallExpansionPolicy("on"), "on", "explicit on arg wins over env off");
  } finally {
    if (saved === undefined) delete process.env.RECALL_EXPANSION_POLICY;
    else process.env.RECALL_EXPANSION_POLICY = saved;
  }
});

// ─── No-op expansion yields a byte-identical append (empty string) ────────────
test("formatExpansionAppend returns '' for a non-firing plan (byte-identical pack)", () => {
  const empty: ReturnType<typeof planBoundedExpansion> = planBoundedExpansion({
    misses: [],
    chunks: [],
    packPassageIds: [],
  });
  assert.equal(empty.fired, false);
  assert.equal(formatExpansionAppend(empty), "", "no-op expansion appends nothing");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
