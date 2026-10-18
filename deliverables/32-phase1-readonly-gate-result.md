# Phase 1 — Read-Only Production Prerequisite Gate: PASS

**Date:** 2026-10-12 · **Candidate:** `b676c2d` (branch `trial/worker-isolation-railway`, pushed to origin)
**Production current commit:** `35884ee` (branch `main`) · **Scope:** read-only live queries against production DB + Railway API + git. No migrations, dedup, backfills, db:push, or code changes were run.

## Verdict

**PASS — no prerequisite is missing.** The earlier *source-level* migration-inventory concern (that production might lack a required column / dedup infrastructure) is **REFUTED by live production data**. Every item the controlled-release approval required to be verified has been confirmed against the running production system, not inferred from source files.

## Evidence (all ESTABLISHED via live queries / git — none inferred)

| # | Check | Method | Result |
|---|-------|--------|--------|
| 1 | `framework_measures.expected_yes_rate_justification` column present | live `information_schema` query on prod DB | **EXISTS (text).** `migrate-add-expected-yes-rate-justification.sql` effect already applied in prod. No remedy needed. |
| 2 | Dedup / `document_content` infrastructure | live prod query | Table present, **339,293 rows**; unique index `document_content_url_hash_key`; `documents.content_id` linkage present (6,663 documents). Present & populated. Not an isolation prerequisite. |
| 3 | Exact production release commit | Railway worker deployment meta | **`35884ee` on `main`**, SUCCESS, 2026-10-11 12:23Z, repo `ahow/companyiq-v3`. `origin/main == 35884ee`. |
| 4 | Candidate ↔ production relationship | git | Prod `35884ee` IS the merge-base and an ancestor of candidate `b676c2d`. Candidate = prod **+ 11 linear commits** (clean fast-forward superset; no production fix regressed). |
| 5 | Runtime / build equivalence to the successful trial | git diff prod→candidate | **No change** to `Dockerfile`, `package.json`, `pnpm-lock.yaml`, `railway.json`. Base `node:22-slim`; deploy `restartPolicyType ON_FAILURE`, maxRetries 10. |
| 6 | Isolation is strictly opt-in / inert when disabled | code read | `isolationEnabled()` = `WORKER_ISOLATION_ENABLED==='true'` (NOT set in prod → OFF). Child-only paths gated by `CIQ_ISOLATED_CHILD==='1'`. db.ts pool-partition gated by `CIQ_PROCESS_ROLE==='worker-parent' && flag`. Only ungated changes are two behaviour-preserving refactors (`isRetriableError` extracted verbatim; Cancelled-fencing → `fenceCancelledResult`). **No new boot migration / no DDL.** |
| 7 | Live production work state ("drain existing work" scope) | live prod query | **IDLE** — 0 jobs created/progressed in last 2h; most recent activity 2026-10-11 14:54Z (~22h ago). 3 `pending` analysis_jobs belong to **CANCELLED** batches (dead orphans, never claimable). Drain scope ≈ nil. (BullMQ/Redis waiting set to be confirmed empty immediately before deploy.) |
| 8 | Production operating limits (to be preserved unchanged) | live worker env vars | WORKER_CONCURRENCY=4, LLM_MAX_CONCURRENCY=8, MAX_CONCURRENT_BROWSER=1, MAX_CONCURRENT_SUBPROC=4, ADAPTIVE_CONCURRENCY MIN=2, PG_POOL_MAX=20, NODE_OPTIONS=--max-old-space-size=6144, JOB_TIMEOUT_MS=2400000, PIPELINE_TIMEOUT_MS=2100000, SCORING_SELF_CONSISTENCY=3, SCORING_STRICT_PROVIDER=true. |

**Correction to the record:** the trial environment (`worker-isolation-trial-875b3923-…`) is now an **empty shell** — 0 service instances, 0 worker deployments; its compute was torn down after the trial, only the environment record persists. The successful trial's runtime equivalence is therefore established from the *build inputs* (item 5), which are byte-identical, not from a still-running trial container.

## Blocking decision required before any mutation

Production **worker and app both auto-deploy from `main`.** Deploying the validated candidate via the normal path means advancing `main` to `b676c2d`, which has two material side effects that need your explicit sanction:

- (a) It also **redeploys the APP service** (both services watch `main`), not only the worker. The app does not use isolation; a prod app restart is low-risk but widens the blast radius.
- (b) It **permanently merges the trial scaffolding + evidence docs + profiling scripts into `main` history** (all inert at runtime — the driver has no runtime importer, scripts are standalone, `*.test.ts` is not loaded).

### Options

- **Option A (recommended):** fast-forward `main` → `b676c2d`. Deploys the *exact* validated commit (strongest runtime equivalence). App also redeploys; scaffolding enters main history.
- **Option B:** cherry-pick only the 12 runtime files into one clean commit on `main`. Keeps main history clean, but produces a new tree that is **not** byte-identical to the validated commit (weaker equivalence). App still redeploys.
- **Option C:** Railway-deploy the worker only, without moving `main` (requires changing the worker service's deploy source/branch — a config change you asked me not to touch, and it diverges the worker from the app commit). Not recommended.

A write-capability check (git push/merge to `main`, and whether the Railway token may trigger deploy / set the env var) will be the first step after you choose — only read operations have been performed so far.
