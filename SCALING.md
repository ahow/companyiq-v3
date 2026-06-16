# CompanyIQ v3 — Scaling & Throughput Guide

This document explains how to increase batch-analysis throughput **without
degrading analysis quality**, and the exact steps to run a dedicated worker
service on Railway.

## Why throughput and quality are independent here

Analysis quality is determined by *which documents are fetched* and *how each
one is scored/verified* — not by how many companies or documents are processed
in parallel. Every company runs the identical pipeline (discovery → fetch →
per-document LLM verification → scoring) regardless of how many run alongside
it. So parallelism is a pure throughput lever, **provided** we never exceed the
three shared resource ceilings:

1. **LLM rate limit** (DeepSeek primary) — the first ceiling under batch load.
2. **CPU / memory per worker** — Chromium (browser fallback) is heavy.
3. **Browser-slot pool** — capped per process by `MAX_CONCURRENT_BROWSER`.

Pushed past these, requests start timing out / 429-ing, which *can* drop
documents and reduce coverage. The knobs below let you go wide up to — but not
past — those ceilings.

## Throughput knobs (environment variables)

| Variable | Default | What it does | Quality guard |
|---|---|---|---|
| `WORKER_CONCURRENCY` | `10` | Companies processed in parallel per worker process | Indirect: don't exceed CPU/RAM or LLM ceilings |
| `INCOMPANY_FETCH_CONCURRENCY` | `4` | Documents fetched concurrently within one company | Same fetch+verify per doc; only overlapped |
| `LLM_MAX_CONCURRENCY` | `8` | Global cap on in-flight LLM calls **per process** | Keeps DeepSeek within rate limit; prevents dropped scoring |
| `MAX_CONCURRENT_BROWSER` | `2` | Concurrent Chromium browser fetches per process | Prevents fork/OOM crashes |
| `FETCH_TIMEOUT_MS` | `40000` | HTML fetch timeout (ms) | — |
| `FETCH_TIMEOUT_BINARY_MS` | `90000` | PDF/binary fetch timeout (ms) — large annual reports | Stops reachable big PDFs being marked dead |
| `PER_DOCUMENT_TIMEOUT_MS` | `100000` | Outer per-document guard (ms); must exceed binary fetch | — |
| `FETCH_PHASE_BUDGET_MS` | `360000` | Max fetch time per company (ms) | — |
| `PIPELINE_TIMEOUT_MS` | `540000` | Max total pipeline time per company (ms); < 600000 queue lock | — |

### Critical relationship when scaling across replicas

`LLM_MAX_CONCURRENCY` is **per process**. With N worker replicas the effective
LLM concurrency is `LLM_MAX_CONCURRENCY × N`. Size it so that product stays
within DeepSeek's account rate limit. Example: DeepSeek allows ~30 concurrent →
3 replicas → set `LLM_MAX_CONCURRENCY=8` (3×8=24, safely under 30).

## Dedicated worker service (biggest, safest scaling lever)

The code already supports splitting the worker into its own Railway service via
`server/worker-main.ts`. This isolates heavy Chromium/PDF work from the web app
and lets you scale workers horizontally with replicas.

### Steps on Railway (Pro plan)

1. **Web service** (existing): add env var `RUN_WORKER=false` so it stops running
   the embedded worker and only serves the UI/API + queue cleanup is disabled.
2. **Create a new service** in the same Railway project, from the **same GitHub
   repo** (same Dockerfile build).
3. On the new worker service, set the **Start Command** to:
   ```
   node --import tsx server/worker-main.ts
   ```
4. Give the worker service the **same environment variables** as the web service
   (DATABASE_URL, REDIS_URL, all LLM keys, etc.). Both must point at the **same
   Redis** (the BullMQ broker) and the **same Postgres**.
5. On the worker service set `WORKER_RUN_CLEANUP=true` (it now owns queue
   cleanup) and tune `WORKER_CONCURRENCY`, `INCOMPANY_FETCH_CONCURRENCY`,
   `LLM_MAX_CONCURRENCY`, `MAX_CONCURRENT_BROWSER` per the profile below.
6. **Scale replicas** on the worker service (Settings → Replicas) to 2–3.

### Recommended quality-safe starting profile

Per worker replica (assuming ≥2 GB RAM / replica):

```
WORKER_CONCURRENCY=12
INCOMPANY_FETCH_CONCURRENCY=4
LLM_MAX_CONCURRENCY=8
MAX_CONCURRENT_BROWSER=2
```

With 2 replicas this yields ~24 companies in parallel and ~16 in-flight LLM
calls — a large speedup over the previous single embedded worker (10), while
staying within typical DeepSeek limits. Increase replica count first (linear,
safest), then `WORKER_CONCURRENCY`, watching memory and LLM 429 rates.

## Verifying quality is unaffected

- The per-document fetch+verify logic is unchanged; only orchestration is
  concurrent.
- The global LLM semaphore guarantees scoring/verification calls never exceed
  the configured concurrency, so no scoring is dropped due to rate limits.
- Re-running the same companies should produce consistent scores (the providers
  use `temperature: 0` and a fixed `seed`).
