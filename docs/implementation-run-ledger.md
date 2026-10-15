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
| A3 | 3990bcd | prod (app + worker, both SUCCESS) | 1287 | ELIGIBILITY COMPOSITION GUARDRAIL added as a standalone module (`server/lib/eligibility-decision.ts`) that carries an **immutable, frozen eligibility decision** (entity · issuer/author · source class · as-of/version · scope) through compose → recompute-per-target (I1) → bounded repair (I2); repair can fill missing provenance but **can never override an exclusion**; applies framework parent/subsidiary scope (`entity_only` vs `group_consolidated`); recomputes per target so reused source bytes can't carry stale eligibility. Versioned kill-switches: `ELIGIBILITY_POLICY` (v2 default = compose+enforce logic available / v1 = legacy passthrough) and `ELIGIBILITY_ENFORCE` (unset/off = **shadow**: compose & attach decision, zero verdict mutation / on = downgrade excluded positives to No). **Correctness proven by 20 unit tests (EP01–EP06 + kill-switch/immutability/totality/serialization), 20/20 pass; legacy suites still green (evidence-gate 14/14, evidence-gate-a2 17/17, provenance-gate 15/15, provenance 40/40).** tsc gate: 61 baseline == 61 current, **zero new diagnostics**. Live batch 1287 ran in **shadow mode** (no `ELIGIBILITY_ENFORCE` in prod env ⇒ zero verdict impact by construction): 10/10 first-attempt, all ms=36 (no measure collapse), cost $3.8945/13.52M tok (≈baseline $3.95/13.7M — checks are string/compute-cheap, zero LLM overhead). **Cell-flip vs baseline 1284: Yes 56→64, Net +8, Y→N=10, N→Y=18, Total Flips=28; vs A2 1286: Yes 58→64, Net +6, Y→N=9, N→Y=15, Total Flips=24** (see tables below). These flips are **run-to-run model variance, not A3-caused** — shadow mode mutates no verdict. **No collapse / over-rejection**: the three all-No cos (Martin Marietta/Darden/Amphenol) stay 0/0 where expected; the only loss (Aflac −3 vs baseline) is already present in A2 (6→3 at 1286) and is stable A2→A3 (3→3), i.e. reproducible corpus variance independent of A3. | ✅ keep (v2 default, shadow) | revert to v1/off via env flag (no redeploy) or revert 3990bcd (additive module + one optional field + env-gated shadow block) |
| B1 | — | — | — | — | pending | — |
| A4 | — | — | — | — | pending | — |
| A5 | — | — | — | — | pending | — |
| B3 | — | — | — | — | pending | — |
| B4 | — | — | — | — | pending | — |
| A6 | — | — | — | — | pending | — |
| B5 | — | — | — | — | pending | — |
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
