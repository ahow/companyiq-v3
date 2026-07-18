# ACWI May 26 (list 4) Reconciliation — 26 Jun 2026

Framework: 7 (AI Governance and Strategy Assessment Framework), 34 measures.
Batch 667: total_jobs 2443, completed_jobs 2062, failed_jobs 292 (counts reflect job attempts, not final company states).

## List membership = 2443 companies (exact)
Final company analysis_status breakdown for list 4:
- completed: 2317  -> in saved snapshot (analysis_results id 345)
- failed:    70
- idle:      56
- TOTAL:     2443  (2317 + 70 + 56)

Snapshot 345: companies_count 2317, results_data array length 2317, avg 15%.
- In snapshot but not a list member: 0
- List members not in snapshot: 126  (= 70 failed + 56 idle)

## The 126 not in snapshot
- 70 FAILED — all due to "Pipeline timed out after 2100s" (35-min per-company cap). No data produced.
- 56 IDLE — never analysed (never enqueued / left behind).

## Measure completeness (completed companies)
- 2317 completed; 2314 have all 34 measures; **3 have 0 measure rows**:
  - 461  Sony Financial Group Inc. (score 0)
  - 1066 EMPIRE COMPANY LIMITED (score 0)
  - 1981 WSP GLOBAL INC. (score 0)
  These are "completed" with score 0 but no per-measure rows -> violate "all measures populated".

## Required actions
1. Re-run 70 failed + 56 idle = 126 companies.
2. Repair 3 empty-completed so they carry all 34 measures (score 0, no evidence).
3. Rebuild snapshot covering all analysable companies, every company with 34 measures.
4. Code: guarantee auto-save on completion; add count reconciliation (saved + failed + discarded = total) and measure-completeness check.


## WHY the 126 did not run (root cause)

Within batch 667, BOTH groups have a job row and BOTH ended `status=failed`:
- 70 "failed" companies: job failed with "Pipeline timed out after 2100s" (35-min cap), attempts=3.
- 56 "idle" companies: job failed with **"Server restarted — job was orphaned"**, attempts=3.

The difference between "failed" and "idle" at the company level is just how the company row's analysis_status was last set; both groups' batch-667 jobs are `failed`.

Key insight on the 56 "idle": their jobs were orphaned by **server/worker restarts** (deploys + crashes), not by analysis failure. Each restart marked the in-flight job "Server restarted — job was orphaned" and counted an attempt; after 3 such orphanings the job was exhausted and never produced a result. This is the SAME instability the reliability work targeted (stuck claims, restarts, Chromium EAGAIN). ABSA GROUP's history shows this pattern repeating across many batches (b53–b71, etc. all "Server restarted — job was orphaned").

Why your earlier "re-run all failed" did not capture them:
- The manual re-examine re-queued jobs of the batch that was in pending_review at that moment. These 126 belonged to batch 667, which was later CANCELLED (then the snapshot was recovered) — so they were never part of a pending_review re-examine cycle. Batches 668/669 (re-run attempts) were themselves CANCELLED with ok=0 before doing work.
- Net: these 126 fell through because their batch was cancelled/recovered rather than finalised-then-reviewed, so they never re-entered an active queue.

## Fix forward
- Re-run the 126 in a fresh batch now (worker is now stabilised: MAX_CONCURRENT_BROWSER=1, stale-claim reaper, review-gate-aware reconciler).
- The 3 blank-completed (461, 1066, 1981) are actually WSP/Empire + Sony — WSP & Empire were the no-document timeouts; include them in the re-run set too (treat as not-properly-completed). So re-run set = 126 + 3 = 129 (dedup if overlap).
