# Worker isolation — branch diff summary

- Branch: `fix/worker-isolation`
- Head: `36379d0` (docs) on top of `cdc56a6` (implementation)
- Base (frozen production): `35884ee`
- Feature gate: `WORKER_ISOLATION_ENABLED` (default **off** → in-process path identical to `35884ee`)
- No merge, no deploy, no settings/.env change, no paid run.

## Commits since base
- 36379d0 docs(worker-isolation): concise responsibility/resource table; profile BM25 re-tokenisation + evidence-validation loops (evidence only, no scoring change); record verified test re-run
- cdc56a6 fix(worker-isolation): per-job child process isolation behind WORKER_ISOLATION_ENABLED

## Files changed (git diff --stat 35884ee HEAD)

```
 docs/worker-isolation/BRANCH_DIFF.md               |   26 +
 docs/worker-isolation/DESIGN.md                    |  176 +
 docs/worker-isolation/PROFILE_EVIDENCE.docx        |  Bin 0 -> 19554 bytes
 docs/worker-isolation/PROFILE_EVIDENCE.md          |  226 +
 docs/worker-isolation/PROFILE_EVIDENCE.pdf         |  Bin 0 -> 75830 bytes
 docs/worker-isolation/RESPONSIBILITY_TABLE.docx    |  Bin 0 -> 13039 bytes
 docs/worker-isolation/RESPONSIBILITY_TABLE.md      |   17 +
 docs/worker-isolation/RESPONSIBILITY_TABLE.pdf     |  Bin 0 -> 43565 bytes
 docs/worker-isolation/TEST_RESULTS.docx            |  Bin 0 -> 12334 bytes
 docs/worker-isolation/TEST_RESULTS.md              |   47 +
 docs/worker-isolation/TEST_RESULTS.pdf             |  Bin 0 -> 25938 bytes
 .../evidence/cpuprofile-analysis-c1.json           | 1002 +++++
 .../evidence/cpuprofile-analysis-c4.json           | 1218 +++++
 .../evidence/harness-result-c1.json                |  160 +
 .../evidence/harness-result-c4.json                |  464 ++
 docs/worker-isolation/fix-worker-isolation.patch   | 4633 ++++++++++++++++++++
 server/db.ts                                       |   14 +-
 server/lib/__fixtures__/isolation-child.ts         |   52 +
 server/lib/__fixtures__/isolation-pipeline36.ts    |   36 +
 server/lib/adaptive-concurrency.ts                 |   11 +
 server/lib/ai-providers.ts                         |   11 +
 server/lib/isolation-ipc.ts                        |  113 +
 server/lib/job-child.ts                            |   62 +
 server/lib/job-isolation.test.ts                   |  164 +
 server/lib/job-isolation.ts                        |  193 +
 server/lib/llm-usage.ts                            |   15 +
 server/lib/process-role.ts                         |   13 +
 server/lib/processor.ts                            |   31 +
 server/scripts/analyze-cpuprofile.ts               |  128 +
 server/scripts/profile-worker-blocking.ts          |  273 ++
 server/worker-main.ts                              |    1 +
 server/worker.ts                                   |    3 +-
 32 files changed, 9087 insertions(+), 2 deletions(-)
```
