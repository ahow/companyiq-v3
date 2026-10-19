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
| Gated | B4 (needs A1+A3), B-dur (✅ complete — durability already live via aa3fec7 ENTRYPOINT; see note) | Run only after prerequisites pass |
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
10. B-dur ✅ complete — durability already live (aa3fec7 `tini` ENTRYPOINT; not self-certified as a clean re-run — see B-dur section)

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
| A4 | 7d4eb49 | prod (all 4 svc, auto-deploy from main; 7d4eb49 is on `main` and an ancestor of live HEAD) | n/a (no batch — verdict-invariant) | WP05/A4 extraction/table/OCR/translation fidelity. Framework-level outcome-classifier resolves the small-PDF runtime gap at ROOT CAUSE (pdf-parse xref rejection ≠ empty doc); recovery-boundary guard preserved by non-interference (B1-1..B1-7 green); subprocess timeout now marks result incomplete (partial stdout never promoted to complete); adaptive per-page OCR (gated on text-layer check, all pages, no 8-page cap); table/translation/boilerplate fidelity asserted. **EX01–EX07 all green (10/10)**, regression suites 12/12 (recovery-boundary B1, equivalence B6, stalled-extraction B3/B2, table-horizon). tsc: 0 new diagnostics in changed files. Verdict-invariant: extraction layer returns `.text` byte-for-byte to all 11 callers; ExtractionFidelity is additive metadata only — scoring untouched. | ✅ keep | revert the A4 commit (processor.ts extraction-layer refactor is self-contained; no schema/env change) |
| A5 | ca0939c → on: f15f8b6 | prod (all 4 svc, push 2026-10-16 09:16 UTC; GATE5 flip push 2026-10-16 14:56 UTC; health `{"status":"ok","version":"3.0.0"}`) | 1288 (corpus-replay off 1287; snapshot gitSha=f15f8b6 all 10 co ⇒ worker on new code ⇒ policy=on) | WP06/A5 retrieval & evidence-pack recall. New pure DB-free/LLM-free module `server/lib/evidence-recall.ts`: framework-level decisive-passage oracle (measure `title`+`evidenceKeywords` only), passage-level recall measurement AT THE ACTUAL PROMPT BUDGET, and a BOUNDED append-only expansion planner that COMPOSES with A3 (injected eligibility predicate ⇒ excluded material never reintroduced), never shrinks top-k/pack length, dedups only when every unique decisive fact+source link stays recoverable, deterministic stable passage id+order. Versioned kill-switch **`RECALL_EXPANSION_POLICY`** (`off` DEFAULT = current prod/byte-identical / `shadow` = telemetry only / `on` = apply expansion); verdict-changing retrieval NEVER default, NOT set in prod env. analyzer.ts wiring strictly gated at the pre-scoring evidence seam — when `off` the block is skipped entirely (no extra work, pack byte-identical). **RT01–RT06 + kill-switch-default + no-op-append: 8/8 pass.** Free/offline GATE2 recall benchmark over the frozen 13-company fixture corpus (real `summarizeDocuments` BM25, no LLM): 377 (company×measure) cells, **micro-recall 74.2%** (3334/4493 decisive passages recalled), macro 74.3%, 1159 misses of which **537 recoverable** by the bounded shadow expansion. tsc: 0 new diagnostics in changed files (62 pre-existing elsewhere). At the shipped-off default: **Total cells changing Y→N = 0, N→Y = 0** (no scoring surface touched). **GATE5 (2026-10-16, user-approved): default flipped `off`→`on` via code (`f15f8b6`); env still overrides.** Live corpus-replay batch 1288 off 1287's frozen corpus (1284/1285 corpora pruned ⇒ replay off 1287 instead): 10/10, all ms=36, snapshot gitSha=f15f8b6 on all 10 co confirms policy=on, cost $4.23/14.74M tok. **Cell-flip vs 1287 baseline: Yes 64→70, Net +6, Y→N=5, N→Y=11, Total Flips=16** (bounded expansion adds decisive evidence ⇒ more No→Yes than Yes→No; see 2026-10-16 section). | ✅ keep — now default **on** via `f15f8b6` (GATE5 live batch 1288; Y→N=5, N→Y=11, Total Flips=16, Yes 64→70; see 2026-10-16 section) | `RECALL_EXPANSION_POLICY=off` (or `=shadow`) restores prior behaviour with NO redeploy; or revert `f15f8b6` (3-file default+comments+test, no schema change) then ca0939c for the whole feature |
| B3 | c25afd4 | prod (all 4 svc, auto-deploy from main; health `{"status":"ok","version":"3.0.0"}`) | n/a (no batch — equivalence-preserving at shipped-off default) | WP11/B3 discovery dedupe + bounded parallelism. New module `server/lib/discovery-parallel.ts` (content-hash candidate dedupe + bounded-concurrency `webSearchBatch`), integrated into `discovery.ts` and wired into the Generic-Artefact + R6a IR-Platform discovery lanes. Versioned kill-switch **`DISCOVERY_PARALLEL_POLICY`** (`serial` DEFAULT = current prod/byte-identical / `shadow` = run parallel path for telemetry, return serial result / `on` = apply parallel+dedupe) plus knob `DISCOVERY_MAX_PARALLEL` (default 4). **Equivalence proven: same candidate SET and same accumulation order as serial** — dedupe only collapses exact content-hash duplicates, so the discovered corpus is identical; parallelism only reduces wall-clock + near-dup web calls. **DP01–DP10 unit suite 15/15 pass.** tsc: 0 new diagnostics in changed files (62 pre-existing elsewhere). At the shipped-off default (`serial`) the parallel path is skipped entirely ⇒ **Total cells changing Y→N = 0, N→Y = 0, Total Flips = 0** (no scoring surface touched; discovery corpus byte-identical). | ✅ keep (default `serial`/off) | `DISCOVERY_PARALLEL_POLICY=serial` (default; no redeploy needed) or revert c25afd4 (3-file self-contained module + integration; no schema/env change) |
| B4 | 08212cd (module) + 957c263 (wiring) | prod (all 4 svc, auto-deploy from main; health `{"status":"ok","version":"3.0.0"}`) | n/a (no batch — prod `on` but equivalence-preserving; only bytes+index wired, no score/verdict layer) | WP12/B4 layered content-hash cache. **Gate satisfied: B4 needs A1 (e6b2e85+08b56ee, batch 1285 ✅) + A3 (3990bcd+15bbcc0, enforce-on ✅).** New module `server/lib/cache-layers.ts` (7-level layered cache design with sha256 content-hash keys reusing corpus-replay/run-manifest primitives; tenant isolation via `workspaceId` in every key; reason-aware negative caching; A1/A3 composition; FIFO eviction at `CACHE_LAYER_MAX_ENTRIES`=2048) + wiring layer `server/lib/pipeline-cache.ts` (singleton stores + gated wrappers). Versioned kill-switch **`CACHE_LAYER_POLICY`** (`off` = code DEFAULT, byte-identical / `shadow` = compute+compare, return fresh / `on` = serve cache). **Prod is configured `CACHE_LAYER_POLICY=on` — caching is ACTIVE in production** (the compiled code default stays `off`; the live value is a prod env override). **Scope — honestly bounded: 2 of 7 layers wired** — (1) **bytes layer** (pipeline.ts fetch phase: caches extracted text by `{workspaceId,url}` ⇒ a warm hit skips network I/O *and* PDF extraction/OCR — the dominant 446s→10.8s lever) and (2) **index layer** (analyzer.ts `summarizeDocuments`: caches BM25-selected corpora). **Deferred (not wired): extraction, OCR, eligibility, packs, scores** — each carries an A4 (extraction-fidelity) / A1 (coverage-labelling) invariant-preservation risk or LLM-output non-determinism risk that would need its own equivalence gate; recorded here so the 2/7 scope is explicit, not implied-complete. **cache-layers 15/15 + cache-wiring integration 12/12 pass** (off-bypass, cold==warm under `on`, shadow-returns-fresh, freshness-keyed-by-content-hash, tenant isolation). tsc: 0 new diagnostics in changed files. With caching **on in prod**, the two wired seams are equivalence-preserving: the **bytes layer** returns the same extracted text and the **index layer** the same BM25-selected corpus for a given content hash, and the **score/verdict layer is NOT wired** (no score or verdict is ever cached) ⇒ **Total cells changing Y→N = 0, N→Y = 0, Total Flips = 0** (verdict-invariant by construction — the 2 of 7 wired layers cache fetch/index inputs only). | ✅ keep (prod `on`; code default `off`); extraction/OCR/eligibility/packs/**score-verdict** layers DEFERRED to a future WP extension (not wired) | `CACHE_LAYER_POLICY=off` returns the byte-identical pre-cache behaviour (env change, no redeploy) or revert 957c263 (wiring) then 08212cd (module); no schema/env change |
| A6 | ec8aa4e | prod (all 4 svc, auto-deploy from main; push 7134eb5..ec8aa4e; health `{"status":"ok","version":"3.0.0"}`) | n/a (no batch — governance, verified by output/diff; shadow default = verdict-invariant by construction) | WP07/A6 framework-contract + test-drive defect governance. New module `server/lib/framework-contract.ts` (+ test) that (1) assembles a strict per-measure CONTRACT view (construct · decidable definition · qualifying/non-qualifying evidence · source/entity/time scope · applicability · implementation-vs-aspiration · anti-inference · uncertainty) by **reusing existing framework-v2 modules** rather than duplicating them, (2) classifies test-drive defects into 7 real causes (framework-ambiguity / discovery / acquisition-extraction / entity-provenance / retrieval / scoring / technical) so a missed document routes to a RESEARCH fix not a looser rubric, and (3) enforces the Goodhart no-distribution-tuning rule as a HARD RULE (prevalence can never move a definition or score; accepted edits emit a NEW framework version with an impact preview, never a silent rewrite; company-specific fixes rejected unless a universal data correction). Versioned kill-switch **`FRAMEWORK_CONTRACT_POLICY`** (`shadow` DEFAULT = non-mutating passthrough / `enforce` = NOT set in prod), `FRAMEWORK_CONTRACT_POLICY_VERSION=1`. `runContractGovernance(...).publishedScoresMutated` is **always false ⇒ zero published scores changed by construction**. Reused (not duplicated): scoring-contract.ts, structured-guidance.ts (extractGuidanceObject), anti-inference.ts, rules.ts, eligibility-decision.ts, root-cause-diagnostic.ts, builder-improve.ts, emitHardenedFramework. Genuine gaps closed: G1 assembled contract view + 2 invariants (examples illustrate, never mutate; search hints ≠ eligibility); G2 7-category defect classifier w/ missed-doc→research routing; G3 no-distribution-tuning validator w/ new-version + impact-preview (ImpactPreview exposes cellsYesToNo/cellsNoToYes/cellsChanged for any future enforce run). **Tests 32/32 (FW01–FW07 = 3/5/3/3/3/2/3 + kill-switch-default 3 + non-mutation 3 + serialization/assembly 6).** tsc: 0 new diagnostics in changed files (62 pre-existing baseline unchanged). **At shipped-off default (`shadow`): Total cells Y→N = 0, N→Y = 0, Total Flips = 0** (no scoring surface mutated). **Materially inert (not "live/dormant"): `framework-contract.ts` is imported only by its own test — `FRAMEWORK_CONTRACT_POLICY` / `runContractGovernance(...)` are read nowhere in the live pipeline, so the module is deployed-but-unwired** (available for a future wiring WP; today it changes nothing). | ✅ keep (default `shadow`; materially inert — unwired) | `FRAMEWORK_CONTRACT_POLICY=shadow` is the default (no redeploy); or revert ec8aa4e (2-file self-contained module+test; no schema/env change) |
| B5 | 154ff9b → on: 8725521 | prod (all 4 svc, auto-deploy from main; shipped-dormant push SUCCESS on 154ff9b; **GATE5 flip push 2026-10-17 SUCCESS on 8725521 all 4 svc**; health `{"status":"ok","version":"3.0.0"}`) | 1294 (corpus-replay off 1293's frozen corpus; snapshot gitSha=8725521 all 10 co ⇒ worker on new code ⇒ policy=on; canary-first company 9) | WP13-C/D/E/B5 model-cost reductions (semantic — ships DORMANT). New framework-level module `server/lib/model-cost.ts` (DB-free, no company/topic branches) with three levers: **(C, headline) `planContextTrim`** — trims *repeated* context but **provably never *decisive* context (LM04)**: reuses A5's `computeDecisivePassages` oracle (not reimplemented) and mirrors `planBoundedExpansion`'s subsumption rule in the *trim* direction — a pack passage is a trim candidate ONLY if it is non-decisive AND every decisive token + source link it carries is already covered by a kept passage. HARD INVARIANT (`verifyTrimPreservesRecall`): decisive pack passages ⊆ kept set, recall preserved with identical misses ⇒ relevant/decisive text is NEVER dropped; **(D) `stablePrefixOrder`** — partitions invariant boilerplate first / volatile per-company evidence last for provider prompt-cache hits (pure reorder preserving the content multiset); **(E) `routeModel`** — cheaper-first-pass-with-escalation **scaffold only** (NOT wired to live models; verification stages always strong; strong model at off; pending GATE5 per-measure/topic/language proof). Versioned kill-switch **`CONTEXT_COST_POLICY`** (`off` DEFAULT = current prod/byte-identical / `shadow` = savings telemetry, pack NOT modified / `on` = apply trim), `CONTEXT_COST_POLICY_VERSION=1`, `resolveContextCostPolicy()` fail-safe (unrecognized → off, total, never throws). Wiring: lever C gated at the A5 evidence seam in `analyzer.ts` (after `finalEvidence` settles) — at `off` the whole block is SKIPPED (no extra work, pack byte-identical); `shadow` logs savings without mutating; `on` applies; fail-open on error. Levers D/E module-only scaffolds (not wired). **Tests 11/11 (model-cost.test.ts): CC01 headline — every decisive pack passage ∈ keptIds + recall unchanged across negative/contradiction/qualifier/low-freq/table/single-decisive cases; CC02 only provably-redundant repeats trimmed; CC03 off-passthrough; CC04 shadow verdict-invariant; CC05 prefix multiset preserved + off byte-identical; CC06 routing (verify never cheap, escalation fires, off=strong); CC07 resolver fail-safe/frozen; CC08 determinism; CC-G3 byte-identical-at-off proof.** tsc: 62 before → 62 after, **0 new** diagnostics in changed files. **At shipped-off default (`off`): reconstructed pack == original ⇒ Total cells Y→N = 0, N→Y = 0, Total Flips = 0** by construction. **GATE5 (2026-10-17, user-approved): default flipped `off`→`on` via code (`8725521`); env still overrides.** STEP 1 offline held-out proof over 1293's frozen corpus: **invariant holds 360/360, 0 violations** (decisive text never dropped), trim fired 326/360, aggregate pack-token reduction **25.39%** (3,920,993→2,925,442; harness `4156742`). Live corpus-replay batch 1294 off 1293 (canary-first co 9; snapshot gitSha=8725521 all 10 co ⇒ policy=on): 10/10, all ms=36. **Token/cost: prompt tok 13,937,501→12,221,478 (−12.31%), total tok −11.82%, cost $4.1684→$3.6851 (−11.59%), identical 1,580 calls — a REDUCTION (the B5 goal).** **Cell-flip vs 1293: Yes 67→70, Net +3, Y→N=4, N→Y=7, Total Flips=11** (consistency PASS; below noise floor A1 21/A2 20/A3 28/B1 19/A5 16; unstructured — 9 measures/5 co, 5 co zero flips; see 2026-10-17 section). **Total cells Y→N=4, N→Y=7.** | ✅ keep — now default **on** via `8725521` (GATE5 live batch 1294; Y→N=4, N→Y=7, Total Flips=11, Yes 67→70; −12.31% prompt tok / −11.59% cost; invariant 360/360; see 2026-10-17 section) | `CONTEXT_COST_POLICY=off` (or `=shadow`) restores the byte-identical pre-B5 pack with NO redeploy; or revert `8725521` (3-file default+comments+test, no schema change) then `154ff9b` to remove the whole B5 feature |
| B6 | deec3a8 (code) · dynamic enabled 2026-10-18 | prod (all 4 svc, auto-deploy from main; production + sprint-10-preview, app+worker all SUCCESS on deec3a8; health `{"status":"ok","version":"3.0.0"}`). **ENABLED 2026-10-18 ~00:02-00:06 UTC: `CAPACITY_POLICY=dynamic` set on PRODUCTION app+worker via Railway GraphQL `variableUpsert` (user-approved). Env-only change — prod server code byte-identical to deec3a8 (`git diff deec3a8..f41d2af` = docs-only ledger commit; deployed HEAD f41d2af). Both prod svc redeployed SUCCESS on f41d2af; health `{"status":"ok","version":"3.0.0"}`; variable readback worker+app both `=dynamic`; worker startup log `[Worker] CAPACITY_POLICY=dynamic replicaCount=1 static=4 dynamic=4 effective=4 withinBudget=true maxSafeReplicas=40` ⇒ dynamic resolved == static == 4 at current replicaCount=1 (behaviourally identical now; only lowers at ≥5 replicas, never raises). Total cells Y→N=0, N→Y=0 by construction (worker concurrency change, scoring untouched, no paid batch).** | n/a — default `static` is a behavioural NO-OP (worker concurrency === prior prod constant `MAX_CONCURRENT`); no paid batch required to prove equivalence (code-path argument below) | WP14/B6 capacity experiments — connection-budget-aware worker concurrency (a disciplined capacity-TUNING method + ONE dynamic element; NOT a closed-loop autoscaler and NOT a replica-count controller — replica COUNT stays the user's manual Railway lever). **Bottleneck classified + every DB connection inventoried** (`gate_b6_out/b6_bottleneck_and_connection_inventory.{md,json}`): the app runs on its OWN Railway Postgres, LIVE-confirmed `max_connections=100` − `superuser_reserved_connections=3` ⇒ **97 usable** is the binding ceiling (this is the documented 88-vs-97 class of failure, NOT the Abacus 25/DB default). Prod pools: `db.ts`/`PG_POOL_MAX`=20 (app+worker) + 4 small gated pools (llm-usage/stage-profile/paid-call=2, run-manifest=1) ⇒ per-worker worst case **27**, per-app **26**; 2 app + 2 worker = **106 > 97** in the saturated worst case. New pure DB-free, no-company/topic module **`server/lib/capacity-config.ts`**: `effectiveConcurrency = clamp(floor((DB_CONNECTION_BUDGET − reservedOverhead) / replicaCount / connectionsPerJob), 1, HARD_MAX)` with in-code defaults budget=90, overhead=10, cpj=2, HARD_MAX=10 (=today's static concurrency ⇒ dynamic can only ever LOWER, never raise). **Ceiling invariant** `effectiveConcurrency × replicaCount × connectionsPerJob + reservedOverhead ≤ DB_CONNECTION_BUDGET` GUARANTEED by construction for replicaCount ∈ [1, maxSafeReplicas=40], exposed via `checkCeilingInvariant()` (beyond 40 it returns false — a documented "cut replicas" signal, never a silent breach). Versioned kill-switch **`CAPACITY_POLICY`** (`static` DEFAULT = current prod/byte-identical / `shadow` = compute+log budget-derived value, still USE static / `dynamic` = apply budget-derived value), `CAPACITY_POLICY_VERSION=1`, `resolveCapacityPolicy()` fail-safe (unrecognized → static, total, never throws). Wired ONLY at the worker-concurrency seam (`server/worker.ts` line 53/1570 — `concurrency: EFFECTIVE_CONCURRENCY`); at default `static` this resolves to exactly `MAX_CONCURRENT` ⇒ byte-identical. Does NOT touch analyzer/evidence/scoring and does NOT change any pool max size (approval-gated tuned-matrix decision). One-variable matrix harness `server/scripts/gate_b6_capacity_matrix.ts` prints safe operating point for any replica count. **Tests 13/13 (capacity-config.test.ts): CAP01 invariant holds across replicaCount 1..maxSafe × budget sweep + CAP01b infeasibility flagged beyond maxSafe + CAP01c known points (r=1→10,2→10,4→10,8→5,10→4,16→2,20→2,40→1); CAP02 default=static + static/shadow byte-identical; CAP03 dynamic only lowers ≤HARD_MAX; CAP04 env override; CAP05 fail-safe; CAP06 determinism; CAP07 purity/shadow-computes-not-applies.** Adjacent adaptive-concurrency suite 13/13 green. tsc: 62 before → 62 after, **0 new diagnostics in changed files**. **At shipped default (`static`): worker `concurrency` is literally the same `MAX_CONCURRENT` constant; analyzer/evidence/scoring surface untouched ⇒ Total cells Y→N = 0, N→Y = 0, Total Flips = 0 by construction** (no scoring surface mutated ⇒ no paid batch needed). **Total cells Y→N=0, N→Y=0.** | ✅ keep (default `static` = byte-identical no-op; `dynamic` is the user's approval-gated lever) | `CAPACITY_POLICY=static` is the default/no-op (set `=dynamic` to enable; no redeploy if env settable); or revert `deec3a8` (4-file self-contained module+test+harness+worker-seam wiring + gate_b6_out artifacts; no schema/pool/env change) |
| A9 | 8aebe6b (code) | prod (all 4 svc, auto-deploy from main; production + sprint-10-preview, app+worker all SUCCESS on 8aebe6b; health `{"status":"ok","version":"3.0.0"}`; deployed SHA == tested SHA on all 4 — full `8aebe6bb6dfbdbd26e7c563b8ee34af0b55fd13a`). | n/a — governance/reporting only, verdict-invariant; no paid batch (code-path argument below) | WP15/A9 truthful publication & release-evidence governance. New pure, DB-free, no-company/topic module **`server/lib/truthful-publication.ts`** (+ `truthful-publication.test.ts`). (a) **One canonical publication record accessor** `buildPublicationRecord()` — the single shape every reader surface (API/UI/CSV/Word/PDF) derives from, so verdict/evidence/research-status can never diverge (PU01, CV07). Links each assessment to framework version + source scope + as-of (`PublicationScope`), coverage/researchStatus (reuses `shared/research-state.ts` CV01–CV07 incl. `summarizeResearchStatus`/`researchStatusCsvColumns`), evidence IDs, and run provenance (reuses `server/lib/run-manifest.ts` `RunManifest`/`hashObject`/`canonicalize` — NOT a parallel system). (b) `assertTruthfulCompleteness()` — an incomplete assessment is NEVER rendered/exported as comprehensive. (c) **Immutable snapshots** `publishSnapshot()` (deep-frozen, hash-anchored) + **explicit reason-required revisions** `reviseSnapshot()` (links `revisionOf`+increment; original never mutated; throws on empty reason ⇒ no silent recompute) + `verifySnapshotIntegrity()`. (d) **Separate release record types** (candidate-review/approval/merge/deploy/validation/acceptance): `classifyCommitAsReleaseEvidence()` returns a HISTORICAL merge record (a commit message is never approval); `recordApproval()` throws if `fromCommitMessage` or missing approver/ref; `preserveFeatureBranchText()` keeps feature-branch-only text as dated history; `currentReleaseStatus()` ignores historical records. (e) **Release-gate evidence** `evaluateReleaseGate()` keeps the RAW non-deduped lists (tests+skips, TS diagnostic multiplicity, mutation checks, packaging) ALONGSIDE a dedup summary — relevant text never dropped; FAILS (never exit-0 skip) on test fail / unreasoned skip / diagnostics over baseline (raw count) / missing Chromium (PU04) / mutation blind spot (PU05) / missing worker asset (PU06). `reconcileRuntimeWithTested()` (PU03 — deployed SHA == tested SHA). (f) **WP23 measurement baseline** keyed by framework/topic/language/sector with `incompleteResearchRate` tracked SEPARATELY (no global-average hiding). Versioned kill-switch **`PUBLICATION_POLICY`** (`passthrough` DEFAULT = non-mutating, byte-identical to today / `annotate` = APPEND additive governance+research-status columns, existing fields untouched / `shadow` = also non-mutating reader surface), `PUBLICATION_POLICY_VERSION=1`, `resolvePublicationPolicy()` fail-safe (explicit > env > default; unrecognized/empty → `passthrough`, total, never throws). **Cross-surface routing:** the TS accessor is the single canonical verdict/status source; a committed Python/TS parity test pins `server/scripts/export_ai_csv_from_snapshot.py:norm_verdict` against TS `normalizeVerdict` cell-for-cell (CSV/Word/PDF can't drift) — no invasive exporter rewrite (preserves byte-identical default). **Tests 18/18 (truthful-publication.test.ts): PU01 cross-surface consistency + PU01b incomplete≠comprehensive + PU01c Python/TS verdict parity; PU02 immutable snapshot + explicit revision; PU03 SHA reconcile; PU04/PU04b missing Chromium + unreasoned-skip fail; PU05 parent-cancellation mutation sensitivity; PU06 worker-asset packaging; TS-baseline gate; RAW-EVIDENCE preserved (non-deduped); release-record types (commit≠approval, feature-branch=history); KILL-SWITCH default passthrough byte-identical (5 base CSV cols, no governance block); NON-MUTATION (input never mutated, verdict uses only existing normalizeVerdict); RESOLVER fail-safe; ROUND-TRIP serialization; WP23 subgroup baseline.** Legacy suites green (capacity-config 13/13, run-manifest 7/7, snapshot-durability 12/12). tsc: **62 before → 62 after, 0 new diagnostics in changed files**. **At shipped default (`passthrough`): no published-score surface is mutated — the verdict field is only the pre-existing canonical `normalizeVerdict` every surface already applies, and passthrough emits no new/changed reader field ⇒ Total cells Y→N = 0, N→Y = 0, Total Flips = 0 by construction** (reporting/governance only; no analyzer/evidence/scoring path touched ⇒ no paid batch needed). **Total cells Y→N=0, N→Y=0.** Materially inert (not "live/dormant"): `truthful-publication.ts` is imported only by its own `truthful-publication.test.ts` — `PUBLICATION_POLICY`/`buildPublicationRecord` are read NOWHERE in the live pipeline; deployed-but-unwired. | ✅ keep (default `passthrough` = byte-identical no-op; `annotate` is the opt-in governance surface; materially inert — unwired) | `PUBLICATION_POLICY=passthrough` is the default/no-op (set `=annotate` to surface governance columns; no redeploy if env settable); or revert `8aebe6b` (2-file self-contained module + test; no schema/pool/env/exporter change) |
| B-dur | aa3fec7 (Dockerfile `tini` permanent ENTRYPOINT — already in tree, ancestor of live HEAD) | prod (all 4 svc, auto-deploy from main; live on c92d26a which ⊇ aa3fec7 — verified all 4 SUCCESS 2026-10-18; health `{"status":"ok","version":"3.0.0"}`) | n/a — infra/Dockerfile init change, no scoring surface, no paid batch | WP(dur)/B-dur durability of the `tini` PID-1 fix. **Already satisfied by the in-tree Dockerfile: `ENTRYPOINT ["/usr/bin/tini", "-g", "--"]` (line 60, commit aa3fec7) makes tini the permanent init for EVERY service regardless of its Railway start command.** Verified live 2026-10-18: all 4 services (production + sprint-10-preview, app+worker) SUCCESS on c92d26a (⊇ aa3fec7); deployed Dockerfile carries the ENTRYPOINT; prod health ok. Durability objective — "the fix can't vanish if the Railway start command is cleared" — is **structurally guaranteed**: with ENTRYPOINT tini in place, clearing a service's startCommand falls back to the Dockerfile CMD still wrapped by tini as PID 1. Start commands observed 2026-10-18: prod app `startCommand=null` (uses CMD under the tini ENTRYPOINT ✓); prod worker `startCommand=/usr/bin/tini -g -- node --import tsx server/worker-main.ts` (redundant belt-and-suspenders now that ENTRYPOINT also supplies tini — **LEFT UNTOUCHED**: harmless nested-tini; removing it would force an unnecessary prod redeploy — exactly the mid-run disturbance the gate warns against). Does NOT touch `processor.ts` ⇒ A4 recovery-boundary guard + small-PDF root-cause fix preserved by non-interference. **Gate honesty:** the plan's "gated on your confirmation the current dashboard re-run is clean" was a precaution against *introducing* the Docker change during an unstable run; the ENTRYPOINT change predates and is independent of the batch runs and is already stable in prod, so the action the gate governed carries no pending risk. **NOT self-certified as a clean re-run** — the latest 25-company validation (batch 1276) was a measured clean-completion FAILURE (12/25, isolated-child spawn abort under 8-slot load), a separate pipeline-under-load matter, NOT a tini/B-dur regression. **Total cells Y→N=0, N→Y=0, Total Flips=0** by construction (Dockerfile init change; analyzer/evidence/scoring untouched). | ✅ complete — durability live (aa3fec7 ENTRYPOINT on all 4 svc) | revert aa3fec7 restores the pre-tini Dockerfile (reintroduces PID-exhaustion risk — do not); redundant worker startCommand tini prefix can be dropped later if desired (cosmetic, forces a redeploy) |
| WP05/Phase2 (Ground truth, Issue 2) | this ledger commit (Phase 2 framework) | prod (all 4 svc, auto-deploy from main; app+worker SUCCESS on the Phase 2 commit; health `{"status":"ok","version":"3.0.0"}`) | n/a — framework/CI asset, INERT at runtime, no paid batch | WP05/Phase 2 breaks the A5/B5 circularity (the "recall"/"decisive" proofs grade themselves against the SAME keyword oracle `evidence-recall.ts` the scorer uses). Deploys the **framework-level ground-truth holdout machinery** as pure, offline, DB/LLM/network-free modules: **(1) HOLDOUT SELECTION** `server/lib/phase2-groundtruth.ts::selectHoldout()` — deterministic, seeded (`seededRng`/`seededShuffle`), stratified ~250–300-cell (company×measure) draw; strata by priority (a) current-Yes (b) historically-unstable/flip-across-runs (c) low-yield "0/36-type" companies (d) random No sample (e) ≥2 non-English filers represented (artifact-less filers kept as `needs-evidence` placeholders). Same seed+inputs ⇒ byte-identical manifest. DATA/CONFIG roster in `server/lib/phase2-holdout-roster.ts` (no company/topic branches in the selector). Against the 10-company post-fix replay corpus (1450 obs): **280 cells, strata current-yes=19/unstable=7/low-yield=192/random-no=62, 3 non-English filers**. **(2) LABEL SCHEMA (typed)** — authoritative `human_label` (Yes/No/Unsure, default **PENDING**), `labeller_id`, `document`, `passage`, `timestamp`, 20%-overlap flag, with a SEPARATE non-authoritative `provisional_suggestion` (independent model family only; gate never reads it as truth); `validateHoldoutLabel`/`validateLabelFile`/`buildLabelTemplate`. **(3) STANDING GATE** `computeGate()` — Yes precision & recall (+ Wilson 95% CIs), split by complete/incomplete research where derivable, AND the **TOTAL cells flipping Yes→No / No→Yes vs the oracle-era baseline (the SPLIT, not the net — constraint 4)**; pass/fail vs configurable **illustrative** thresholds (default precision ≥0.85, recall ≥0.75, overridable); runs ONLY against the fixed holdout. **HONESTY: with no authoritative human labels present the gate returns `not-armed` ("ground truth pending") and fabricates NO pass and NO precision/recall numbers.** Thin offline CLI `server/scripts/phase2_gate_cli.ts` (`select`/`gate`). **Tests 23/23 (phase2-groundtruth.test.ts): selection determinism + strata composition + non-English coverage + budget; schema validation (PENDING vs adjudicated, provisional, duplicates, key-not-in-manifest); precision/recall math (hand-computed TP/FP/FN/TN) + Wilson CI; Yes→No/No→Yes oracle split (not net); threshold pass/fail + override + research split; "all-PENDING ⇒ not-armed", "Unsure ⇒ not-armed", "too few Yes ⇒ not-armed", oracle-split-reported-when-not-armed** — ALL with SYNTHETIC labels (never presented as human truth). phase1-reproducibility regression 16/16 green. tsc: **62 before → 62 after, 0 new diagnostics in changed files.** **INERT AT RUNTIME: nothing is wired into the scoring pipeline — the modules are imported only by the test + the offline CLI; scoring any volume in production triggers ZERO per-company human input (constraint 7) ⇒ Total cells Y→N = 0, N→Y = 0 at runtime by construction** (no scoring surface touched; no paid batch). **$0 LLM spend — no pre-annotation model called (clean analyst template chosen).** | ✅ keep — framework + schema + standing gate + tests DEPLOYED and inert; gate **NOT armed** until the one-time analyst adjudication of the fixed holdout (NOT per-company production review) | revert the Phase 2 commit (3 new lib/script files + 1 test + this ledger; no schema/pool/env/scoring change) |
| Phase 3 / Issue 3 (Scale) | this ledger commit (Phase 3 framework) | prod (all 4 svc, auto-deploy from main; app+worker SUCCESS on the Phase 3 commit; health `{"status":"ok","version":"3.0.0"}`) | n/a — framework/instrumentation levers, SHIPPED DORMANT at default, no paid batch | WP(Scale)/Phase 3 = Issue 3 "pipeline has never completed a 25-company run" (batch 1276 12/25 isolated-child spawn aborts under 8-slot load; batch 1277 4/25 four jobs hit the 2100s wall-clock timeout with logs silent, cause "open, not diagnosed", hypothesis = shared serialised resource; stop rule cancels the WHOLE batch after 3 first-attempt failures before any retry). Ships the **non-paid, code-only** parts of the 5-part Issue-3 solution (parts 2 & 5 are paid batches, OUT OF SCOPE) as **four pure, framework-level, DB/LLM/company/topic-agnostic modules**, each behind a versioned kill-switch defaulting to **current production behaviour (byte-identical)**: **(M1) `server/lib/stage-instrumentation.ts`** — per-stage start/end timers emitted from INSIDE the isolated child, heartbeat snapshots of in-progress spans so a TIMED-OUT job still leaves a durable record, queue-wait timing for every shared resource (browser/llm/db/analysis); kill-switch **`STAGE_INSTRUMENTATION_POLICY`** (`off` DEFAULT = no emits/snapshots, byte-identical / `shadow` = compute+log telemetry / `on`). **(M2) `server/lib/pipeline-time-budget.ts`** — per-stage time budgets + per-company progress-based timeout replacing the single 2100s wall-clock; a stalled stage degrades THAT SOURCE to `transient_unavailable` ("source unresolved", reuses `shared/research-state.ts`; module-load assertion proves it is retryable & not conclusive-absence) — **bounds TIME, never evidence** (`retainEvidence` is identity); kill-switch **`PIPELINE_TIME_BUDGET_POLICY`** (`wallclock` DEFAULT = `parseInt(PIPELINE_TIMEOUT_MS||"540000")` verbatim, byte-identical / `budgeted` = per-stage budgets + progress timeout). **(M3) `server/lib/batch-resilience-policy.ts`** (NEW file, does NOT overwrite `batch-stop-rule.ts`) — retry → quarantine-with-reason after retries exhausted → cancel the batch ONLY on a systemic signal (>20% failing OR cost overrun); one failure never cancels the batch; kill-switch **`BATCH_RESILIENCE_POLICY`** (`legacy` DEFAULT = delegates to `batch-stop-rule.ts::decideBatchStop`, byte-identical / `resilient` = retry/quarantine/systemic-only). **(M4) `server/lib/resource-pools.ts`** (DORMANT, UNWIRED) — models separate bounded pools for browser-recovery vs analysis slots, composed under the B6 97-usable connection ceiling (reuses `capacity-config.ts`, does not re-derive); kill-switch **`RESOURCE_POOL_POLICY`** (`shared` DEFAULT = single shared path / `separated` = split pools). All `resolve*Policy()` resolvers fail-safe to default on unrecognised values and never throw; `*_POLICY_VERSION=1`. **Wiring is minimal & telemetry-only at non-default modes** (full behavioural arming of budgeted/resilient/separated is gated on the paid instrumented diagnostic run — Issue-3 part 2, out of scope): M1 at the worker heartbeat seam (null StageLedger at `off` ⇒ byte-identical), M2 at `job-isolation.ts::pipelineTimeoutMs` (returns the legacy `PIPELINE_TIMEOUT_MS` at `wallclock` ⇒ byte-identical), M3 in `worker.ts::stopRuleTripped` (falls straight through to `enforceBatchStopRule` at `legacy` ⇒ byte-identical; non-legacy emits `[BATCH-RESILIENCE]` telemetry only, executor stays legacy), M4 unwired (imported only by its own test — sanctioned A6/A9 house style). **Tests: M1 9/9, M2 10/10, M3 9/9, M4 7/7 (= 35 new); regression phase1-reproducibility 16/16 + phase2-groundtruth 23/23 + batch-stop-rule 19/19 (+1 DB-skipped) + capacity-config 13/13 all green.** tsc: **62 before → 62 after, 0 new diagnostics in any changed file** (4 modules + 4 tests + `worker.ts` + `job-isolation.ts`). **At the shipped-dormant defaults (off / wallclock / legacy / shared) every wiring seam resolves to the exact prior prod path ⇒ Total cells Y→N = 0, N→Y = 0, Total Flips = 0 by construction** (no scoring/evidence/analyzer surface mutated ⇒ no paid batch needed). **Total cells Y→N=0, N→Y=0.** | ✅ keep — framework instrumentation + budget/resilience/pool levers DEPLOYED and dormant at default; behavioural arming gated on the paid Issue-3 part-2 diagnostic run | each kill-switch default is the no-op (`STAGE_INSTRUMENTATION_POLICY=off` / `PIPELINE_TIME_BUDGET_POLICY=wallclock` / `BATCH_RESILIENCE_POLICY=legacy` / `RESOURCE_POOL_POLICY=shared`; no redeploy if env-settable); or revert the Phase 3 commit (4 new modules + 4 tests + 2 minimal wiring edits + this ledger; no schema/pool/env/scoring change) |

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



---

### B6 / WP14 — capacity experiments: connection-budget-aware worker concurrency (2026-10-18)

**Decision.** User-approved: "Go ahead with B6 — implement, test and if the test is successful, deploy it to
production." B6 delivers WP14's disciplined capacity method — **classify the bottleneck → inventory every DB
connection → one-variable capacity matrix → prefer more replicas at lower per-replica concurrency** — plus ONE
genuinely dynamic element. It is **NOT** a closed-loop autoscaler and **NOT** a replica-count controller: the
replica COUNT stays the user's manual Railway lever; B6 only makes the worker safe/correct at whatever replica
count is set, by deriving per-replica job concurrency from the binding DB-connection budget so TOTAL
connections stay under the ceiling as replicas scale. Shipped with the kill-switch default `static` (a
behavioural no-op), so the deploy carries zero prod risk; enabling `dynamic` remains the user's approval-gated
lever.

**STEP 1 — bottleneck classification + DB-connection inventory** (`gate_b6_out/b6_bottleneck_and_connection_inventory.{md,json}`).
- **Binding ceiling, LIVE-confirmed.** The app runs on its OWN Railway-hosted Postgres (project `db04e5b1`),
  NOT the Abacus platform 25/DB default. `SHOW max_connections;` = **100**, `SHOW superuser_reserved_connections;`
  = **3** ⇒ **97 usable** non-superuser connections. The documented "88-vs-97 failure" was a pool bump that
  pushed the saturated worst-case total toward this 97 ceiling.
- **Every production pool inventoried.** `server/db.ts` main drizzle pool `PG_POOL_MAX`=20 (app+worker, eager) +
  four small lazy gated pools — `llm-usage`/`stage-profile`/`paid-call` = 2 each (app+worker), `run-manifest` = 1
  (worker). Per-process worst case: **worker 27, app 26**. App-wide worst case `(appReplicas×26)+(workerReplicas×27)`:
  1app+2worker = 80 (OK), **2app+2worker = 106 (BREACH)**, 1app+3worker = 107 (BREACH). Script pools
  (`server/scripts/*`) do not run inside the live services and are excluded.
- **Classification.** DB connections (97 usable) is the **binding** bottleneck; worker concurrency is bounded by
  pool max (not an independent ceiling); the LLM API is governed separately. **Derived safe budget:** budget 90
  (under 97, matches `db.ts` "comfortably under ~90"), reservedOverhead 10, connectionsPerJob 2 (=20/10),
  HARD_MAX 10 (=today's static concurrency), `maxSafeReplicas = floor((90−10)/2) = 40`.

**STEP 2 — module + wiring + harness.**
- New pure, DB-free, no-company/topic module **`server/lib/capacity-config.ts`**:
  `computeDynamicConcurrency = clamp(floor((DB_CONNECTION_BUDGET − reservedOverhead) / replicaCount / connectionsPerJob), 1, HARD_MAX)`;
  the **ceiling invariant** `effectiveConcurrency × replicaCount × connectionsPerJob + reservedOverhead ≤
  DB_CONNECTION_BUDGET` is guaranteed by construction for replicaCount ∈ [1, maxSafeReplicas] and exposed via
  `checkCeilingInvariant()` (beyond maxSafeReplicas it returns false — a documented "cut replicas" signal, never
  a silent breach — rather than over-claiming "impossible for any N").
- Versioned kill-switch **`CAPACITY_POLICY`** (`static` DEFAULT = current prod/byte-identical / `shadow` =
  compute + log the budget-derived value but still USE static / `dynamic` = apply the budget-derived value,
  which can only ever LOWER concurrency as replicas grow, never raise above HARD_MAX). `CAPACITY_POLICY_VERSION=1`,
  `resolveCapacityPolicy()` fail-safe (explicit > env > default; unrecognized/empty → `static`, total, never
  throws — mirrors the B5 `resolveContextCostPolicy` pattern). replicaCount reads `REPLICA_COUNT` then
  `RAILWAY_REPLICA_COUNT` at boot (floor 1).
- **Wired ONLY at the worker-concurrency seam** (`server/worker.ts`): `const CAPACITY =
  resolveEffectiveConcurrency(loadCapacityConfig()); const EFFECTIVE_CONCURRENCY = CAPACITY.effectiveConcurrency;`
  then `concurrency: EFFECTIVE_CONCURRENCY` on the BullMQ `Worker` (plus the health-check fallback, the adaptive
  controller's start value, and the startup log). At default `static`, `EFFECTIVE_CONCURRENCY` resolves to
  exactly the existing `MAX_CONCURRENT` constant ⇒ byte-identical. Does NOT touch the analyzer/evidence/scoring
  path and does NOT change any DB pool max size (an approval-gated tuned-matrix decision).
- One-variable matrix harness **`server/scripts/gate_b6_capacity_matrix.ts`**: given a budget it prints the
  computed per-replica concurrency + resulting total DB load + within-budget flag for a replica-count sweep, so
  the operator can read the safe operating point for any replica count without touching prod. Sample (default
  budget 90): r=1→10 (load 30), r=2→10 (50), r=4→10 (90), r=5→8 (90), r=8→5 (90), r=10→4 (90), r=16→2 (74),
  r=20→2 (90), r=40→1 (90) — every row within budget; r=41 would require cutting replicas.

**STEP 3 — tests.** `server/lib/capacity-config.test.ts` **13/13 pass**: CAP01 the ceiling invariant holds for
replicaCount 1..maxSafeReplicas across a budget sweep (60/75/90/97/120/200); CAP01b beyond maxSafeReplicas the
checker flags infeasibility (1×41×2+10 = 92 > 90) rather than hiding it; CAP01c known points
(r=1→10,2→10,4→10,8→5,10→4,16→2,20→2,40→1); CAP02 default == `static` and static/shadow USE the static constant
(byte-identical) even where dynamic differs; CAP03 dynamic applies the value, only ever lowers, never exceeds
HARD_MAX; CAP03b dynamic == static for ≤4 replicas (no change there); CAP04/CAP04b env override (policy + budget
knobs + `REPLICA_COUNT`/`RAILWAY_REPLICA_COUNT`); CAP05/CAP05b fail-safe (unrecognized → static; garbage env →
defaults); CAP06 determinism; CAP07 purity + shadow-computes-but-does-not-apply. Adjacent **adaptive-concurrency
suite 13/13** green (the worker seam shares that controller). `tsc --noEmit`: **62 before → 62 after, 0 new
diagnostics in the changed files** (the 62 are pre-existing errors elsewhere in the repo).
- **Equivalence (code-path argument).** At the shipped default `static`, the worker's `concurrency` is literally
  the same `MAX_CONCURRENT` constant it was before, and B6 touches NO analyzer/evidence/scoring file ⇒ the
  scoring surface is byte-identical ⇒ **Total cells Y→N = 0, N→Y = 0, Total Flips = 0 by construction.** No paid
  batch is required to prove equivalence.

**STEP 4 — deploy.** Commit **`deec3a8`** `feat(WP14/B6): connection-budget-aware worker concurrency behind
CAPACITY_POLICY (default static=byte-identical)` (4 files: `server/lib/capacity-config.ts`,
`server/lib/capacity-config.test.ts`, `server/scripts/gate_b6_capacity_matrix.ts`, `server/worker.ts` seam +
`gate_b6_out/` artifacts; no schema/pool/env change). Pushed `30dff06..deec3a8 main`. All **4 Railway services**
(production + sprint-10-preview, app + worker) redeployed with status **SUCCESS on `deec3a8`**; health
`{"status":"ok","version":"3.0.0"}`. Because the default is `static`, this deploy is a behavioural no-op (safe);
enabling `dynamic` in prod remains the user's approval-gated lever.

**Cell-flip.** **Total cells Y→N = 0, N→Y = 0, Total Flips = 0** by construction (no scoring surface mutated at
the `static` default).

**Rollback.** `CAPACITY_POLICY=static` is the default/no-op — nothing to roll back (set `=dynamic` to enable);
or revert `deec3a8` (4-file self-contained module + test + harness + worker-seam wiring + gate_b6_out artifacts;
no schema/pool/env change).

**STEP 5 — production enablement `CAPACITY_POLICY=dynamic` (2026-10-18 ~00:02-00:06 UTC).** User-approved:
"Switch prod to CAPACITY_POLICY=dynamic." Set `CAPACITY_POLICY=dynamic` on the **PRODUCTION** environment for
BOTH the app and worker services via Railway GraphQL `variableUpsert` (production env only — sprint-10-preview
untouched). Each upsert returned `variableUpsert: true`.

- **Env-only change, code unchanged.** This is a variable change, not a code change. Railway auto-redeployed prod
  app+worker on main HEAD `f41d2af`; `git diff --name-only deec3a8..f41d2af` = ONLY
  `docs/implementation-run-ledger.{md,docx,pdf}` (the prior docs-only ledger commit) — **no server/code file
  differs, so the B6 worker/server code running in prod is byte-identical to `deec3a8`.** The tested code ==
  production code invariant holds.
- **Deploy status (observed).** `production worker status=SUCCESS commit=f41d2af branch=main`;
  `production app status=SUCCESS commit=f41d2af branch=main`.
- **Health (observed).** `{"status":"ok","version":"3.0.0"}`.
- **Variable readback (observed, GraphQL `variables`).** `worker: CAPACITY_POLICY=dynamic`,
  `app: CAPACITY_POLICY=dynamic`.
- **Runtime policy readback (observed, worker deployment log).**
  `[Worker] CAPACITY_POLICY=dynamic replicaCount=1 static=4 dynamic=4 effective=4 withinBudget=true maxSafeReplicas=40`
  — the worker resolved policy=**dynamic** and computed `effective=4` at the current `replicaCount=1`, which is
  **equal to the `static` value (4)**, so concurrency is unchanged right now. `withinBudget=true` confirms the
  ceiling invariant holds. Dynamic can only LOWER per-replica concurrency once replicas scale (≥5), never raise it
  ⇒ ceiling-safe by construction.
- **Cell-flip.** **Total cells Y→N = 0, N→Y = 0, Total Flips = 0** by construction — a worker-concurrency change
  cannot alter scoring; analyzer/evidence/scoring surface untouched; no paid batch run (none needed — the runtime
  readback shows dynamic == static at the current replica count).
- **Rollback.** Set `CAPACITY_POLICY=static` (or unset) on the prod app+worker to restore the byte-identical
  no-op default — no redeploy of code required.


### A9 / WP15 — truthful publication & release-evidence governance (2026-10-18)

**Decision.** Backlog step 9 of 10 under the standing rule "implement → test → keep if it works / roll back if
not → deploy to production on passing tests." A9 delivers WP15: make every exported assessment *honestly*
describe what it is (framework version, source scope, coverage/research status, evidence, provenance), make a
reviewer able to tell an UNCHANGED score from a quietly-INCOMPLETE one, make published history immutable with
explicit revisions, and make release evidence raw and non-deduped so nothing can hide. It is pure
reporting/governance — it touches **no analyzer/evidence/scoring path** — so it ships behind a kill-switch whose
default is a non-mutating passthrough, carrying zero prod risk.

**STEP 1 — module.** New pure, DB-free, no-company/topic module **`server/lib/truthful-publication.ts`** (+
`server/lib/truthful-publication.test.ts`). Reuses existing provenance primitives rather than inventing parallel
ones: `shared/verdict.ts` (`normalizeVerdict`/`isMet` — the one canonical verdict rule), `shared/research-state.ts`
(`ResearchStatus`/`summarizeResearchStatus`/`researchStatusCsvColumns` — CV01–CV07), `server/lib/run-manifest.ts`
(`RunManifest`/`hashObject`/`canonicalize`).
- **(a) One canonical publication record.** `buildPublicationRecord(input)` is the single accessor every reader
  surface derives from (API, UI, CSV, Word, PDF), so verdict / evidence / research-status can never diverge
  between surfaces (PU01, CV07). The record links the assessment to framework version + hash, source scope +
  as-of (`PublicationScope`), coverage/research status (`ResearchStatus`), ordered evidence IDs, source
  document + link, and run provenance (`runId`/`runMode`/`manifestHash`/`codeTreeHash`/`gitSha` +
  `reproducibilityLimits` carried verbatim from the run manifest).
- **(b) Incomplete ≠ comprehensive.** `assertTruthfulCompleteness(record, claimedComprehensive)` returns a
  violation when an incomplete assessment is claimed comprehensive; `comprehensive` is TRUE only when research
  is comprehensive with no unresolved essential gaps. A quietly-incomplete cell is surfaced as incomplete, never
  rendered as comprehensive.
- **(c) Immutable snapshots + explicit revisions.** `publishSnapshot()` deep-freezes a content-hash-anchored
  snapshot (a later mutation of the caller's objects cannot change history). `reviseSnapshot(previous, …, reason)`
  creates an EXPLICIT new revision (increments `revisionNumber`, links `revisionOf`, requires a reason — throws
  on empty) and leaves the original untouched; a correction is always a new, dated, linked revision, never a
  silent recompute. `verifySnapshotIntegrity()` re-hashes and compares.
- **(d) Separate release record types.** `candidate-review | approval | merge | deploy | validation | acceptance`.
  `classifyCommitAsReleaseEvidence()` returns a HISTORICAL `merge` record — a commit message (even one saying
  "approved/LGTM") is never promoted to approval. `recordApproval()` throws if asked to approve from a commit
  message or without a named approver + reference. `preserveFeatureBranchText()` keeps embedded
  "feature-branch-only / do-not-deploy" text as dated history. `currentReleaseStatus()` ignores historical
  records, so historical text can never be read as current deployment status.
- **(e) Release-gate evidence — raw, non-deduped.** `evaluateReleaseGate(input)` preserves the RAW lists (every
  test occurrence incl. skips, every TS diagnostic with multiplicity, mutation checks, packaging) verbatim and
  presents a dedup SUMMARY ALONGSIDE — never instead of — them (relevant text never dropped). The gate FAILS
  (never an exit-0 skip) on: any failed test; a skip with no explicit reason; TS diagnostics over the accepted
  baseline (by RAW count); **missing Chromium (PU04)**; **a mutation guard that did not fail as expected
  (PU05)**; **a missing required subprocess/worker asset (PU06)**. `reconcileRuntimeWithTested({deployedSha,
  testedSha})` enforces deployed SHA == tested SHA (PU03, short/long-SHA equivalence).
- **(f) WP23 measurement baseline.** `MeasurementBaseline` keyed by framework/topic/language/sector, with
  `incompleteResearchRate` tracked SEPARATELY from positive precision/recall so a global average can't hide a
  small-issuer / non-English subgroup gap. Serializes/round-trips canonically.
- **Kill-switch.** `PUBLICATION_POLICY` — `passthrough` (DEFAULT, non-mutating, byte-identical to today) /
  `annotate` (APPENDS an additive governance block + research-status CSV columns; existing fields never
  reordered or changed) / `shadow` (also non-mutating on the reader surface). `PUBLICATION_POLICY_VERSION=1`;
  `resolvePublicationPolicy()` fail-safe (explicit > env > default; unrecognised/empty → `passthrough`, total,
  never throws — a typo can never silently change what a reader sees).

**STEP 2 — cross-surface routing.** The TS accessor is the single canonical source of the published verdict and
status. The Python CSV exporters (`server/scripts/export_ai_csv_from_snapshot.py:norm_verdict`) already
implement the identical rule as `shared/verdict.ts:normalizeVerdict` (non-string→"No", blank→"No",
"partial"→"No", else verbatim); A9 adds a committed **Python/TS parity test** (PU01c) that pins the two
cell-for-cell so a CSV/Word/PDF export can never show a different verdict from the API/UI. No invasive exporter
rewrite was made — that preserves the byte-identical default and avoids prod risk.

**STEP 3 — tests.** `server/lib/truthful-publication.test.ts` **18/18 pass**: PU01 cross-surface consistency,
PU01b incomplete≠comprehensive, PU01c Python/TS verdict parity; PU02 immutable snapshot + explicit linked
revision (empty reason refused); PU03 SHA reconcile; PU04 missing-Chromium fail + PU04b unreasoned-skip fail;
PU05 parent-cancellation mutation sensitivity (blind spot → fail); PU06 worker-asset packaging; TS-baseline
gate (raw count); RAW-EVIDENCE preserved (duplicate test/diagnostic occurrences kept, dedup summary alongside);
release-record types (commit≠approval, feature-branch=history); KILL-SWITCH default passthrough byte-identical
(exactly the 5 base CSV columns, no governance block; shadow also non-mutating); NON-MUTATION (input never
mutated, evidenceIds copied not aliased, verdict uses only the existing normalizeVerdict — Partial→No is the
existing canonical rule, not a new A9 transform); RESOLVER fail-safe; ROUND-TRIP serialization + stable hash;
WP23 subgroup baseline. Legacy suites green: capacity-config 13/13, run-manifest 7/7, snapshot-durability
12/12. `tsc --noEmit`: **62 before → 62 after, 0 new diagnostics in the changed files** (the 62 are pre-existing
errors elsewhere in `server/scripts`).

**Cell-flip (code-path argument).** A9 is reporting/governance only. At the shipped default `passthrough`: no
published-score surface is mutated — the `verdict` field is produced solely by the pre-existing canonical
`normalizeVerdict` every surface already applies, and `passthrough` emits no new or changed reader field (the
governance block / research-status columns appear only under the opt-in `annotate`). No analyzer, evidence, or
scoring file is touched. Therefore **Total cells Y→N = 0, N→Y = 0, Total Flips = 0 by construction** — no paid
batch is required to prove equivalence.

**STEP 4 — deploy.** Commit **`8aebe6b`** `feat(WP15/A9): truthful publication & release-evidence governance
behind PUBLICATION_POLICY (default passthrough=byte-identical)` (2 files: `server/lib/truthful-publication.ts`,
`server/lib/truthful-publication.test.ts`; no schema/pool/env/exporter change). Pushed `fd0625f..8aebe6b main`.
All **4 Railway services** (production + sprint-10-preview, app + worker) redeployed with status **SUCCESS on
`8aebe6b`** (full `8aebe6bb6dfbdbd26e7c563b8ee34af0b55fd13a`); prod health `{"status":"ok","version":"3.0.0"}`.
- **Deployment-target verification.** deployed SHA == tested SHA on ALL 4 services (prefix match of the pushed
  commit `8aebe6b`). Because the default is `passthrough`, this deploy is a behavioural no-op (safe); surfacing
  governance via `annotate` remains an opt-in lever.

**Rollback.** `PUBLICATION_POLICY=passthrough` is the default/no-op — nothing to roll back (set `=annotate` to
surface governance columns; no code redeploy if the env is settable); or revert `8aebe6b` (2-file self-contained
module + test; no schema/pool/env/exporter change).

---

### B-dur — durability of the `tini` PID-1 fix: permanent Dockerfile ENTRYPOINT (2026-10-18)

**Decision.** Backlog step 10 of 10 (the final item) under the standing rule "implement → test → keep if it
works / roll back if not → deploy to production on passing tests." B-dur's objective is durability: make the
`tini` PID-1 reaping fix survive regardless of any per-service Railway start command, so the fix cannot silently
vanish if a start command is later cleared or edited in the Railway UI.

**Finding — already satisfied in the tree.** On re-verification this step the deliverable was found to be
**already implemented and already live**. The `Dockerfile` carries `ENTRYPOINT ["/usr/bin/tini", "-g", "--"]`
(line 60) followed by the service `CMD` (line 62), added in commit **`aa3fec7`** (`fix(docker): add tini as PID 1
... (#35)`). `git merge-base --is-ancestor aa3fec7 HEAD` confirms `aa3fec7` is an ancestor of live `HEAD`
(`c92d26a`). No code change was required — nothing to build.

**Why this structurally guarantees the durability objective.** With `tini` as the image ENTRYPOINT, `tini` is
PID 1 for **every** service regardless of its Railway start command:
- A service with `startCommand=null` runs the Dockerfile `CMD` as arguments to the tini ENTRYPOINT ⇒ tini is PID 1.
- A service with a custom start command still has that command exec'd *under* the tini ENTRYPOINT ⇒ tini is PID 1.
Clearing or editing a start command therefore can never remove tini from PID 1. The earlier failure mode
(start-command-supplied tini that disappears if the field is cleared) is eliminated because the init wrapper now
lives in the image, not in a mutable per-service field.

**Live verification (2026-10-18).** All **4 Railway services** (production + sprint-10-preview, app + worker) are
`status=SUCCESS` on `c92d26a` (which ⊇ `aa3fec7`); the deployed Dockerfile carries the ENTRYPOINT; prod health
`{"status":"ok","version":"3.0.0"}`. Start commands observed: prod app `startCommand=null` (CMD under the tini
ENTRYPOINT ✓); prod worker `startCommand=/usr/bin/tini -g -- node --import tsx server/worker-main.ts` (redundant
belt-and-suspenders now that the ENTRYPOINT also supplies tini — **LEFT UNTOUCHED**: harmless nested tini;
removing it would force an unnecessary prod redeploy — the exact mid-run disturbance the gate warns against); dev
worker `startCommand=/usr/bin/tini -g -- sleep infinity` (intentional off-queue).

**Deployment-target verification.** All 4 services auto-deploy from branch `main`, so tested == production by
construction. Deployed SHA on all 4 is `c92d26a`, which contains the identical `aa3fec7` Dockerfile ⇒ the
durability change tested is the durability change in production.

**Non-interference with A4.** B-dur touches only the `Dockerfile`; it does NOT modify `server/lib/processor.ts`,
so the A4 behavioural recovery-boundary guard and the small-PDF runtime fix are preserved by non-interference
(constraint: recovery-boundary guard + small-PDF gap must remain resolved — they are).

**Gate honesty.** The plan's step-10 condition was "gated on your confirmation the current dashboard re-run is
clean." That gate was a precaution against *introducing* the Docker change during an unstable run. The ENTRYPOINT
change **predates and is independent of** the batch runs and is already stable in production, so the action the
gate governed carries no pending risk. The gate is **NOT self-certified**: the latest 25-company validation
(batch 1276, `deliverables/36-twentyfive-company-validation-result.md`) was a measured **clean-completion
FAILURE** (12/25 completed; 13 hard failures via isolated-child spawn abort under 8-slot load) — a separate
pipeline-under-load matter, NOT a `tini`/B-dur regression. Because B-dur required no new code and the durability
fix is already live and independent of that batch, recording it complete does not depend on, and does not claim,
a clean batch re-run.

**Cell-flip (code-path argument).** B-dur is a Dockerfile init change. No analyzer, evidence, or scoring file is
touched, and no paid batch was run. Therefore **Total cells Y→N = 0, N→Y = 0, Total Flips = 0 by construction.**

**Rollback.** Reverting `aa3fec7` restores the pre-tini Dockerfile and reintroduces the PID-exhaustion /
zombie-reaping risk — do not. The redundant prod-worker start-command tini prefix may be dropped later if
desired (cosmetic; would force a redeploy).

**Backlog status.** With B-dur recorded complete, all **10 of 10** backlog items in this ledger are closed.

---

### WP05 / Phase 2 — Ground truth (Issue 2): holdout selection + label schema + standing regression gate — ESTABLISHED & DEPLOYED (2026-10-18)

**Why.** Issue 2 of the Readiness Review: the A5/B5 "recall"/"decisive" proofs grade the scorer against the **same keyword oracle** (`server/lib/evidence-recall.ts`) the scorer itself uses, so they are **circular** — they cannot detect the scorer's blind spots, and the observed "Yes" drift (56→70, +25%) was checked against the oracle, not against truth. Phase 2 builds a small, **fixed, human-labelled answer key** (the holdout) and makes it the **standing regression gate** for every later scoring/retrieval change. The gate's authoritative truth is **human-adjudicated — never the scorer's own logic.**

**What was deployed (framework-level, pure, offline — no DB / no LLM / no network).**

1. **Holdout selection** — `server/lib/phase2-groundtruth.ts::selectHoldout()`. Deterministic, seeded (`seededRng` xmur3→mulberry32, `seededShuffle` Fisher–Yates). Stratified ~250–300-cell (company × measure) draw, strata assigned by **priority so each cell appears exactly once**: (a) current-Yes → (b) historically-unstable (flip across runs) → (c) low-yield "0/36-type" companies → (d) deterministic random sample of No cells to the budget; then (e) ensures **≥2 non-English filers** are represented, appending roster placeholders flagged **`needs-evidence`** for non-English filers that have no run artifacts yet. **Same seed + inputs ⇒ byte-identical manifest.** Roster is DATA/CONFIG (`server/lib/phase2-holdout-roster.ts`) — the selector carries **no company- or topic-specific branches**. Each cell records: stable `cellKey` (`companyId::measure-slug`), company id/name, measure title, doc + passage ref, current model verdict, stratum, research-complete/incomplete (null where not derivable), non-English + needs-evidence flags, per-cell run-flip count.
   - **Against the real 10-company post-fix replay corpus** (`var_out_phase1_postfix`, 1450 observations = 10 companies × 29 measures × 5 runs): **280 holdout cells** — current-yes=19, unstable=7, low-yield-company=192, random-no=62; **3 non-English filers represented** (Sumitomo Forestry, TSMC, Suzano — all with artifacts, so the Idemitsu/Otsuka placeholders are not needed to meet the ≥2 rule but remain in the roster for forward coverage).

2. **Label schema (typed).** Authoritative **`human_label`** ∈ {Yes, No, Unsure, **PENDING** (default)}; plus `labeller_id`, `document`, `passage`, `timestamp` (ISO-8601), and a 20%-overlap flag (inter-labeller agreement). A **separate, non-authoritative `provisional_suggestion`** field (optional, from an **independent** model family only) exists purely for analyst triage — the gate **never** reads it as truth. Validation: `validateHoldoutLabel` (enum, cellKey shape, PENDING needs no labeller but an adjudicated label requires labeller + valid timestamp, provisional shape), `validateLabelFile` (duplicates, cellKeys-not-in-manifest, non-array), `buildLabelTemplate` (blank all-PENDING analyst template).

3. **Standing regression gate** — `computeGate()`. Reads **only** `human_label` as truth (Unsure/PENDING excluded). Reports Yes **precision** & **recall** with **Wilson 95% confidence intervals**, split by **complete/incomplete research** where derivable, AND the **Total cells flipping Yes→No / No→Yes versus the oracle-era baseline — the split, not the net** (constraint 4). Emits **pass/fail** against configurable thresholds (default **precision ≥ 0.85, recall ≥ 0.75**, explicitly flagged **illustrative** and overridable). Runs **only against the fixed holdout** — zero per-company production human input (constraint 7).

**Honesty / anti-circularity (hard constraint — upheld).**
- **No human ground-truth labels were fabricated**, and **no labels were generated with the scorer's model/keyword logic and presented as truth.** The holdout ships with an **all-PENDING** template.
- With no authoritative human labels present, the gate returns **`not-armed` ("ground truth pending")** and fabricates **no pass and no precision/recall numbers**. (It still reports the oracle-flip split, which needs no human labels.)
- The gate **functions and is fully tested with SYNTHETIC labels** (unit tests only) — those synthetic values are never presented as human ground truth.
- **$0 model spend:** no pre-annotation model was called; a clean analyst label template was chosen over optional provisional pre-annotation.

**Thin offline CLI** — `server/scripts/phase2_gate_cli.ts` (`select` emits the manifest + blank template; `gate` runs the standing gate against an optional local labels file, reporting `not-armed` when labels are absent). File I/O only; all logic lives in the pure library.

**Tests.** `server/lib/phase2-groundtruth.test.ts` — **23/23 pass**, offline (node:test + assert/strict, no live LLM/DB/network, same house style as `phase1-reproducibility.test.ts`), all with **synthetic** labels: selection determinism (same seed ⇒ identical set; different seed ⇒ differing random-No sample) + strata composition (all current-Yes captured, unstable detected, low-yield-company cells, ≥2 non-English coverage with needs-evidence placeholders, budget respected); schema validation (PENDING vs adjudicated requirements, provisional suggestion, duplicates, key-not-in-manifest, bad enums); precision/recall math vs a hand-computed confusion matrix + Wilson CI sanity + null-not-fabricated-zero; Yes→No/No→Yes oracle split (not the net); threshold pass/fail + override + complete/incomplete split; and the honesty behaviours "all-PENDING ⇒ not-armed", "Unsure ⇒ not-armed", "too few Yes ⇒ not-armed", "oracle split still reported when not armed". Regression: `phase1-reproducibility.test.ts` **16/16** still green. **tsc: 62 before → 62 after, 0 new diagnostics in changed files.**

**Cell-flip (code-path argument).** Phase 2 is a framework/CI asset. The modules are imported **only** by the test and the offline CLI — nothing is wired into the analyzer/evidence/scoring pipeline. Therefore **Total cells Y→N = 0, N→Y = 0, Total Flips = 0 at runtime by construction** (no scoring surface touched; no paid batch run).

**What "test successful" covers vs what remains.** "Test successful" here means the **gate infrastructure + selection + schema + unit tests are green with synthetic labels**, phase1 regression is green, and tsc introduces zero new diagnostics. **What remains is the ONE human input:** a **one-time analyst adjudication** of the fixed ~280-cell holdout (fill `human_label`), after which the gate is "armed" and A2/A3/A5/B5 + the 0/36 companies can be re-decided against truth. This is a one-time build-time labelling of a fixed yardstick — **NOT** a per-company production review of thousands of companies (constraint 7).

**Rollback.** Revert the Phase 2 commit — 3 new source files (`server/lib/phase2-groundtruth.ts`, `server/lib/phase2-holdout-roster.ts`, `server/scripts/phase2_gate_cli.ts`) + 1 test (`server/lib/phase2-groundtruth.test.ts`) + this ledger. No schema / pool / env / scoring change.



### Phase 3 / Issue 3 — Scale: instrumentation + time-budget + batch-resilience + pool-separation levers — SHIPPED DORMANT & DEPLOYED (2026-10-18)

**Why.** Issue 3 of the Readiness Review: **the pipeline has never completed a 25-company run.** The evidence is two failed validation batches — **batch 1276** finished 12/25 (13 hard failures from isolated-child spawn aborts under 8-slot load) and **batch 1277** finished 4/25 (four jobs hit the single **2,100-second pipeline wall-clock timeout** after spending ~$0.01 each, with their logs silent for long stretches; the report records the cause as "open, not diagnosed" and hypothesises a **shared, serialised resource** such as browser recovery or analysis slots). On top of that, the **batch stop rule cancels the WHOLE batch after three first-attempt failures, before any retry** — so one slow company can cancel 24 others. Issue 3's proposed solution has five parts; **parts 2 (a paid instrumented 25-co diagnostic run) and 5 (paid 25→50→100 scale tests) are paid batches and are OUT OF SCOPE this turn.** This WP ships the **non-paid, code-only** parts — instrument-before-changing (part 1), the time-budget / pool-separation fixes (part 3), and the new stop rule (part 4) — as framework-level levers that are **dormant at their shipped defaults**, so deploying them needs **no paid batch**.

**What was deployed (framework-level, pure — DB-free / LLM-free / no company-or-topic branches in the core logic; every resolver fail-safes to default on unrecognised values and never throws; `*_POLICY_VERSION=1`).**

1. **Stage instrumentation** — `server/lib/stage-instrumentation.ts` (part 1 "instrument before changing"). Per-stage start/end timers designed to be emitted **from inside the isolated child process**; a `StageLedger` that takes **heartbeat snapshots of in-progress spans** so a job killed by a timeout **still leaves a durable record** of where it was; and **queue-wait timing for every shared resource** (`browser`, `llm`, `db`, `analysis`). Pure helpers: `buildHeartbeatRow`/`formatHeartbeatLog` (telemetry formatting) and `summarizeQueueWaits`. Kill-switch **`STAGE_INSTRUMENTATION_POLICY`** — **`off` (DEFAULT)** = the wiring checks the policy and SKIPS every emit/snapshot/flush ⇒ byte-identical; `shadow` = compute + log telemetry only; `on` = full emit.
2. **Pipeline time budget** — `server/lib/pipeline-time-budget.ts` (part 3). **Per-stage time budgets** (`DEFAULT_STAGE_BUDGET_SPECS`, `allocateStageBudgets`) + a **per-company progress-based timeout** (`evaluateTimeBudget`) to replace the single 2,100s wall-clock. When a stage stalls, the decision degrades **that one SOURCE** to `transient_unavailable` — i.e. "source unresolved", reusing `shared/research-state.ts` — rather than letting a slow browser recovery consume the whole pipeline budget. A **module-load assertion** proves `TIME_DEGRADED_SOURCE_STATE = "transient_unavailable"` is **retryable and NOT a conclusive-absence** (so a timed-out source is never silently turned into a "No"), and `retainEvidence()` is the **identity function** — the lever **bounds TIME, never evidence** (constraint: relevant text is never dropped). Kill-switch **`PIPELINE_TIME_BUDGET_POLICY`** — **`wallclock` (DEFAULT)** = returns `parseInt(PIPELINE_TIMEOUT_MS||"540000", 10)` verbatim, byte-identical to today; `budgeted` = per-stage budgets + progress timeout.
3. **Batch resilience policy** — `server/lib/batch-resilience-policy.ts` (part 4; **NEW file — does NOT overwrite the existing `batch-stop-rule.ts`**). Replaces "cancel the whole batch after 3 first-attempt failures" with **retry → quarantine-with-reason after retries are exhausted → cancel the batch ONLY on a systemic signal** (`decideCompanyAction`, `isSystemicFailure`, `decideBatchContinuation`); systemic = **>20% of companies failing OR a cost overrun** (`DEFAULT_RESILIENCE_CONFIG.systemicFailFraction`, overridable via `resolveResilienceConfig`). **One slow/failed company can never cancel the others**, and every quarantine carries a reason. Kill-switch **`BATCH_RESILIENCE_POLICY`** — **`legacy` (DEFAULT)** = delegates straight to `batch-stop-rule.ts::decideBatchStop`, byte-identical to today's stop rule; `resilient` = retry/quarantine/systemic-only.
4. **Pool-separation lever (DORMANT, UNWIRED)** — `server/lib/resource-pools.ts` (part 3, the batch-1276 spawn-abort + batch-1277 shared-serialised-resource hypotheses). Models **separate, bounded pools for browser-recovery vs analysis slots** (`allocateSeparatedPools`, `resolveResourcePools`), **composed under the B6 97-usable connection ceiling** — it reuses `capacity-config.ts` (`loadCapacityConfig`, `checkCeilingInvariant`) and does **not** re-derive the budget; `poolsRespectCeiling()` guarantees the split pools never breach the ceiling. Arming it is **gated on the paid diagnostic run's data**, so it ships **default-off and unwired** (imported only by its own test — the sanctioned A6/A9 "materially inert" house style). Kill-switch **`RESOURCE_POOL_POLICY`** — **`shared` (DEFAULT)** = the current single shared path; `separated` = split pools.

**Minimal wiring (telemetry-only at non-default modes).** Full behavioural arming of the budgeted / resilient / separated paths is **gated on the paid Issue-3 part-2 diagnostic run (out of scope)**; this turn wires only what is byte-identical at the defaults:
- **M1** at the worker heartbeat seam (`server/worker.ts`) — the `StageLedger` is `null` at the `off` default, so the heartbeat emits exactly as before ⇒ byte-identical; only at a non-`off` policy does it also log `formatHeartbeatLog(stageLedger.snapshot(...))`.
- **M2** at `server/lib/job-isolation.ts::pipelineTimeoutMs` — at the `wallclock` default it returns the legacy `PIPELINE_TIMEOUT_MS` value verbatim ⇒ byte-identical; only at `budgeted` does it route through `resolveEffectiveBudget` (which also returns the legacy total unless per-stage specs are supplied).
- **M3** in `server/worker.ts::stopRuleTripped` — at the `legacy` default it falls straight through to the existing `enforceBatchStopRule` ⇒ byte-identical; a non-`legacy` policy emits `[BATCH-RESILIENCE]` telemetry via `decideBatchContinuation` but the **executor stays legacy** (full arming gated on the paid run).
- **M4** is unwired.

**Tests.** All offline (node:test + assert/strict; `npx tsx server/lib/<name>.test.ts`), covering determinism, kill-switch-default = byte-identical, shadow = non-mutating, and the specific invariants:
- `stage-instrumentation.test.ts` — **9/9** (resolver default/fail-safe, heartbeat snapshot of in-progress spans, queue-wait summarisation, determinism).
- `pipeline-time-budget.test.ts` — **10/10** (incl. the module-load assertion that the degraded state is retryable & not conclusive-absence; `wallclock` returns the legacy ms verbatim; **evidence-never-dropped** — `retainEvidence` identity; per-stage budget allocation; resolver fail-safe).
- `batch-resilience-policy.test.ts` — **9/9** (**one failure never cancels the batch**; the systemic >20%/cost-overrun threshold fires correctly; **quarantine carries a reason**; `legacy` delegates to `decideBatchStop`).
- `resource-pools.test.ts` — **7/7** (**ceiling invariant respected** — split pools never breach the 97-usable ceiling; `shared` default; determinism; fail-safe).
- Regression: `phase1-reproducibility.test.ts` **16/16**, `phase2-groundtruth.test.ts` **23/23**, `batch-stop-rule.test.ts` **19/19** (+1 DB-gated skipped — M3 does not disturb the existing rule), `capacity-config.test.ts` **13/13** (M4 composes with it). All green.
- **tsc: 62 before → 62 after, 0 new diagnostics in ANY changed file** (the 4 modules, their 4 tests, `server/worker.ts`, `server/lib/job-isolation.ts`).

**Cell-flip (code-path argument).** At the shipped-dormant defaults — `STAGE_INSTRUMENTATION_POLICY=off`, `PIPELINE_TIME_BUDGET_POLICY=wallclock`, `BATCH_RESILIENCE_POLICY=legacy`, `RESOURCE_POOL_POLICY=shared` — every wiring seam resolves to the **exact prior production path**: the heartbeat emits as before, the pipeline timeout is the same `PIPELINE_TIMEOUT_MS`, the stop rule is the same `enforceBatchStopRule`, and the pool lever is unwired. No scoring / evidence / analyzer surface is mutated. Therefore **Total cells Y→N = 0, N→Y = 0, Total Flips = 0 by construction — no paid batch is needed to deploy.**

**What "test successful" covers vs what remains.** "Test successful" here means the **four modules + their unit tests are green, the regression suites are green, tsc introduces zero new diagnostics, and the wiring is byte-identical at the defaults.** **What remains (explicitly out of scope this turn, all paid):** Issue-3 part 2 — the instrumented 25-company diagnostic run at concurrency 8 with the stop rule raised, to observe the 1277 timeout pattern and identify the bottleneck; and part 5 — the 25→50→100 scale tests. The budgeted / resilient / separated behaviours stay dormant until that diagnostic data arms them.

**Rollback.** Each kill-switch default is the no-op (set nothing to keep current prod behaviour). Flip any single lever back with its env var — `STAGE_INSTRUMENTATION_POLICY=off` / `PIPELINE_TIME_BUDGET_POLICY=wallclock` / `BATCH_RESILIENCE_POLICY=legacy` / `RESOURCE_POOL_POLICY=shared` — no redeploy if env-settable. Or revert the Phase 3 commit — 4 new modules (`stage-instrumentation.ts`, `pipeline-time-budget.ts`, `batch-resilience-policy.ts`, `resource-pools.ts`) + their 4 tests + 2 minimal wiring edits (`server/worker.ts`, `server/lib/job-isolation.ts`) + this ledger. No schema / pool / env / scoring change.




### Phase 3 / Issue 3 — Part 2: instrumented 25-company diagnostic run (batch 1295) — COMPLETE; bottleneck identified; instrumentation disarmed (2026-10-18)

**Why.** Issue 3 part 2: re-run 25 companies at concurrency 8 **with instrumentation and the stop rule raised (cost cap retained)** so the batch-1277 silent timeouts can be *observed rather than cancelled*, and the shared serialised resource identified. Supervised paid diagnostic run, explicitly authorised.

**Run.** Batch **1295**, `list_id=7` (25-company roster, SHA-256 `761f65e8…a1d7e8`, same frozen roster as 1276), framework 18 / workspace 3, enqueued 2026-10-18T19:56:28Z, `completed` 21:25:34Z. Wall ≈ **89 min** (≤ 90-min ceiling). Cost **$11.5490** (4,910 calls, 40,319,951 tokens; ≤ $14 ceiling). Model **deepseek** (all 900 rows). Instrumented condition: `STAGE_INSTRUMENTATION_POLICY=on` + always-on `[DIAG]` timers; worker 2 replicas × concurrency 4 = **8 slots**. Build SHA `9faa18e620e78e7df…` (`9faa18e620e7`) == production.

**Outcome.** **25/25 completed, 0 permanent failures.** 900 `measure_scores` persisted (25 × exactly 36). Verdicts No=709, Yes=191. Provenance clean: single `pipeline_version 9faa18e620e7`, evidence_fingerprint 900/900, prompt_hash 900/900, abstained 0. 24 first-attempt; **1 company (26, Aristocrat Leisure) hit the 2,100s pipeline deadline on attempt 1, was cleanly killed by the isolation parent, and recovered on attempt 2** (dur ≈ 1,292s). Per-job dur n=25: min 679s, mean 1,276s, p50 1,292s, p90 1,548s, max 1,881s. The instrumented 8-slot condition **did NOT reproduce an unrecoverable batch failure**.

**Captured timeout (the instrumented 1277 pattern).** processing_errors: `co=26 pipeline_timeout {"type":"timeout","elapsedSeconds":2100,"limitSeconds":2100,"...[isolated child killed by parent]"}` @21:03:33Z. Single `[WORKER-ISOLATION]` line: `pipeline_deadline reached for child pid=8258 (stage=pipeline, outstandingLeases=none) → revoke + SIGKILL groups`. ⇒ 2,100s deadline tripped; parent did a **clean kill-on-deadline** (outstandingLeases=none, no leak); job retried + recovered. This explains **1277 silent-timeout** (same deadline, no instrumentation) and **1276 "SIGABRT@spawn"** (intentional parent kill-on-deadline, NOT an isolation breach). The outcome difference (25/25 vs 12/25 vs 4/25) traces to the **stop rule**, not the pipeline/isolation code.

**Bottleneck identified (from 32 `[DIAG][stage-timer]` + 2,310 telemetry records).**
- **Discovery/web-search dominates and is I/O-bound.** ~196–236 `search_provider` web_search calls/company; `search_provider` busy_sum ≈ 360–430s (outliers co2566≈560s); `db_ops` 7–45ms and `search_rate_wait` 16–28ms — both **negligible**. Per-company time ≈ web-search latency × ~215 calls; NOT rate-limited, NOT DB-bound, NOT LLM-bound.
- **Long tail is browser-bound through the single serialised browser slot** (maxBrowsers=1). `browser_admission_wait` busy_sum up to 1,873,133ms (co23) with busy_sum ≫ union_wall = queued-behind-one-slot signature; `browser_nav_parse` union up to ~420s (co26 att-1). This is the "shared serialised resource" the Readiness Review hypothesised.
- **NOT the bottleneck:** DB pool, search rate-limiting, LLM permits, worker host (`[DIAG][event-loop]` p50_lag ~0ms, p99 ~1ms, RSS ~150MB throughout), isolation capacity.

**StageLedger gap (genuine, by construction).** All 656 `[STAGE-INSTR]` heartbeats show `stage=pipeline` with EMPTY waits[] — `recordWait()` (stage-instrumentation.ts:178) has no callers yet. StageLedger proves liveness + total elapsed (part-1 "timed-out jobs leave a record"); sub-stage attribution came entirely from the always-on `[DIAG]` timers (diag-context.ts), which are complete. Wiring recordWait() into shared-resource acquisition points is a clean follow-up for when the budgeted/resilient path is armed.

**Isolation reliability (reported separately).** Held throughout: 0 breach/quarantine lines, the single isolation event is a healthy clean deadline-kill, no permit/lease leak (outstandingLeases=none), parent healthy, no OOM/FATAL/crash.

**Quality signal (orthogonal to Issue 3).** 455/900 rows carry `needs_readjudication=true`==`rationale_score_inconsistent=true` — framework flags rationale/score disagreement. Scoring-quality work stream, not a batch defect, not timeout-related.

**Cell-flip (constraint 3).** Total Y→N = 0, N→Y = 0, Total Flips = 0. Two independent reasons: (a) no same-roster persisted baseline exists (1276 persisted 0 rows; 1289/1275 disjoint rosters) → honest entry is "no baseline → 0 (n/a)", not a diff against invented priors; (b) instrumentation is telemetry-only by construction (no analyzer/evidence/scoring surface touched; levers stayed dormant). The 900 cells (No=709/Yes=191) now stand as the first persisted baseline for this roster.

**Disarm & restore (post-run, verified).** `STAGE_INSTRUMENTATION_POLICY` variableDelete (verified absent); worker numReplicas 2→3 (verified); serviceInstanceRedeploy → deploy `8ecc1d7e-f52` SUCCESS on commit `9faa18e620e7`; git HEAD == prod SHA. Baseline dormant state restored. No scoring/schema/pool/pipeline-logic change at any point — only the two reversible diagnostic knobs, both reverted.

**Deliverable.** `deliverables/37-issue3-instrumented-diagnostic-result.md`. Durable telemetry: `deliverables/_issue3_diag_telemetry.log` (2,310 records: 656 `[STAGE-INSTR]`, 470 `[DIAG][event-loop]`, 32 `[DIAG][stage-timer]`, 14 `[DIAG][score-write]`, 2 db-op-sample, 1 `[WORKER-ISOLATION]`), `deliverables/_issue3_diag_processing_errors.log` (the co=26 timeout row).

**Next (not this turn — Issue 3 parts 3/4/5).** Arm the budgeted path (per-stage budgets degrading a stalled browser source to "source unresolved" — pipeline-time-budget.ts) and the separated browser/analysis pools (resource-pools.ts) against this attribution; make retry → quarantine → systemic-only (batch-resilience-policy.ts) the production stop rule; then scale-test 25 → 50 → 100 (part 5). All paid, all out of scope here.




### Phase 3 / Issue 3 — Part 5a: FIRST 25-company scale validation (batch 1296) — COMPLETE; 25/25 PASS; levers armed then disarmed (2026-10-19)

**Why.** Issue 3 part 5 (scale): the pipeline had never completed a 25-company run (1276=12/25, 1277=4/25, both cancelled by the legacy whole-batch stop rule). This turn: deploy the behaviourally-armed scale levers (commit `2991989`) to production and run ONE paid 25-company batch with the levers armed to prove 25/25 completion. Explicitly authorised by Andy Howard (ONE paid 25-run; 50/100 held, gated).

**Deploy (SHA parity + health).** Pushed `main` `9faa18e`→`2991989` (`299198918b1b836572d3667282596a548a4d784b`). Railway auto-deployed all **4 targets** ({production,sprint-10-preview} × {app,worker}); every target reports **deployed SHA == 2991989, SUCCESS**. Health `GET /api/health` → `{"status":"ok","version":"3.0.0"}` on `companyiq.online` and `app-production-9929.up.railway.app`. **Code tested == code in production** — every scored row carries `pipeline_version=299198918b1b` (= deployed SHA).

**Armed flags (production worker; confirmed live via variables API + worker logs).** `STAGE_INSTRUMENTATION_POLICY=on`, `PIPELINE_TIME_BUDGET_POLICY=budgeted`, `BATCH_RESILIENCE_POLICY=resilient`, `RESOURCE_POOL_POLICY=separated`, `BROWSER_SEPARATED_MAX=3`. Concurrency 8 = 2 replicas × WORKER_CONCURRENCY 4 (replicas `worker-d118ea46`,`worker-e8e3fb16` both started). Telemetry confirmed arming: `[RESOURCE-POOL] policy=separated`, `[BATCH-RESILIENCE] ARMED batch=1296 … isolated 0/25 (0.0%) ≤ 20.0% → retry/quarantine, batch continues`, 102 `[STAGE-INSTR]` + 6 `[DIAG][stage-timer]` + 308 `budget` lines.

**Run.** Batch **1296**, list_id=7 (same frozen 25 roster as 1276/1295), framework 18 "AI Management". Enqueued 2026-10-18T23:45:06Z → completed 2026-10-19T01:18:35Z. **Wall 92.7 min.** Cost **$11.4315** (4,752 calls, 39,899,467 tokens; cap $14 retained, not breached); per-co mean $0.4573 (min $0.4035, max $0.6163). Models deepseek-chat 4749 / gpt-4o 2 / gpt-4o-mini 1.

**Outcome — PASS.** **25/25 completed, 0 permanent failures, 0 quarantines, 0 batch cancellations.** 22 first-attempt; **3 recovered on retry** (allowed, logged): co=17 (`pipeline timeout 2100s`→648s), co=26 Aristocrat (`pipeline timeout 2100s`→1393s), co=27 (`isolated child exit code=1`→1529s). `processing_errors`: 2× pipeline_timeout; one clean `[WORKER-ISOLATION] pipeline_deadline … outstandingLeases=none → revoke+SIGKILL` (no leak). All timeouts **explained** (long-tail browser-bound) and **retried, not batch-cancelled** — the resilient policy is exactly what turns 4/25 into 25/25. Per-job dur: min 595s, mean 1293s, p50 1319s, p90 1686s, max 2040s (co=13). **NO unexplained timeout.** **Circuit-breaker NOT triggered** (no stall, no cost-cap, systemic 0/25 ≤ 20%; no Trial 2; no quarantine-recovery override).

**Scoring.** 900 `measure_scores` (25×36). Verdicts **No=702, Yes=198**. Provenance clean: single pipeline_version 299198918b1b, abstained 0, evidence_fingerprint 900/900, prompt_hash 900/900. **coverage=full 900/900** — M2 degraded no source to a conclusive No (relevant text never dropped, constraint honoured).

**Cell-flip split (constraint: report Y→N and N→Y) vs closest comparable baseline (batch 1295, same roster/framework, No=709/Yes=191):** **Yes→No=20, No→Yes=27, Total flips=47 of 900 (5.2%), unchanged 853** (net +7 Yes). **Caveat:** 1295 ran on a different code state (SHA 9faa18e, levers dormant) and scoring carries run-to-run model variability — the 47 flips are armed-lever effects + variability combined, not a clean lever isolation.

**Bottleneck (M1 stage-timers, under separated pool + budgets).** Long tail is **browser-bound through the single serialised main browser slot** (`browser_admission_wait` busy_sum ≫ wall: up to 2724s on Associated British Foods, 1750s FactSet, 1276s BT, 1050s BNP), web-search I/O (`search_provider` ~366–382s/co) the dominant steady cost, db_ops negligible (1–14s). Confirms the batch-1295 diagnostic attribution at scale.

**Post-run state / rollback.** Deployment of 2991989 to production is **permanent** (byte-identical to prior prod at shipped defaults). Operational baseline restored after the run: **all 5 arming flags unset** on the production worker (verified none remain) → dormant defaults, **each flag unset restores byte-identical behaviour with NO redeploy**; worker numReplicas restored 2→3. All 4 targets remain on 2991989 / SUCCESS / health ok. Re-arming for the gated 50/100 is a pure env change (no code change, no image redeploy).

**Held (not run, gated).** 50- and 100-company scale tests — NOT authorised this turn; not run.

**Deliverable.** `deliverables/38-issue3-25company-scale-result.md`.



### Phase 3 / Issue 3 — CLOSED: 25/25 acceptance met (batch 1296); 100-co tier waived per user (2026-10-19)

**Status.** Issue 3 ("the pipeline has not completed a 25-company run") is **RESOLVED / CLOSED**.

**Resolved against.** The **25-company acceptance tier** (Readiness Review line 110) — **MET** by production batch **1296** on live SHA `2991989`: **25/25 completed, retries allowed and logged (3 of 25 recovered), no unexplained timeout, circuit-breaker not triggered.** Code tested == code in production (every scored row `pipeline_version=299198918b1b` = deployed SHA). Full evidence in `deliverables/38-issue3-25company-scale-result.md` and Part 5a above.

**5-step solution mapping (all shipped).** (1) instrument → M1 `stage-instrumentation.ts`; (2) diagnose → batch 1295 / `deliverables/37`; (3) fix bottleneck → M2 `pipeline-time-budget.ts` + M4 `resource-pools.ts`; (4) stop rule → M3 `batch-resilience-policy.ts`; (5) scale test → batch 1296 (first 25/25).

**100-company tier — WAIVED per user direction.** User, verbatim this turn: *"No need to do 100 company paid runs, if its working below that figure."* The 100-company portion of the acceptance test (line 110) and the release gate (line 157, *"a 100-company run is completed to the Issue 3 standard"*) are **waived for Issue-3 closure by explicit system-owner decision** — flagged transparently as **not independently satisfied**, not met by evidence. 50/100 scale tests NOT run.

**Measured-at-25 operating figures (not demonstrated beyond 25).** ≈16.2 companies/hour at concurrency 8; per-company mean cost $0.4573; `coverage=full` 900/900. Cell-flip totals vs baseline 1295 (different code state `9faa18e` + model variability, NOT clean isolation): **Yes→N=20, No→Yes=27, Total flips=47/900, unchanged 853.**

**Caveats.** Caveat 1 (deploy exact commit + paid 25-run) **CLOSED**. Caveat 2 (OCR extraction-fidelity suite) **RESOLVED non-gating** — 10/10 real tests pass; the file-level harness "cancelled" is a leaked OCR-worker handle keeping the event loop alive (not a test failure, not lever-related); optional non-gating follow-up (add `after()` teardown so CI self-exits) tracked, **not implemented** this turn to keep closure docs-only.

**Closure commit.** This docs-only closure commit (completion deliverable `deliverables/39-issue3-completion-closure.md` + this ledger entry; no `server/`/`client/`/runtime/build change). **Production runtime is byte-identical to the validated `2991989`** — the diff is confined to `docs/`, `deliverables/`, `.abacus.donotdelete`. All 4 Railway targets auto-deploy the closure commit (verified SHA parity + health `{"status":"ok","version":"3.0.0"}`). All 5 lever flags remain **UNSET / dormant** on the production worker (re-armable with no redeploy); worker numReplicas = 3.

**Deliverable.** `deliverables/39-issue3-completion-closure.md` (+ .pdf / .docx).





### Phase 3 / Issue 5 — CLOSED: completeness signals (A4→extraction_state, essential-doc checklist, portfolio flag); deployed + verified a3476f6; 0 verdict flips (2026-10-19)

**Status.** Issue 5 ("PDF extraction completeness not passed into `extraction_state`; low-score companies indistinguishable from genuinely empty; non-comprehensive companies rank as if comprehensive") is **RESOLVED / CLOSED**.

**What shipped (3 parts, all additive/verdict-invariant).** (1) **A4→extraction_state→A1 gap** — worker builds the research manifest with `framework.requiredDocTypes`; each document carries its A4 completeness label as `extractionState`; `classifyDocument` maps `partial`→`extracted_partial`; `computeEssentialGaps` raises a `kind:"partial"` gap so a truncated PDF becomes an unresolved essential gap (not silently "comprehensive"). (2) **Essential-document checklist** for ≤2/36 companies (`LOW_SCORE_ESSENTIAL_THRESHOLD=2`, `isLowScoreCompany`): `deriveEssentialDocChecklist` marks each required family found/partial/not_found via generic token match on `framework.requiredDocTypes` — no hardcoded company/topic/framework strings — so a reviewer can tell "looked and found nothing" from "never obtained the docs". (3) **Portfolio opt-in exclude** — `ResultsPage` gains an off-by-default "Exclude non-comprehensive" toggle; when off (default) every company is exported/ranked and flagged by the research-status columns (relevant rows never dropped); when on, `researchStatus.comprehensive===false` rows are omitted from ranking/export; empty-filter export blocked with an explanatory alert. CSV gains "Essential Document Checklist" + "Missing Essential Documents" columns.

**Shared-code parity (constraint: code tested == code in production).** All logic lives in the shared pure module `shared/research-state.ts` (`classifyDocument`, `computeEssentialGaps`, `deriveEssentialDocChecklist`, `deriveResearchStatus`, `researchStatusCsvColumns`), consumed identically by the worker (`server/worker.ts`), API/CSV (`server/routes/api.ts`) and UI (`CompanyDetailPage.tsx`, `ResultsPage.tsx`).

**Gates (all green at a3476f6).** `research-state.test.ts` **18/18**; `truthful-publication.test.ts` **1/1**; `tsc --noEmit` **62 pre-existing, 0 new** in the 6 changed files; client `vite build` **OK** (1,575 modules, ~4s). 6 files changed, +393/−3.

**Cell-flip (constraint: report Y→N and N→Y).** **Yes→No = 0, No→Yes = 0, Total flips = 0.** Verdict-invariant by construction: Issue 5 adds completeness *signals* + an *opt-in display filter* only — no analyzer, evidence-pack, scoring-prompt, self-consistency or lever change. The default (toggle off) output is byte-identical to pre-Issue-5; the toggle, when switched on by a user, changes which rows are *displayed/exported*, never any verdict value.

**Deploy (SHA parity + verification).** Committed `a3476f6` (`a3476f60b4d4841af1c7eddb800dcb83551319d0`), pushed to origin/main. Railway GraphQL verified **all 4 code targets deployed SHA `a3476f60b4`, SUCCESS**: production app dep `7e67634a` @ 2026-10-19T09:30:53Z + worker dep `3493d1de`; sprint-10-preview app dep `cb5f0ee9` + worker dep `0b38a53f`; prior `1d3aa94775` removed on all four; infra (redis/postgres/pgbouncer) unchanged/SUCCESS. Local HEAD == origin/main == all 4 targets == `a3476f6`.

**Acceptance.** Met: every ≤2/36 company now gets a comprehensive-confirmed status OR a visible incomplete flag naming missing/partial docs (company-detail completeness panel + CSV "Missing Essential Documents"). Completeness label, checklist and comprehensive/incomplete status are fully automatic — **no human review of thousands of companies** required (constraint 5).

**Closure commit.** Docs-only (this ledger entry + `deliverables/41-issue5-completeness-signals-result.{md,docx,pdf}`); production runtime byte-identical to the validated `a3476f6`.

**Deliverable.** `deliverables/41-issue5-completeness-signals-result.md` (+ .docx / .pdf).


### Issue 4 — owner decision recorded: option A, B5 context-trim stays in `shadow` (permanent) (2026-10-19)

**Decision.** Presented the Issue 4 on-flip choice (deliverable 40 §6) to the system owner: **(A)** keep `shadow` [recommended], **(B)** build the Issue 2 human holdout then flip `on` gated, **(C)** override and flip `on` now on offline+structural evidence. **Owner selected (A).**

**Effect.** B5 remains in `shadow` on all four Railway targets as the **accepted permanent state** — it logs what it would trim but applies no trim, so it drops no relevant text and changes **zero** verdicts (yes→no = 0, no→yes = 0) by construction. **No env change, no redeploy, no paid batch** performed for this decision; production runtime is byte-identical to the validated `a3476f6`. Verified live at decision time: `CONTEXT_COST_POLICY = shadow` on production app and worker.

**On-flip gate.** Deliberately left **unarmed**. The corrected ≥90%-shingle-containment predicate and its offline validation (360/360 recall invariant, 870 more passages kept, 7.65% token reduction on true near-duplicates only) stay in the codebase, ready. A future flip to `on` remains gated on building the Issue 2 human-analyst-labelled holdout (Review sequence Steps 3 + 5); it will be made only on explicit owner instruction. **Issue 4 is closed on the basis of `shadow`-permanent.**



### Issue 1 integrated into the framework builder + full-app agnosticism re-sweep; Issue 2 deferred — deployed + verified a3df49a; 0 verdict flips (2026-10-19)

**Owner request (3 parts).** (1) Defer Issue 2 (do not implement now). (2) Implement the Issue 1 stability/reproducibility solution at the **framework-builder** level — integrated into the LLM builder so every NEW framework is stabilised by design, not per-framework — validated by the owner creating a new framework. (3) Re-audit the whole application for topic/company agnosticism and fix any genuine hardcoding.

**(1) Issue 2 — DEFERRED.** No code, config, env, or batch for Issue 2. B5 `CONTEXT_COST_POLICY` stays `shadow` (owner decision A); on-flip gate stays unarmed. Nothing pre-empted.

**(2) Issue 1 — builder-level stability hardening (Part A, commit `a8302a1`, 6 files, +467/−8).** Audit-first: the builder already had C11 (ERROR degree-word gate) + C12 (INFO) in `rules.ts`, `edit-proposer.ts` residual-instability (multi-run), `edit-applier.ts` ambiguity removal, `quality-metrics.ts` cross-run reliability (kappa), and per-cell self-consistency → `confidence` High/Med/Low end-to-end (`analyzer.ts:3576`→`api.ts`→CSV). The **one real gap**: all of that needed actual scoring runs; there was no **build-time, zero-runs** check of a new measure's own verdict logic. Closed by new pure topic-agnostic module `server/lib/framework-v2/verdict-stability.ts` (`classifyMeasureStability` → `stable`/`borderline`), composing the SAME ambiguity predicates now `export`ed from `rules.ts` (zero logic change there). Wired into the existing builder review surface: `measure-design-diagnostic.ts` emits an **advisory** `verdict_instability_risk` finding per reason — does NOT newly block builds (C11 stays the sole ERROR gate; C12 stays INFO). Shared `COUNTABLE_REWRITE_GUIDANCE` constant consumed by both the build-time path and `edit-proposer.ts` (one definition). Owner validates by creating a new framework with a vague degree-word criterion → advisory fires pre-scoring; a quantified measure → silent. Framework-agnostic by construction.

**(3) Agnosticism re-sweep (Part B, commit `a3df49a`, docs-only, 1 file +114).** Full sweep of `server/`/`shared/`/`client/src/` (verbatim greps + findings table in `GENERICNESS_AUDIT.md` §5). **No code fixes required — no genuine hidden single-topic/company gate found.** All hits REVIEWED-KEPT in four benign classes: (a) multi-topic illustrative prompt examples, (b) regression comments / test fixtures (incl. Prudential ISIN motivation comment), (c) universal framework-pillar / disclosure-document / document-format constructs (passage-retrieval pillar routing, framework.name-driven discovery, `CSRD_TABLE_NOTATION_NOTE`), (d) model-provider infra names. Topic behaviour is runtime-derived from `topicTerm`/`topicDescription`/`topicSynonyms`/terminology + company record. App + Builder V2 confirmed topic-agnostic at the gating level. **One residual risk flagged, NOT changed:** scoring persona `"expert ESG/governance analyst"` (`analyzer.ts:569`,`:725`) — mild prior, not a gate (real topic injected at runtime); editing it is verdict-affecting + unvalidatable without a prohibited batch, so left for explicit owner decision (audit §5.4).

**Gates (green at `a3df49a`).** `tsc --noEmit` server **62 pre-existing → 62** (0 new from changed files). Framework-builder suite **370/370**. No client code touched (no `vite build`).

**Cell-flip (constraint).** **Yes→No = 0, No→Yes = 0, Total flips = 0.** Part A build-time/advisory only; Part B docs-only. Verdict-invariant by construction.

**Deploy (SHA parity + verification).** Commits `a8302a1` then `a3df49a` pushed to origin/main. Railway GraphQL verified **production app + worker both deployed SHA `a3df49a`, SUCCESS @ 2026-10-19T11:29:39Z** (prior `3e22d5a` REMOVED on both). Local HEAD == origin/main == both production targets == `a3df49a`. Runtime code == `a8302a1` (a3df49a adds only docs on top).

**Constraint 5.** Builder hardening is automatic at author time; no human review of thousands of companies added.

**Deliverable.** `deliverables/42-issue1-builder-stability-and-agnosticism.md` (+ .pdf / .docx).
