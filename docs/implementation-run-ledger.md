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
| WP01 | — | — | — | — | pending | — |
| WP08 | — | — | — | — | pending | — |
| WP10 | — | — | — | — | pending | — |
| WP13-A | — | — | — | — | pending | — |
| A1 | — | — | — | — | pending | — |
| A2 | — | — | — | — | pending | — |
| A3 | — | — | — | — | pending | — |
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
