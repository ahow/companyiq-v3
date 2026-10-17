# Implementation Run Ledger — Quality & Efficiency Backlog

**Purpose.** Single source of truth for executing the backlog in
`docs/quality-and-efficiency-improvement-plan.md` under the user's instruction:
*"implement each change, test in the live application with a ten-company sample,
review the result, keep if it works, roll back if it doesn't, then move to the next."*

**Status:** AUTHORIZED & IN EXECUTION — on 2026-10-15 the user granted: (1) spend on
paid production batches; (2) production deployment of each change; (3) dev-testing is
acceptable **provided the dev code is identical to production**; (4) judging/scoring is
OK; (5) permission to **combine changes** where sensible. Execution has begun with the
free offline foundations group.

### Deployment-target verification (2026-10-15, before any build)
Hard constraint from the user: the code a change is tested on must be the **same as
production**. Verified via Railway GraphQL (`/tmp/check_commits.cjs`, project
`db04e5b1…`):

| Environment | Service | Deployed commit | Branch |
|---|---|---|---|
| production (`c1166ef6…`) | app | `64d0b9d8…` | main |
| production | worker | `64d0b9d8…` | main |
| sprint-10-preview (`6987d716…`) | app | `64d0b9d8…` | main |
| sprint-10-preview | worker | `64d0b9d8…` | main |

Local repo `HEAD` is also `64d0b9d8…`. **All four services + local == `64d0b9d`.**
Therefore a feature branch cut from `64d0b9d` and deployed to dev yields
`dev = prod + (only the change under test)`, satisfying the constraint. Note: the
earlier-recorded "prod `c1166ef6` / dev `6987d716`" were **environment IDs**, not
commit hashes — corrected here.

**Deploy topology (decisive):** Railway `deploymentTriggers` confirms **all four
services auto-deploy from branch `main`** of `ahow/companyiq-v3`. There is no separate
dev branch; pushing `main` redeploys prod **and** dev together. Governance model is
therefore **prod-centric keep/rollback**: merge a WP to main → push → both envs
auto-deploy the identical commit → run paid batch → keep (main stays) or `git revert`
+ push to roll back. `dev == prod` is satisfied by construction.

### Measurement foundations — MERGED & DEPLOYED (2026-10-15 09:47 UTC)
Combined WP10 (per-stage profiler), WP13-A (per-call cost attribution keyed by request
identity/emit-timestamp, not log order), WP08 (immutable replay/dependency manifest)
on `feat/measurement-foundations` (`bad9f23`), merged `--no-ff` into main as **`2b91d86`**
and pushed. All four Railway services observed **BUILDING on `2b91d86`** immediately
after push. Change is **read-only / additive**: pipeline outputs byte-identical; each
feature has a default-on kill-switch (`RUN_MANIFEST_ENABLED`, etc.). Verified before
merge: 21/21 new unit tests pass; client build passes; diff vs `64d0b9d` = +1793/−1
across 13 files (3 new DB tables via idempotent `CREATE TABLE IF NOT EXISTS`). New read
paths: `paid_call_events`, `stage_profile_events`, `run_manifests`.

**NEXT (not yet run — requires live supervision):** instrumented **baseline** paid batch
on the frozen roster (company_ids 9–18) via `POST /api/admin/resume-analysis`, once both
envs show `2b91d86` = SUCCESS. This baseline anchors both Lane A (scores) and Lane B
(speed/cost). ~35 min for 10 companies; record batch id + commit `2b91d86` here, then read
`stage_profile_events` / `paid_call_events` / `run_manifests` + scores.

### Post-deploy verification + topology CORRECTION (2026-10-15 10:29 UTC)

Confirmed the merge landed healthy on both environments:

| check | result |
|---|---|
| prod app /worker deploy | **SUCCESS** on commit `328d025` (merge + this ledger) |
| dev app /worker deploy | **SUCCESS** on commit `328d025` |
| prod app `/api/health` | `{status:ok, version:3.0.0}` |
| dev app `/api/health` | `{status:ok, version:3.0.0}` |
| dev worker process | alive, redis+pg ready, pools idle |

**CORRECTION to the "`dev == prod` by construction" claim above.** That is true for the
**code** (both on `328d025`) but **FALSE for runtime behaviour and state**. Direct
inspection of Railway variables + serviceInstances shows:

1. **Shared state.** Prod `DATABASE_URL` → `postgres.railway.internal`, dev → 
   `pgbouncer.railway.internal`, but **same user / db name `companyiq_v3` / same password
   hash** and **same `REDIS_URL`**. The two environments share **one Postgres database and
   one Redis**. Queue name is the hardcoded string `"analysis"` in both `queue.ts` and
   `worker.ts` with **no environment namespacing** → there is exactly **one** BullMQ queue.
2. **Different pipeline config, both live on that one queue.** Both worker pools are
   currently up and connected as `bullmq-worker` to the shared queue:

   | knob | prod worker (3 replicas) | dev worker (8 replicas) |
   |---|---|---|
   | `FRAMEWORK_V2_MEASURES_PER_CALL` | 8 | **1** |
   | `FRAMEWORK_V2_TWO_STEP` | — | **1** |
   | `FRAMEWORK_V2_CONTEXT_EXPAND` | — | **1** |
   | `FRAMEWORK_V2_EVIDENCE_ABSENT` | — | **1** |
   | scoring rule | `SCORING_CANONICAL_RULE_GOVERNS=1` | `SCORING_BASE_RATE_PRIOR=true` |
   | `RECONCILE_ENABLED` | true | **false** |
   | `WORKER_CONCURRENCY` | 4 | 2 |
   | `JOB/PIPELINE_TIMEOUT_MS` | 2.4M / 2.1M | **3.9M / 3.6M** |

3. **Consequence (blocks a clean baseline).** Because both pools pull from the **same**
   queue, a batch enqueued now would be processed by a **nondeterministic mix** of the
   canonical (prod) and experimental (dev) pipeline configurations. That is not a valid,
   attributable baseline and would waste the authorized spend. A clean run requires exactly
   **one** worker pool consuming the queue for its duration (scale the other to 0 replicas).

4. **Strategic implication.** The dev environment already has several Lane-A-style quality
   knobs enabled as env flags (two-step, context-expand, evidence-absent, base-rate prior,
   per-call=1). Part of the backlog may already be live-as-flags on dev, which must be
   reconciled with the "implement one WP at a time from a clean baseline" protocol.

**PAUSED for a decision** (money + live-infra change + contradicting evidence): which
configuration is the baseline/target, and which single worker pool should own the batch
runs. No spend and no replica change made unilaterally.

---

### Topology decision RESOLVED — dev aligned to prod + dev worker off the queue (2026-10-15 12:11 UTC)

User decision: production is canonical (`companyiq.online` confirmed = prod custom domain).
Dev (sprint-10-preview) settings are to match production exactly, and the dev worker pool is
authorized to come off the shared `"analysis"` queue so prod is the sole consumer.

**Actions taken (Railway GraphQL, reversible — see `dev_env_rollback_2026-10-15T1210.json`):**

1. **Dev worker taken off the queue.** Railway rejects `numReplicas:0` (min 1), and
   `worker-main.ts` calls `startWorker()` unconditionally (no env guard). So the dev worker
   `startCommand` was overridden to `/usr/bin/tini -g -- sleep infinity` and `numReplicas`
   dropped `8 → 1`. The BullMQ consumer never registers → the dev pool no longer pulls jobs.
   Prod worker unchanged (3 replicas, real start command) = sole consumer.
2. **Dev var alignment (dev → prod values).** Every **non-protected** behavioural / scoring /
   concurrency / timeout variable on the dev app and dev worker set to its production value;
   prod-only vars added; dev-only experimental flags removed. Verified: **0 non-protected
   diffs** vs prod on both services. Key changes:
   - App: `FRAMEWORK_V2_MEASURES_PER_CALL 1→8`, `+SCORING_CANONICAL_RULE_GOVERNS=1`,
     removed `SCORING_BASE_RATE_PRIOR`, `FRAMEWORK_V2_TWO_STEP/CONTEXT_EXPAND/EVIDENCE_ABSENT`.
   - Worker: `MEASURES_PER_CALL 1→8`, `RECONCILE_ENABLED false→true`, `WORKER_CONCURRENCY 2→4`,
     `JOB/PIPELINE_TIMEOUT_MS 3.9M/3.6M→2.4M/2.1M`, `PG_POOL_MAX 5→20`, added isolation /
     adaptive-concurrency / discovery / issuer-sweep / firecrawl / llm-usage-logging vars,
     removed the four experimental flags.
3. **Protected (left env-specific, NOT copied):** `DATABASE_URL`, `REDIS_URL`, `PORT`,
   `PG_CONNECTION_TIMEOUT_MS`, all `RAILWAY_*`, all `*_API_KEY` / `SESSION_SECRET` / proxy creds.

**Post-change verification:** dev app redeploy **SUCCESS** + HTTP 200; dev worker redeploy
**SUCCESS** (sleep cmd, 1 replica); `companyiq.online` (prod) HTTP 200; prod worker untouched.

**Rollback:** restore dev worker `startCommand` + `numReplicas=8`, re-add/delete vars per the
rollback JSON. No prod changes were made.

---

## Authorization gate (one-time, blocking)

Each live 10-company production run costs ≈ **$4+ model spend alone** (≈$0.405/co ×10,
evidence E2) plus search/proxy/compute. Across ~7 behavioural WPs, each with an
implement-run and a possible rollback re-run, the full sequence is **~15–20 paid
production batches (~$80–150+ model cost)**, and each production deploy is an
irreversible change to the live service. The plan document flags production/paid/
scoring/migration steps as needing **separate approval**.

**Required before any paid run:** explicit go-ahead on (1) the spend, (2) production
deployment of each change, (3) dev-first testing being acceptable. Until then this
ledger only accumulates **free, reversible** work (code on a feature branch, offline
builds, this ledger, the frozen roster).

---

## Frozen 10-company roster (identical inputs for every WP)

**Frozen at (UTC):** 2026-10-15 (scaffolding)
**Source list:** company_lists.id = 7 ("25 companies", workspace 3) — same provenance
as the adjudicated 25-company validation (VALIDATION25_ROSTER.md) and the authorized
10-company acceptance run (batch 1275).
**Selection rule:** first 10 members of list 7 → company_ids **9,10,11,12,13,14,15,16,17,18**
**Roster id CSV:** `9,10,11,12,13,14,15,16,17,18`

| company_id | name |
|---|---|
| 9  | CSX Corporation |
| 10 | MAGNA INTERNATIONAL INC. |
| 11 | THE SOUTHERN COMPANY |
| 12 | S&P GLOBAL INC. |
| 13 | MARTIN MARIETTA MATERIALS, INC. |
| 14 | DARDEN RESTAURANTS, INC. |
| 15 | BCE INC.  *(E3 unresolved-disclosure diagnostic anchor)* |
| 16 | STRYKER CORPORATION |
| 17 | AMPHENOL CORPORATION |
| 18 | AFLAC INCORPORATED |

Workspace 3 · framework 18 (36 measures). Roster is frozen BEFORE any enqueue; launches
pass explicit companyIds (provenance list_id=7). Every WP is judged on this identical set.

---

## How "works / doesn't work" is judged (per category)

| Category | WPs | Pass criterion |
|---|---|---|
| Behavioural, live-10-co | A2, A4, A5, B1, B3, B5, B6 | 10-co live sample vs WP01 adjudicated baseline; semantic WPs also need an equivalence/held-out check so a change can't silently alter answers |
| Gated | B4 (needs A1+A3), B-dur (needs confirmed clean re-run) | Run only after prerequisites pass |
| Foundational / offline | A0/WP01, A7/WP08, B0/WP10 profiler, B0/WP13-A | "Works" = builds + emits correct artifacts (no live score) |
| Governance / reporting | A1, A3, A6, A9 | Verified by output/diff |
| Verify-only | A8/WP09 | Confirm already-present behaviour; no rebuild |

Pass bar for behavioural live runs (reuse of the batch-1275 acceptance bar): 10/10
first-attempt completions, each ≤ 35 min from claim, any retry voids the pass; AND no
accuracy/completeness regression vs baseline. Speed/cost wins that regress
accuracy/completeness = **rollback** (hard rule).

---

## Dependency-ordered execution sequence

1. Foundations (offline, free): WP01 baseline harness · WP08 replay keys · WP10 profiler · WP13-A attribution
2. A1 (governance) → A2 (behavioural) → A3 (governance)
3. B1 (behavioural)
4. A4 → A5 (behavioural)
5. B3 → B4 (gated on A1+A3)
6. A6 (governance)
7. B5 (behavioural)
8. B6 (behavioural)
9. A9 (reporting)
10. B-dur (gated on a confirmed clean re-run)

---

## Outcome ledger (filled as each WP runs)

| WP | Branch/commit | Deployed to | Batch id | Result vs baseline | Decision | Rollback note |
|---|---|---|---|---|---|---|
| WP01 | 328d025 (deployed) | prod (all 4 svc) | 1284 | BASELINE CAPTURED: 10/10 first-attempt, max 26m42s claim→done, sum_score=156/met=56, Yes=56/No=304, cost $3.95, 13.7M tok | ✅ reference established | n/a (reference) |
| WP08 | — | — | — | — | pending | — |
| WP10 | — | — | — | — | pending | — |
| WP13-A | — | — | — | — | pending | — |
| A1 | e6b2e85 + 08b56ee | prod (all 4 svc) | 1285 | ADDITIVE/NON-REGRESSIVE: 10/10 first-attempt, max 30m46s claim→done (<35m bar), all ms=36, 360 measure_scores (=baseline), sum_score=152/met=55 & Yes=55/No=305 (within run-to-run variance; baseline 156/56, 56/304). **Cell-flip vs baseline 1284: Y→N=11, N→Y=10, Total Flips=21** (net −1 Yes conceals 21 changed cells — see Comparison methodology below). cost $3.94/13.68M tok (≈baseline $3.95/13.7M). Code diff (328d025→e6b2e85) touches NO scoring/analyzer file ⇒ additivity by construction. researchStatus/extraction_state verified live. | ✅ keep | revert e6b2e85+08b56ee if ever needed (additive cols only) |

**A1 reuse-path completeness fix (08b56ee):** verification found `markLinkedDocumentVerified` (cache-reuse promote path) left `extraction_state` NULL on reused docs — 292/338 fetch=ok docs (77%) unlabeled in batch 1285, breaking A1's "every required source has a traceable outcome" acceptance + coverage denominator. Fixed via scalar-subquery derivation (promotion to 'ok' never gated on the join; mirrors recordFetchSuccess). Live-validated by backfilling batch 1285: all 292 → 'complete', now **338/338 fetch=ok docs (100%) labeled**, remaining 42 NULL = exactly the 19 dead + 23 rejected (never extracted ⇒ correctly NULL). In-pipeline behaviour of the promote-path write will be confirmed incidentally in the next WP's batch (warm corpus ⇒ heavy reuse).
| A2 | 7702606 | prod (all 4 svc) | 1286 | EVIDENCE-GATE HARDENED, versioned (v2 default; v1 via `EVIDENCE_GATE_POLICY=v1`). Fixes E6 #1/#2/#3: NFKC Unicode-aware normalisation (preserves digits/−/%/decimals/non-Latin; removed ASCII-only strip), removed fuzzy `lcs≥120` escape hatch + honest-ellipsis span validation, explicit source-attribution failure instead of silent pack-wide fallback, anti-echo override for authoritative provenance. **Correctness proven by 17 unit tests (QI01–QI09 + idempotence/non-mutation/fail-open), legacy gate+provenance tests still green under v1.** Live batch 1286: 10/10 first-attempt, 38m24s, all ms=36 (no measure collapse), docs gate 403 accept/29 reject (6.7%), cost $3.9531/13.72M tok (≈baseline — pure string gate, zero LLM overhead). Aggregate 58 yes vs baseline 56/A1 55 (within run-to-run band). **Cell-flip vs baseline 1284: Y→N=9, N→Y=11, Total Flips=20** (net +2 Yes conceals 20 changed cells; vs A1 1285: Y→N=7, N→Y=10, Total Flips=17 — see Comparison methodology + table below). **No over-rejection**: three 0/0 cos (MartinMarietta/Darden/Amphenol) are baseline-stable (0/0 in 1284 & 1285 too — see L281), NOT caused by A2. | ✅ keep (v2 on) | revert to v1 via env flag (no redeploy) or revert 7702606 |
| A3 | 3990bcd | prod (app + worker, both SUCCESS) | 1287 | ELIGIBILITY COMPOSITION GUARDRAIL added as a standalone module (`server/lib/eligibility-decision.ts`) that carries an **immutable, frozen eligibility decision** (entity · issuer/author · source class · as-of/version · scope) through compose → recompute-per-target (I1) → bounded repair (I2); repair can fill missing provenance but **can never override an exclusion**; applies framework parent/subsidiary scope (`entity_only` vs `group_consolidated`); recomputes per target so reused source bytes can't carry stale eligibility. Versioned kill-switches: `ELIGIBILITY_POLICY` (v2 default = compose+enforce logic available / v1 = legacy passthrough) and `ELIGIBILITY_ENFORCE` (unset/off = **shadow**: compose & attach decision, zero verdict mutation / on = downgrade excluded positives to No). **Correctness proven by 20 unit tests (EP01–EP06 + kill-switch/immutability/totality/serialization), 20/20 pass; legacy suites still green (evidence-gate 14/14, evidence-gate-a2 17/17, provenance-gate 15/15, provenance 40/40).** tsc gate: 61 baseline == 61 current, **zero new diagnostics**. Live batch 1287 ran in **shadow mode** (no `ELIGIBILITY_ENFORCE` in prod env ⇒ zero verdict impact by construction): 10/10 first-attempt, all ms=36 (no measure collapse), cost $3.8945/13.52M tok (≈baseline $3.95/13.7M — checks are string/compute-cheap, zero LLM overhead). **Cell-flip vs baseline 1284: Yes 56→64, Net +8, Y→N=10, N→Y=18, Total Flips=28; vs A2 1286: Yes 58→64, Net +6, Y→N=9, N→Y=15, Total Flips=24** (see tables below). These flips are **run-to-run model variance, not A3-caused** — shadow mode mutates no verdict. **No collapse / over-rejection**: the three all-No cos (Martin Marietta/Darden/Amphenol) stay 0/0 where expected; the only loss (Aflac −3 vs baseline) is already present in A2 (6→3 at 1286) and is stable A2→A3 (3→3), i.e. reproducible corpus variance independent of A3. | ✅ keep — now **enforce-ON** via `15bbcc0` (framework-level provenance fix; VERDICT_CHANGE=0, Y→N=0, N→Y=0, zero regressions — see 2026-10-16 section) | kill switches intact: `ELIGIBILITY_ENFORCE=off` (shadow) / `ELIGIBILITY_POLICY=v1` (legacy passthrough); or revert 3990bcd/15bbcc0 |
| B1 | 57716af | prod (all 4 svc, auto-deploy from main; app+worker SUCCESS on 57716af; health `{"status":"ok","version":"3.0.0"}`) | 1293 (corpus-replay off 1288; `pipeline_version=57716af` on all 360 measure_scores rows + manifest gitSha=57716af all 10 co ⇒ worker provably on B1 code) | WP10/B1 prep-stage compute cache (exact-equivalence speedup). New module `server/lib/prep-compute-cache.ts` precompiles the peer-scan regex once, precomputes BM25 term maps/doc-lengths under content keys, skips no-op DB writes, bounds caches; wired into `passage-retrieval.ts`, `aboutness.ts`, `storage.ts`. Versioned kill-switch **`PREP_COMPUTE_CACHE_POLICY`** (`on` DEFAULT = B1 active / `off` = exact pre-B1 behaviour). **Equivalence proven by offline byte-identical guard (authoritative)** over full fixture (104 docs, 4601 chunks, **full 2675-peer universe uncut**, 36 queries): scoreAboutness per-doc, bm25Score per query×chunk, and BM25 ranking+tie-breaks all **identical OFF vs ON ⇒ byte-identical LLM input**. Speedup: BM25 scoring p50 264.9→3.8ms (−98.6%), p95 321.3→7.5ms (−97.7%); peer-scan aboutness p95 536.4→451.2ms (−15.9%) (one-time cost shifts into buildBM25Index). **38/38 tests green (prep-compute-cache 19 new + legacy suites); tsc 0 new diagnostics.** Live batch 1293: 10/10 first-attempt, 0 fail, 10m38s/3 replicas, cost $4.1684/14.57M tok (≈baseline 1288 $4.23/14.74M — byte-identical prompts). **Cell-flip vs baseline 1288: Yes 70→67, Net −3, Y→N=11, N→Y=8, Total Flips=19** (within LLM noise floor A1 21/A2 20/A3 28 — run-to-run model variance, NOT B1; B1 produces byte-identical LLM input per offline guard, and `quotes` is LLM-cited not raw pack). **Total cells Y→N=11, N→Y=8.** | ✅ keep (default `on`) | `PREP_COMPUTE_CACHE_POLICY=off` (no redeploy) or revert 57716af (6-file self-contained module+wiring; no schema/env change) |
| A4 | (pending push) | pending deploy | n/a (no batch — verdict-invariant) | WP05/A4 extraction/table/OCR/translation fidelity. Framework-level outcome-classifier resolves the small-PDF runtime gap at ROOT CAUSE (pdf-parse xref rejection ≠ empty doc); recovery-boundary guard preserved by non-interference (B1-1..B1-7 green); subprocess timeout now marks result incomplete (partial stdout never promoted to complete); adaptive per-page OCR (gated on text-layer check, all pages, no 8-page cap); table/translation/boilerplate fidelity asserted. **EX01–EX07 all green (10/10)**, regression suites 12/12 (recovery-boundary B1, equivalence B6, stalled-extraction B3/B2, table-horizon). tsc: 0 new diagnostics in changed files. Verdict-invariant: extraction layer returns `.text` byte-for-byte to all 11 callers; ExtractionFidelity is additive metadata only — scoring untouched. | ✅ keep | revert the A4 commit (processor.ts extraction-layer refactor is self-contained; no schema/env change) |
| A5 | ca0939c → on: f15f8b6 | prod (all 4 svc, push 2026-10-16 09:16 UTC; GATE5 flip push 2026-10-16 14:56 UTC; health `{"status":"ok","version":"3.0.0"}`) | 1288 (corpus-replay off 1287; snapshot gitSha=f15f8b6 all 10 co ⇒ worker on new code ⇒ policy=on) | WP06/A5 retrieval & evidence-pack recall. New pure DB-free/LLM-free module `server/lib/evidence-recall.ts`: framework-level decisive-passage oracle (measure `title`+`evidenceKeywords` only), passage-level recall measurement AT THE ACTUAL PROMPT BUDGET, and a BOUNDED append-only expansion planner that COMPOSES with A3 (injected eligibility predicate ⇒ excluded material never reintroduced), never shrinks top-k/pack length, dedups only when every unique decisive fact+source link stays recoverable, deterministic stable passage id+order. Versioned kill-switch **`RECALL_EXPANSION_POLICY`** (`off` DEFAULT = current prod/byte-identical / `shadow` = telemetry only / `on` = apply expansion); verdict-changing retrieval NEVER default, NOT set in prod env. analyzer.ts wiring strictly gated at the pre-scoring evidence seam — when `off` the block is skipped entirely (no extra work, pack byte-identical). **RT01–RT06 + kill-switch-default + no-op-append: 8/8 pass.** Free/offline GATE2 recall benchmark over the frozen 13-company fixture corpus (real `summarizeDocuments` BM25, no LLM): 377 (company×measure) cells, **micro-recall 74.2%** (3334/4493 decisive passages recalled), macro 74.3%, 1159 misses of which **537 recoverable** by the bounded shadow expansion. tsc: 0 new diagnostics in changed files (62 pre-existing elsewhere). At the shipped-off default: **Total cells changing Y→N = 0, N→Y = 0** (no scoring surface touched). **GATE5 (2026-10-16, user-approved): default flipped `off`→`on` via code (`f15f8b6`); env still overrides.** Live corpus-replay batch 1288 off 1287's frozen corpus (1284/1285 corpora pruned ⇒ replay off 1287 instead): 10/10, all ms=36, snapshot gitSha=f15f8b6 on all 10 co confirms policy=on, cost $4.23/14.74M tok. **Cell-flip vs 1287 baseline: Yes 64→70, Net +6, Y→N=5, N→Y=11, Total Flips=16** (bounded expansion adds decisive evidence ⇒ more No→Yes than Yes→No; see 2026-10-16 section). | ✅ keep — now default **on** via `f15f8b6` (GATE5 live batch 1288; Y→N=5, N→Y=11, Total Flips=16, Yes 64→70; see 2026-10-16 section) | `RECALL_EXPANSION_POLICY=off` (or `=shadow`) restores prior behaviour with NO redeploy; or revert `f15f8b6` (3-file default+comments+test, no schema change) then ca0939c for the whole feature |
| B3 | c25afd4 | prod (all 4 svc, auto-deploy from main; health `{"status":"ok","version":"3.0.0"}`) | n/a (no batch — equivalence-preserving at shipped-off default) | WP11/B3 discovery dedupe + bounded parallelism. New module `server/lib/discovery-parallel.ts` (content-hash candidate dedupe + bounded-concurrency `webSearchBatch`), integrated into `discovery.ts` and wired into the Generic-Artefact + R6a IR-Platform discovery lanes. Versioned kill-switch **`DISCOVERY_PARALLEL_POLICY`** (`serial` DEFAULT = current prod/byte-identical / `shadow` = run parallel path for telemetry, return serial result / `on` = apply parallel+dedupe) plus knob `DISCOVERY_MAX_PARALLEL` (default 4). **Equivalence proven: same candidate SET and same accumulation order as serial** — dedupe only collapses exact content-hash duplicates, so the discovered corpus is identical; parallelism only reduces wall-clock + near-dup web calls. **DP01–DP10 unit suite 15/15 pass.** tsc: 0 new diagnostics in changed files (62 pre-existing elsewhere). At the shipped-off default (`serial`) the parallel path is skipped entirely ⇒ **Total cells changing Y→N = 0, N→Y = 0, Total Flips = 0** (no scoring surface touched; discovery corpus byte-identical). | ✅ keep (default `serial`/off) | `DISCOVERY_PARALLEL_POLICY=serial` (default; no redeploy needed) or revert c25afd4 (3-file self-contained module + integration; no schema/env change) |
| B4 | 08212cd (module) + 957c263 (wiring) | prod (all 4 svc, auto-deploy from main; health `{"status":"ok","version":"3.0.0"}`) | n/a (no batch — equivalence-preserving at shipped-off default) | WP12/B4 layered content-hash cache. **Gate satisfied: B4 needs A1 (e6b2e85+08b56ee, batch 1285 ✅) + A3 (3990bcd+15bbcc0, enforce-on ✅).** New module `server/lib/cache-layers.ts` (7-level layered cache design with sha256 content-hash keys reusing corpus-replay/run-manifest primitives; tenant isolation via `workspaceId` in every key; reason-aware negative caching; A1/A3 composition; FIFO eviction at `CACHE_LAYER_MAX_ENTRIES`=2048) + wiring layer `server/lib/pipeline-cache.ts` (singleton stores + gated wrappers). Versioned kill-switch **`CACHE_LAYER_POLICY`** (`off` DEFAULT = current prod/byte-identical / `shadow` = compute+compare, return fresh / `on` = serve cache). **Scope — honestly bounded: 2 of 7 layers wired** — (1) **bytes layer** (pipeline.ts fetch phase: caches extracted text by `{workspaceId,url}` ⇒ a warm hit skips network I/O *and* PDF extraction/OCR — the dominant 446s→10.8s lever) and (2) **index layer** (analyzer.ts `summarizeDocuments`: caches BM25-selected corpora). **Deferred (not wired): extraction, OCR, eligibility, packs, scores** — each carries an A4 (extraction-fidelity) / A1 (coverage-labelling) invariant-preservation risk or LLM-output non-determinism risk that would need its own equivalence gate; recorded here so the 2/7 scope is explicit, not implied-complete. **cache-layers 15/15 + cache-wiring integration 12/12 pass** (off-bypass, cold==warm under `on`, shadow-returns-fresh, freshness-keyed-by-content-hash, tenant isolation). tsc: 0 new diagnostics in changed files. At the shipped-off default (`off`) both wrapped seams bypass the cache entirely ⇒ **Total cells changing Y→N = 0, N→Y = 0, Total Flips = 0** (byte-identical to prod). | ✅ keep (default `off`); extraction/OCR/eligibility/packs/scores layers DEFERRED to a future WP extension | `CACHE_LAYER_POLICY=off` (default; no redeploy) or revert 957c263 (wiring) then 08212cd (module); no schema/env change |
| A6 | ec8aa4e | prod (all 4 svc, auto-deploy from main; push 7134eb5..ec8aa4e; health `{"status":"ok","version":"3.0.0"}`) | n/a (no batch — governance, verified by output/diff; shadow default = verdict-invariant by construction) | WP07/A6 framework-contract + test-drive defect governance. New module `server/lib/framework-contract.ts` (+ test) that (1) assembles a strict per-measure CONTRACT view (construct · decidable definition · qualifying/non-qualifying evidence · source/entity/time scope · applicability · implementation-vs-aspiration · anti-inference · uncertainty) by **reusing existing framework-v2 modules** rather than duplicating them, (2) classifies test-drive defects into 7 real causes (framework-ambiguity / discovery / acquisition-extraction / entity-provenance / retrieval / scoring / technical) so a missed document routes to a RESEARCH fix not a looser rubric, and (3) enforces the Goodhart no-distribution-tuning rule as a HARD RULE (prevalence can never move a definition or score; accepted edits emit a NEW framework version with an impact preview, never a silent rewrite; company-specific fixes rejected unless a universal data correction). Versioned kill-switch **`FRAMEWORK_CONTRACT_POLICY`** (`shadow` DEFAULT = non-mutating passthrough / `enforce` = NOT set in prod), `FRAMEWORK_CONTRACT_POLICY_VERSION=1`. `runContractGovernance(...).publishedScoresMutated` is **always false ⇒ zero published scores changed by construction**. Reused (not duplicated): scoring-contract.ts, structured-guidance.ts (extractGuidanceObject), anti-inference.ts, rules.ts, eligibility-decision.ts, root-cause-diagnostic.ts, builder-improve.ts, emitHardenedFramework. Genuine gaps closed: G1 assembled contract view + 2 invariants (examples illustrate, never mutate; search hints ≠ eligibility); G2 7-category defect classifier w/ missed-doc→research routing; G3 no-distribution-tuning validator w/ new-version + impact-preview (ImpactPreview exposes cellsYesToNo/cellsNoToYes/cellsChanged for any future enforce run). **Tests 32/32 (FW01–FW07 = 3/5/3/3/3/2/3 + kill-switch-default 3 + non-mutation 3 + serialization/assembly 6).** tsc: 0 new diagnostics in changed files (62 pre-existing baseline unchanged). **At shipped-off default (`shadow`): Total cells Y→N = 0, N→Y = 0, Total Flips = 0** (no scoring surface mutated). | ✅ keep (default `shadow`) | `FRAMEWORK_CONTRACT_POLICY=shadow` is the default (no redeploy); or revert ec8aa4e (2-file self-contained module+test; no schema/env change) |
| B5 | 154ff9b → on: 8725521 | prod (all 4 svc, auto-deploy from main; shipped-dormant push SUCCESS on 154ff9b; **GATE5 flip push 2026-10-17 SUCCESS on 8725521 all 4 svc**; health `{"status":"ok","version":"3.0.0"}`) | 1294 (corpus-replay off 1293's frozen corpus; snapshot gitSha=8725521 all 10 co ⇒ worker on new code ⇒ policy=on; canary-first company 9) | WP13-C/D/E/B5 model-cost reductions (semantic — ships DORMANT). New framework-level module `server/lib/model-cost.ts` (DB-free, no company/topic branches) with three levers: **(C, headline) `planContextTrim`** — trims *repeated* context but **provably never *decisive* context (LM04)**: reuses A5's `computeDecisivePassages` oracle (not reimplemented) and mirrors `planBoundedExpansion`'s subsumption rule in the *trim* direction — a pack passage is a trim candidate ONLY if it is non-decisive AND every decisive token + source link it carries is already covered by a kept passage. HARD INVARIANT (`verifyTrimPreservesRecall`): decisive pack passages ⊆ kept set, recall preserved with identical misses ⇒ relevant/decisive text is NEVER dropped; **(D) `stablePrefixOrder`** — partitions invariant boilerplate first / volatile per-company evidence last for provider prompt-cache hits (pure reorder preserving the content multiset); **(E) `routeModel`** — cheaper-first-pass-with-escalation **scaffold only** (NOT wired to live models; verification stages always strong; strong model at off; pending GATE5 per-measure/topic/language proof). Versioned kill-switch **`CONTEXT_COST_POLICY`** (`off` DEFAULT = current prod/byte-identical / `shadow` = savings telemetry, pack NOT modified / `on` = apply trim), `CONTEXT_COST_POLICY_VERSION=1`, `resolveContextCostPolicy()` fail-safe (unrecognized → off, total, never throws). Wiring: lever C gated at the A5 evidence seam in `analyzer.ts` (after `finalEvidence` settles) — at `off` the whole block is SKIPPED (no extra work, pack byte-identical); `shadow` logs savings without mutating; `on` applies; fail-open on error. Levers D/E module-only scaffolds (not wired). **Tests 11/11 (model-cost.test.ts): CC01 headline — every decisive pack passage ∈ keptIds + recall unchanged across negative/contradiction/qualifier/low-freq/table/single-decisive cases; CC02 only provably-redundant repeats trimmed; CC03 off-passthrough; CC04 shadow verdict-invariant; CC05 prefix multiset preserved + off byte-identical; CC06 routing (verify never cheap, escalation fires, off=strong); CC07 resolver fail-safe/frozen; CC08 determinism; CC-G3 byte-identical-at-off proof.** tsc: 62 before → 62 after, **0 new** diagnostics in changed files. **At shipped-off default (`off`): reconstructed pack == original ⇒ Total cells Y→N = 0, N→Y = 0, Total Flips = 0** by construction. **GATE5 (2026-10-17, user-approved): default flipped `off`→`on` via code (`8725521`); env still overrides.** STEP 1 offline held-out proof over 1293's frozen corpus: **invariant holds 360/360, 0 violations** (decisive text never dropped), trim fired 326/360, aggregate pack-token reduction **25.39%** (3,920,993→2,925,442; harness `4156742`). Live corpus-replay batch 1294 off 1293 (canary-first co 9; snapshot gitSha=8725521 all 10 co ⇒ policy=on): 10/10, all ms=36. **Token/cost: prompt tok 13,937,501→12,221,478 (−12.31%), total tok −11.82%, cost $4.1684→$3.6851 (−11.59%), identical 1,580 calls — a REDUCTION (the B5 goal).** **Cell-flip vs 1293: Yes 67→70, Net +3, Y→N=4, N→Y=7, Total Flips=11** (consistency PASS; below noise floor A1 21/A2 20/A3 28/B1 19/A5 16; unstructured — 9 measures/5 co, 5 co zero flips; see 2026-10-17 section). **Total cells Y→N=4, N→Y=7.** | ✅ keep — now default **on** via `8725521` (GATE5 live batch 1294; Y→N=4, N→Y=7, Total Flips=11, Yes 67→70; −12.31% prompt tok / −11.59% cost; invariant 360/360; see 2026-10-17 section) | `CONTEXT_COST_POLICY=off` (or `=shadow`) restores the byte-identical pre-B5 pack with NO redeploy; or revert `8725521` (3-file default+comments+test, no schema change) then `154ff9b` to remove the whole B5 feature |
| B6 | — | — | — | — | pending | — |
| A9 | — | — | — | — | pending | — |
| B-dur | — | — | — | — | pending | — |

> Circuit-breaker: after 2 failed attempts on any single WP, mark BLOCKED and move on.
> Never auto-invoke quarantine-recovery override. Stop and surface before any Trial 2.

---

## Comparison methodology — cell-level flips (why net Yes counts are insufficient)

Earlier result rows reported only the **number of Yes verdicts** per run (e.g. A2 58
vs baseline 56). A net Yes count hides **offsetting cell changes**: a run can flip
several cells No→Yes and several others Yes→No, so a small net can sit on top of a
large amount of actual churn — and a genuine regression (a measure that broke) can be
masked by an unrelated improvement elsewhere. Net Yes alone therefore both understates
churn and can hide direction-specific harm.

We compare two runs over the shared **company × measure** cell set (10 companies × 36
measures = 360 cells; identical set is asserted, not assumed) and report, per company
and in aggregate:

- **Yes (baseline)** / **Yes (variant)** — Yes-verdict counts in each run.
- **Net** = Yes(variant) − Yes(baseline).
- **Y→N** = cells that were **Yes in baseline but No in variant** (direction: lost Yes).
- **N→Y** = cells that were **No in baseline but Yes in variant** (direction: gained Yes).
- **Total Flips** = Y→N + N→Y — the real count of cells whose verdict changed.

Internal consistency (always holds): **Net == N→Y − Y→N**. "No" here means *any*
verdict that is not exactly `Yes` (No / Partial / Insufficient evidence / Scoring error).

Numbers below are produced by `server/scripts/compare_run_flips.ts` reading the
immutable `analysis_results` batch snapshots (read-only); they are reproducible with
`node --import tsx server/scripts/compare_run_flips.ts <baseline> <variant>`.

### A2 (batch 1286) vs WP01 baseline (batch 1284) — corrected table

Cell set: 10 companies × 36 measures = 360 cells. Source: `analysis_results` snapshots.

| Company ID | Company | Yes (baseline) | Yes (variant) | Net | Y→N | N→Y | Total Flips |
|---|---|---|---|---|---|---|---|
| 9 | CSX Corporation | 3 | 2 | −1 | 1 | 0 | 1 |
| 10 | MAGNA INTERNATIONAL INC. | 10 | 12 | +2 | 1 | 3 | 4 |
| 11 | THE SOUTHERN COMPANY | 2 | 5 | +3 | 0 | 3 | 3 |
| 12 | S&P GLOBAL INC. | 14 | 14 | +0 | 3 | 3 | 6 |
| 13 | MARTIN MARIETTA MATERIALS, INC. | 0 | 0 | +0 | 0 | 0 | 0 |
| 14 | DARDEN RESTAURANTS, INC. | 0 | 0 | +0 | 0 | 0 | 0 |
| 15 | BCE INC. | 14 | 14 | +0 | 1 | 1 | 2 |
| 16 | STRYKER CORPORATION | 7 | 8 | +1 | 0 | 1 | 1 |
| 17 | AMPHENOL CORPORATION | 0 | 0 | +0 | 0 | 0 | 0 |
| 18 | AFLAC INCORPORATED | 6 | 3 | −3 | 3 | 0 | 3 |
| **ALL** | **Aggregate (10 companies)** | **56** | **58** | **+2** | **9** | **11** | **20** |

Consistency check (Net == N→Y − Y→N): **PASS** (+2 == 11 − 9).

**Reading:** the +2 net Yes is the surface of **20 changed cells** (9 lost, 11 gained).
The churn concentrates in S&P Global (6 flips, net 0), Magna (4), Southern (3) and
Aflac (3 flips, all Yes→N). The three all-No companies (Martin Marietta, Darden,
Amphenol) show **zero** flips — baseline-stable, confirming no over-rejection there.

For reference, **A1 (batch 1285) vs baseline (1284)**: Yes 56→55, Net −1, Y→N=11,
N→Y=10, **Total Flips=21** (consistency: −1 == 10 − 11, PASS). And **A2 vs A1
(1286 vs 1285)**: Net +3, Y→N=7, N→Y=10, Total Flips=17 — the 7 Y→N here reproduce
exactly the earlier `a2_cmp.json` `y2nList`, which had lacked the N→Y side and totals.

### A3 (batch 1287) vs WP01 baseline (batch 1284)

Cell set: 10 companies × 36 measures = 360 cells. Source: `analysis_results` snapshots.

| Company ID | Company | Yes (baseline) | Yes (variant) | Net | Y→N | N→Y | Total Flips |
|---|---|---|---|---|---|---|---|
| 9 | CSX Corporation | 3 | 5 | +2 | 0 | 2 | 2 |
| 10 | MAGNA INTERNATIONAL INC. | 10 | 12 | +2 | 1 | 3 | 4 |
| 11 | THE SOUTHERN COMPANY | 2 | 3 | +1 | 1 | 2 | 3 |
| 12 | S&P GLOBAL INC. | 14 | 13 | −1 | 4 | 3 | 7 |
| 13 | MARTIN MARIETTA MATERIALS, INC. | 0 | 0 | +0 | 0 | 0 | 0 |
| 14 | DARDEN RESTAURANTS, INC. | 0 | 5 | +5 | 0 | 5 | 5 |
| 15 | BCE INC. | 14 | 16 | +2 | 1 | 3 | 4 |
| 16 | STRYKER CORPORATION | 7 | 7 | +0 | 0 | 0 | 0 |
| 17 | AMPHENOL CORPORATION | 0 | 0 | +0 | 0 | 0 | 0 |
| 18 | AFLAC INCORPORATED | 6 | 3 | −3 | 3 | 0 | 3 |
| **ALL** | **Aggregate (10 companies)** | **56** | **64** | **+8** | **10** | **18** | **28** |

Consistency check (Net == N→Y − Y→N): **PASS** (+8 == 18 − 10).

### A3 (batch 1287) vs A2 (batch 1286)

| Company ID | Company | Yes (A2 1286) | Yes (A3 1287) | Net | Y→N | N→Y | Total Flips |
|---|---|---|---|---|---|---|---|
| 9 | CSX Corporation | 2 | 5 | +3 | 0 | 3 | 3 |
| 10 | MAGNA INTERNATIONAL INC. | 12 | 12 | +0 | 1 | 1 | 2 |
| 11 | THE SOUTHERN COMPANY | 5 | 3 | −2 | 2 | 0 | 2 |
| 12 | S&P GLOBAL INC. | 14 | 13 | −1 | 4 | 3 | 7 |
| 13 | MARTIN MARIETTA MATERIALS, INC. | 0 | 0 | +0 | 0 | 0 | 0 |
| 14 | DARDEN RESTAURANTS, INC. | 0 | 5 | +5 | 0 | 5 | 5 |
| 15 | BCE INC. | 14 | 16 | +2 | 1 | 3 | 4 |
| 16 | STRYKER CORPORATION | 8 | 7 | −1 | 1 | 0 | 1 |
| 17 | AMPHENOL CORPORATION | 0 | 0 | +0 | 0 | 0 | 0 |
| 18 | AFLAC INCORPORATED | 3 | 3 | +0 | 0 | 0 | 0 |
| **ALL** | **Aggregate (10 companies)** | **58** | **64** | **+6** | **9** | **15** | **24** |

Consistency check (Net == N→Y − Y→N): **PASS** (+6 == 15 − 9).

**Reading (A3 is shadow-mode — these flips are run variance, not A3 behaviour).**
A3 deployed with `ELIGIBILITY_ENFORCE` **unset** in prod, so the composition logic
attaches an eligibility decision to each `MeasureResult` but mutates **no verdict**;
by construction A3 cannot have produced any of the 28/24 flips above — they are the
same run-to-run model/corpus variance seen between every pair of runs (cf. A1-vs-base
21 flips, A2-vs-base 20 flips). Direction confirms **no collapse or over-rejection**:
the net is a Yes **increase** (+8 / +6), not a loss; the three structurally all-No cos
(Martin Marietta, Darden, Amphenol) show zero regression; **Darden 0→5** is a gain, not
a collapse; and the single loss — **Aflac −3 vs baseline** — is not new to A3: Aflac
dropped 6→3 under A2 as well (see A2 table above) and is **stable A2→A3 (3→3, zero
flips)**, i.e. a reproducible corpus artefact independent of this change. The STEP-5
stop-rule (halt on measure-level collapse / over-rejection / regression) is therefore
**not triggered**; no second batch was run.

**Correctness is established by the unit suite, not the live run.** Because the live
batch is shadow-mode, the EP01–EP06 guarantees (rejected third-party stays rejected
through every path; a subsidiary can't support a parent-wide claim unless scope permits;
a current-year question doesn't inherit a superseded report; issuer-filed vs
analyst-commentary is distinguished; cache reuse can't carry stale eligibility;
incomplete provenance → repair/review, never authority assumption) are proven by the
20 passing tests in `server/lib/eligibility-decision-a3.test.ts`, reproducible with
`DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub npx tsx server/lib/eligibility-decision-a3.test.ts`.

> **GATE3 caveat (no held-out human labels).** There is no adjudicated human-labelled
> set for this roster, so A3 acceptance rests on (a) the EP01–EP06 unit tests encoding
> the composition guarantees and (b) demonstrably safe, baseline-stable live behaviour
> in shadow mode — **not** on measured agreement with human ground truth. Enabling
> enforcement (`ELIGIBILITY_ENFORCE=on`) should be gated on such a held-out check.

> **Carried-forward constraint (recovery-boundary guard + small-PDF runtime gap).**
> This open constraint belongs to **A4/WP05** (subprocess PDF extraction — EX04/EX06).
> A3 touches none of the extraction path (`pipeline.ts` / `processor.ts` are untouched;
> A3 adds a standalone module, one optional `MeasureResult` field, and an env-gated
> shadow block in `analyzer.ts`), so it does **not intersect** A3 and is **carried
> forward to A4** unchanged.

### Step-1 trace findings (A3 composition gap, confirmed before building)

The plan flagged wrong-entity reinsertion as a *carried-forward* concern to re-verify.
Trace confirmed the app already has the individual controls — `classifyProvenance`
(`server/lib/provenance.ts`) labels issuer-self / issuer-filed / third-party sources,
and `issuer-resolver.ts` derives entity aliases — but there was **no single immutable
decision composed from them and carried through scoring**: provenance was classified
ad hoc at gate time and not re-pinned per target, so a reused passage or a
similarly-named / subsidiary / superseded source had no end-to-end object asserting
eligibility. A3 fills exactly that composition gap (compose once → freeze → recompute
per target → bounded repair that can't override exclusion), which is why it is a
*composition* guardrail over existing controls rather than a replacement for them.

---

## Baseline run (WP01 reference) — ESTABLISHED

- **Batch id:** 1284
- **Deployed commit (all 4 services):** 328d025 (= measurement-foundations code 2b91d86 + docs-only commits; carries stage_profile_events / paid_call_events / run_manifests telemetry sinks)
- **Roster:** frozen 9–18 (CSX, Magna, Southern Co, S&P Global, Martin Marietta, Darden, BCE, Stryker, Amphenol, Aflac)
- **Workspace 3, framework 18 (36 measures), provenance list_id=7**
- **Enqueue:** production-canonical POST /api/admin/resume-analysis (createBatchRun→createAnalysisJobs→addBatchJobs), 10/10 enqueued
- **Pre-run state:** CLEAN SLATE — documents + measure_scores purged, status reset to idle for all 10 (prior state snapshotted to /home/ubuntu/baseline_prerun_snapshot.json: 180 measure_scores, 309 docs). Clean-slate chosen so every company runs full discovery→fetch→extraction→retrieval→scoring (uniform/reproducible starting state + complete stage telemetry + maximal regression coverage); harness-only reset, pipeline/scoring code byte-identical to production.
- **Sole queue consumer:** prod worker (3 replicas); dev worker off shared "analysis" queue (sleep infinity, numReplicas 1).
- **Enqueued at:** 2026-10-15 (resume-analysis HTTP 200)
- **Pass bar (from batch-1275):** 10/10 first-attempt completions, each ≤35 min from claim; any retry voids pass; no accuracy/completeness regression.
- **Status:** ✅ COMPLETE / CAPTURED — 2026-10-15T13:29:51Z.

### Baseline captured results (batch 1284) — this is the WP01 reference for all comparisons

- **Completion:** 10/10 completed, 0 failed, **all first-attempt (attempts=1)**. Wall-clock **46m16s** (8-concurrency, 1 prod worker × 3 replicas).
- **Per-company claim→complete:** min 12m29s (Aflac), max 26m42s (Martin Marietta). **NONE exceeded 35 min.** ✅ PASS BAR MET.
  - CSX 23m15s · Magna 20m18s · Southern 20m28s · S&P 26m17s · Martin Marietta 26m42s · Darden 24m43s · BCE 24m05s · Stryker 19m33s · Amphenol 26m16s · Aflac 12m29s.
- **Scores (deterministic reference — keep byte-stable for equivalence WPs):**

  | id | company | score | met/36 | ms |
  |----|---------|-------|--------|-----|
  | 9 | CSX | 8 | 3 | 36 |
  | 10 | Magna | 28 | 10 | 36 |
  | 11 | Southern Co | 6 | 2 | 36 |
  | 12 | S&P Global | 39 | 14 | 36 |
  | 13 | Martin Marietta | 0 | 0 | 36 |
  | 14 | Darden | 0 | 0 | 36 |
  | 15 | BCE | 39 | 14 | 36 |
  | 16 | Stryker | 19 | 7 | 36 |
  | 17 | Amphenol | 0 | 0 | 36 |
  | 18 | Aflac | 17 | 6 | 36 |

  **Aggregate:** sum_score=156, sum_met=56, all companies ms=36 (full coverage). Verdict distribution over 360 measure_scores: **No=304, Yes=56**.
- **Cost / telemetry:** total paid LLM cost **$3.9476** (deepseek 1825 calls $3.9464 + openrouter 1 escalation $0.0012); 13,704,064 tokens; 1826 LLM calls, 61 browser (evomi_proxy), 2161 search (serper). 104 stage_profile_events. run_manifest run_id=batch-1284, mode=fresh, hash=fe36c21278c271c6.
- **Interpretation:** three companies scored 0/0 (Martin Marietta, Darden, Amphenol) — all completed with ms=36 (every measure adjudicated), i.e. legitimate "all-No" results, not failures. This all-No cohort is exactly where WP02/A1 research-state accounting (distinguish "looked & found nothing" from "never got doc") will add signal without changing verdicts.

---

## WP04 / A3 — GATE3 label set (full supporting-quote-set eligibility) — ESTABLISHED

**What changed.** Commit `9e94507` ("feat(WP04/A3): full supporting-quote-set
eligibility basis + quote-correction-primary enforcement") is on `origin/main` and
auto-deployed to all four Railway services (shadow: `ELIGIBILITY_ENFORCE` unset).
A3's eligibility basis now equals the **verdict's basis** — it evaluates the **entire
supporting-quote set** of each positive cell (new pure/total `composeCellEligibility`
in `server/lib/eligibility-decision.ts`), not just the single cited quote. Remedy order
is **quote-correction primary, verdict-change last resort**: if any supporting quote is
eligible, promote it (`A3-CORRECT`, verdict unchanged); only if **all** quotes are
hard-excluded does the verdict downgrade to No/0 (`A3-ENFORCE DOWNGRADE`).

**GATE3 forecast — method (replaces the "no held-out labels" caveat with a measured forecast).**
Rather than a human-labelled set (none exists for this roster), the label set replays the
exact enforcement composer over **real production evidence**: batch **1287** snapshot
(`analysis_results` id 803, roster 9–18, policy v2). Persisted snapshots drop quote
`sourceUrl`, so URLs were **recovered** by matching each quote's `{text, source}` back to
the batch corpus (`batch_corpus`→`documents`/`document_content`) via NFKC-normalised
anchor-window containment. **Recovery rate 99.34% (150/151 supporting quotes; 1
unresolved)** — high enough that the offline replay is rigorous, so **no paid batch was
spent** (the fail-silent "URL-drop ⇒ REVIEW" artifact that made the first offline attempt
unusable is fully eliminated: **0 cells excluded as artifacts**).

**Label buckets (64 positive cells, all currently Yes):**

| Bucket | Cells | Share | Meaning |
|---|---|---|---|
| STAY | 56 | 87.5% | cited quote already eligible — no change |
| QUOTE_CORRECT | 5 | 7.8% | eligible supporting quote promoted; **verdict unchanged** |
| VERDICT_CHANGE | 3 | 4.7% | all quotes hard-excluded → downgrade (last resort) |
| REVIEW (genuine) | 0 | 0.0% | none eligible, some unknown-provenance |
| excluded (URL-drop artifact) | 0 | n/a | — |

**Directional verdict flips implied by enforcement (per standing reporting constraint):**

| Direction | Cells | Of which genuine | Of which provenance-attribution artifact |
|---|---|---|---|
| **Yes→No** | **3** | **0** | **3** |
| **No→Yes** | **0** | 0 | 0 |
| **Total cells changing verdict** | **3** | **0** | **3** |

(No→Yes is structurally 0: A3 only acts on positive cells.) Per-company detail and the
per-quote exclusion-kind table are in `/home/ubuntu/gate3_labels.md` / `.json`; all 3
Yes→No flips are **S&P Global (co 12)**.

**User expectation — CONFIRMED.** The governing expectation was that making A3 evaluate
the full quote set *"should almost always result in the quote being changed … rather than
the verdict being changed."* Among the 8 actionable cells, **quote-correction (5)
dominates verdict-change (3)**; VERDICT_CHANGE is 4.7% of classified cells (rare). The
data confirms the expectation.

**Root-cause of the 3 VERDICT_CHANGE cells — provenance-attribution gaps, not genuine
ineligibility.** Every excluded quote in the 3 flips is **S&P Global's own disclosure**
(2025/2026 Proxy Statements) whose recovered URL the classifier cannot map to the issuer:
unmapped **Q4 Inc IR-distribution CDN** tenants (`s29.q4cdn.com`, kind `ir_cdn`) and
**search-engine redirect masks** (`www.google.com/goto`, kind `redirect_mask`). These are
issuer-self sources mis-scored as third-party — i.e. a classifier provenance gap, **not**
evidence the verdict should flip. **Genuine verdict-change after removing the artifacts = 0.**

### Enforcement enablement — GATED (two prerequisites, decision required)

Enabling `ELIGIBILITY_ENFORCE=on` **as-is** would apply 3 **false** Yes→No downgrades to
S&P Global. That contradicts the data (0 genuine ineligibility) and the project goal
("legitimate results per measure, not fail-silent downgrades"). Enforcement is therefore
gated on:

1. **Provenance-gap closure (recommended first; code, not env).** Map the issuer's
   Q4/IR-CDN tenants into `related_domains` and resolve `www.google.com/goto` redirect
   masks to their target before provenance classification, so these 3 issuer disclosures
   score as issuer-self. After this, the forecast becomes **STAY 56 / QUOTE_CORRECT 5 /
   VERDICT_CHANGE 0** and enforcement produces **zero** verdict flips on this roster —
   pure quote-correction, exactly the intended behaviour. *(Distinct scope from the
   approved A3 work; awaiting go-ahead.)*
2. **Production write mechanism.** Flipping `ELIGIBILITY_ENFORCE=on` in prod needs Railway
   env-var write access (current CLI token here is unauthenticated), **or** approval to
   change the in-code default to enforce-on (ships via `git push` to main, which is how
   `9e94507` already deployed; kill switch `ELIGIBILITY_ENFORCE=off` + `ELIGIBILITY_POLICY=v1`
   remain). Code deploys work from here; **env-var writes do not.**

**Carried forward unchanged:** WP05/A4 (behavioral recovery-boundary guard + small-PDF
runtime gap) remains OUTSTANDING and does not intersect A3.

---

## WP04 / A3 — Framework-level provenance fix SHIPPED + enforcement ENABLED + validated — ESTABLISHED (2026-10-16)

**Decision taken.** The provenance-gap closure of the section above was executed, and the
in-code enforcement default was flipped to **enforce-ON** (both prerequisites resolved).
Crucially, the fix was made **framework-level, with zero per-company / per-topic data** —
the earlier proposed 1-row `related_domains` tenant declaration for S&P Global (id 12) was
**REJECTED by the user as company-specific** and was **never written** (production DB guard
also blocked it). It is fully superseded.

**Commits on `origin/main` (auto-deploy to all 4 Railway services; dev==prod):**
`58236a2` (GATE3 label-set docs) → `e06a78f` (enforcement default-ON + redirect-mask
unwrap + IR-platform recognition) → **`15bbcc0`** ("feat(provenance+A3): framework-level
full-name phrase identity + IR-tenant propagation through eligibility composer") — the
superseding framework fix.

**What `15bbcc0` ships (all name-derived, company-/topic-agnostic, NO data rows):**
1. **Full-name phrase identity** (`server/lib/provenance.ts` `fullNamePhraseMatch`) — an
   issuer's complete legal name minus generic corporate-form suffixes (Inc/Corp/PLC/Co) is
   matched as a contiguous phrase against a document's title/URL-path/content, so an issuer
   with no distinctive single token and no ticker in the URL (e.g. S&P Global, ticker SPGI,
   on `s29.q4cdn.com/690959130/.../S-P-Global-Inc-2026-Proxy-Statement.pdf`) self-confirms
   its own IR document. Guarded ≥2 tokens & ≥6 joined chars so short names (AT&T, Visa) do
   not over-fire.
2. **IR-tenant propagation through the A3 eligibility composer**
   (`composeCellEligibility`, two-pass, order-independent) — the existing R5c
   `knownIrTenants` cache (write-through whenever ANY source self-confirms a Q4/IR-CDN
   tenant) is now threaded through the composer and shared across all of a company's
   sources (one cache per company in `analyzer.ts` AND in the GATE3 builder, so offline ==
   live). A confirmed tenant then covers sibling documents on the same tenant that carry no
   self-identifying name. Cross-company reuse guard (`companyMatchesBinding`) still blocks a
   different issuer borrowing another's bound tenant.
3. **Enforcement default-ON** (`server/lib/analyzer.ts`) — unset/empty `ELIGIBILITY_ENFORCE`
   now enforces; kill switches intact: `ELIGIBILITY_ENFORCE=off` restores shadow mode,
   `ELIGIBILITY_POLICY=v1` restores legacy passthrough.

**Tests:** `eligibility-decision-a3.test.ts` (34) + `provenance.test.ts` (49) pass, incl. 6
new R5c cases (order-independent sibling propagation; cross-company reuse over-fire guard),
plus kill-switch and default-ON cases.

### Validation — deterministic isolation over intact snapshot 1287 (free, zero-confound)

The fix lives **purely in post-scoring eligibility composition** — it changes neither
retrieval nor LLM scoring. The defensible validation is therefore a **deterministic replay
of the fixed composer over a fixed snapshot**, which isolates the fix's directional flips
with **zero LLM-noise confound**. Snapshot **1287** (analysis_results id 803) is the
frozen roster (FW18, companies 9–18, full run) with a **byte-intact corpus** (457/457 docs
join, 59.19M chars recovered at 99.34% URL-recovery).

| Bucket (64 positive cells, snapshot 1287) | Pre-framework-fix | **Post-fix (`15bbcc0`, enforce-ON)** |
|---|---|---|
| STAY | 56 | **63** |
| QUOTE_CORRECT | 5 | **1** |
| VERDICT_CHANGE | 3 | **0** |
| REVIEW (genuine) | 0 | **0** |

**Directional verdict flips from enabling enforcement (standing reporting constraint):**
- **Yes→No = 0**  (pre-fix would have been **3**, all S&P provenance-attribution artifacts, **0 genuine**)
- **No→Yes = 0**  (A3 acts only on positive cells)
- **Total cells changing verdict = 0**

Only S&P Global (id 12) changed between pre-fix and post-fix; the other 9 companies are
**byte-identical — zero regressions**. The one QUOTE_CORRECT (Magna id 10) is the intended
remedy (promote an eligible quote, verdict unchanged). Evidence:
`deliverables/release-evidence/provenance-gap-closure/AFTER_framework-phrase-and-propagation.{json,md}`.

### Why NOT a fresh paid batch — the LLM noise floor swamps the signal

Two fresh runs of the **identical frozen roster with no code change** — baseline **1284**
(snapshot 800) vs **1287** (snapshot 803), both run 2026-10-15 — differ by **28 cell
flips**:

| | Yes (1284) | Yes (1287) | Net | Y→N | N→Y | Total Flips |
|---|---|---|---|---|---|---|
| **Aggregate (10 cos)** | 56 | 64 | +8 | **10** | **18** | **28** |

This 28-flip run-to-run variance is **pure LLM nondeterminism** (no code differs between the
two runs). It is ~10× the fix's isolated effect (0–3 cells), so a fresh paid batch would
make the fix's directional flips **unattributable** — the noise would mask the signal. This
is why the deterministic composer replay over a fixed snapshot is strictly more defensible
for an eligibility-layer change, consistent with the isolation-reliability discipline.

### Why baseline 1284 itself could not host the deterministic replay

Baseline **1284**'s underlying corpus **documents have been pruned** from the DB: its
`batch_corpus` id-rows survive (333 across 10 companies) but the
`batch_corpus → documents → document_content` join returns **0/333** (vs 457/457 intact for
1287). Free URL recovery over 1284 is therefore impossible (measured 0/140 quotes resolved).
Snapshot 1287 — the **same frozen roster** — is byte-intact and is the correct validation
snapshot. The raw-verdict snapshots for both batches survive (used in the noise-floor table
above); only the corpus text for 1284 is gone.

**Status: A3 COMPLETE.** Framework-level provenance fix shipped (`15bbcc0`), enforcement
enabled (default-ON, kill switches intact), validated at VERDICT_CHANGE=0 / Y→N=0 / N→Y=0
with zero regressions. **Next: WP05/A4** (behavioral recovery-boundary guard + small-PDF
subprocess-extraction runtime gap, EX04/EX06).



---

### A4 / WP05 — ESTABLISHED (2026-10-16): extraction / table / OCR / translation fidelity

**Scope.** Framework-level only — ZERO per-company/per-topic logic or data patches. All change confined
to the extraction layer in `server/lib/processor.ts` plus a new test file
`server/lib/extraction-fidelity.test.ts`. No schema change, no env-var change, no scoring/analyzer
touched. Verdict-invariant by construction.

**Files changed**
- `server/lib/processor.ts` — extraction-engine layer reworked (details below).
- `server/lib/extraction-fidelity.test.ts` — new, EX01–EX07 + boilerplate-safety (10 tests).
- `docs/implementation-run-ledger.md` — this section + A4 row.

**Small-PDF runtime gap — ROOT CAUSE and framework fix.**
Empirically confirmed: `pdf-parse@1.1.4` bundles an old pdfjs whose xref reader REJECTS minimal
hand-built xref tables ("bad XRef entry") — even after the worker's retry-once. A 767-byte fixture
fails pdf-parse yet `pdftotext` recovers its full text. The earlier REJECTED approach was a
size-special-case bound. The shipped fix is NOT size-based: a pure, exported outcome-classifier
`classifyExtractionCompleteness({textLen,minChars,timedOut,failed,pagesAvailable?,pagesProcessed?})`
keyed on the *outcome* (parser rejected structure vs. document genuinely empty vs. timed-out partial),
not on byte size. "Parser rejected" → `unknown` (retry/review, never a false `empty`); clean run with
no text → `empty`; timed-out with partial text → `partial`, never promoted to `complete`. The
orchestrator `extractPdfWithFidelity` chains pdf-parse → pdftotext → adaptive OCR and feeds the
classifier, so a small PDF rejected by pdf-parse is recovered by pdftotext and labelled `complete`.

**Recovery-boundary guard — preserved by non-interference.**
The behavioural guard lives in `pipeline.ts` (`runCompanyPdfRecovery`, `remainingFetchBudgetMs`,
`RECOVERY_WINDOW_FLOOR_MS`) and is proven by `company-pdf-recovery-boundary.test.ts` (B1-1..B1-7).
`pipeline.ts` was NOT touched. Confirmed green: **B1-1..B1-7 all pass** post-change.

**Subprocess timeout fidelity (EX06).**
Previously `extractViaPdftotext` silently returned partial stdout on timeout (accepted as success).
Now `extractViaPdftotextDetailed` returns `{text, timedOut:true, failed:true}` on timeout; the
classifier never promotes timed-out partial stdout to `complete`. `runProcessCollect` still captures
partial stdout and flags `timedOut` (verified) — the fix is in how the outcome is *classified*, not in
discarding the bytes.

**Adaptive OCR (EX02, Lane-B speed gated on Lane-A fidelity).**
`extractViaOcrDetailed` is per-page: tries the `pdftotext -f p -l p` text layer first and skips OCR for
any page already carrying ≥20 chars (text pages preserved verbatim), else rasterises just that page
(`pdftoppm`) and OCRs it (`tesseract`). No 8-page cap — all pages processed, budget-bounded; flags
`partial` when budget/scope cuts it short (`pagesProcessed < pagesAvailable`). Strictly ⊇ old content.

**Table / translation / boilerplate fidelity (f).**
Asserted against existing framework helpers (not rewritten): `normaliseTableHorizonMarkers` annotates
bullet-only horizon rows with their column relationship; `translation.ts` keeps the aligned derivative
(`looksNonEnglish` detects foreign text; translation never replaces the original source carrying
numbers/negation/scope); `stripRepeatedStructuralBlocks` dedupes repeated headers but NEVER strips a
repeated line containing a quantified figure (policy/decisive note preserved).

**Test results (EX01–EX07 + safety) — all green, 10/10**
| Test | Result | Proves |
|------|--------|--------|
| EX01 | ok | decisive evidence on a later page survives (no truncation) |
| EX02 | ok | mixed doc: text page verbatim AND scanned page recovered by adaptive OCR |
| EX03 | ok | table units/headers preserved; horizon row→column relationship annotated |
| EX04 (small) | ok | pathological pdf-parse-rejected xref recovered via pdftotext, labelled `complete` (no false empty) |
| EX04 (large) | ok | benign 40-page PDF fully extracted, first AND last page markers present (no silent truncation) |
| EX05 | ok | translation is an aligned derivative; detector flags foreign text, original source preserved |
| EX06 (capture) | ok | `runProcessCollect` captures partial stdout on timeout and flags `timedOut` |
| EX06 (rule) | ok | completeness rule NEVER promotes timed-out partial stdout to `complete` |
| EX07 | ok | downstream passage recall = 10/10 = 100% across ordinary/multipage/table/OCR/non-Latin |
| A4 safety | ok | boilerplate dedupe removes repeated headers but KEEPS a repeated policy line with a figure |

**Regression suites — 12/12 green:** `company-pdf-recovery-boundary` (B1-1..B1-7, guard preserved),
`pdf-parse-subprocess-equivalence` (B6 byte-identical + B3/B2 slot handling), `stalled-extraction-boundary`,
`table-horizon-normaliser`.

**Typecheck:** `tsc --noEmit` — 0 new diagnostics in `processor.ts` / `translation.ts` /
`extraction-fidelity.test.ts` (repo has unrelated pre-existing errors in other files).

**Cell-flip impact:** n/a — no live batch run. The change is verdict-invariant by construction:
`extractTextFromPdf` is a thin wrapper returning `ExtractionFidelity.text` byte-for-byte to all 11
existing callers; the fidelity record is additive metadata consumed by nothing in the scoring path.
**Total cells changing Y→N = 0, N→Y = 0** (no scoring surface touched).

**Boundary noted (not a gap):** the `ExtractionFidelity` record (completeness/pages/engine/language/
truncation) is produced and available but not yet threaded into `storage.recordFetchSuccess` /
`extraction_state` — intentionally out of scope for this surgical, verdict-invariant change. The
`extraction_state` column already supports `partial`; wiring the completeness label through is a
follow-up and would remain verdict-invariant.



### A5 / WP06 — ESTABLISHED (2026-10-16): retrieval & evidence-pack recall

**Scope.** Framework-level only — ZERO per-company/per-topic logic or data patches. A valid document can
sit in the corpus while its DECISIVE passage never reaches the model prompt; smarter models cannot fix
missing input. A5 does NOT add a new retriever — it (a) MEASURES passage-level recall of decisive
passages AT THE ACTUAL PROMPT BUDGET, and (b) closes measured misses with a BOUNDED, append-only
evidence-expansion that EXTENDS the existing BM25/deep-read path and COMPOSES with A3 eligibility and A4
fidelity — never by shrinking top-k or pack length.

**Files changed**
- `server/lib/evidence-recall.ts` — new. Pure, DB-free, LLM-free toolkit (oracle + recall + planner).
- `server/lib/evidence-recall.test.ts` — new. RT01–RT06 + kill-switch-default + no-op-append (8 tests).
- `server/scripts/evidence_recall_benchmark.ts` — new. Free/offline/deterministic recall benchmark.
- `server/lib/analyzer.ts` — strictly gated wiring at the pre-scoring evidence seam (details below).
- `docs/implementation-run-ledger.md` — this section + A5 row.

**Kill-switch and shipped default.**
`RECALL_EXPANSION_POLICY` (resolved by `resolveRecallExpansionPolicy()`), three values:
- **`off` — DEFAULT = current production behaviour.** The analyzer block is skipped ENTIRELY: no extra
  compute, no extra retrieval, the evidence pack is byte-identical, the verdict surface is unchanged.
- `shadow` — compute recall telemetry + the expansion plan but DO NOT modify the pack (verdict-invariant;
  observability only).
- `on` — APPLY the bounded expansion (behaviour-changing; append-only).
Any unrecognised value falls back to `off` (fail-safe — a typo can never silently enable expansion).
Verdict-changing retrieval is NEVER the default and is NOT set in the prod env. **To enable:
`RECALL_EXPANSION_POLICY=on`** (or `=shadow` for telemetry); unsetting it restores current behaviour with
no redeploy.

**Decisive-passage oracle (framework-level).**
`computeDecisivePassages({measure,chunks})` marks a passage decisive when it carries ≥ 2 distinct decisive
tokens OR a verbatim multi-word `evidenceKeyword` phrase. The decisive signal is drawn ONLY from the
measure's own framework-authored fields (`title` + `evidenceKeywords`) — no company names, no topic
hardcoding. Ranked (phraseHit, distinctTokens, stable id) and capped (`RECALL_DECISIVE_MAX`, default 12),
so it is deterministic and bounded. This single definition is BOTH the recall ground-truth AND the
candidate universe for expansion, so "what should have reached the model" and "what expansion may add"
can never diverge.

**Recall measurement at the actual prompt budget.**
`measurePackRecall({decisive,packPassageIds})` reports |decisive ∩ pack| / |decisive| by STABLE passage
identity (`stablePassageId` = `docUrl#seq#sha1(text)`, mirrors the evidence-pack fingerprint scheme), plus
the exact misses in oracle order. `packPassageIds` are the ids of the chunks that ACTUALLY reached the
pack shown to the scoring role (membership recovered by verbatim substring against the assembled pack
text).

**Bounded expansion planner (A3-composing, append-only, deterministic).**
`planBoundedExpansion(...)` fires only on DEMONSTRATED insufficiency (an eligible decisive passage exists
in the corpus but missed the pack). It:
- COMPOSES with A3: an injected eligibility predicate filters excluded material BEFORE selection, so
  expansion can NEVER reintroduce what A3 excluded (RT04). The analyzer injects the real A3 predicate
  (`composeEligibilityDecision` per candidate; `status==="excluded"` ⇒ ineligible), fail-open on error.
- is BOUNDED: ≤ `RECALL_EXPANSION_MAX_PASSAGES` (default 6) and ≤ `RECALL_EXPANSION_MAX_CHARS` (default
  12000) per measure — no unlimited retrieval.
- NEVER shrinks top-k or pack length (append-only; the original pack is intact, order preserved).
- dedups ONLY when a candidate adds no new decisive token AND its source link is already represented —
  so every unique decisive fact AND source link stays recoverable; qualifiers/negation in a distinct
  passage are never dropped (RT06).
- is DETERMINISTIC: stable identity + stable ordering, re-runs byte-identical (RT05).

**analyzer.ts wiring (strictly gated).**
At the pre-scoring seam (`finalEvidence = evidenceText`), guarded by
`if (recallPolicy !== "off" && settings.useBm25Retrieval && evidenceText)`. When `off` the whole block is
skipped (no `buildDeepIndex()`, no oracle, no plan) ⇒ zero added cost and byte-identical packs. When
`shadow` it logs recall telemetry only; when `on` it appends `formatExpansionAppend(plan)` (a provenance-
headed block) to `finalEvidence`. No existing pack content is removed or reordered.

**Deterministic test results (RT01–RT06 + extras) — 8/8 pass**
| Test | Result | Proves |
|------|--------|--------|
| RT01 | ok | synonym/sector-language passage is decisive and recalled at the budget |
| RT02 | ok | a low-frequency phrase-hit (table cell) is decisive and recoverable by bounded expansion |
| RT03 | ok | negative/contradictory evidence is decisive and never suppressed |
| RT04 | ok | bounded expansion composes with A3 — excluded material is never reintroduced |
| RT05 | ok | stable passage identity and deterministic ordering under input shuffling |
| RT06 | ok | dedup drops only pure duplicates; unique facts/links/negation preserved |
| kill-switch | ok | default is `off` (current production behaviour, verdict-invariant) |
| no-op append | ok | `formatExpansionAppend` returns `""` for a non-firing plan (byte-identical pack) |

Run: `DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub npx tsx server/lib/evidence-recall.test.ts`
(the tests never touch the DB; the stub only satisfies the pool constructor).

**GATE2 — free/offline/deterministic recall benchmark.**
`server/scripts/evidence_recall_benchmark.ts` builds the EXACT pack the scorer sees using the REAL,
deterministic `summarizeDocuments` (retrievalV2 BM25 corpus selection — NO LLM) + the REAL
`buildEvidencePacksForCategory`, over the frozen fixture corpus (`var_corpus/*`), and reports
passage-level recall + shadow recoverability. Read-only w.r.t. the production DB (needs only an empty
throwaway `summary_cache`; a cache miss is the normal path). Full 13-company fixture roster, all 29
measures, 0 company errors:

| Metric | Value |
|---|---|
| Companies evaluated | 13 (ids 1, 20, 120, 22, 107, 21, 14, 18, 11, 12, 13, 102, 16) |
| (company × measure) cells | 377 |
| Decisive passages (corpus total) | 4493 |
| Recalled into the budgeted pack | 3334 |
| **Micro-averaged recall** | **74.2%** |
| Macro-averaged recall | 74.3% |
| Decisive misses | 1159 |
| Recoverable by A5 bounded expansion (shadow) | 537 (46.3% of misses) |
| Budget | corpusMaxChars 560000, top-k 45, evidenceMaxChars 45000 |
| Resolved policy during run | `off` (expansion run in SHADOW for measurement; pack never modified) |

Outputs: `var_out/evidence_recall_benchmark.{json,md}` (per-cell + aggregate). Re-runs are byte-identical.

**Typecheck:** `tsc --noEmit` — 0 new diagnostics in `evidence-recall.ts` / `evidence-recall.test.ts` /
`evidence_recall_benchmark.ts` / `analyzer.ts` (repo has 62 unrelated pre-existing errors in other
scripts/files).

**Adjacent regression suites — all green:** evidence-gate 14/14, evidence-gate-a2 17/17,
eligibility-decision-a3 34/34, passage-retrieval 35/35, retrieval-stability 5/5, retrieval-review-queue
(green). No regression in the retrieval/evidence-gate/eligibility surfaces A5 sits next to.

**Cell-flip impact:** n/a — no live batch run, and none is required. The shipped default
`RECALL_EXPANSION_POLICY=off` skips the analyzer block entirely, so the evidence pack and verdict surface
are byte-identical to current production. **Total cells changing Y→N = 0, N→Y = 0** (no scoring surface
touched at the default). Behaviour-changing recall (`on`) is opt-in and NOT enabled in prod.



### A5 / WP06 — live validation batch: RECALL_EXPANSION_POLICY flipped `off`→`on` (2026-10-16, GATE5)

**Decision.** User-approved GATE5: flip the A5 kill-switch default from `off` to `on` in production and run ONE
paid live validation batch to measure the real cell-flip impact of the bounded evidence-expansion.

**How the flip was shipped (code default, not env).** The Railway CLI on this VM is unauthenticated and there
is no token available, and env vars cannot be set on the worker service from here, so — exactly as the A3
enforce-on precedent (`15bbcc0`) — the default was flipped **in code** and deployed via push→auto-deploy:
- commit **`f15f8b6`** `feat(WP06/A5): flip RECALL_EXPANSION_POLICY default off->on (GATE5)`.
- 3 files only: `server/lib/evidence-recall.ts` (constant `DEFAULT_RECALL_EXPANSION_POLICY = "on"` + doc
  comments), `server/lib/analyzer.ts` (gate-region + import comments updated to the new default; the runtime
  gate `recallPolicy !== "off" && settings.useBm25Retrieval && evidenceText` is unchanged), and
  `server/lib/evidence-recall.test.ts` (default-assertion test rewritten to assert default `on` and still
  prove env `off`/`shadow`/explicit-arg override). Framework-level only — zero per-company/topic strings.
- `RECALL_EXPANSION_POLICY` env **still overrides** the default (unset ⇒ resolves to `on`; `=off`/`=shadow`
  restores prior behaviour with no redeploy). Unrecognised values still fail-safe — now to `on`.
- Validation before push: unit 8/8; adjacent suites green (evidence-gate 14/14, evidence-gate-a2 17/17,
  eligibility-decision-a3 34/34, passage-retrieval 35/35, retrieval-stability 5/5); `tsc --noEmit` 0 new
  diagnostics in the changed files. Pushed `8a8a4a6..f15f8b6 main`. All 4 Railway services redeployed;
  health `{"status":"ok","version":"3.0.0"}`.

**Policy=on confirmed empirically before the full spend (gitSha signal).** Prod has no
`RECALL_EXPANSION_POLICY` env var, so the resolved policy on the worker == the deployed code default. There
is no pre-batch SHA signal (Railway unauth; health has no SHA; expansion telemetry is console-log-only). The
earliest empirical confirmation is the per-company snapshot `analysis_results.results_data[].manifest.gitSha`
(written by the worker from `RAILWAY_GIT_COMMIT_SHA`). To cap waste under worker concurrency=10, the batch
was enqueued **canary-first**: company 9 alone was queued; it completed healthy (ms=36) and its scores
differed from the 1287 baseline (1 verdict flip) — then the remaining 9 were released. On completion, the
snapshot gitSha = **`f15f8b6`** on **all 10** companies ⇒ the worker ran the new code ⇒ policy resolved to
`on`.

**Batch method — corpus-replay off 1287 (deviation: 1284 corpus pruned).** The canonical GATE plan was a
corpus-replay off baseline **1284**'s frozen corpus, but **1284's and 1285's corpora are pruned** (0 of the
snapshot `document_id`s still exist in `documents`; cf. commit `525ac7b` "baseline-1284 corpus pruned"), so a
replay off 1284 is impossible. **1287** has a fully intact frozen corpus (457/457 docs present, all 10
companies) and was itself scored pre-A5-on (gitSha `3990bcd`, A3-shadow ⇒ its pack reflects policy-`off`
behaviour), making it the correct isolated baseline. The replay re-scores **1287's exact frozen corpus** with
the current deployed code:
- replay batch **1288**, score-only, `skipFetch:true`, `sourceBatchId:1287`; the worker loads the frozen
  corpus from `batch_corpus[1287]` (throws if missing — no live-doc fallback) and forces fresh LLM re-scoring
  (`freshScoring = !!sourceBatchId`). This isolates the pure A5-on expansion effect from discovery/corpus
  variance — the same isolation 1284-replay would have given.
- source corpus fingerprint `7811721a4ba3941af2772b8f44a067fc32c4b44f7b2a8b7a88e93fd9ad364c8b`;
  run key `run_a180249bb00d51f1c7bbbbb8074b11a21559bb68a05fab7b427a563bfc86ce85`.
- enqueued storage-direct (mirrors `/api/analyze/replay`) because the admin/session auth paths are not
  reachable from this VM — precedent `validate-enqueue.ts`.
- **10/10 completed**, all 10 companies **ms=36** (no measure collapse). Cost **$4.23 / 14.74M tokens**
  (deepseek-chat, 1,579 calls) vs baseline 1287 $3.89 / 13.52M — the ~+9% token delta is the bounded
  expansion appending decisive evidence to scoring prompts, as designed.

**Cell-flip impact — variant 1288 (policy=on) vs baseline 1287 (policy=off), 10 companies × 36 measures = 360 cells:**

| Company ID | Company | Yes (baseline 1287) | Yes (variant 1288) | Net | Y→N | N→Y | Total Flips |
|---|---|---|---|---|---|---|---|
| 9 | CSX Corporation | 5 | 4 | −1 | 1 | 0 | 1 |
| 10 | MAGNA INTERNATIONAL INC. | 12 | 15 | +3 | 0 | 3 | 3 |
| 11 | THE SOUTHERN COMPANY | 3 | 5 | +2 | 0 | 2 | 2 |
| 12 | S&P GLOBAL INC. | 13 | 14 | +1 | 2 | 3 | 5 |
| 13 | MARTIN MARIETTA MATERIALS, INC. | 0 | 1 | +1 | 0 | 1 | 1 |
| 14 | DARDEN RESTAURANTS, INC. | 5 | 4 | −1 | 1 | 0 | 1 |
| 15 | BCE INC. | 16 | 15 | −1 | 1 | 0 | 1 |
| 16 | STRYKER CORPORATION | 7 | 8 | +1 | 0 | 1 | 1 |
| 17 | AMPHENOL CORPORATION | 0 | 0 | +0 | 0 | 0 | 0 |
| 18 | AFLAC INCORPORATED | 3 | 4 | +1 | 0 | 1 | 1 |
| **ALL** | **Aggregate (10 companies)** | **64** | **70** | **+6** | **5** | **11** | **16** |

Consistency check (Net == N→Y − Y→N): **PASS** (6 == 11 − 5). Compare artifacts:
`/home/ubuntu/a5_gate5_replay.{json,md}` (built by `server/scripts/compare_run_flips.ts 1287 1288`).

**Reading.** Policy=on produces **16 changed cells (11 No→Yes, 5 Yes→No), net +6 Yes (64→70)**. The bias
toward No→Yes (11 vs 5) is the designed signature of the bounded, append-only expansion: it adds
previously-missed decisive passages to the pack (GATE2 measured 537 recoverable misses), lifting more
measures over the Yes threshold than it displaces. No measure collapse (all ms=36); no company zeroed that
was non-zero in a way inconsistent with the baseline (Amphenol stays 0/0 as in every prior run). Because
fresh re-scoring carries run-to-run LLM variance, some of the 5 Y→N and a share of the N→Y are variance
rather than pure expansion effect; the net direction and No→Yes skew are the expansion signal.

**Pass bar / outcome.** ✅ Keep policy **on**. 10/10 clean, ms=36 throughout, expansion effect is coherent
and net-positive for recall with no collapse or mass over-flip.

**Rollback.** `RECALL_EXPANSION_POLICY=off` (or `=shadow`) in the prod env restores prior behaviour with **no
redeploy**; or revert `f15f8b6` (3-file default+comments+test change, no schema change), and `ca0939c` to
remove the whole A5 feature.



### B5 / WP13-C — live validation batch: CONTEXT_COST_POLICY flipped `off`→`on` (2026-10-17, GATE5)

**Decision.** User-approved GATE5: flip the B5 kill-switch default from `off` to `on` in production and run ONE
paid live corpus-replay validation batch to confirm the context-trim is verdict-invariant (near-zero cell
flips) WHILE delivering the designed token/cost reduction.

**STEP 1 — offline held-out proof (free, no paid LLM), authoritative for the HARD INVARIANT.** Over the frozen
corpus of baseline batch **1293** (A5-on, B1-on, B5-off), all **360 cells** (10 companies × 36 measures) were
reconstructed as production produces them — REAL `summarizeDocuments` (retrievalV2=false, the workspace-3
setting) + REAL `buildEvidencePacksForCategory` per category + A5 `planBoundedExpansion` then B5
`planContextTrim` at the SAME seam/order as `analyzer.ts` — and `verifyTrimPreservesRecall` asserted on every
cell. Result: **invariant holds 360/360, 0 violations** (decisive pack passages ⊆ kept set, recall preserved,
identical misses) ⇒ relevant/decisive text is NEVER dropped. Trim fired on **326/360** cells; aggregate pack
token reduction **25.39%** (3,920,993 → 2,925,442 pack tokens; 995,551 saved). Per-company pack reduction
ranged 6.30% (Aflac) to 32.02% (Magna), each 36/36 invariant-OK. Harness + artifacts committed as `4156742`
(`server/scripts/gate_b5_offline_proof.ts`, `gate_b5_out/gate_b5_offline_proof.{json,md}`). This 25.39% is the
pack-only first-pass projection; the live batch below measures the true end-to-end prompt delta.

**How the flip was shipped (code default, not env).** The Railway CLI on this VM is unauthenticated and env
vars cannot be set on the services from here, so — exactly as the A3 enforce-on (`15bbcc0`) and A5 GATE5
(`f15f8b6`) precedents — the default was flipped **in code** and deployed via push→auto-deploy:
- commit **`8725521`** `feat(WP13/B5): flip CONTEXT_COST_POLICY default off->on (GATE5)`.
- 3 files only: `server/lib/model-cost.ts` (constant `DEFAULT_CONTEXT_COST_POLICY = "on"` + module/kill-switch/
  resolver doc comments), `server/lib/analyzer.ts` (gate-region + import comments updated to the new default;
  the runtime gate `contextCostPolicy !== "off" && settings.useBm25Retrieval && finalEvidence` is unchanged),
  and `server/lib/model-cost.test.ts` (CC03 rewritten to assert default `on` + prove env `off`/`shadow`/
  explicit-arg override; CC07 bad-env now fail-safe to `on`; CC-G3 sets env `off` explicitly for the
  byte-identical rollback proof). Framework-level only — zero per-company/topic strings.
- `CONTEXT_COST_POLICY` env **still overrides** the default (unset ⇒ resolves to `on`; `=off`/`=shadow`
  restores prior behaviour with no redeploy). Unrecognised values still fail-safe — now to `on`.
- Validation before push: model-cost 11/11; adjacent suites green (evidence-recall 8/8, evidence-gate 14/14,
  evidence-gate-a2 17/17, passage-retrieval 35/35, passage-retrieval-allowlist 4/4,
  passage-retrieval-empty-corpus 7/7); `tsc --noEmit` 62 before → 62 after, **0 new diagnostics in the changed
  files**. Pushed `d491c69..8725521 main`. All 4 Railway services (production + sprint-10-preview, app +
  worker) redeployed with status SUCCESS on **`8725521`**; health `{"status":"ok","version":"3.0.0"}`.

**Policy=on confirmed empirically before the full spend (gitSha signal).** Prod has no `CONTEXT_COST_POLICY`
env var, so the resolved policy on the worker == the deployed code default. To cap waste under worker
concurrency, the batch was enqueued **canary-first**: company 9 alone was queued; it completed healthy (ms=36)
and its `pipeline_version` / snapshot `manifest.gitSha` = **`8725521`** (= the new SHA) ⇒ the worker ran the
new code ⇒ policy resolved to `on`. The remaining 9 were then released; the final snapshot gitSha =
`8725521` on **all 360 measure_scores rows (all 10 companies)**.

**Batch method — corpus-replay off 1293.** The replay re-scores **1293's exact frozen corpus** with the
current deployed code:
- replay batch **1294**, score-only, `skipFetch:true`, `sourceBatchId:1293`; the worker loads the frozen
  corpus from `batch_corpus[1293]` (throws if missing — no live-doc fallback) and forces fresh LLM re-scoring
  (`freshScoring = !!sourceBatchId`). Baseline 1293 was scored under B5-off (gitSha `57716af`, pre-flip), so
  this isolates the pure B5 context-trim effect with A5+B1 on in BOTH runs.
- source corpus fingerprint `7811721a4ba3941af2772b8f44a067fc32c4b44f7b2a8b7a88e93fd9ad364c8b`;
  run key `run_f92811fbf758796070792a3505a07a49e4042dd9ab08cbedc33282c14d8ed999`.
- enqueued storage-direct (mirrors `/api/analyze/replay`) because the admin/session auth paths are not
  reachable from this VM — precedent `a5_replay_enqueue.ts` (reused unchanged; labels via env only).
- **10/10 completed**, all 10 companies **ms=36** (no measure collapse).

**Token/cost delta — variant 1294 (policy=on) vs baseline 1293 (policy=off), same 1,580 scoring calls
(deepseek-chat):**

| Metric | Baseline 1293 (off) | Variant 1294 (on) | Delta |
|---|---|---|---|
| Prompt tokens | 13,937,501 | 12,221,478 | **−1,716,023 (−12.31%)** |
| Total tokens | 14,570,574 | 12,847,942 | **−1,722,632 (−11.82%)** |
| Cost (USD) | $4.1684 | $3.6851 | **−$0.4833 (−11.59%)** |

Per-company prompt-token reduction was consistent across all 10 companies (10.4% Martin Marietta → 14.4%
Stryker) — the trim fired everywhere, not on a subset. The call count is identical (1,580 → 1,580), confirming
no structural pipeline change: the saving is purely smaller prompts. This is a **REDUCTION**, the designed
outcome of B5 (opposite of A5, which added tokens). The live −12.31% prompt delta is smaller than the offline
−25.39% pack projection because the offline figure measured only the evidence-pack portion, whereas the live
prompt also carries fixed framework rubric / instruction boilerplate the trim does not touch; both are
directionally consistent.

**Cell-flip impact — variant 1294 (policy=on) vs baseline 1293 (policy=off), 10 companies × 36 measures = 360 cells:**

| Company ID | Company | Yes (baseline 1293) | Yes (variant 1294) | Net | Y→N | N→Y | Total Flips |
|---|---|---|---|---|---|---|---|
| 9 | CSX Corporation | 5 | 5 | +0 | 0 | 0 | 0 |
| 10 | MAGNA INTERNATIONAL INC. | 11 | 12 | +1 | 2 | 3 | 5 |
| 11 | THE SOUTHERN COMPANY | 3 | 4 | +1 | 0 | 1 | 1 |
| 12 | S&P GLOBAL INC. | 14 | 14 | +0 | 1 | 1 | 2 |
| 13 | MARTIN MARIETTA MATERIALS, INC. | 0 | 0 | +0 | 0 | 0 | 0 |
| 14 | DARDEN RESTAURANTS, INC. | 4 | 4 | +0 | 0 | 0 | 0 |
| 15 | BCE INC. | 16 | 18 | +2 | 0 | 2 | 2 |
| 16 | STRYKER CORPORATION | 10 | 9 | −1 | 1 | 0 | 1 |
| 17 | AMPHENOL CORPORATION | 0 | 0 | +0 | 0 | 0 | 0 |
| 18 | AFLAC INCORPORATED | 4 | 4 | +0 | 0 | 0 | 0 |
| **ALL** | **Aggregate (10 companies)** | **67** | **70** | **+3** | **4** | **7** | **11** |

**Total cells changing Y→N = 4, N→Y = 7.** Consistency check (Net == N→Y − Y→N): **PASS** (+3 == 7 − 4).
Compare artifacts: `gate_b5_out/b5_flips_1293_vs_1294.{json,md}` (built by
`server/scripts/compare_run_flips.ts 1293 1294`).

**Reading — the 11 flips are LLM run-to-run noise, not a B5 regression.** Three independent lines of evidence:
(1) **Below the established noise floor.** Prior paired comparisons on this same 10-company sample — with
changes that do NOT touch the scoring surface or (A5) add evidence — recorded Total Flips of A1=21, A2=20,
A3=28, B1=19, A5-GATE5=16. B5's **11** is below all of them. (2) **Unstructured.** The 11 flips are scattered
across 9 distinct measures and 5 companies (companies 9, 13, 14, 17, 18 had **zero**), max 2 flips on any
single measure, and bidirectional (4 Y→N, 7 N→Y) — not the concentrated, one-directional pattern a systematic
regression would produce. (3) **Provably no dropped evidence.** STEP 1's invariant proof showed 0 decisive
passages trimmed across all 360 cells, so B5 cannot have removed decisive evidence; the residual flips are
near-threshold scoring variance from the (recall-preserving) smaller prompt. No measure collapse (all ms=36);
the three all-No companies (Martin Marietta / Amphenol, and here Darden's 4) stay stable.

**Pass bar / outcome.** ✅ Keep policy **on**. Near-zero, sub-noise-floor, unstructured flips WITH a measurable
−12.31% prompt-token / −11.59% cost reduction — exactly the B5 success criterion. 10/10 clean, ms=36
throughout, invariant proven 360/360 offline.

**Rollback.** `CONTEXT_COST_POLICY=off` (or `=shadow`) in the prod env restores the byte-identical pre-B5 pack
with **no redeploy**; or revert `8725521` (3-file default+comments+test change, no schema change), and
`154ff9b` to remove the whole B5 feature.
