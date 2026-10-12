# CompanyIQ-v3: Production Deployment Verification (fix 9a1b931)

**Date:** 2026-10-12 (UTC)
**Scope:** deployment and verification only. **No run was launched.** There was no POST to `/api/admin/resume-analysis`, no batch was enqueued, and nothing was written to the production DB.
**Railway:** project `db04e5b1-416b-4335-b3bc-056dd81e5bbf`, environment **production** `c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b`. The sprint-10-preview environment (`6987d716-…`) was not touched.
**Services:** app `66371757-60e9-4da3-bdf1-b3d2ea96544f`, worker `27920e1f-3835-44be-98ac-2a40a43678cf`.

## 1. Pre-deploy gates (read-only)

### 1a. Production queue idle: PASS
All queries ran against `companyiq_v3` in a session with `default_transaction_read_only = on` and `statement_timeout = 15s`. The connection URL was loaded from the Railway API into an env var and never printed.

| Query | Result |
|---|---|
| `batch_runs` by status | cancelled 333 · completed 932 · pending_review 9 · **running/active: 0** |
| `analysis_jobs` by status | cancelled 5307 · completed 49472 · failed 41681 |
| `count(*) analysis_jobs WHERE status NOT IN ('completed','failed','cancelled')` | **0** |
| `count(*) batch_runs WHERE status NOT IN ('completed','cancelled','pending_review')` | **0** |
| Latest batch | 1276 (`pending_review`, last heartbeat 2026-10-12 02:18:03, about 14 h before the deploy) |
| Latest `analysis_jobs.created_at` | 2026-10-12 01:24:46 (DB `now()` was 16:40:48) |

`pending_review` is a terminal, awaiting-human-review status that the reconciler sets (`server/reconciler.ts`). No work is attached to it. The 9 batches in that status are 1211, 1219, 1221, 1244, 1248, 1249, 1255, 1261 and 1276.

The same checks were re-run after the env change: 0 non-terminal jobs, 0 active batches, and max batch id still 1276. **No new batch was created.**

### 1b. Rollback target: PASS
Before the deploy, both app and worker production deployments were `SUCCESS` on `b676c2ddf37512dad0e18c6e812a4dc7e58a12a2` (branch `main`, repo `ahow/companyiq-v3`).

### 1c. No trial settings: PASS
There were zero keys matching `DIAG|FAULT|TRIAL|SYNTH|STUB|TEST` on the app (45 keys) or the worker (68 keys). This was re-checked after the change and is still zero on both.

## 2. Repository: merge into `main`
- Both Railway services deploy from `ahow/companyiq-v3`, branch `main`. Before the merge, origin/main = `b676c2d`.
- A normal `--no-ff` merge of `fix/browser-lifetime-and-stop-rule` (head `c86787b`) produced:
  **new main = `8c03b07449701a7fb83dc062abbfe6726cf7c208`** (parents `b676c2d`, `c86787b`). There was no history rewrite.
- `git push origin HEAD:main` updated `b676c2d..8c03b07`.

### Tree-equivalence proof (run on the local merge commit BEFORE pushing)
```
$ git diff --stat 9a1b931 8c03b07 -- server shared client package.json package-lock.json pnpm-lock.yaml \
    'tsconfig*.json' Dockerfile Procfile railway.json railway.toml nixpacks.toml 'vite.config.*' \
    'drizzle.config.*' scripts .dockerignore
(empty)
$ git diff --stat 9a1b931 8c03b07 -- . ':!deliverables' ':!docs'
(empty)
$ git diff --stat c86787b 8c03b07
(empty)            # tree 27522e3e… identical to the fix-branch head
$ git diff --name-only 9a1b931 8c03b07 | cut -d/ -f1 | sort | uniq -c
     36 deliverables   # review documents only; no runtime path differs
```
**Result:** the runtime tree of `8c03b07` is identical to `9a1b931`.

## 3. Build verification: PASS
| Service | Deployment | Status | Commit |
|---|---|---|---|
| app | `d54446bb-c3d4-49ba-84a3-db157d589ff9` | SUCCESS | `8c03b07449701a7fb83dc062abbfe6726cf7c208` |
| worker (code deploy) | `0ca4cae3-af5f-4206-ad88-d4e1441adf42` | SUCCESS, then REMOVED (superseded by the env-change redeploy below) | `8c03b07…` |
| worker (after env change) | `18a827b7-a02e-46de-9ad4-f0d9578d90c9` | **SUCCESS (current)** | `8c03b07449701a7fb83dc062abbfe6726cf7c208` |

The app root URL returned HTTP 200 after the deploy. Between the code deploy and the env change, the env hashes for both services matched the pre-deploy snapshot exactly.

## 4. Env change (the only one)
`variableUpsert` was run on the WORKER service only, in production: `BATCH_STOP_RULE_FAILED_JOBS=2`. It returned `true` at 16:45:29Z, and the redeploy `18a827b7` reached SUCCESS on `8c03b07`.

**Full env delta (per-key sha256 comparison, before vs after):**
| Service | Added | Removed | Changed |
|---|---|---|---|
| worker (68 → 69 keys) | `BATCH_STOP_RULE_FAILED_JOBS=2` | none | none |
| app (45 keys) | none | none | none |

**Post-change worker values:**
| Setting | Value |
|---|---|
| `WORKER_ISOLATION_ENABLED` | `true` |
| `WORKER_CONCURRENCY` | 4 |
| `ADAPTIVE_CONCURRENCY_ENABLED` | `true` |
| `MAX_CONCURRENT_BROWSER` | 1 |
| `WORKER_LOCK_DURATION_MS` | 300000 |
| `WORKER_STALLED_INTERVAL_MS` | 120000 |
| `numReplicas` | 3 |

Nothing else changed: replicas, concurrency, memory, timeouts, pool and runtime are all as they were.

## 5. Rollback procedure
- **Rollback target:** `b676c2ddf37512dad0e18c6e812a4dc7e58a12a2`.
  1. In Railway → production, redeploy `b676c2d` on both the **app** and the **worker**: use the deployment history entries (`685e905a…` for the app, `cf79e5a7…` for the worker) and choose "Redeploy". Alternatively, push a `git revert -m 1 8c03b07` to `main`.
  2. Delete `BATCH_STOP_RULE_FAILED_JOBS` from the worker. It is opt-in, and with it unset the stop rule is disabled. Leave `WORKER_ISOLATION_ENABLED=true`.
  3. Confirm both services show SUCCESS on `b676c2d` and that the env matches the pre-deploy snapshot.

## 6. Statements
- **No run was launched.** There was no resume-analysis call and no enqueue, and no batch was created (max id is still 1276).
- No trial, diagnostic or fault keys are present on the app or the worker.
- The production DB was accessed read-only. The hosted `default` DB was not touched.
- This report is committed to `fix/browser-lifetime-and-stop-rule` only, not to `main`, so that it does not trigger another production auto-deploy. Production stays on `8c03b07`.
