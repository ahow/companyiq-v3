# CompanyIQ v3 — Rollback + Surviving-Solutions Backlog

_2026-10-07. Rollback commit `ee3180c` (tree == last-known-good `43f35ede`, 2026-10-05)._

## 1\. What was rolled back and why

**Last-known-good = `43f35ede` (2026-10-05 14:43).** Database `batch_runs` proves full\
50-company batches ran **50/50/0** as recently as batch 1201 (completed 2026-10-06 11:50).\
The first broken batch was 1202 (2026-10-06 19:02, 48/50 failed). The break therefore\
deployed between \~11:50 and \~18:00 on 10-06 — the discovery-expansion work, **not** the\
14-Sep `recordLlmUsage` commit (that earlier hypothesis is retracted; the DB-pool layer\
held during the failures — 0 heartbeat failures in batch 1235).

**7 commits reverted (`43f35ede..f0ad1f1`):**

| commit | time (UTC) | subject |
| --- | --- | --- |
| `42e7ddf` | 10-06 14:26 | discovery C/D/E: variants=4 + deep-num, analyst/factbook PDF query, known-doc URL seeding |
| `401ed91` | 10-06 14:26 | docs only (Proposal A draft) — no code |
| `fe26685` | 10-06 17:31 | **Proposal A**: issuer-domain PDF sweep + post-fetch aboutness |
| `aba322c` | 10-06 21:21 | reject non-issuer aggregator domains; env-tunable search timeout |
| `bb8e08b` | 10-06 23:25 | fix worker-stacking restart loop (one replica claimed all 50) |
| `88fb278` | 10-07 10:16 | decouple issuer-sweep depth from DISCOVERY_DEEP_NUM |
| `f0ad1f1` | 10-07 18:38 | llm-usage: batched inserts through dedicated pool |

**Root cause (evidence-based):** Proposal A's issuer-domain PDF sweep fires far more\
`site:` search queries per company. Under 20-way concurrency this overwhelmed the search\
providers → broken batch 1235 logged **47× `timeout of 8000ms`** (SerpAPI 26, Serper 22)\
→ 20-min discovery timeout → company fails. Isolation tests: single Serper call 1.3s,\
single SerpAPI call 12.8s (intrinsically slower than the 8s client timeout). Both provider\
accounts have credit and report no issues, so this is contention/latency, not quota.

**Variables:** No destructive changes needed. `WORKER_CONCURRENCY=10` is the baseline. The\
knobs `DISCOVERY_DEEP_NUM`, `ISSUER_SWEEP_MAX`, `ISSUER_SWEEP_SITEMAP`, `SEARCH_TIMEOUT_MS`\
are **inert** after rollback (verified: the good commit's code does not read them).

**Reversibility:** prior state preserved on branch `pre-rollback-20261007`.

## 2\. Verification (batch 1236 — same 50 companies as the last-good batch 1201)

* Both `app` + `worker` deployed `ee3180c` → SUCCESS.

* Search-timeout storm **eliminated**: **0** `timeout of 8000ms` (vs 47 in 1235), 0 Discovery\
  timeouts, 0 connection timeouts.

* **6 companies completed, 0 failed** at \~26 min (PEARSON 47, MAHINDRA 44, PNC 36,\
  SCHWAB 28; POWER FINANCE 0 and NVR 0 are legitimate "no evidence" completions). Batch\
  still running healthily toward full completion — heartbeats fresh, DB pool idle.

## 3\. Surviving solutions backlog (to re-apply one by one)

### KEEP — re-apply (valuable)

1. **Per-provider search rate-limiter + SerpAPI circuit-breaker** _(NEW — the enabling fix;\
  do this FIRST)._ Today `SEARCH_RATE_LIMIT` (discovery.ts L1008–1052) is a single global\
  token bucket (8 tokens, refill 4/s) shared across both providers, and one token is held\
  across the Serper→SerpAPI fallback (up to \~16s). Needed: separate per-provider budgets;\
  a breaker that de-ranks/skips SerpAPI when its latency exceeds the client timeout; and\
  either raise SerpAPI's client timeout or stop using it as synchronous failover. This is\
  the prerequisite that makes the discovery-quality work below safe to re-introduce.

2. **llm-usage batched inserts (`f0ad1f1`).** Self-contained; it did its job (DB pool held\
  through the failures). Low risk. Re-apply.

3. **Worker-stacking restart-loop fix (`bb8e08b`).** Genuine worker bug — stopped a replica\
  from claiming all 50 jobs at once on restart. Independent of the search issue. Re-apply.

4. **Cross-brand aggregator-domain rejection (`aba322c`, part 1).** Improves discovery\
  precision; independent of query volume. Re-apply. (The env-tunable search-timeout knob in\
  the same commit is neutral — keep it but don't rely on it as a fix.)

5. **Proposal A — issuer-domain PDF sweep + post-fetch aboutness (`fe26685`, `88fb278`).**\
  High discovery-quality value, but it was the regression. Re-apply **only after #1**, and\
  stage it: land the sweep behind the rate-limiter, watch the search-timeout count stay at\
  0, then enable aboutness.

6. **Discovery C/D/E (`42e7ddf`).** Mixed: known-doc URL seeding (E) is cheap (direct URLs,\
  not searches) — safe. Query-variant expansion (C) and analyst PDF query (D) add search\
  volume — gate them behind #1 and add incrementally, measuring the timeout count each time.

### DISCARD — did not help (masked or wrong target)

* **WORKER_CONCURRENCY throttle 10→3.** Masked load, didn't fix; trades throughput (rejected).\
  Already restored to 10.

* **pgbouncer worker routing.** Evidence showed the DB pool was not the live blocker. Demote\
  to optional future hardening, not a fix.

* **Env tuning of `DISCOVERY_DEEP_NUM` / `ISSUER_SWEEP_MAX` / `ISSUER_SWEEP_SITEMAP` /\
  `SEARCH_TIMEOUT_MS`.** Knobs for the reverted code, not fixes. Inert now.