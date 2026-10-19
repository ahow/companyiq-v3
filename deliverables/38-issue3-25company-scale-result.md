# Issue 3 — 25-Company Scale Validation (batch 1296) — RESULT

**Date:** 2026-10-19 (UTC)
**Commit under test:** `2991989` (`299198918b1b836572d3667282596a548a4d784b`) — "Phase 3/Issue 3: behaviourally arm scale levers M1–M4 behind kill-switches (defaults byte-identical)"
**Authorisation:** Andy Howard — ONE paid production deployment + ONE paid 25-company batch. 50/100 scale tests NOT run (held, gated).

---

## Verdict: **PASS** — 25/25 completed, 0 unexplained timeouts, circuit-breaker NOT triggered.

The CompanyIQ pipeline has now **completed its first full 25-company production run** (prior attempts: batch 1276 = 12/25, batch 1277 = 4/25, both cancelled by the legacy whole-batch stop rule). The armed M1–M4 levers are the fix for exactly that.

---

## 1. Deployment (SHA parity + health)

| Service (env/role) | Deployed SHA | Status |
|---|---|---|
| production / app | `299198918b1b…` (= 2991989) | SUCCESS |
| production / worker | `299198918b1b…` | SUCCESS |
| sprint-10-preview / app | `299198918b1b…` | SUCCESS |
| sprint-10-preview / worker | `299198918b1b…` | SUCCESS |

- **SHA parity confirmed: YES** — all 4 Railway targets advanced from prod `9faa18e` → `2991989` (full match) before any arm/run.
- **Health:** `GET /api/health` → `{"status":"ok","version":"3.0.0"}` on both `https://companyiq.online` and `https://app-production-9929.up.railway.app`.
- **Code tested == code in production:** satisfied — the exact tested SHA was deployed, and every scored row carries `pipeline_version=299198918b1b` (= the deployed SHA).

## 2. Armed levers (confirmed live during the run)

Set on the Railway **production worker** (restarted to pick them up); confirmed via `variables` API + worker logs:

| Env var | Value | Confirmation |
|---|---|---|
| `STAGE_INSTRUMENTATION_POLICY` | `on` | 102 `[STAGE-INSTR]` + 6 `[DIAG][stage-timer]` records emitted |
| `PIPELINE_TIME_BUDGET_POLICY` | `budgeted` | 308 `budget` / 102 `transient_unavailable` telemetry lines |
| `BATCH_RESILIENCE_POLICY` | `resilient` | `[BATCH-RESILIENCE] ARMED batch=1296 … isolated 0/25 (0.0%) ≤ 20.0% → retry/quarantine, batch continues` |
| `RESOURCE_POOL_POLICY` | `separated` | `[RESOURCE-POOL] policy=separated … browser_recovery clamped to [1,3]` |
| `BROWSER_SEPARATED_MAX` | `3` | recovery pool bounded 1→3 (≤ B6 97-connection ceiling) |

- **Armed flags confirmed live: YES.**
- **Concurrency 8** = 2 worker replicas × `WORKER_CONCURRENCY=4` (both replicas started: `worker-d118ea46`, `worker-e8e3fb16`). 8 jobs claimed immediately on enqueue.

## 3. The 25-company batch (batch 1296, list_id=7, framework 18 "AI Management")

- Roster (25, frozen, same as 1276/1295): `9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,2566,2567,2568`
- Enqueued 2026-10-18T23:45:06Z → completed 2026-10-19T01:18:35Z.

### Completion
| Metric | Value |
|---|---|
| Completed | **25 / 25** |
| Permanent failures | **0** |
| First-attempt (att=1) | 22 |
| After-retry (att>1) | 3 |
| Quarantines | **0** |
| Batch cancellations / systemic trips | **0** |

### Retries (allowed, logged) — all recovered
| Company | Attempts | att-1 failure reason | Recovered on att-2 (dur) |
|---|---|---|---|
| co=17 | 2 | `Pipeline timed out after 2100s` (long-tail browser-bound) | ✔ 648s |
| co=26 (Aristocrat Leisure) | 2 | `Pipeline timed out after 2100s` | ✔ 1393s |
| co=27 | 2 | `Isolated job child exited (code=1, stage=pipeline)` | ✔ 1529s |

All three are **explained** long-tail failures that the **resilient policy retried instead of cancelling the batch** — the exact behaviour that turned 4/25 (batch 1277) into 25/25. `processing_errors`: 2 × `pipeline_timeout`; one clean `[WORKER-ISOLATION] pipeline_deadline reached … outstandingLeases=none → revoke + SIGKILL` (no leak).

### Timing (per-company duration, seconds)
| n | min | mean | p50 | p90 | max |
|---|---|---|---|---|---|
| 25 | 595 | 1293 | 1319 | 1686 | 2040 (co=13) |

- **Wall-clock total: 92.7 min** (first claim 23:45:52Z → last completion 01:18:35Z).

### Cost (cap $14 retained — not breached)
| Metric | Value |
|---|---|
| Total | **$11.4315** |
| LLM calls | 4,752 |
| Tokens | 39,899,467 |
| Per-company | mean $0.4573, min $0.4035, max $0.6163 |
| Models | deepseek-chat 4749, gpt-4o 2, gpt-4o-mini 1 |

### Research-status / coverage
- **coverage = `full` for all 900 cells.** No source was persisted as a conclusive "No" due to a time budget — M2 degrades a stalled source to a retryable `transient_unavailable` (telemetry only), **never drops relevant evidence** (constraint honoured).

## 4. Scoring & cell-flip split (constraint 2)

- 900 `measure_scores` persisted (25 × exactly 36). Verdicts: **No = 702, Yes = 198.**
- Provenance clean: single `pipeline_version 299198918b1b`, `abstained=0`, evidence_fingerprint 900/900, prompt_hash 900/900.

**Flip split vs closest comparable baseline (batch 1295 — same roster, same framework; No=709/Yes=191):**

| Direction | Cells |
|---|---|
| **Yes → No** | **20** |
| **No → Yes** | **27** |
| **Total flips** | **47** (of 900; 5.2%) |
| Unchanged | 853 |

**Caveat:** batch 1295 is the only same-roster persisted baseline, but it ran on a **different code state** (SHA `9faa18e`, levers dormant) and scoring carries inherent run-to-run model variability (DeepSeek + self-consistency). The 47 flips therefore reflect armed-lever effects **and** normal model variability combined — they are **not** a clean isolation of the levers. Net movement is +7 Yes.

## 5. Bottleneck telemetry (M1, under separated pool + budgets)

Per-stage busy-sum from `[DIAG][stage-timer]` (sample of long-tail companies):

| Company | wall | browser_admission_wait | search_provider | browser_nav_parse | db_ops |
|---|---|---|---|---|---|
| FACTSET RESEARCH SYS. | 1266s | **1750s** | 378s | 171s | 1s |
| BNP PARIBAS SA | 1931s | **1050s** | 382s | 164s | 9s |
| BT GROUP PLC | 1637s | **1276s** | 366s | 335s | 13s |
| ASSOCIATED BRITISH FOODS | 1528s | **2724s** | — | 678s | 14s |

Confirms the diagnostic (batch 1295) finding: the long tail is **browser-bound through the single serialised main browser slot** (`busy_sum ≫ wall` = queued-behind-one-slot), with web-search I/O (`search_provider`) the dominant steady cost. DB is negligible. The separated recovery pool + budgets + resilient retry kept all 25 alive to completion.

## 6. Circuit-breaker

**NOT triggered.** No stall, no cost-cap breach, no systemic-failure trip (0/25 isolated ≤ 20% threshold). No Trial 2 launched; no quarantine-recovery override invoked. 50/100 held.

## 7. Post-run state (rollback)

The deployment of `2991989` to production is **permanent and intended** (advances prod; byte-identical to today at the shipped defaults). After the validation batch the operational baseline was restored:
- All 5 arming flags **unset** on the production worker (verified: none remain) → dormant defaults, byte-identical behaviour, **no redeploy required to roll back or re-arm**.
- Worker `numReplicas` restored 2 → 3 (pre-run production baseline).
- All 4 targets remain on `2991989`, SUCCESS, health `ok`/`3.0.0`.

**Re-arming** for the gated 50/100 tests is a pure env change (set the 5 vars again; no code change, no redeploy of the image).
