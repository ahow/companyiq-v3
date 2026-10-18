# 25-Company Validation Run — Plan (PREPARED, NOT LAUNCHED)

**Status: this is a proposal. Nothing is launched. No code, replica, or configuration change is made by this document.** The run is described so cost/time boundaries and stop rules are agreed *before* any launch. Launch requires an explicit, separate go-ahead.

## 1. Purpose

Validate the already-accepted worker-isolation build at ~2.5× the ten-company acceptance scale, on the **unchanged** build and the **actual** two-worker configuration, to confirm isolation reliability and pipeline completion hold on a larger, independent roster.

## 2. Fixed configuration (unchanged from batch 1275)

| Parameter | Value |
|---|---|
| Build / SHA | `b676c2ddf37512dad0e18c6e812a4dc7e58a12a2` (no change) |
| `WORKER_ISOLATION_ENABLED` | `true` (remains enabled) |
| Worker replicas | 2 (unchanged) |
| Concurrency / replica | 4 → **8 execution slots** total (unchanged) |
| LLM permit pool | `max = 8` (unchanged) |
| Framework | 18 ("AI Management", 36 measures) |
| Workspace | 3 |
| Per-job watchdog | existing `JOB_TIMEOUT_MS` / pipeline deadline (unchanged) |

No migration, backfill, dedup, `db:push`, tuning, or replica change is part of this plan.

## 3. Roster

**Proposed roster: `list_id = 7` ("25 companies"), exactly 25 members**, company_ids 9–30 and 2566–2568 (CSX, Magna, Southern Co., S&P Global, Martin Marietta, Darden, BCE, Stryker, Amphenol, Aflac, Celestica, Dominion, Power Assets, BNP Paribas, ABB, AXA, Otsuka, Aristocrat, Associated British Foods, BT Group, Idemitsu Kosan, Barratt Redrow, Coterra Energy, J M Smucker, FactSet).

This cohort is **independent of the ten-company acceptance set** (147, 148, 158, 257, 1063, 1486, 1533, 2004, 2682, 2696) — no overlap — which strengthens validation by exercising fresh corpora rather than re-scoring known-good companies. It also avoids corpus-pinning to the acceptance set.

**Roster must be re-confirmed at launch time.** If the list membership has changed, or a different 25-company set is preferred, the roster is finalised then; this plan fixes the *size* (25) and the *source list* as the default, not a frozen id-list.

## 4. Expected work

- Jobs: **25**, each the full framework-18 pipeline (36 measures).
- Expected measure results: 25 × 36 = **900** scored rows at completion.
- Expected snapshot: one immutable `analysis_results` row, `companies_count = 25`.

## 5. Cost boundary

Derived from batch 1275 actuals (mean $0.405/company, observed range $0.3651–$0.4520):

| Basis | 25-company estimate |
|---|---|
| Central (mean $0.405 × 25) | **≈ $10.1** |
| Band (min–max per-company × 25) | **$9.1 – $11.3** |
| **Proposed hard cost ceiling** | **$14.0** (≈1.4× central) |

The $14 ceiling absorbs a heavier/longer roster and more provider fallbacks than the acceptance set saw. **Stop rule S3** (below) enforces it.

## 6. Time boundary

Ten-company batch 1275 ran 24m 32s wall across effectively 2 slot-waves (8 immediate + 2 queued). 25 jobs over 8 slots ≈ **3.1 waves**. Observed per-job execution ranged 9m 34s – 23m 40s (mean ≈ 15m).

| Basis | 25-company estimate |
|---|---|
| ~3–4 waves × ~15m mean | **≈ 45 – 70 min** wall |
| **Proposed hard wall-clock ceiling** | **90 min** |

Per-job watchdog remains the existing deadline (unchanged); the wall-clock ceiling is a *monitoring* stop rule (S2), not a new timeout setting.

## 7. Stop rules (decided before launch)

Monitoring is read-only observation of the same DB tables and worker logs used for batch 1275. If any rule trips, **stop/cancel the batch, then verify child + permit settlement** (no `[WORKER-ISOLATION]` quarantine residue; `[DIAG][llm-permits]` returns to `held = 0, waiting = 0`) before any further action. Isolation reliability is judged separately from completion throughout.

| ID | Condition | Action |
|---|---|---|
| **S1 — Isolation breach** | Any `[WORKER-ISOLATION]` quarantine, withheld-permit, or forced-kill (SIGTERM/SIGKILL) line, **or** permits fail to return to 0 (leak) | **Stop immediately.** Capture logs. Do not retry. This is the primary gate — isolation reliability failure overrides completion. |
| **S2 — Wall-clock overrun** | No batch completion by **90 min** wall, or no job state progress for **> 40 min** (stall) | Stop/cancel; verify settlement; report as INCONCLUSIVE (a genuine stop condition is evidence, not a failure). |
| **S3 — Cost overrun** | `llm_usage_events` cumulative cost for the batch exceeds **$14.0** | Stop/cancel; verify settlement; report spend at stop. |
| **S4 — Failure rate** | **≥ 2** jobs reach `failed`, or any job exhausts retries | Stop/cancel; capture failing attempt_ids + logs; verify settlement. |
| **S5 — Completeness shortfall at completion** | Batch reports completed but `measure_scores` < 900 rows, or any company ≠ 36, or any null/abstained not explainable as legitimate "no information" | Do not accept; flag the shortfall; keep snapshot for inspection. |
| **S6 — Provenance/snapshot defect** | Snapshot not written, not immutable, or `companies_count ≠ 25`; or attempt_id inconsistency within a company | Flag; do not accept. |

**Reporting discipline on stop:** an S2 timeout or any genuine stop condition is reported as INCONCLUSIVE with the evidence captured, **not** silently as a failure, and completion-time observations (e.g. the parent-RSS spike from §3.3 of the addendum) are recorded as observations, not diagnoses.

## 8. What to watch (carried from batch 1275 observations)

- **Parent-RSS completion spike** (addendum §3.3): instrument whether it recurs and whether magnitude scales with roster size. Observation only.
- **Browser-render `Cannot fork` pressure** (addendum §3.4): browser-subprocess limits may rise with more concurrent renders at 25 companies. Watch; not a job-level failure unless it blocks completion.
- **Parent RSS vs container memory**: still only parent RSS is instrumented; container/child memory remains uninstrumented (labelling caveat stands).
- **8-slot ceiling**: 25 jobs will queue ~17 behind the first 8; queue-wait tail will be longer than batch 1275. Expected and benign — distinguish queue wait from execution time when reading results.

## 9. Launch checklist (for the future go-ahead — do NOT act now)

1. Confirm HEAD still `b676c2d…`; confirm 2 replicas × concurrency 4; confirm `WORKER_ISOLATION_ENABLED=true`.
2. Confirm/finalise the 25-company roster (default `list_id = 7`).
3. Confirm framework 18, workspace 3.
4. Start monitoring (read-only) for S1–S6 before enqueue.
5. Enqueue the single 25-company batch. **(This step only on explicit go-ahead.)**
6. On completion or any stop rule: run the same completion-addendum queries (completeness, provenance, snapshot, costs, timing) and the isolation-reliability checks, reported separately.

---

**This plan launches nothing.** It fixes scale (25), roster source, cost ceiling ($14), wall ceiling (90 min), and stop rules S1–S6 so a later run is bounded and decision-driven.
