# CompanyIQ-v3: Production Deployment Verification (candidate 6e09ced — HTML-path bounded in-flight interrupt)

**Date:** 2026-10-13 (UTC)
**Scope:** merge + deploy of the validated cancellation candidate only. **No run was launched; no extraction pipeline, paid-provider call, or live fetch was performed.** The only live HTTP calls made were read-only `GET /api/health` probes and read-only Railway GraphQL status queries.
**Authorization:** The user (Andy Howard) explicitly approved this merge and the consequent app + worker redeployments, and approved inclusion of inert trial scaffolding, tests and evidence in `main` history.

## 0. Summary of this deploy

| Item | Value |
|---|---|
| New `main` SHA (merge commit) | **`64d0b9d856ca72a7b34fa40d40b396106fa372e9`** |
| Merge parents | `8c03b07…` (old main) + `3c84ecf…` (feature tip) |
| Candidate code commit shipped | **`6e09ced4bf42d036c257cb35772335600215ff30`** (confirmed ancestor of new main) |
| Docs commit shipped | `3c84ecf400f8ecc459c87c4cb6dad8f89cb87f2f` |
| `origin/main` before | `8c03b07449701a7fb83dc062abbfe6726cf7c208` |
| `origin/main` after | `64d0b9d856ca72a7b34fa40d40b396106fa372e9` — **moved off 8c03b07: YES** |

## 1. Merge method and lineage (fast-forward was NOT possible)

`origin/main` (`8c03b07`) is **not** an ancestor of the feature tip (`3c84ecf`), so a fast-forward was impossible. `8c03b07` is itself a merge commit (parents `b676c2d` + `c86787b`); the feature branch is built on `c86787b`. A standard **`--no-ff` merge commit** was therefore created: `64d0b9d`.

### Runtime-equivalence check against the validated candidate (not build-file equality alone)
Performed on the merge result **before pushing**:
```
# Runtime source (server/ shared/ client/ Dockerfile package.json package-lock.json tsconfig.json):
$ git diff --cached --name-only 3c84ecf -- server/ shared/ client/ Dockerfile package.json package-lock.json tsconfig.json
(empty)   -> merged runtime source is BYTE-IDENTICAL to validated candidate 3c84ecf

# Full tree (any path):
$ git diff --cached --name-only 3c84ecf
(empty)   -> entire merged tree is identical to the validated candidate tip
```
Direct runtime-content checks on the merged `server/lib/processor.ts`:
- Contains the HTML-path fix (6e09ced): `installBoundedPageInterrupt` defined (`BROWSER_ABORT_GRACE_MS = 500`) and **wired at 3 call sites** (lines ~1506, ~2021, ~2298).
- Worker-isolation code preserved: `remoteAcquire`, `WORKER_ISOLATION_ENABLED` path, child close+reap all present.

### Credentials check: PASS
No production credentials in the shipped diff. The only matches were documentation comments in test files showing example invocation (`DATABASE_URL=<any pg url; not connected>` and a local dummy `postgres://ciq:ciq@127.0.0.1:55432/ciq`) — inert test scaffolding the user explicitly approved.

### Start/deploy commands: UNCHANGED
`git diff --cached --name-only origin/main -- railway.json Procfile Dockerfile package.json` returned empty. `Procfile` = `web: npx tsx server/index.ts`; `package.json` `start` = `tsx server/index.ts`; `railway.json` builder = DOCKERFILE. None altered by this merge.

## 2. Push
```
$ git push origin main
   8c03b07..64d0b9d  main -> main
$ git ls-remote origin refs/heads/main
64d0b9d856ca72a7b34fa40d40b396106fa372e9  refs/heads/main
```

## 3. Deployment mechanism (discovered, not assumed)
**Railway git-integration auto-deploy** on push to `main`. Evidence:
- `railway.json` present with `"builder": "DOCKERFILE"` and `dockerBuildArgs.CACHEBUST = ${{RAILWAY_GIT_COMMIT_SHA}}`. No GitHub Actions workflow exists (`.github/workflows` absent). No manual CLI deploy was run.
- Project `companyiq-v3` (`db04e5b1-416b-4335-b3bc-056dd81e5bbf`), production env `c1166ef6-…`. Both `app` (`66371757-…`) and `worker` (`27920e1f-…`) deploy from branch `main`.
- **The push itself was the deploy trigger.** Within seconds of the push, Railway created new BUILDING deployments on both services carrying `branch=main, sha=64d0b9d` — no deploy command was issued by this task.

## 4. Deployment verification (every actual instance)
Queried via Railway GraphQL (`backboard.railway.app/graphql/v2`, read-only), polled to terminal state:

| Service | Deployment | Final status | Built commit (platform-reported) |
|---|---|---|---|
| app | `4195f8f0` | **SUCCESS (current)** | `64d0b9d856ca…` |
| worker | `44a213a4` | **SUCCESS (current)** | `64d0b9d856ca…` |

The prior `8c03b07` deployments (app `d54446bb`, worker `18a827b7`) are now **REMOVED** — i.e. traffic is served by the new `64d0b9d` deployments, not the old ones. Redis/Postgres/pgbouncer services were untouched.

Live app response (read-only):
```
GET https://companyiq.online/api/health            -> HTTP 200 {"status":"ok","version":"3.0.0",...}
GET https://app-production-9929.up.railway.app/api/health -> HTTP 200 {"status":"ok","version":"3.0.0",...}
```

## 5. Verification level — honest statement of what IS and is NOT proven
- **Pushed:** PROVEN — `origin/main` = `64d0b9d`, off `8c03b07`.
- **Built / deployed:** PROVEN — Railway reports both `app` and `worker` production deployments SUCCESS, built from `sha=64d0b9d`, with the previous `8c03b07` deployments REMOVED.
- **Running app reachable:** PROVEN — `/api/health` returns HTTP 200 on both the custom domain and the Railway domain.
- **Running code verified to contain `6e09ced` by in-process introspection:** **NOT POSSIBLE from here.** `/api/health` reports a hard-coded `version: "3.0.0"` and the app exposes **no commit/version endpoint**. The strongest available evidence that the running code contains `6e09ced` is the **platform-reported deployed commit** `64d0b9d` (a confirmed git-ancestor of `6e09ced`) on a SUCCESS deployment now serving traffic, combined with the pre-push proof that the `64d0b9d` tree is byte-identical to the validated candidate. There is no independent in-process confirmation of the commit hash, and this document does not claim one.

---

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
