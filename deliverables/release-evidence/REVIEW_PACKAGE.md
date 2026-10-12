# Review package: browser lifetime + stop rule S4

| | |
|---|---|
| Branch | `fix/browser-lifetime-and-stop-rule` (pushed to origin) |
| Base | `b676c2d` |
| Release candidate | `caaa191` (fix `f2288ce` + test/harness commit) |
| Patch | `fix-browser-lifetime-and-stop-rule.patch` (`git format-patch b676c2d..caaa191`) |
| Gates | `WORKER_ISOLATION_ENABLED` (fix active only in isolated children), `BATCH_STOP_RULE_FAILED_JOBS` (stop rule). Both are off by default, so production behaviour is unchanged until one is set. |

## Contents

| Document | What it contains |
|---|---|
| [BRANCH_DIFF.md](BRANCH_DIFF.md) | Commits, files, what changed in `processor.ts`/`worker.ts`/`batch-stop-rule.ts`, and review focus |
| [TEST_RESULTS.md](TEST_RESULTS.md) | Before/after repro (unlimited and TasksMax=400), new tests, 11 regression suites, integration suite, stop-rule outcome, tsc, what is not verified |
| [evidence/batch1276-url-reconciliation.md](evidence/batch1276-url-reconciliation.md) | Batch 1276: failed, then recovered, then residual gap per company |
| `evidence/browser-lifetime-candidate/` | Raw repro JSON and logs for the four worktree runs, plus `wt-run.sh` |
| `evidence/regression-caaa191/` | Every suite log, tsc outputs (base and candidate), integration logs and JSON |

## Headline results

**Live browsers.**

- With 1 browser permit, the base keeps up to **4** Chromium instances alive (one per child), and the candidate keeps **1**.
- Threads fell from 550 to 205 and summed RSS from 4.9 GB to 2.0 GB, with no change in wall time, admission wait or permit hold.

**Under a 400-task cgroup cap (TasksMax=400).**

- The base failed **4/12** jobs. Those documents were never fetched, after Chromium launch failures and protocol timeouts, and the run took 3.9× as long.
- The candidate ran **12/12** with unchanged timing.

**Ordering.** `browser-close-order.test.ts` (4/4) shows that Chromium is gone before the permit returns on the success, fetch-failure, cancellation and child-death paths. A mutation check showed that releasing the permit first makes these tests fail.

**Regressions.**

- All 11 existing suites passed with the same counts as the previous baseline. tsc reports 62 errors on both base and candidate, with an identical error set.
- Integration (real PG/Redis/BullMQ/Chromium): 1 of 2 candidate runs passed 11/11. The other failed 2 harness process-count checks because of one extra non-Chromium direct child of the test process, likely tsx's esbuild service (hypothesis; details in TEST_RESULTS §3). The base passed 11/11.

**Stop rule.** In the batch-1276 shape, the rule off means 13 jobs exhaust retries (39 failed attempts). With `BATCH_STOP_RULE_FAILED_JOBS=2`, the batch is cancelled at the 2nd failed job, before any retry is exhausted.

**Coverage impact (batch 1276).**

- 95 failed URLs: 26 recovered by fallback, 20 ok in DB without a logged recovery, and a **49-URL residual gap** (12.5% of the attempted corpus).
- Southern lost 10/27 (37%), all after browser-launch failures. That is the clearest coverage loss consistent with the browser-lifetime defect. It is an inference from log tags, not a measured causal link.

## Claims kept narrow

- The production SIGABRT signature was **not** reproduced locally. Locally we reproduced the launch-failure / starvation mode under a task cap.
- Not run on Railway or at production settings. No real web fetches or LLM providers were used.
