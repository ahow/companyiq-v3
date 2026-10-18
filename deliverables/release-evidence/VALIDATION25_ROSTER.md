# 25-Company Validation Run — Frozen Roster

**Frozen at (UTC):** 2026-10-12T01:24:01Z
**Build (HEAD):** b676c2ddf37512dad0e18c6e812a4dc7e58a12a2
**Worker config:** 2 replicas (live-verified via 2 distinct deploymentInstanceId) × WORKER_CONCURRENCY=4 = 8 slots; WORKER_ISOLATION_ENABLED=true (worker only); JOB_TIMEOUT_MS=2400000 (unchanged)
**Framework:** 18 (36 measures)
**Workspace:** 3
**Source list:** company_lists.id=7 "25 companies" (workspace 3)
**Roster size:** 25
**Roster id CSV:** 9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,2566,2567,2568
**Roster SHA-256 (of id CSV):** 761f65e8deb27223454deaed464675e4db28f6d65fae3db5fca8a95babd1a7e8

## Members (company_id → name)

| company_id | name |
|---|---|
| 9 | CSX Corporation |
| 10 | MAGNA INTERNATIONAL INC. |
| 11 | THE SOUTHERN COMPANY |
| 12 | S&P GLOBAL INC. |
| 13 | MARTIN MARIETTA MATERIALS, INC. |
| 14 | DARDEN RESTAURANTS, INC. |
| 15 | BCE INC. |
| 16 | STRYKER CORPORATION |
| 17 | AMPHENOL CORPORATION |
| 18 | AFLAC INCORPORATED |
| 19 | CELESTICA INC. |
| 20 | Dominion Energy, Inc. |
| 21 | Power Assets Holdings Limited |
| 22 | BNP PARIBAS SA |
| 23 | ABB Ltd |
| 24 | AXA SA |
| 25 | OTSUKA CORPORATION |
| 26 | ARISTOCRAT LEISURE LIMITED |
| 27 | ASSOCIATED BRITISH FOODS PLC |
| 28 | BT GROUP PLC |
| 29 | Idemitsu Kosan Co.,Ltd. |
| 30 | BARRATT REDROW |
| 2566 | COTERRA ENERGY |
| 2567 | J M SMUCKER |
| 2568 | FACTSET RESEARCH SYS. |

> No code, replica or settings changes. Roster frozen BEFORE enqueue. Launch uses explicit companyIds (provenance: list_id=7).

---

## Launch record

**Batch id:** 1276
**Launched at (UTC):** 2026-10-12T01:24:46Z
**Endpoint:** POST /api/admin/resume-analysis (normal enqueue path: createBatchRun → createAnalysisJobs → addBatchJobs)
**Response:** {"success":true,"batchId":1276,"enqueued":25,"requested":25}
**Provenance note:** createBatchRun does not persist list_id, so batch_runs.list_id will be NULL; roster provenance is list_id=7 (recorded above). companyIds passed explicitly = frozen roster.
**Stop boundaries:** 4 recorded-model monitoring threshold; 90-min wall-clock boundary. No automatic rerun.
