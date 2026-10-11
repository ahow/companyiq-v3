# Worker isolation: test results (branch fix/worker-isolation, base 35884ee)

## New tests: server/lib/job-isolation.test.ts (9/9 pass, exit 0, ~36 s)
| Test | Result |
|---|---|
| Busy child (3 s CPU) | parent max event-loop lag 6.2 ms, wall 3830 ms |
| Cooperative cancel | resolved "Cancelled" after 2527 ms |
| Deadline / revoke, child ignores SIGTERM + grandchild | rejected after 6672 ms "Job watchdog timeout: ... signal=SIGKILL ... after revoke:job_watchdog_timeout"; child and grandchild gone |
| Child crash holding LLM permit | "Isolated job child exited unexpectedly (code=1 ...)", retriable; permit released |
| Permit brokering | max LLM 8, max browser 1, all released |
| Usage forwarding | rows land in parent buffer, child buffer 0, child PG_POOL_MAX=4 |
| ProviderScoringError | rebuilt as real class (quota_exhausted, deepseek) |
| Real runAnalysisPipeline, 40 docs (stub PG/providers) | success, 36 measures, 168 provider calls, 1 fenced write, wall 14716 ms, parent max lag 16.9 ms |
| childPgBudget() | 4 |

Log: evidence/job-isolation.test.log

## Full suite (each test file run with tsx, stub DATABASE_URL)
- Baseline 35884ee: 97 files, 94 pass, 3 fail.
- Branch: 98 files, 95 pass, 3 fail: the same 3 pre-existing failures (corpus-replay.test.ts, lifecycle-fence.db.test.ts needs REDIS_URL, r6-discovery.test.ts vitest missing). No regressions; the only extra file is job-isolation.test.ts (pass).

## tsc
- Baseline 61 errors, branch 62. The one new error: TS7016 (no pdf-parse types) in server/scripts/profile-worker-blocking.ts, the same pre-existing error class as processor.ts(4,22). No new errors in runtime files.

## Not verified
- No runs against real Postgres/Redis/Railway. WORKER_ISOLATION_ENABLED defaults to off, so staging is still needed.
- Expected costs: ~200 MB and ~1.7-1.9 s cold start per child, up to 4 Chromium instances per replica, DB cap of 4 per job, BatchFetchState merged only at job end, credit-breaker/provider pause state kept per child.
