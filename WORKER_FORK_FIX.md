# Worker Fork-Exhaustion Fix & AI Governance Batch Resume

## Summary

The dedicated Railway worker was failing every Chromium browser-fallback launch with
`spawn /usr/bin/chromium EAGAIN` / `Cannot fork`. Jobs technically completed but were
crippling-slow because each one looped through dozens of failing Chromium launches before
giving up. Root cause analysis showed the dominant document source — **SEC EDGAR
(`www.sec.gov`)** — was returning **HTTP 403** to the browser-style `User-Agent`, forcing a
browser fallback that the memory-constrained container could not satisfy.

## Root Cause

1. **SEC Fair-Access policy**: `www.sec.gov` rejects generic browser User-Agents with `403`
   and requires a descriptive UA that identifies the requester. Verified empirically:
   - Browser UA → `403`
   - `CompanyIQ Research admin@pullcite.com` → `200`
2. Every 403 triggered a Chromium browser fallback. The container lacks the process/fork
   budget to launch Chromium (even at `MAX_CONCURRENT_BROWSER=1`), so each launch failed and,
   at concurrency 6, the per-URL launch attempts created a fork storm.

## Fix (commit `936c6ed`)

`server/lib/processor.ts`:
1. **SEC-compliant HTTP headers** — when the host is `sec.gov` / `sec.report`, send the
   compliant `SEC_USER_AGENT` plus `Accept-Encoding: gzip, deflate`. SEC documents now
   succeed over plain HTTP, eliminating the need for Chromium on the bulk of documents.
2. **Chromium launch circuit breaker** — on a launch failure matching
   `EAGAIN|Cannot fork|Resource temporarily unavailable|Failed to launch`, open a cooldown
   window (`BROWSER_LAUNCH_COOLDOWN_MS`, default 120s) during which `fetchWithBrowser()`
   returns immediately without acquiring a slot or attempting another fork. This stops the
   per-URL launch storm; the analyzer proceeds with the documents fetched over HTTP.

### Railway worker env changes
- `WORKER_CONCURRENCY`: 6 → **3** (less simultaneous heavy fetching / memory pressure)
- `MAX_CONCURRENT_BROWSER`: 2 → **1**
- `SEC_USER_AGENT` = `CompanyIQ Research admin@pullcite.com`

## Result

- **No more `EAGAIN` / `Cannot fork`** log lines.
- SEC docs fetched over HTTP (200); browser fallback now only attempted for a few genuinely
  bot-blocked third-party pages and is gracefully short-circuited by the breaker.
- Worker RSS stable ~330–360 MB (transient spikes recover; no OOM, no crash).
- **Batch 60** (workspace 3 / framework 7 / AI Governance) is draining autonomously with
  **zero failures**: jobs complete with full 34-measure score sets.

## Batch lineage (framework 7, workspace 3, list 4 — 2443 companies total)
- Batch 57/58: cancelled during the architecture split (web/worker cleanup race, now fixed).
- Batch 59: cancelled — used to confirm the fork issue (6 completed slowly).
- **Batch 60: active** — re-enqueued the 410 companies still lacking framework-7 scores
  after the fix. Self-draining at ~3 jobs / 5–6 min.

## How to check progress
- App API health: `GET https://app-production-9929.up.railway.app/api/health`
- Worker logs: Railway → `worker` service (id `27920e1f-3835-44be-98ac-2a40a43678cf`),
  deployment `ef9f0c13`.
- To re-enqueue any future remainder, POST to `/api/admin/resume-analysis` with
  `x-admin-token`, body `{"workspaceId":3,"frameworkId":7,"companyIds":[...]}`.

## Security
- Temporary Postgres TCP proxy (`thomas.proxy.rlwy.net:56916`) **deleted**; DB is no longer
  externally reachable.

## Known limitation / follow-up
- Chromium cannot launch on the current Railway container size; browser fallback is
  effectively disabled. This is acceptable because SEC (the main source) now works over HTTP.
  If broader JS-rendered/bot-blocked coverage is ever needed, it would require a larger
  worker container (plan change) or an external headless-browser/fetch API.
- Model name deprecation reminder: `deepseek-chat` / `deepseek-reasoner` are deprecated
  2026-07-24; migrate to `deepseek-v4-flash` / `deepseek-v4-pro` before then.
