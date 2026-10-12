# 25-Company Validation Run — Results (batch 1277)

**Overall result: FAILED / INCOMPLETE.** The batch was cancelled by the S4 batch stop rule after 35 min. Only **4 of 25** companies completed and were scored. The cause was **4 first-attempt pipeline timeouts (2100 s)** in the first wave of 8 jobs. The stop rule, the cancellation path and settlement worked as designed. The run does **not** support a production-readiness claim for throughput or for source coverage.

| Item | Value |
|---|---|
| Environment | Railway prod env `c1166ef6` (project `db04e5b1`) |
| Worker deployment | `18a827b7` SUCCESS, commit `8c03b07` (merge of `c86787b`, runtime `9a1b931`). Created 16:45:30Z, before launch. Unchanged at 17:34Z and re-checked after the run (no newer worker or app deployment). |
| Key worker vars (re-read post-run) | `BATCH_STOP_RULE_FAILED_JOBS=2`, `PIPELINE_TIMEOUT_MS=2100000`, `WORKER_CONCURRENCY=4`, `LLM_MAX_CONCURRENCY=8` (8 job slots, matching the 8 jobs claimed at t0) |
| Roster | `VALIDATION25_ROSTER.md`, 25 ids, SHA-256 `761f65e8…a7e8` (verified pre-launch) |
| Launch | `POST /api/admin/resume-analysis` (workspace 3, framework 18, 25 ids) at **2026-10-12T16:55:56.37Z**. HTTP 200 `{"success":true,"batchId":1277,"enqueued":25,"requested":25}` |
| Terminal | `batch_runs.status='cancelled'`, `terminal_at=17:30:57.081Z`, `acceptance_state='rejected'`, `rejection_reason='stop rule S4: 3 job(s) failed (threshold 2)'` |
| Wall clock | 35 min 01 s (limit 90 min, not reached) |
| Spend | **$1.7706**, 810 `llm_usage_events` (limit $14, not reached). All LLM spend since launch belongs to batch 1277. **0 events after terminal.** Last event 17:30:54.6Z. |
| Interventions | None. No manual cancel, redeploy, config change or DB write. All DB access was read-only (`default_transaction_read_only=on`). |

## Verdicts

| Dimension | Verdict | Basis |
|---|---|---|
| Execution reliability | **FAIL** (lifecycle/isolation sub-checks PASS) | 4 of the 8 first-wave jobs hit the 2100 s pipeline timeout. Dominion completed at 2097 s, 3 s before the limit. No crashes, signals-of-death, lock loss, stalls or worker restarts. |
| First-attempt completion | **FAIL** | 4/25 completed (16%). 4 timed out. 5 were cancelled in flight. 12 were never claimed. |
| Source acquisition | **INCONCLUSIVE** | Only 4 scored companies. Browser **launch** failures: 0 (batch 1276: 69 URLs). Residual gap 10/172 (5.8%) across the 4, but BCE is 8/52 (15.4%), 6 of them first-party. |
| Cost | **PASS** | $1.77 against a $14 cap. |
| Settlement | **PASS, with 3 open items** | Batch terminal, no claimed/running rows anywhere, no LLM spend after terminal, permits and pool drained. Open items are listed below. |

## Job outcomes (DB, read at 17:37Z)

| Outcome | Companies (id) | Notes |
|---|---|---|
| **completed**, attempt 1, 36 `measure_scores` rows / 36 distinct measures each | MAGNA (10) 17:07:28, BCE (15) 17:23:08, CSX (9) 17:24:45, Dominion (20) 17:30:54 | Pipeline time: MAGNA 691 s, BCE 1630 s, CSX 1727 s, Dominion ≈2097 s (claim→complete) |
| **timed out**, attempt 1 → `pending`, `attempts=1`, `last_error='Pipeline timed out after 2100s'` | DARDEN (14), CELESTICA (19), AXA (24), Idemitsu (29) | All 4 timed out at 17:30:56.96–17:30:57.01Z. 29, 14 and 19 logged `stop-rule-cancelled-no-retry`. 24 logged `will retry` (attempt 1/3) before the trip. No later activity for 24 in logs or DB. |
| **failed**, `'Cancelled (batch cancelled)'` (in flight at cancel) | Southern (11), Stryker (16), Power Assets (21), Otsuka (25), Barratt (30) | Lifecycle fence revoked each attempt. Child results arriving after the terminal decision were discarded. |
| **pending**, `attempts=0` (never claimed) | 12, 13, 17, 18, 22, 23, 26, 27, 28, 2566, 2567, 2568 | All 12 refused at pre-claim (`cancel-path step=d where=pre-claim flag_read=true`, 17:30:59.5–.6Z) |

`measure_scores` for batch 1277 contains 144 rows: 4 companies × 36.

### Stop-rule trip sequence (worker logs)
- 17:30:56.96–57.01: `cancel-path step=e reason=pipeline_timeout` for jobs 96955 (AXA), 96950 (Celestica), 96960 (Idemitsu) and 96945 (Darden).
- 17:30:57.082: `[BATCH-STOP-RULE] TRIPPED batch=1277 job=96960 failedAttemptJobs=3 … threshold=2`. Then `cancelBatchRun transitioned=true` (17:30:57.091).
- Two further trips (`failedAttemptJobs=4`) were idempotent no-ops (`transitioned=false … already cancelled`).
- Cancel flag acked in Redis (`cancelled:batch:1277`, TTL 3600 s). Fence revocations for in-flight jobs ran 17:30:59–17:31:09.
- Last job transition: 17:31:09.32 (Southern, Barratt).

Note: S4 counts first-attempt failures (`failedAttemptJobs`), not retry-exhausted jobs (`retryExhaustedJobs=0`). At threshold 2, the first 3 timeouts trip the rule even though each job still had retries left. This matches the configured threshold, but it means no retries were attempted.

## Why the 4 jobs timed out — open, not diagnosed
This section is a **hypothesis only**. No root cause was confirmed in this run.

- The timed-out jobs spent almost nothing on LLM calls: 13–15 events, about $0.01 each, all during discovery (16:58–17:08). None of them recorded analysis-phase LLM spend.
- Each one's per-company log trail goes silent long before the timeout:

| Job | Last log line |
|---|---|
| Celestica | 17:07:42 `All documents resolved: 45 ok, 3 dead` |
| Idemitsu | 17:11:58 `2 origin(s) queued for browser recovery` |
| Darden | 17:12:46 `deferred retry sweep complete` |
| AXA | 17:23:30 `Analyzing with 43 fetched documents` |

- The completed companies show the same pattern of long silent intervals:

| Company | Entered `PHASE 2: ANALYZE` | Bulk of analysis LLM calls |
|---|---|---|
| BCE | 17:13:27 | 17:19–17:23 |
| Dominion | 17:20:33 | 17:27–17:30 |
| CSX | 17:22:07 | 17:23–17:24 (no LLM events 17:03–17:22) |

- Likely cause (hypothesis): stage work queued behind a shared, serialised resource (analysis or browser-recovery slots) across the 8 concurrent jobs. This is **not** a per-job hang inside the isolation layer: heartbeats and lock renewals continued throughout. Confirming it requires per-stage timers for the timed-out children, which were not emitted because the children were aborted.
- Caveat: worker logs were collected through the Railway `deploymentLogs` API. They carry no replica id and may be incomplete under API limits, so a silent interval could partly be log loss.

## Execution reliability detail (7,154 de-duplicated log lines, 16:55:56–17:33:30Z, `ev_exec.py`)

| Check | Result |
|---|---|
| SIGABRT / SIGSEGV / OOM / `Killed` / EAGAIN / uncaught exceptions | 0 / 0 / 0 / 0 / 0 / 0 |
| Worker restarts (`Starting standalone worker`) | 0 |
| SIGKILL / SIGTERM mentions | 4 / 3. All are cancel-path child cleanup (`still alive 10000ms after cancel → SIGTERM groups` ×3, 17:31:07–09). |
| Child results `reported AFTER terminal decision` | 3, all discarded (diagnostic only) |
| BullMQ locks | 213 renewals, since-last 75,001–120,517 ms. `stalledCounter>0`: 0. Lock-lost lines: 0. |
| Browser lifecycle | 72 launches, 71 closes, 71 reaped (all `via=close`). Max holders 1. Close time max 214 ms (median 91 ms). **1 launch with no close/reap line:** pid 3471, child 48, 17:12:46Z (see open items). |
| Browser **launch** failures | **0**. The 14 `Browser fetch failed` lines are navigation timeouts (9) and `ERR_TUNNEL_CONNECTION_FAILED` (10 across all fetch lines), not launches. 2 `Browser temporarily unavailable`. |
| Worker-main RSS | 140–246 MB. Event-loop max lag 235 ms. DB pool waiting max 0. LLM permits max held 8 / waiting 1, drained to 0/0. |

## Source acquisition (4 completed + 4 timed-out companies)
Method is identical to `evidence/batch1276-url-reconciliation.md`: `documents` rows (read-only) joined by URL to the archived worker logs, window 16:55:56–17:31:10Z. Script: `evidence/recon1277.py`. Output: `evidence/recon1277_out.json`. Unattributable log lines: 12 timeout, 18 deferred-retry, 2 http, 2 unavailable.

**Tag caveat:** in `recon1277.py`, the tag `browser-launch-failed` is the 1276 regex and also matches `Browser fetch failed for …`. In this run those are navigation timeouts or proxy tunnel errors, not launch failures (see above).

| Company (id) | ok (= analysed snapshot) | dead in window (reasons) | failed URLs (log) | recovered via fallback (by) | ok in DB w/o logged recovery | **residual gap** | gap first-party | gap share | batch 1276 gap |
|---|---|---|---|---|---|---|---|---|---|
| CSX (9) | 30 | 1 (timeout) | 9 | 2 (firecrawl) | 6 | **1** | 0 | 1/31 (3.2%) | 2 |
| MAGNA (10) | 56 | 0 | 1 | 0 | 0 | **1** | 0 | 1/57 (1.8%) | 1 |
| BCE (15) | 44 | 16 (timeout 12, budget 4) | 14 | 6 (browser-pdf) | 0 | **8** | 6 | 8/52 (15.4%) | 4 |
| Dominion (20) | 32 | 0 | 5 | 0 | 5 | **0** | 0 | 0/32 (0%) | 1 |
| **Scored total** | **162** | 17 | **29** | **8** | **11** | **10** | **6** | **10/172 (5.8%)** | 8 |
| DARDEN (14)* | 39 | 3 (timeout) | 5 | 1 (firecrawl, deferred-retry) | 1 | 3 | 2 | — | 3 |
| CELESTICA (19)* | 45 | 3 (timeout) | 6 | 5 (firecrawl) | 1 | 0 | 0 | — | 2 |
| AXA (24)* | 43 | 9 (timeout 6, 403 challenge 2, budget 1) | 10 | 4 (firecrawl) | 1 | 5 | 5 | — | 5 |
| Idemitsu (29)* | 32 | 5 (timeout) | 8 | 4 (browser-pdf; direct-retry 2) | 1 | 3 | 0 | — | 7 |

\* Timed out, not scored. Their corpus was fetched, but no scores exist for this batch. The `ok` counts for these four are DB state, not an analysed snapshot (AXA's snapshot was 43). The "ok" column includes documents cached from earlier runs: 13 `cached documents available` lines, e.g. CSX 27, BCE 29, MAGNA 53, Dominion 24.

Per-row arithmetic holds: failed = recovered + ok-without-logged-recovery + gap.

**Residual-gap URLs, scored companies**
- CSX: `aba.stevieawards.com/awards/aba-winners/2025/publication-awards/` (third-party, timeout)
- MAGNA: `gurufocus.com/stock/MGA/transcripts/8838359` (third-party, gate `rejected`)
- BCE, first-party, all dead/timeout (3 of them had `ERR_TUNNEL_CONNECTION_FAILED` on the browser attempt) — 6 `bce.ca` / `www.bce.ca` newsroom articles:
  - Bell Cyber launch
  - Bell AI Fabric × Cohere/Hypertec/BUZZ HPC
  - Canadian businesses AI study
  - Bell AI Fabric 300 MW Saskatchewan
  - Bell Cyber × Cohere sovereign AI
  - Bell × Celestica sovereign AI infrastructure
- BCE, third-party, budget_exceeded: `mediumir.com/01301/2026042903407.pdf`, `ca.finance.yahoo.com/sec-filing/BRK-A/…`

**Residual-gap URLs, timed-out companies (first-party)**
- Darden: 2 `investor.darden.com` SEC-filing detail pages (FilingId 19643942, 19681313)
- AXA:
  - `axa.com` 2024 integrated report
  - `axa.com` 2022 climate report
  - `webcast.axa.com` document 264
  - `axa.co.uk` s172/governance page
  - `axa.com` AI FAQ

**Reading:**
- The batch-1276 defect class (browser launch failures, 69 URLs; Southern 10/27) did **not** recur. There were 0 launch failures.
- Coverage still has losses: page/navigation timeouts and proxy tunnel errors on issuer domains.
- BCE's gap doubled versus 1276 (4 → 8), all newsroom pages rather than the 1276 annual-report PDFs.
- Southern, the main 1276 coverage casualty, was cancelled in flight here, so the fix's effect on Southern is **untested**.
- As in 1276, 36 score rows per company does not by itself demonstrate coverage.

## Settlement
- `batch_runs` 1277 is terminal (`cancelled`, `terminal_at` set).
- No `analysis_jobs` row in any batch is in a claimed or running state.
- The only `pending` rows in the DB are the 16 belonging to terminal batch 1277: 12 with `attempts=0` and 4 with `attempts=1`. The lifecycle fence and the pre-claim cancel-flag check refuse them.
- No LLM spend after `terminal_at`. LLM permits ended at held=0/waiting=0. Main pool ended at total=0, waiting=0.

**Open items (not resolved in this run):**
1. **`batch_runs.failed_jobs = 0`** while 5 job rows are `failed` and 4 more carry a timeout error. The aggregate counter disagrees with the job rows and the rejection reason.
2. **Browser pid 3471** (child 48, launched 17:12:46Z) has no close/reap log line. All other 71 launches were reaped. This could be log loss; it was not verified on the host.
3. **Redis/BullMQ state was not inspected** (no read-only Redis access was used). AXA job 96955 logged `will retry` before the trip, and that delayed retry may still exist in the queue. Its DB row is `pending` in a terminal batch, and no activity or spend was observed for it after the cancel. The Redis cancel flag has a 3600 s TTL from 17:30:57Z.

## What this run does and does not show
- **Shows:**
  - The durable-first stop-rule cancel (`9a1b931`) trips once, is idempotent on repeat trips, and fences in-flight and queued jobs within about 12 s.
  - Cancelled children's late results are discarded.
  - Browser lifetimes are bounded (max 1 holder, 0 launch failures).
  - Spend stopped at the terminal decision.
- **Does not show:**
  - That the pipeline finishes within 2100 s under 8-way concurrency. Half the first wave did not, and one completion came within 3 s of the limit.
  - That source coverage is comprehensive across the roster: 21 of 25 companies were not scored.
- **Batch 1277 results must not be treated as a completed 25-company validation.** The 4 scored companies are valid single-attempt results on the corpora listed above.

## Evidence files
- `evidence/recon1277.py`, `evidence/recon1277_out.json`: source-acquisition join (read-only SELECT plus archived logs)
- Run working files (not committed, on the operator VM): `launch.json` (launch request/response), `poll.log` (11 DB/deployment polls, 16:56–17:34Z), `logs.jsonl` (7,193 archived worker log lines), `ev_exec.py` (execution-reliability counts), `final_state.txt` (final DB snapshot)
