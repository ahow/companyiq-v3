# B6 / WP14 — Bottleneck classification & DB-connection inventory

_Generated 2026-10-18. Companion to `b6_bottleneck_and_connection_inventory.json`._

## 1. Method (WP14 order)

WP14 requires: **classify the bottleneck first → inventory every DB connection → one-variable
capacity matrix → prefer more replicas at lower per-replica concurrency.** The metric is *accepted*
throughput (accepted companies/hour at batch level), not single-company latency, and the risk is
*environmental, not algorithmic*. This document does steps 1–2; the capacity matrix is the harness
`server/scripts/gate_b6_capacity_matrix.ts`.

## 2. The binding ceiling (LIVE-confirmed)

The app runs on its **own** Railway-hosted PostgreSQL (project `db04e5b1`), **not** the Abacus
platform 25-connection default. Confirmed live against the production DB on 2026-10-18:

| Setting | Value | Source |
|---|---|---|
| `max_connections` | **100** | `SHOW max_connections;` |
| `superuser_reserved_connections` | **3** | `SHOW superuser_reserved_connections;` |
| **Usable non-superuser connections** | **97** | `100 − 3` |

The documented **"88-vs-97 failure"** was a pool bump that pushed the saturated worst-case total
toward this 97 ceiling. **97 is the binding constraint.**

## 3. Production connection inventory (per process)

Every DB pool opened inside the live `app` / `worker` services:

| Module | Pool | Env var | Default max | Services | Lazy | Gate (default) |
|---|---|---|---|---|---|---|
| `server/db.ts` | main (drizzle) | `PG_POOL_MAX` | **20** | app + worker | no | — |
| `server/lib/llm-usage.ts` | usagePool | `PG_USAGE_POOL_MAX` | 2 | app + worker | yes | `LLM_USAGE_LOGGING_ENABLED` (true) |
| `server/lib/stage-profile-sink.ts` | pool | `PG_STAGE_PROFILE_POOL_MAX` | 2 | app + worker | yes | `STAGE_PROFILE_PERSIST_ENABLED` (true) |
| `server/lib/paid-call-attribution.ts` | pool | `PG_PAID_CALL_POOL_MAX` | 2 | app + worker | yes | `PAID_CALL_ATTRIBUTION_ENABLED` (true) |
| `server/lib/run-manifest.ts` | pool | `PG_RUN_MANIFEST_POOL_MAX` | 1 | worker | yes | `RUN_MANIFEST_ENABLED` (true) |

Scripts under `server/scripts/*` open their own short-lived pools (max 2–5) but **do not run inside
the app/worker services**, so they are excluded from the live budget.

### Per-process worst case
- **worker**: 20 + 2 + 2 + 2 + 1 = **27 connections**
- **app**: 20 + 2 + 2 + 2 + 0 = **26 connections**

### App-wide worst case
`(appReplicas × 26) + (workerReplicas × 27)`

| Topology | Worst-case total | vs 97 ceiling |
|---|---|---|
| 1 app + 2 worker | 80 | OK |
| 2 app + 2 worker | **106** | **BREACH** |
| 1 app + 3 worker | **107** | **BREACH** |

Even a modest 2 app + 2 worker fan-out breaches 97 in the saturated worst case with the default
`PG_POOL_MAX=20`. This is exactly the 88-vs-97 class of failure.

## 4. Bottleneck classification

| Candidate | Verdict |
|---|---|
| **DB connections (97 usable)** | **BINDING.** Saturating pools across replicas breaches this first. |
| Worker concurrency | Static 10 jobs/replica; each job fans ~100 sequential drizzle queries through the shared pool — bounded by pool max, not an independent ceiling. |
| LLM API | Governed separately by `LLM_MAX_CONCURRENCY × replicas` against the provider account; not the DB-side constraint B6 addresses. |

**Conclusion:** DB connections (97 usable) is the binding bottleneck. B6 governs **worker job
concurrency** against a connection budget so that
`effectiveConcurrency × replicaCount × connectionsPerJob + reservedOverhead` can never exceed the
budget as replicas scale.

## 5. Derived safe budget

| Parameter | Value | Rationale |
|---|---|---|
| `DB_CONNECTION_BUDGET` | **90** | Sits safely under the 97 usable ceiling (matches `server/db.ts` "comfortably under ~90"). |
| `reservedOverhead` | **10** | App service's main-pool share + worker control-plane (claim/heartbeat/reaper) + small telemetry pools. |
| `connectionsPerJob` | **2** | `PG_POOL_MAX`(20) ÷ static concurrency(10). |
| `HARD_MAX` | **10** | Pins the ceiling at today's static concurrency so dynamic mode can only ever **lower** concurrency as replicas grow — never raise it above the historical value. |
| `replicaCount` fallback | **1** | Read from `REPLICA_COUNT` / `RAILWAY_REPLICA_COUNT` at boot; defaults to 1. |
| **`maxSafeReplicas`** | **40** | `floor((90 − 10) / 2) = 40`. Beyond this the min-concurrency-1 clamp would breach the ceiling; the invariant checker reports infeasibility ("cut replicas") rather than silently breaching. |

**B6 does NOT change any pool max in this WP** — that is an approval-gated tuned-matrix decision. B6
only derives safe per-replica worker concurrency from the known budget, behind the `CAPACITY_POLICY`
kill-switch whose default (`static`) reproduces today's fixed concurrency byte-identically.
