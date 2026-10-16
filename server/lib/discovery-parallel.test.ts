/**
 * discovery-parallel.test.ts — B3 / WP11 committed test suite (DP01–DP10).
 *
 * Proves the discovery dedupe + bounded parallelism + canonical-source-first
 * invariants that B3 adds behind the DISCOVERY_PARALLEL_POLICY kill-switch. All
 * tests are deterministic and fully OFFLINE (no DB, no network, no LLM): the real
 * search function is injected as a stub, so GATE2 equivalence is exercised with a
 * fixed in-memory query→results corpus.
 *
 * Mirrors the A5/evidence-recall suite style: plain tsx script, node:assert/strict,
 * a local test() harness with pass/fail counters.
 *
 * GATE1 (unit invariants):
 *   DP01 — kill-switch default is "serial" (OFF): resolve/enabled/active report the
 *          shipped-off default, and unrecognised values fail safe to "serial".
 *   DP02 — canonicalisation collapses ONLY provably-identical queries (whitespace /
 *          case), and NEVER merges queries that differ in any meaningful token,
 *          provider, or option.
 *   DP03 — dedupe planner preserves first-occurrence order, never drops a query
 *          from the plan, and counts collapsed redundant calls correctly.
 *   DP04 — bounded parallel executor never exceeds maxParallel in flight and
 *          returns results in INPUT order regardless of completion order.
 *   DP05 — canonical-source-first execution order is a STABLE partition (canonical
 *          units dispatched first; relative order preserved) WITHOUT changing output.
 *   DP06 — concurrency bound resolver clamps to >= 1 and honours env / default.
 *   DP07 — attribution marks the FIRST-yielding query per source; redundant /
 *          collapsed queries contribute ZERO new sources.
 *
 * GATE2 (fixed-corpus equivalence — the release gate):
 *   DP08 — the SET of sources discovered via the deduped+bounded-parallel plan is
 *          IDENTICAL to the serial baseline over a fixed corpus, AND the output
 *          ordering (candidate-accumulation sequence) is identical, AND the call
 *          count under the plan is STRICTLY LESS when near-duplicate queries exist
 *          ("fewer redundant calls, not fewer queries").
 *   DP09 — equivalence holds under an adversarial completion-order stub (slowest
 *          query finishes last) — completion order never leaks into output order.
 *   DP10 — a single failing query is isolated (best-effort) without corrupting the
 *          result array or the discovered set.
 *
 * Run: DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub \
 *        npx tsx server/lib/discovery-parallel.test.ts
 */

import assert from "node:assert/strict";
import {
  DEFAULT_DISCOVERY_PARALLEL_POLICY,
  DISCOVERY_PARALLEL_ENV,
  resolveDiscoveryParallelPolicy,
  isDiscoveryParallelEnabled,
  isDiscoveryParallelActive,
  DEFAULT_DISCOVERY_MAX_PARALLEL,
  DISCOVERY_MAX_PARALLEL_ENV,
  resolveDiscoveryMaxParallel,
  canonicalizeOptions,
  normalizeQueryText,
  canonicalizeQuery,
  planQueryDedupe,
  orderForExecution,
  specIsCanonical,
  runBoundedParallel,
  expandUnitResults,
  buildQueryAttribution,
  runDiscoveryQueryPlan,
  type QuerySpec,
} from "./discovery-parallel.js";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) {
      // Tests are awaited sequentially by the runner below; keep sync accounting.
      throw new Error("use testAsync for async tests");
    }
    pass++;
    console.log(`\u2713 ${name}`);
  } catch (err) {
    fail++;
    console.log(`\u2717 ${name}`);
    console.log(`    ${(err as Error)?.stack ?? (err as Error)?.message ?? err}`);
  }
}
const asyncTests: { name: string; fn: () => Promise<void> }[] = [];
function testAsync(name: string, fn: () => Promise<void>): void {
  asyncTests.push({ name, fn });
}

// ─── DP01 — kill-switch default is serial / OFF ───────────────────────────────

test("DP01 default policy is serial (shipped OFF)", () => {
  assert.equal(DEFAULT_DISCOVERY_PARALLEL_POLICY, "serial");
  assert.equal(DISCOVERY_PARALLEL_ENV, "DISCOVERY_PARALLEL_POLICY");
  const saved = process.env[DISCOVERY_PARALLEL_ENV];
  delete process.env[DISCOVERY_PARALLEL_ENV];
  assert.equal(resolveDiscoveryParallelPolicy(), "serial", "no env → serial");
  assert.equal(isDiscoveryParallelEnabled(), false, "default not enabled");
  assert.equal(isDiscoveryParallelActive(), false, "default path not active");
  // unrecognised value fails safe to serial, never to a behaviour-changing mode
  process.env[DISCOVERY_PARALLEL_ENV] = "parallel-please";
  assert.equal(resolveDiscoveryParallelPolicy(), "serial", "typo → serial");
  process.env[DISCOVERY_PARALLEL_ENV] = "ON";
  assert.equal(resolveDiscoveryParallelPolicy(), "on", "case-insensitive on");
  assert.equal(isDiscoveryParallelEnabled(), true);
  process.env[DISCOVERY_PARALLEL_ENV] = " shadow ";
  assert.equal(resolveDiscoveryParallelPolicy(), "shadow", "trimmed shadow");
  assert.equal(isDiscoveryParallelEnabled(), false, "shadow is not 'enabled'");
  assert.equal(isDiscoveryParallelActive(), true, "shadow IS active");
  // explicit arg overrides env
  assert.equal(resolveDiscoveryParallelPolicy("serial"), "serial");
  if (saved === undefined) delete process.env[DISCOVERY_PARALLEL_ENV];
  else process.env[DISCOVERY_PARALLEL_ENV] = saved;
});

// ─── DP02 — canonicalisation collapses only provably-identical ────────────────

test("DP02 normalizeQueryText collapses whitespace + case only", () => {
  assert.equal(normalizeQueryText('  "Acme Corp"   annual report  '), '"acme corp" annual report');
  assert.equal(normalizeQueryText("Foo\tBar\nBaz"), "foo bar baz");
  // case + whitespace identical ⇒ same normal form
  assert.equal(normalizeQueryText("FOO bar"), normalizeQueryText("foo   BAR"));
  // token order is NOT normalised (would change recall)
  assert.notEqual(normalizeQueryText("foo bar"), normalizeQueryText("bar foo"));
  // punctuation / operators are preserved (would change recall)
  assert.notEqual(normalizeQueryText('site:example.com pdf'), normalizeQueryText('example.com pdf'));
  assert.notEqual(normalizeQueryText('"exact phrase"'), normalizeQueryText("exact phrase"));
  assert.equal(normalizeQueryText(undefined as any), "");
});

test("DP02 canonicalizeOptions is order-insensitive and distinguishes values", () => {
  assert.equal(canonicalizeOptions({ num: 10, tbs: "qdr:y2" }), canonicalizeOptions({ tbs: "qdr:y2", num: 10 }));
  // absent vs explicit-undefined treated the same
  assert.equal(canonicalizeOptions({ num: 10, tbs: undefined }), canonicalizeOptions({ num: 10 }));
  // differing values do NOT collapse
  assert.notEqual(canonicalizeOptions({ num: 10 }), canonicalizeOptions({ num: 5 }));
  assert.notEqual(canonicalizeOptions({ num: 10 }), canonicalizeOptions({ num: 10, gl: "cn" }));
  assert.equal(canonicalizeOptions(null), "{}");
  assert.equal(canonicalizeOptions(undefined), "{}");
});

test("DP02 canonicalizeQuery merges only identical provider+text+opts", () => {
  const a = canonicalizeQuery("  Acme  Report ", "serper", { num: 10 });
  const b = canonicalizeQuery("acme report", "serper", { num: 10 });
  assert.equal(a, b, "whitespace/case-identical queries share a key");
  // different provider ⇒ different key
  assert.notEqual(a, canonicalizeQuery("acme report", "serpapi", { num: 10 }));
  // different opts ⇒ different key
  assert.notEqual(a, canonicalizeQuery("acme report", "serper", { num: 5 }));
  // different text ⇒ different key
  assert.notEqual(a, canonicalizeQuery("acme reports", "serper", { num: 10 }));
});

// ─── DP03 — dedupe planner ────────────────────────────────────────────────────

test("DP03 planQueryDedupe preserves order, drops nothing, counts collapses", () => {
  const specs: QuerySpec[] = [
    { query: "alpha", provider: "serper", opts: { num: 10 } },
    { query: "  ALPHA ", provider: "serper", opts: { num: 10 } }, // dup of #0
    { query: "beta", provider: "serper", opts: { num: 10 } },
    { query: "alpha", provider: "serper", opts: { num: 5 } },     // NOT a dup (opts differ)
    { query: "beta", provider: "serper", opts: { num: 10 } },      // dup of #2
  ];
  const plan = planQueryDedupe(specs);
  assert.equal(plan.totalQueries, 5, "no query dropped from the plan");
  assert.equal(plan.units.length, 3, "3 unique execution units");
  assert.equal(plan.collapsedCount, 2, "2 redundant calls collapsed");
  // first-occurrence order preserved: unit reps are originals #0, #2, #3
  assert.deepEqual(plan.units.map((u) => u.spec.query), ["alpha", "beta", "alpha"]);
  // mapping: every original index maps to its canonical unit
  assert.deepEqual(plan.unitForOriginalIndex, [0, 0, 1, 2, 1]);
  // representative is the FIRST occurrence
  assert.equal(plan.units[0].index, 0);
  assert.equal(plan.units[1].index, 2);
  assert.equal(plan.units[2].index, 3);
});

test("DP03 empty / non-array input is total", () => {
  const plan = planQueryDedupe([]);
  assert.equal(plan.units.length, 0);
  assert.equal(plan.totalQueries, 0);
  assert.equal(plan.collapsedCount, 0);
  const plan2 = planQueryDedupe(undefined as any);
  assert.equal(plan2.totalQueries, 0);
});

// ─── DP06 — concurrency bound resolver ────────────────────────────────────────

test("DP06 resolveDiscoveryMaxParallel clamps and honours env/default", () => {
  assert.equal(DEFAULT_DISCOVERY_MAX_PARALLEL, 4);
  assert.equal(DISCOVERY_MAX_PARALLEL_ENV, "DISCOVERY_MAX_PARALLEL");
  const saved = process.env[DISCOVERY_MAX_PARALLEL_ENV];
  delete process.env[DISCOVERY_MAX_PARALLEL_ENV];
  assert.equal(resolveDiscoveryMaxParallel(), 4, "default 4");
  assert.equal(resolveDiscoveryMaxParallel(8), 8, "explicit arg wins");
  assert.equal(resolveDiscoveryMaxParallel(0), 4, "0 is invalid → default");
  assert.equal(resolveDiscoveryMaxParallel(-3), 4, "negative → default");
  process.env[DISCOVERY_MAX_PARALLEL_ENV] = "6";
  assert.equal(resolveDiscoveryMaxParallel(), 6, "env honoured");
  process.env[DISCOVERY_MAX_PARALLEL_ENV] = "0";
  assert.equal(resolveDiscoveryMaxParallel(), 4, "env 0 → default (never deadlock)");
  process.env[DISCOVERY_MAX_PARALLEL_ENV] = "garbage";
  assert.equal(resolveDiscoveryMaxParallel(), 4, "env garbage → default");
  if (saved === undefined) delete process.env[DISCOVERY_MAX_PARALLEL_ENV];
  else process.env[DISCOVERY_MAX_PARALLEL_ENV] = saved;
});

// ─── DP05 — canonical-source-first ordering ───────────────────────────────────

test("DP05 orderForExecution is a stable canonical-first partition", () => {
  const specs: QuerySpec[] = [
    { query: "q0", canonical: false },
    { query: "q1", canonical: true },
    { query: "q2", canonical: false },
    { query: "q3", canonical: true },
    { query: "q4", canonical: false },
  ];
  const plan = planQueryDedupe(specs, (s) => s.query); // key by query text so all unique
  const order = orderForExecution(plan.units, specIsCanonical);
  // canonical units (idx 1,3) first in relative order, then rest (0,2,4)
  assert.deepEqual(order, [1, 3, 0, 2, 4]);
  // it is a permutation of all unit indices (nothing lost)
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

// ─── runner for async tests ───────────────────────────────────────────────────

// DP04 — bounded parallel executor
testAsync("DP04 runBoundedParallel caps concurrency and returns input order", async () => {
  const N = 12;
  const items = Array.from({ length: N }, (_, i) => i);
  let inFlight = 0;
  let maxInFlight = 0;
  const bound = 4;
  const results = await runBoundedParallel(
    items,
    async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Stagger completion: later items finish SOONER, so completion order != input order.
      await new Promise((r) => setTimeout(r, (N - item) * 2));
      inFlight--;
      return item * 10;
    },
    bound,
  );
  assert.ok(maxInFlight <= bound, `maxInFlight ${maxInFlight} must be <= ${bound}`);
  assert.ok(maxInFlight >= 2, "should actually run in parallel");
  // results in INPUT order despite reversed completion order
  assert.deepEqual(results, items.map((i) => i * 10));
});

testAsync("DP04 runBoundedParallel executionOrder changes dispatch, not output", async () => {
  const items = ["a", "b", "c", "d"];
  const started: string[] = [];
  const results = await runBoundedParallel(
    items,
    async (item) => {
      started.push(item);
      await new Promise((r) => setTimeout(r, 1));
      return item.toUpperCase();
    },
    1, // bound 1 so dispatch order == started order deterministically
    { executionOrder: [2, 0, 3, 1] },
  );
  assert.deepEqual(started, ["c", "a", "d", "b"], "dispatched in executionOrder");
  assert.deepEqual(results, ["A", "B", "C", "D"], "output still in INPUT order");
});

testAsync("DP04 runBoundedParallel empty input is total", async () => {
  const results = await runBoundedParallel([], async () => 1, 4);
  assert.deepEqual(results, []);
});

// DP07 — attribution
testAsync("DP07 attribution marks first-yielding query; redundant = 0 new", async () => {
  // Two near-duplicate queries (collapse) + genuine queries with overlapping results.
  const specs: QuerySpec[] = [
    { query: "alpha", provider: "serper", opts: { num: 10 } },
    { query: " ALPHA ", provider: "serper", opts: { num: 10 } }, // collapses onto #0
    { query: "beta", provider: "serper", opts: { num: 10 } },
  ];
  const plan = planQueryDedupe(specs);
  // unit results: unit0(alpha) → [u1,u2]; unit1(beta) → [u2,u3]  (u2 shared)
  const unitResults: string[][] = [
    ["u1", "u2"],
    ["u2", "u3"],
  ];
  const attr = buildQueryAttribution(specs, plan, unitResults, (r) => r);
  assert.equal(attr.length, 3);
  // #0 executed → first to yield u1,u2
  assert.equal(attr[0].executed, true);
  assert.deepEqual(attr[0].newSources, ["u1", "u2"]);
  // #1 is the collapsed duplicate → executed=false, zero new
  assert.equal(attr[1].executed, false);
  assert.deepEqual(attr[1].newSources, []);
  // #2 executed → only u3 is new (u2 already seen)
  assert.equal(attr[2].executed, true);
  assert.deepEqual(attr[2].newSources, ["u3"]);
});

// ─── GATE2 — fixed-corpus equivalence (the release gate) ──────────────────────

// A fixed in-memory corpus: canonical query text → the source ids it returns.
// Deterministic; identical for both serial and planned execution.
const CORPUS: Record<string, string[]> = {
  "alpha report": ["s1", "s2", "s3"],
  "beta filing": ["s3", "s4"],          // s3 overlaps alpha
  "gamma disclosure": ["s5"],
  "delta governance": ["s2", "s6"],      // s2 overlaps alpha
  "registry lookup": ["s7", "s1"],       // s1 overlaps alpha; canonical source
};

function makeStub(opts?: { order?: "normal" | "reverse"; failKey?: string }) {
  let calls = 0;
  const callLog: string[] = [];
  const search = async (spec: QuerySpec): Promise<string[]> => {
    calls++;
    const key = normalizeQueryText(spec.query);
    callLog.push(key);
    if (opts?.failKey && key === opts.failKey) {
      await new Promise((r) => setTimeout(r, 1));
      throw new Error(`stub failure for ${key}`);
    }
    // completion-order adversary: reverse makes earlier-input queries finish LAST
    const delay = opts?.order === "reverse" ? 1 : 1;
    await new Promise((r) => setTimeout(r, delay));
    return CORPUS[key] ? [...CORPUS[key]] : [];
  };
  return { search, getCalls: () => calls, callLog };
}

// Serial baseline: run every query in order, accumulate the discovered SET + the
// exact accumulation sequence (first occurrence of each source wins — this is the
// addCandidate/seenUrls semantics in discovery.ts).
async function serialBaseline(specs: QuerySpec[], search: (s: QuerySpec) => Promise<string[]>) {
  const seen = new Set<string>();
  const order: string[] = [];
  let calls = 0;
  for (const spec of specs) {
    calls++;
    const res = await search(spec);
    for (const id of res) {
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  return { set: seen, order, calls };
}

// Planned path: dedupe + bounded parallel + canonical-first, then consume results
// in ORIGINAL input order (exactly as webSearchBatch callers iterate).
async function plannedPath(
  specs: QuerySpec[],
  search: (s: QuerySpec) => Promise<string[]>,
  maxParallel: number,
) {
  const { results } = await runDiscoveryQueryPlan<string[]>(specs, search, {
    maxParallel,
    isCanonical: specIsCanonical,
  });
  const seen = new Set<string>();
  const order: string[] = [];
  for (const res of results) {
    for (const id of res || []) {
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  return { set: seen, order };
}

testAsync("DP08 planned set == serial set, same order, FEWER calls with near-dups", async () => {
  // Query list with NEAR-DUPLICATES (whitespace/case variants) interleaved — the
  // query SET is preserved; only redundant CALLS should be removed.
  const specs: QuerySpec[] = [
    { query: "alpha report", provider: "serper", opts: { num: 10 } },
    { query: "beta filing", provider: "serper", opts: { num: 10 } },
    { query: "  ALPHA   report ", provider: "serper", opts: { num: 10 } }, // dup of #0
    { query: "gamma disclosure", provider: "serper", opts: { num: 10 } },
    { query: "delta governance", provider: "serper", opts: { num: 10 } },
    { query: "Beta   Filing", provider: "serper", opts: { num: 10 } },     // dup of #1
    { query: "registry lookup", provider: "serper", opts: { num: 10 }, canonical: true },
  ];

  const stubA = makeStub();
  const baseline = await serialBaseline(specs, stubA.search);

  const stubB = makeStub();
  const planned = await plannedPath(specs, stubB.search, 4);

  // SET identical (B3 Lane-B equivalence — any difference blocks release)
  assert.deepEqual(
    [...planned.set].sort(),
    [...baseline.set].sort(),
    "discovered SET must be identical to serial",
  );
  // accumulation ORDER identical (completion order must not leak out)
  assert.deepEqual(planned.order, baseline.order, "accumulation order must match serial");
  // CALL COUNT strictly less (2 near-dups collapsed): 7 queries → 5 calls
  assert.equal(baseline.calls, 7, "serial issues one call per query");
  assert.equal(stubB.getCalls(), 5, "planned collapses 2 redundant calls");
  assert.ok(stubB.getCalls() < baseline.calls, "fewer redundant CALLS, not fewer QUERIES");
});

testAsync("DP09 equivalence under adversarial completion order + varying bounds", async () => {
  const specs: QuerySpec[] = [
    { query: "alpha report", provider: "serper", opts: { num: 10 } },
    { query: "delta governance", provider: "serper", opts: { num: 10 } },
    { query: "beta filing", provider: "serper", opts: { num: 10 } },
    { query: "registry lookup", provider: "serper", opts: { num: 10 }, canonical: true },
    { query: "gamma disclosure", provider: "serper", opts: { num: 10 } },
  ];
  const baseline = await serialBaseline(specs, makeStub().search);
  for (const bound of [1, 2, 3, 8]) {
    const planned = await plannedPath(specs, makeStub({ order: "reverse" }).search, bound);
    assert.deepEqual([...planned.set].sort(), [...baseline.set].sort(), `set @bound=${bound}`);
    assert.deepEqual(planned.order, baseline.order, `order @bound=${bound}`);
  }
});

testAsync("DP10 a single failing query is isolated (best-effort)", async () => {
  const specs: QuerySpec[] = [
    { query: "alpha report", provider: "serper", opts: { num: 10 } },
    { query: "beta filing", provider: "serper", opts: { num: 10 } },   // will fail
    { query: "gamma disclosure", provider: "serper", opts: { num: 10 } },
  ];
  const stub = makeStub({ failKey: "beta filing" });
  const { results } = await runDiscoveryQueryPlan<string[]>(specs, stub.search, {
    maxParallel: 4,
    onItemError: () => [],
  });
  assert.equal(results.length, 3, "result array stays full-length");
  assert.deepEqual(results[0], ["s1", "s2", "s3"]);
  assert.deepEqual(results[1], [], "failed query yields [] not a hole");
  assert.deepEqual(results[2], ["s5"]);
});

// ─── run ──────────────────────────────────────────────────────────────────────

(async () => {
  for (const t of asyncTests) {
    try {
      await t.fn();
      pass++;
      console.log(`\u2713 ${t.name}`);
    } catch (err) {
      fail++;
      console.log(`\u2717 ${t.name}`);
      console.log(`    ${(err as Error)?.stack ?? (err as Error)?.message ?? err}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
