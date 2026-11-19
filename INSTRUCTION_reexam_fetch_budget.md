# Instruction — longer fetch-phase budget on re-examine / re-run only

**Goal.** Give re-queued jobs (re-examine of failures, and the low-retrieval "Re-run")
a longer per-company fetch-phase budget than first-pass batch jobs, so companies whose
own filings are large/slow (e.g. NVR, 59/92 fetched, 19 docs killed with
`budget_exceeded` on its slow IR host) get their primaries in on the second attempt —
**without** slowing the first-pass 50-company batch or worsening the 55-min job
watchdog timeouts.

**Why not just raise the global budget.** `FETCH_PHASE_BUDGET_MS` is one global env var
applied to every company. Prod currently runs it at **20 min** (1,200,000 ms; code
default is 6 min). Raising it globally slows all 50 companies on the first pass (most
don't need it) and pushes more of them into the 55-min `JOB_TIMEOUT_MS` watchdog under
worker contention — which is exactly what timed out Adani/Haier/JPX/UniCredit the first
time. The headroom is only needed on the second iteration, where the company runs alone
with far less contention and the fetch-cache means a re-run only re-fetches the handful
of dead docs.

---

## Code change (repo `companyiq-v3`, branch `main` → Railway prod)

All references are in `server/`.

**1. New env var, beside the existing one.** `server/lib/pipeline.ts:104`
```ts
const FETCH_PHASE_BUDGET_MS = parseInt(process.env.FETCH_PHASE_BUDGET_MS || "360000", 10); // 6 min default; prod=1200000 (20 min)
// NEW — budget used only for re-examine / re-run jobs:
const FETCH_PHASE_BUDGET_RECHECK_MS = parseInt(process.env.FETCH_PHASE_BUDGET_RECHECK_MS || "2700000", 10); // 45 min
```
Keep it under `JOB_TIMEOUT_MS` (55 min) so the job watchdog is never the thing that fires.

**2. Thread a recheck flag through the job payload.** It already carries `skipFetch`.
- `server/storage.ts` `enqueueReexamination` (~L2380) — the queue payload is
  `{ jobId, companyId, frameworkId, batchId, workspaceId, skipFetch: false }`. Add
  `recheck: true`.
- `server/worker.ts:272` — destructure `recheck` from `job.data` alongside `skipFetch`.
- `server/worker.ts:~517` — pass `recheck` into the `runAnalysisPipeline({...})` call,
  next to `skipFetch, skipDiscovery, sourceBatchId`.
- `server/lib/pipeline.ts` `PipelineOptions` (~L155, where `skipFetch?`/`skipDiscovery?`
  are declared) — add `recheck?: boolean;`.

**3. Use one effective budget everywhere.** Inside `runAnalysisPipeline`
(`server/lib/pipeline.ts:3813`), right after `fetchPhaseStart` is set (~L404), compute:
```ts
const effectiveFetchBudgetMs = opts.recheck ? FETCH_PHASE_BUDGET_RECHECK_MS : FETCH_PHASE_BUDGET_MS;
```
Then replace the **direct** `FETCH_PHASE_BUDGET_MS` reads in the fetch path with
`effectiveFetchBudgetMs`: lines **1151, 1261, 1587, 2078**, and the default param at
**355** (pass it explicitly from the caller). Do a final
`grep -n FETCH_PHASE_BUDGET_MS server/lib/pipeline.ts` and confirm the only remaining
raw references are the two `const` definitions and comments — every runtime check must
read `effectiveFetchBudgetMs`.

**4. Set the env var in prod.** Railway → project `db04e5b1…` → **PROD env
`c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b`** → **worker service `27920e1f…`** →
`FETCH_PHASE_BUDGET_RECHECK_MS=2700000`. (Leave `FETCH_PHASE_BUDGET_MS=1200000` as-is.)
Do **not** touch the preview env.

**No schema/migration needed** — `recheck` rides in the BullMQ payload, not the DB.

---

## Operational use after it ships

- **NVR and the other low-retrieval companies:** use the dashboard **"Re-run all" /
  "Re-run"** on the Low Retrieval Rate banner. That hits
  `POST /api/diagnostics/low-discovery/rerun` → `enqueueReexamination` per company, which
  now carries `recheck:true` → 45-min fetch budget, and only re-fetches the ~19 dead docs
  (successful `ok` docs are preserved by `clearDiscoveredDocuments`). Non-destructive and
  idempotent (dedup guard already prevents duplicate re-exam batches).
- **Hyundai Glovis is NOT fixed by this.** Its failure is a discovery / entity-matching
  gap — the only primary the gate accepted was a mis-identified Norwegian government
  "Annual Report" (regjeringen.no), and its real Korean annual/sustainability report was
  never discovered or was gate-rejected. More clock won't find a document that discovery
  never surfaced. Track that separately (discovery query / entity-disambiguation work).

## Acceptance check
Re-run NVR after deploy; expect fetch ratio to rise above 70% (its own-host primaries —
10-K, DEF 14A, annual reports — fetch instead of being cut), the "Low Retrieval Rate"
flag to clear, and the score to move off 3%. Confirm first-pass full-list batches are
unchanged (still 20-min budget) by inspecting a fresh non-recovery job's logs.
