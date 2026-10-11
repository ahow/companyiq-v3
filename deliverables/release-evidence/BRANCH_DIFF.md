# Worker isolation: branch diff summary

- Branch: `fix/worker-isolation`
- Head of the code/docs covered here: `36a1386` (the commit adding this file and the regenerated patch sits on top of it)
- Base (frozen production): `35884ee`
- Feature gate: `WORKER_ISOLATION_ENABLED` (default **off**, so the in-process path is identical to `35884ee`)
- No merge, no deploy, no settings/.env change, no paid run. Scoring rules and BM25 are unchanged.
- `fix-worker-isolation.patch` = `git format-patch 35884ee..36a1386 --stdout` (8 commits). A patch cannot contain the commit that adds it.

## Commits since base
- 36a1386 docs(worker-isolation): regenerate TEST_RESULTS/RESPONSIBILITY_TABLE docx+pdf (ahow)
- 55d452a worker-isolation: opt-in integration suite (real BullMQ/Redis/Postgres/Chromium, 2 isolated children) + evidence; docs for quarantine, monotonic decision, browser permits vs instances (ahow)
- f8f8384 worker-isolation: quarantine unconfirmed descendant cleanup (permits withheld, never clean success; zombie-aware probe); monotonic terminal decision (late reports discarded) + ordering-barrier tests (Andy Howard)
- 0f6bebc docs(worker-isolation): regenerate BRANCH_DIFF + full patch (35884ee..70426ea); mirror to deliverables/release-evidence (Andy Howard)
- 70426ea docs(worker-isolation): full pool inventory, deadline/retry tables, parent-work audit, test results + log (Andy Howard)
- bfa711e worker-isolation: parent-enforced pipeline/job deadlines, parent-death watchdog, retry parity, permit/background-work guarantees (Andy Howard)
- 46c42ff docs(worker-isolation): concise responsibility/resource table; profile BM25 re-tokenisation + evidence-validation loops (evidence only, no scoring change); record verified test re-run (Andy Howard)
- cdc56a6 fix(worker-isolation): per-job child process isolation behind WORKER_ISOLATION_ENABLED (ahow)

## Files changed (git diff --stat 35884ee 36a1386)

```
 deliverables/release-evidence/BRANCH_DIFF.md                       |    55 +
 deliverables/release-evidence/DESIGN.md                            |   201 +
 deliverables/release-evidence/PROFILE_EVIDENCE.docx                |   Bin 0 -> 20810 bytes
 deliverables/release-evidence/PROFILE_EVIDENCE.md                  |   250 +
 deliverables/release-evidence/PROFILE_EVIDENCE.pdf                 |   Bin 0 -> 58572 bytes
 deliverables/release-evidence/RESPONSIBILITY_TABLE.docx            |   Bin 0 -> 16773 bytes
 deliverables/release-evidence/RESPONSIBILITY_TABLE.md              |   109 +
 deliverables/release-evidence/RESPONSIBILITY_TABLE.pdf             |   Bin 0 -> 39485 bytes
 deliverables/release-evidence/TEST_RESULTS.docx                    |   Bin 0 -> 13502 bytes
 deliverables/release-evidence/TEST_RESULTS.md                      |    76 +
 deliverables/release-evidence/TEST_RESULTS.pdf                     |   Bin 0 -> 30243 bytes
 deliverables/release-evidence/evidence/cpuprofile-analysis-c1.json |  1002 ++
 deliverables/release-evidence/evidence/cpuprofile-analysis-c4.json |  1218 ++
 deliverables/release-evidence/evidence/harness-result-c1.json      |   160 +
 deliverables/release-evidence/evidence/harness-result-c4.json      |   464 +
 deliverables/release-evidence/evidence/job-isolation.test.log      |   311 +
 deliverables/release-evidence/fix-worker-isolation.patch           | 27264 +++++++++++++++++++++++++++++++++++++++++++
 docs/worker-isolation/BRANCH_DIFF.md                               |    55 +
 docs/worker-isolation/DESIGN.md                                    |   201 +
 docs/worker-isolation/PROFILE_EVIDENCE.docx                        |   Bin 0 -> 20810 bytes
 docs/worker-isolation/PROFILE_EVIDENCE.md                          |   250 +
 docs/worker-isolation/PROFILE_EVIDENCE.pdf                         |   Bin 0 -> 58572 bytes
 docs/worker-isolation/RESPONSIBILITY_TABLE.docx                    |   Bin 0 -> 19480 bytes
 docs/worker-isolation/RESPONSIBILITY_TABLE.md                      |   140 +
 docs/worker-isolation/RESPONSIBILITY_TABLE.pdf                     |   Bin 0 -> 50217 bytes
 docs/worker-isolation/TEST_RESULTS.docx                            |   Bin 0 -> 16047 bytes
 docs/worker-isolation/TEST_RESULTS.md                              |   117 +
 docs/worker-isolation/TEST_RESULTS.pdf                             |   Bin 0 -> 37523 bytes
 docs/worker-isolation/evidence/cpuprofile-analysis-c1.json         |  1002 ++
 docs/worker-isolation/evidence/cpuprofile-analysis-c4.json         |  1218 ++
 docs/worker-isolation/evidence/harness-result-c1.json              |   160 +
 docs/worker-isolation/evidence/harness-result-c4.json              |   464 +
 docs/worker-isolation/evidence/integration-run.json                |   981 ++
 docs/worker-isolation/evidence/job-isolation.test.log              |   381 +
 docs/worker-isolation/fix-worker-isolation.patch                   | 27264 +++++++++++++++++++++++++++++++++++++++++++
 server/db.ts                                                       |    14 +-
 server/lib/__fixtures__/isolation-child.ts                         |   161 +
 server/lib/__fixtures__/isolation-integration-child.ts             |    28 +
 server/lib/__fixtures__/isolation-parent.ts                        |    11 +
 server/lib/__fixtures__/isolation-pipeline36.ts                    |    36 +
 server/lib/adaptive-concurrency.ts                                 |    11 +
 server/lib/ai-providers.ts                                         |    11 +
 server/lib/isolation-ipc.ts                                        |   127 +
 server/lib/job-child.ts                                            |    89 +
 server/lib/job-isolation.integration.test.ts                       |   233 +
 server/lib/job-isolation.test.ts                                   |   611 +
 server/lib/job-isolation.ts                                        |   460 +
 server/lib/llm-usage.ts                                            |    20 +
 server/lib/process-role.ts                                         |    13 +
 server/lib/processor.ts                                            |    34 +
 server/lib/retry-policy.ts                                         |    50 +
 server/scripts/analyze-cpuprofile.ts                               |   128 +
 server/scripts/profile-worker-blocking.ts                          |   273 +
 server/worker-main.ts                                              |     1 +
 server/worker.ts                                                   |    31 +-
 55 files changed, 65660 insertions(+), 25 deletions(-)
```
