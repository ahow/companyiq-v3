 docs/worker-isolation/DESIGN.md                    |  176 +++
 docs/worker-isolation/PROFILE_EVIDENCE.docx        |  Bin 0 -> 17590 bytes
 docs/worker-isolation/PROFILE_EVIDENCE.md          |  196 ++++
 docs/worker-isolation/PROFILE_EVIDENCE.pdf         |  Bin 0 -> 65700 bytes
 docs/worker-isolation/TEST_RESULTS.md              |   27 +
 .../evidence/cpuprofile-analysis-c1.json           | 1002 ++++++++++++++++
 .../evidence/cpuprofile-analysis-c4.json           | 1218 ++++++++++++++++++++
 .../evidence/harness-result-c1.json                |  160 +++
 .../evidence/harness-result-c4.json                |  464 ++++++++
 server/db.ts                                       |   14 +-
 server/lib/__fixtures__/isolation-child.ts         |   52 +
 server/lib/__fixtures__/isolation-pipeline36.ts    |   36 +
 server/lib/adaptive-concurrency.ts                 |   11 +
 server/lib/ai-providers.ts                         |   11 +
 server/lib/isolation-ipc.ts                        |  113 ++
 server/lib/job-child.ts                            |   62 +
 server/lib/job-isolation.test.ts                   |  164 +++
 server/lib/job-isolation.ts                        |  193 ++++
 server/lib/llm-usage.ts                            |   15 +
 server/lib/process-role.ts                         |   13 +
 server/lib/processor.ts                            |   31 +
 server/scripts/analyze-cpuprofile.ts               |  128 ++
 server/scripts/profile-worker-blocking.ts          |  273 +++++
 server/worker-main.ts                              |    1 +
 server/worker.ts                                   |    3 +-
 25 files changed, 4361 insertions(+), 2 deletions(-)
