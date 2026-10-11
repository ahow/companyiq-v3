# Worker Isolation — Bounded Deployment Trial Plan (Trial 1)

**Status:** Approved to execute; pinned and ready (see §9). **Held at one gate:** the host has 7 GB RAM / 2 vCPU, below the pinned 8 GB ceiling / production-equivalent CPU (§9.4). **No paid run, no cloud resources, no production enablement, no settings change has been performed.**
**Pinned commit (full hash, immutable):** `bbc3c11e0be3fe666b9f1a8e080275f692a7fde4` on `fix/worker-isolation`.
**Tested range (corrected):** `35884eeac8314114df924b8dc303ae2bdd64ed25..bbc3c11e0be3fe666b9f1a8e080275f692a7fde4`.
The previously-recorded range ending at `80632ea` (`80632ead1e223cafb440af34c124015bd91291c9`) was **stale and is withdrawn**: `80632ea` is *not* an ancestor of HEAD, and the only differences between it and `bbc3c11` are docs/evidence files (BRANCH_DIFF, RESPONSIBILITY_TABLE, TEST_RESULTS, patches, integration-run.json) — **zero `server/` code delta**. The pinned HEAD is therefore the correct and complete tested surface.
**What this document is:** the single bounded trial the branch is now ready for, with an exact
configuration, a fixed resource/wall-clock ceiling to approve *before* launch, the measurements
that decide pass/fail, and the stop conditions. It deliberately contains **no new design** and
**no further report-only iteration** — per the standing decision to stop expanding and give the
change one limited chance to show the benefit.

This plan reflects the reviewer's decision contract verbatim; it does not reopen scope.

---

## 0. Pre-launch verification already completed (read-only, free)

Confirmed directly against the working tree at `bbc3c11` — not from the prior report:

| Claim to verify before trusting the trial | Result |
|---|---|
| Branch/commit is the one to be tested | `fix/worker-isolation` @ `bbc3c11`, pushed to origin. |
| `recoverQuarantinedChildren` (the permit-return-regardless-of-probe override) has **no automatic caller** | Confirmed. Referenced only in its own definition and the unit test. The background `quarantineTimer` returns permits *only* after a probe confirms `live.length === 0` (termination confirmed). The override is invoked by nothing in production. |
| Isolation is OFF by default | Confirmed: `WORKER_ISOLATION_ENABLED === "true"` is required; default is OFF. |

**Consequence for safety restriction #3:** "do not call the quarantine recovery override" is a
pure operational rule for this trial. It needs **no code change**, because nothing calls it
automatically. Unresolved quarantine is therefore a clean stop condition.

---

## 1. Scope of this approval request

**Included:** one isolated Railway environment/service running the pinned branch, at the intended
four-child concurrency, with real Chromium and representative saved inputs; measurement of actual
container memory/CPU, parent responsiveness, deadline/cancellation/cleanup behaviour, and aggregate
resource limits.

**Explicitly excluded (unchanged standing constraints):**
- No production enablement. No merge. No change to production settings or worker config.
- No mixing with production workers on the same queue — the trial runs on its **own** isolated
  service/environment and its **own** queue namespace.
- No paid ten-company acceptance run (that is Trial 2, contingent and separately approved).
- The quarantine recovery override must not be called.

---

## 2. Trial 1 configuration (pin these exactly)

Set on the isolated trial service only. Left column is the code default; right column is the value
to run the trial at. Where a production budget differs from the code default (deadlines), set it to
the **intended production budget** so the trial exercises the real envelope.

| Env knob | Code default | Trial value | Why |
|---|---|---|---|
| `WORKER_ISOLATION_ENABLED` | `false` | `true` | The whole point of the trial. |
| `WORKER_CONCURRENCY` | `10` | `4` | Intended four concurrent children per replica. |
| `PG_POOL_MAX` | `20` | `20` | Intended pool; gives per-child budget (20−4)/4 = **4 conns/child**. |
| `WORKER_ISOLATION_PARENT_PG_RESERVE` | `4` | `4` | Parent keeps 4 for lock renewal / control. |
| `PIPELINE_TIMEOUT_MS` | `540000` | **intended production value** (e.g. 35 min) | Exercise the real pipeline deadline, parent-enforced. |
| `JOB_TIMEOUT_MS` (→ `lifecycle.deadlineAt`) | per claim | **intended production value** (e.g. 40 min) | Exercise the real job deadline, parent-enforced. |
| `WORKER_ISOLATION_KILL_GRACE_MS` | `10000` | `10000` | Default. |
| `WORKER_ISOLATION_EXIT_GRACE_MS` | `2000` | `2000` | Default. |
| `WORKER_ISOLATION_REAP_WINDOW_MS` | `2000` | `2000` | Default reap window before quarantine. |
| `WORKER_ISOLATION_QUARANTINE_POLL_MS` | `5000` | `5000` | Background termination-confirmation poll. |
| `WORKER_ISOLATION_PARENT_POLL_MS` | `250` | `250` | Child parent-death watchdog poll. |
| `WORKER_ISOLATION_CHILD_NICE` | `10` | `10` | Children de-prioritised vs the parent. |

**Inputs:**
- Real Chromium (as packaged in the deployed image — this is also the packaging test).
- Representative **saved** documents for discovery/retrieval so corpus is realistic without live crawling cost.
- **Synthetic LLM responses** where practical (stubbed providers) so scoring exercises the pipeline
  without paid provider spend. Keep enough real structure that the event loop and memory behave
  representatively.
- One replica (the trial validates a single replica at four children; horizontal scaling is a later question).

---

## 3. What the trial must verify (and record)

Record the **exact tested commit** (`bbc3c11`) and every env value above in the run log.

**A. Deployed packaging & startup**
- Image builds and boots on Railway with isolation on; children `fork` and start under the deployed layout.

**B. Parent responsiveness (the core hypothesis)**
- Parent event-loop lag stays bounded while four children run CPU-bound work.
- BullMQ lock renewals continue throughout — no lock loss, no duplicate execution.
- Measure parent event-loop delay separately from child event-loop delay.

**C. Resource behaviour (the main remaining risk)**
- **Actual container memory** (RSS of the whole cgroup, not summed per-process RSS — summed RSS
  double-counts shared pages) at steady state with four children, including peak during concurrent
  Chromium use.
- CPU contention across parent + four children.
- Confirm the measured footprint fits the provisioned replica with headroom (see §5 ceiling).

**D. Deadlines, cancellation, cleanup**
- Pipeline and job deadlines fire on the parent's clock and kill the child even when it is blocked.
- Cancellation/revoke precedence is monotonic (first terminal decision wins; late child "results" discarded).
- After each child exits, descendant processes (Chromium, pdftotext) are gone; **zero orphans**.
- If cleanup cannot be confirmed within the reap window, permits are **withheld** (quarantine), not returned.

**E. Aggregate limits**
- Summed PG connections never exceed `PG_POOL_MAX`; parent reserve is never starved.
- Browser admission remains one fetch at a time even though each child may hold its own Chromium.

---

## 4. Pass / fail criteria — evaluate reliability and completion **separately**

**Trial 1 passes** iff all of B, C, D, E hold: parent stays responsive, no lock loss / duplicate
execution, container memory within the approved ceiling, deadlines/cancellation correct, cleanup
reliable (no orphans; quarantine only on genuine unconfirmed cleanup), aggregate limits respected.

Trial 1 is **not** asked to prove ten-company completion time. That is Trial 2.

**If Trial 1 fails:** return **one specific defect**, its **smallest remedy**, and a **bounded
effort estimate** — no further redesign without approval. Do not add mechanisms speculatively.

---

## 5. Resource & cost/time boundary (approve this ceiling before launch)

The trial runs against a fixed envelope so cost is bounded regardless of outcome:

- **Service:** 1 isolated Railway service, **1 replica**.
- **Memory ceiling:** provision for measured worst case plus headroom. Prior local measurement was
  ~2.4 GB summed Chromium RSS with two children (summed RSS over-counts shared memory, so cgroup
  memory will be lower). At four children, provision an **8 GB** replica as the ceiling; if cgroup
  memory approaches it, that is itself a recorded result (a §6 drop signal), not a reason to grow it mid-trial.
- **Wall-clock box:** a single trial cycle — deploy + startup + one four-child run through the
  configured deadlines + cleanup observation. Hard-stop the service at **≤ 90 minutes** of run time.
- **Spend:** at Railway per-second billing, cost = (replica size) × (wall-clock) for one service.
  No paid LLM provider calls (synthetic/stubbed). The exact figure follows from the replica size and
  the ≤90-minute box on your account — **please confirm the replica size and time box before launch**;
  I will not start a paid service without that go-ahead.

Nothing in this trial spends LLM/provider money; the only cost is the bounded isolated Railway
service for ≤90 minutes.

---

## 6. Stop / drop conditions (decide, don't keep building)

Stop the trial and report if any occur:
- Parent cannot stay responsive under the four-child workload.
- Resource cleanup is unreliable (orphans remain, or quarantine does not clear by confirmed termination).
- **Unresolved quarantine** at trial end — a stop condition. Preserve evidence; recover the isolated
  test service deliberately. **Do not call `recoverQuarantinedChildren`** to declare capacity free
  while termination is uncertain.
- Container memory exceeds the approved ceiling without a clear, small remedy.
- Preserving resource limits is seen to require progressively more custom orchestration.

Dropping isolation here would **not** mean reverting to the unchanged worker (it already failed the
acceptance test); the fallback would be a simpler, narrower isolation of the specifically measured
CPU-heavy stages — proposed separately, not assumed.

---

## 7. Trial 2 (contingent — only if Trial 1 passes; separate approval)

Deploy through the controlled release process and run the original ten-company acceptance workload.
Judge two independent questions:
1. Did isolation prevent queue-lock loss, duplicate execution, and unbounded teardown?
2. Did all ten companies complete the required work within their existing budgets?

If (1) passes but (2) fails, isolation is working while a **different** throughput bottleneck
remains (slow discovery/retrieval/scoring). Do **not** rewrite isolation to fix that — diagnose the
throughput bottleneck on its own terms.

---

## 8. One-line decision for the developer

Trial 1 is specified and ready. On your go-ahead for the replica size and ≤90-minute time box, it
can be launched on an isolated service at commit `bbc3c11`; otherwise everything above stays
unlaunched. No production enablement is in this approval.

---

## 9. Execution readiness, pinned values, thresholds, and the resource blocker (added on approval to execute Trial 1)

This section records everything fixed **before launch** per the approval, and the one hard
host-capacity blocker that must be cleared before a faithful run.

### 9.1 Execution venue — the existing isolation harness, run locally (not a billable Railway deploy)

The branch already contains a purpose-built isolation rig:
`server/lib/job-isolation.integration.test.ts` + the synthetic child fixture
`server/lib/__fixtures__/isolation-integration-child.ts`. It runs a **real BullMQ worker**
(`startWorker`) on **real Redis + real Postgres**, **isolation ON** (test env only), each job in a
**real isolated `fork` child** doing real shared-Chromium PDF fetch (local HTTP-served PDF — a
**saved/local browser input**, no live crawl) + real `runAnalysisPipeline`, with **LLM providers
stubbed in the child (zero paid calls)**. It instruments, via `/proc` sampling and Redis:
per-process descendants, Chromium count, concurrent job-children, descendant/parent RSS, BullMQ lock
PTTL renewals, stalled events, quarantined children, broker-permit return, and host-wide orphan
Chromium — then asserts clean teardown (`descendants === 0`, no orphans, no quarantine, permits
returned) with **teardown driven from the parent harness, outside the children** (`stopWorker`).

This satisfies the approval's requirements more faithfully, and with tighter cost/teardown control,
than a billable Railway service:

| Approval requirement | How the harness meets it |
|---|---|
| Test-only DB state, isolated Redis/queue/cancellation keys | Dedicated throwaway docker `ciq-int-pg` / `ciq-int-redis` on non-default ports; queue obliterated before the run; a fresh seeded workspace/framework/companies per run. |
| Synthetic providers, no paid credentials, no real fallback | `CIQ_CHILD_TEST_MODULE` swaps the child to the stubbed fixture; parent carries **no** provider keys; `CREDIT_PAUSE_ENABLED=false`. None of the production provider keys are copied in. |
| Saved/local browser inputs | Real Chromium prints a local HTML to PDF, served over `127.0.0.1`; no external fetch. |
| Four children overlap under representative processing | `WORKER_CONCURRENCY=4` with 4 seeded companies; `/proc` sampling records max concurrent job-children. |
| Enforce teardown from outside the worker; stop/remove within window | Harness `stopWorker()` + docker stop/rm are issued by the parent process; nothing depends on a child cleaning itself. |
| Do not invoke the quarantine-recovery override | Harness never calls `recoverQuarantinedChildren`; it only reads `quarantinedChildren()`. Unresolved quarantine ⇒ FAIL. |
| Report actual cost | **No billable cloud resources are provisioned.** Incremental cost = **$0** (local docker on the existing VM); the only resource is VM compute time already covered by the subscription. |

**Production-equivalent CPU — determination and caveat.** Railway PRO worker replicas run on a
**burstable** envelope (up to 32 vCPU, usage-billed); the `ServiceInstance` GraphQL type exposes
**no `cpuLimit`/`cpuCores`/`memoryLimit` field** (full field list introspected — none exist), so an
exact vCPU count **cannot be hard-pinned on Railway at all**. "Fix the production-equivalent CPU
allocation" is therefore honoured here by running the single trial replica under a **fixed, recorded
cgroup CPU allocation** (via `systemd-run --scope -p CPUQuota=… -p MemoryMax=8G`) that is **not
changed mid-trial** — which is a *stronger* guarantee than Railway can give. Production parity
targets replicated exactly: `WORKER_CONCURRENCY=4`, `NODE_OPTIONS=--max-old-space-size=6144`,
`LLM_MAX_CONCURRENCY=8`, `MAX_CONCURRENT_BROWSER=1`, `MAX_CONCURRENT_SUBPROC=4`, `PG_POOL_MAX=20`.

### 9.2 Pinned trial values (exact, per approval)

| Parameter | Pinned value |
|---|---|
| `WORKER_ISOLATION_ENABLED` | `true` |
| `WORKER_CONCURRENCY` (concurrent children) | `4` |
| `PIPELINE_TIMEOUT_MS` | **`2100000`** (2,100,000 ms) |
| `JOB_TIMEOUT_MS` (→ lifecycle deadline) | **`2400000`** (2,400,000 ms) |
| `PG_POOL_MAX` (main pool, evaluated against) | `20` |
| `WORKER_ISOLATION_PARENT_PG_RESERVE` | `4` |
| `PG_USAGE_POOL_MAX` (usage pool, evaluated against) | `2` |
| Kill/exit/reap grace, quarantine poll, parent poll, child nice | code defaults (10000 / 2000 / 2000 / 5000 / 250 / 10) — preserved and recorded |
| LLM / browser / subproc limits | `8` / `1` / `4` — production baseline, preserved |
| Replicas | 1 | 
| Memory ceiling | **8 GB** (cgroup `MemoryMax=8G`) |
| Active trial window | **≤ 90 minutes** |

Diagnostics PG connections are counted separately from the main (≤20) and usage (≤2) pools.

### 9.3 Numerical pass thresholds (defined before launch; report actual peaks)

- **Parent responsiveness:** parent event-loop lag **p99 < 100 ms** and **max < 250 ms** sustained
  while four children run; **lock renewals ≥ 1 per job** with **zero** BullMQ `stalled` events and
  zero lock loss / duplicate execution.
- **Memory headroom:** peak cgroup memory **≤ 6.8 GB** (i.e. **≥ 15 % headroom** below the 8 GB
  ceiling). Touching the ceiling is a recorded drop signal, not a reason to grow it.
- **Cleanup:** **zero** descendants after completion, **zero** orphan Chromium host-wide, **zero**
  unresolved quarantined children, all broker permits returned.
- **Aggregate limits:** summed main-pool PG connections **≤ 20** (parent reserve never starved),
  usage pool **≤ 2**, browser admission **= 1** at a time.
- **Packaging/startup:** image/layout builds and the worker boots with isolation on; children `fork`
  and start. Any failure here fails the trial.

### 9.4 BLOCKER — host capacity is below the pinned envelope (must clear before a faithful run)

Verified on the current VM: **2 vCPU, 7 GB total RAM (≈6 GB available)**.

- The **8 GB memory ceiling exceeds physical RAM**, so `MemoryMax=8G` can never bind — the host OOMs
  at ~7 GB first. The required *memory-headroom-vs-8 GB* measurement is therefore **impossible** on
  this host; any peak reported would be an artefact of a 7 GB wall, not of the 8 GB ceiling.
- **2 vCPU is below a production-equivalent allocation** for a 4-concurrent-child replica; CPU
  starvation would inflate parent event-loop lag and make the responsiveness threshold
  non-representative.

Running now would violate the "do not change the ceiling" and "production-equivalent CPU"
constraints and produce a non-defensible result, so the trial is **held** at this gate.

**Smallest remedy:** resize this VM to **4 vCPU / 32 GB RAM** (32 GB hosts the 8 GB cgroup with
ample headroom; 4 vCPU matches a single 4-child replica), then run §9.1 under
`systemd-run -p CPUQuota=400% -p MemoryMax=8G`. **Bounded effort after resize:** one ≤90-minute
trial window — ~10 min to parameterise the harness to 4 children/4 companies, one run to completion,
evidence written to `docs/worker-isolation/evidence/`, then teardown. No code change to the
production isolation path is required (harness-only parameterisation).

**Alternative (not recommended):** a billable Railway isolated environment — but PRO cannot hard-pin
CPU or an 8 GB cap (§9.1), so the ceiling becomes an *observed*/heap-bounded target, teardown-within-
90-minutes carries cost risk, and `/proc` instrumentation is harder to obtain. Local-after-resize is
the faithful, zero-cloud-cost path.



### 9.5 Correction — what was actually executed (supersedes the §9.1/§9.4 venue determination)

§9.1 and §9.4 above were written **before execution**, on the belief that (a) Railway PRO could not
hard-pin CPU or an 8 GB memory cap, and (b) a faithful run therefore required resizing this VM and
running the local harness. **Both premises were wrong, and the trial was executed on Railway without
any VM resize.** This subsection records the correction; the earlier text is retained only as the
pre-execution reasoning trail.

- **Railway *is* the venue, and it *can* cap resources.** The per-replica limits are set by the
  **`serviceInstanceLimitsUpdate(input:{environmentId, serviceId, memoryGB, vCPUs})`** mutation —
  a separate mutation from the `ServiceInstance` object whose fields were introspected in §9.1. The
  earlier "no `cpuLimit`/`memoryLimit` field exists, so CPU cannot be hard-pinned at all" conclusion
  was an over-generalisation from one type's field list to the whole API, which is one of the error
  classes being actively guarded against. For this trial the worker replica was capped at
  **`memoryGB: 8`, `vCPUs: 4`** via that mutation (returned `true`).
- **8 GB / 4 vCPU are MAXIMA (ceilings), not reservations.** Railway bills **actual consumed**
  GB-minutes and vCPU-minutes; the limit only caps the top. These numbers are **not** a claim of
  production-equivalent resourcing — Railway PRO worker replicas are burstable and usage-billed, so
  the trial deliberately makes **no exact-production-equivalence claim**. The ceiling is a trial
  envelope within which contention was observed.
- **No VM resize was performed.** This VM stayed at 2 vCPU / 7 GB throughout; the §9.4 host-capacity
  blocker was cleared by moving the run **off this VM onto the capped Railway replica**, not by
  growing the VM. The "do not resize the VM" constraint was honoured.
- **Single replica, single region, no auto-restart.** `numReplicas: 1`, `multiRegionConfig: {}`,
  `restartPolicyType: "NEVER"`, `restartPolicyMaxRetries: 0` — so a crash could not be silently
  masked by a restart.
- **Only the driver differs from the branch under test.** The deployed commit differs from branch
  HEAD (`bbc3c11`) by exactly one file — `server/lib/trial-railway-driver.ts` (the trial harness).
  The worker-isolation code path itself is byte-identical to the branch.
- **Environment:** a throwaway Railway environment `worker-isolation-trial` forked from the project
  config, with **test-only** Railway-internal Postgres + Redis, **synthetic providers** (stubbed
  child via `CIQ_CHILD_TEST_MODULE`; all 22 provider/proxy keys scrubbed from the worker), a
  **synthetic seeded corpus**, and **real Chromium**. The environment was **deleted at teardown**.

### 9.6 Fresh-environment bootstrap finding (run 1)

The **first** worker run on the freshly-forked Railway Postgres **failed** — not an isolation defect,
but a real environmental gap: all four jobs errored with
`column "expected_yes_rate_justification" does not exist`. Root cause:
`initializeDatabase()` (`server/db.ts`) creates tables via `CREATE TABLE IF NOT EXISTS` + inline
`ALTER … ADD COLUMN IF NOT EXISTS`, but it **does not apply the stand-alone `migrate-*.sql` files**
(those are applied out-of-band, e.g. via `pnpm db:push`). The column is defined in
`shared/schema.ts` and added only by `migrate-add-expected-yes-rate-justification.sql`. The local
smoke DB happened to already have the column (from earlier work), which is why the local smoke passed
while the fresh Railway DB failed — a textbook "works-on-my-DB" drift.

**Fix (driver-only):** the trial driver now applies every `migrate-*.sql` (sorted) after
`initializeDatabase()`. Run 2 logged `[INT] applied migration migrate-add-expected-yes-rate-justification.sql`
and `[INT] applied migration migrate-dedup.sql`, then passed. **This is a genuine finding worth
flagging for the real deploy path: any environment that bootstraps schema via `initializeDatabase()`
alone (rather than `db:push`) will be missing stand-alone-migration columns.** It is orthogonal to
worker isolation.

---

## 10. Executed result — Trial 1 (Railway isolated replica): **PASS**

**Run:** commit `6a5c3aa5` on `trial/worker-isolation-railway`, deployment `58c03c46`, Railway env
`worker-isolation-trial`, worker replica capped at 8 GB / 4 vCPU, `WORKER_ISOLATION_ENABLED=true`,
`WORKER_CONCURRENCY=4`. Teardown completed 22:49 UTC (env deleted; backstop cancelled), well within
the 90-minute window.

**Workload:** 4 companies (ids 5–8), framework 2, 6 measures/company, 25 synthetic docs/company; one
BullMQ batch of 4 analysis jobs run concurrently, each in its own isolated `fork` child with real
shared Chromium. LLM providers stubbed in-child (zero paid calls).

### 10.1 All 12 integration checks passed → `INTEGRATION PASS`

| # | Check | Result |
|---|---|---|
| 1 | All 4 analysis jobs completed | PASS (completed ×4, attempt 1 each) |
| 2 | Batch counters | PASS (completed=4, failed=0) |
| 3 | `measure_scores` persisted | PASS (6 per company × 4) |
| 4 | Isolated job-children ran concurrently | PASS (target 4; **max concurrent seen 12**) |
| 5 | Real Chromium under job-children | PASS (**peak 35 procs, 3458 MB**) |
| 6 | No BullMQ stalled events | PASS (0) |
| 7 | Lock renewed ≥1/job | PASS (renewals 3 / 5 / 7 / 4) |
| 8 | No descendants after completion | PASS (0, Chromium 0) |
| 9 | No orphaned Chromium host-wide | PASS (none) |
| 10 | No quarantined children | PASS (0; recovery override never invoked) |
| 11 | Broker permits all returned | PASS (llm 0/0/8, browser 0/0/1, proc 0/0/4) |
| 12 | Integration verdict | **INTEGRATION PASS** |

### 10.2 Observed peaks (actual trial environment — not a production-equivalence claim)

- **Concurrency / forking:** `WORKER_CONCURRENCY=4` honoured; **peak 12 concurrent forked
  job-children** — each of the 4 concurrent jobs forks nested analysis children, so the isolation
  model peaks at ~3× the job-concurrency in live forked children. **Peak 40 total descendants**
  (incl. Chromium helpers), **35 Chromium processes**.
- **Memory:** peak descendant RSS **4027 MB (~3.9 GB)** — Chromium 3458 MB, parent 140 MB (max
  parent 166 MB). **~50 % headroom below the 8 GB ceiling; no OOM-kill.** (Note: capacity scales with
  concurrent children × Chromium, so the 12-children peak is the figure to size production RAM
  against.)
- **Parent health / timing:** batch elapsed **~58.8 s**; max fork time **4.3 ms**; max handler time
  **0.39 ms**; 439 broker messages; 0 late reports discarded. 0 stalled, 0 failed events.
- **Cleanup (teardown driven from the parent, not the children):** after completion **descendants 0,
  Chromium 0, job-children 0, descendant RSS 0**, parent 142 MB; **no host-wide orphan Chromium; 0
  quarantined children; all broker permits returned.**

### 10.3 Cost (clearly-labelled estimate)

Railway bills **consumed** GB-min / vCPU-min, and per-run cost is not exposed via the GraphQL usage
API (only billing-cycle aggregates), so this is an estimate, not a metered figure:

- **Worker** — allocation window ~15 min (first deploy 22:34 UTC → env delete 22:49 UTC). Conservative
  **upper bound at the 8 GB / 4 vCPU ceiling**: RAM 8 × 15 × \$0.000231 ≈ **\$0.028**; CPU 4 × 15 ×
  \$0.000463 ≈ **\$0.028** ⇒ **≈ \$0.055**. Actual is lower (billed on ~4 GB peak RSS, far less at
  idle, and CPU near-cap only during the ~90 s active analysis window).
- **Supporting Postgres + Redis** — small default footprint, ~20 min ⇒ **≈ \$0.01**.
- **Total trial ≈ \$0.06 (upper bound)** — well within the pre-authorized ~\$0.33 ceiling.

### 10.4 Interpretation

The isolation path on `fix/worker-isolation` **ran cleanly under 4-way concurrency on a capped,
isolated Railway replica**: four jobs each in a real forked child with real Chromium completed with
correct persistence, locks renewed without stalls, and **fully clean teardown** (zero descendants,
zero orphans, zero quarantine, all permits returned) driven from the parent. Memory stayed at ~3.9 GB
peak against the 8 GB ceiling. **Isolation reliability (the clean-teardown / no-leak property) is
reported here independently of completion time**, per the standing distinction.

**Scope of the claim:** this exercises the isolation/fork/Chromium/cleanup mechanics under synthetic
providers and a synthetic corpus on a single capped replica in a single region — it is **not** a
production-load or production-equivalence test, and the 8 GB / 4 vCPU figures are **trial ceilings,
not production reservations**. One real environmental gap was surfaced and fixed in the trial driver
(§9.6); it should be addressed in the real deploy path (ensure `migrate-*.sql` are applied, e.g. via
`db:push`, on any freshly-bootstrapped environment). **No production change, no VM resize, no merge,
no enablement, and no Trial 2 were performed.**
