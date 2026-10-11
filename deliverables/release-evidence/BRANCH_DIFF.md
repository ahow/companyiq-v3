# Worker isolation: branch diff summary

- Branch: `fix/worker-isolation`
- Head of the code/docs covered here: `70426ea` (the commit adding this file and the regenerated patch sits on top of it)
- Base (frozen production): `35884ee`
- Feature gate: `WORKER_ISOLATION_ENABLED` (default **off**, so the in-process path is identical to `35884ee`)
- No merge, no deploy, no settings/.env change, no paid run. Scoring rules and BM25 are unchanged.
- `fix-worker-isolation.patch` = `git format-patch 35884ee..70426ea --stdout` (4 commits). A patch cannot contain the commit that adds it.

## Commits since base
- 70426ea docs(worker-isolation): full pool inventory, deadline/retry tables, parent-work audit, test results + log (Andy Howard)
- bfa711e worker-isolation: parent-enforced pipeline/job deadlines, parent-death watchdog, retry parity, permit/background-work guarantees (Andy Howard)
- 46c42ff docs(worker-isolation): concise responsibility/resource table; profile BM25 re-tokenisation + evidence-validation loops (evidence only, no scoring change); record verified test re-run (Andy Howard)
- cdc56a6 fix(worker-isolation): per-job child process isolation behind WORKER_ISOLATION_ENABLED (ahow)

## Files changed (git diff --stat 35884ee 70426ea)

```
 docs/worker-isolation/BRANCH_DIFF.md                       |   49 +
 docs/worker-isolation/DESIGN.md                            |  201 +
 docs/worker-isolation/PROFILE_EVIDENCE.docx                |  Bin 0 -> 20810 bytes
 docs/worker-isolation/PROFILE_EVIDENCE.md                  |  250 +
 docs/worker-isolation/PROFILE_EVIDENCE.pdf                 |  Bin 0 -> 58572 bytes
 docs/worker-isolation/RESPONSIBILITY_TABLE.docx            |  Bin 0 -> 16773 bytes
 docs/worker-isolation/RESPONSIBILITY_TABLE.md              |  109 +
 docs/worker-isolation/RESPONSIBILITY_TABLE.pdf             |  Bin 0 -> 39485 bytes
 docs/worker-isolation/TEST_RESULTS.docx                    |  Bin 0 -> 13502 bytes
 docs/worker-isolation/TEST_RESULTS.md                      |   76 +
 docs/worker-isolation/TEST_RESULTS.pdf                     |  Bin 0 -> 30243 bytes
 docs/worker-isolation/evidence/cpuprofile-analysis-c1.json | 1002 ++++
 docs/worker-isolation/evidence/cpuprofile-analysis-c4.json | 1218 +++++
 docs/worker-isolation/evidence/harness-result-c1.json      |  160 +
 docs/worker-isolation/evidence/harness-result-c4.json      |  464 ++
 docs/worker-isolation/evidence/job-isolation.test.log      |  311 ++
 docs/worker-isolation/fix-worker-isolation.patch           | 9393 ++++++++++++++++++++++++++++++++
 server/db.ts                                               |   14 +-
 server/lib/__fixtures__/isolation-child.ts                 |  133 +
 server/lib/__fixtures__/isolation-parent.ts                |   11 +
 server/lib/__fixtures__/isolation-pipeline36.ts            |   36 +
 server/lib/adaptive-concurrency.ts                         |   11 +
 server/lib/ai-providers.ts                                 |   11 +
 server/lib/isolation-ipc.ts                                |  127 +
 server/lib/job-child.ts                                    |   89 +
 server/lib/job-isolation.test.ts                           |  417 ++
 server/lib/job-isolation.ts                                |  317 ++
 server/lib/llm-usage.ts                                    |   20 +
 server/lib/process-role.ts                                 |   13 +
 server/lib/processor.ts                                    |   34 +
 server/lib/retry-policy.ts                                 |   45 +
 server/scripts/analyze-cpuprofile.ts                       |  128 +
 server/scripts/profile-worker-blocking.ts                  |  273 +
 server/worker-main.ts                                      |    1 +
 server/worker.ts                                           |   31 +-
 35 files changed, 14919 insertions(+), 25 deletions(-)
```
