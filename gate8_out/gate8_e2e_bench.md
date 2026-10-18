# GATE8 — paid end-to-end cold-vs-warm cache no-op benchmark (Option B)

Generated: 2026-10-17T10:26:42.570Z

**Scope (Option B):** one real company scored **twice in one process** through the real production `analyzeCompanyMeasures` entry point, on a frozen `batch_corpus` snapshot (read-only). Run 1 COLD (empty in-process verdict cache → real self-consistency LLM scoring), run 2 WARM (same byte-identical opts → the `verdictCache` Map short-circuits scoring). This measures EMPIRICALLY whether warming the cache moves any verdict, plus the real wall-clock and LLM-$ saving.

Target: **MID-AMERICA APARTMENT COMMUNITIES, INC.** (company 135, ws 3) · framework **AI Management** (18, 36 measures) · corpus **10 docs / 2.52M chars** from batch_corpus snapshot batch 1289.

## Verdict: **PASS**

Every measure produced an identical verdict cold vs warm (0 flips), while the warm run skipped the paid scoring LLM calls. Warming the in-process verdict cache is an empirically confirmed **no-op on verdicts** that eliminates the scoring spend.

## Aggregate

- Cold wall: **94.68s**  ·  warm wall: **10.47s**  ·  speedup: **9.0x**
- Cold LLM cost: **$0.3873 · 147 calls · 1.36M tok**
- Warm LLM cost: **$0.0001 · 1 calls · 0.00M tok**
- Cost saved by warm cache: **$0.3872**
- Answered (cold/warm): **36/36** of 36  ·  abstained: 0/0

## Verdict cell-flip accounting (MANDATORY — EMPIRICAL)

Measured per-measure by running the real scoring entry point twice and diffing the verdicts. A Y→N flip = verdict was `Yes` cold and not `Yes` warm; N→Y = not `Yes` cold and `Yes` warm. Any non-flip change (e.g. Partial↔No) is counted in **Any change**.

| Surface | Y→N flips | N→Y flips | Total Flips | Any change | Scoring surface touched |
|---|--:|--:|--:|--:|:--:|
| In-process verdict cache cold vs warm (36 measures) | 0 | 0 | 0 | 0 | yes |
| **Total** | **0** | **0** | **0** | **0** | **yes** |

## Per-measure verdicts (cold vs warm)

_No measure changed verdict. Full table below for audit._

| measureId | cold | warm |
|:--|:--|:--|
| 1.1-ai-strategy-document | No | No |
| 1.10-stakeholder-engagement | No | No |
| 1.2-board-oversight | No | No |
| 1.3-executive-accountability | No | No |
| 1.4-strategic-objectives | No | No |
| 1.5-investment-commitment | No | No |
| 1.6-multi-year-roadmap | No | No |
| 1.7-responsible-ai-commitment | No | No |
| 1.8-external-alignment | No | No |
| 1.9-workforce-strategy | No | No |
| 2.1-deployed-systems | No | No |
| 2.10-operational-efficiency | No | No |
| 2.11-ai-research-activity | No | No |
| 2.12-ai-maturity-assessment | No | No |
| 2.13-ai-portfolio-inventory | No | No |
| 2.2-business-function-deployment | No | No |
| 2.3-quantified-outcomes | No | No |
| 2.4-customer-facing-ai | No | No |
| 2.5-generative-ai-use | No | No |
| 2.6-ai-capability-building | No | No |
| 2.7-ai-infrastructure | No | No |
| 2.8-ai-partnerships | No | No |
| 2.9-ai-product-innovation | No | No |
| 3.1-ai-governance-body | No | No |
| 3.10-model-validation | No | No |
| 3.11-regulatory-compliance | No | No |
| 3.12-workforce-impact | No | No |
| 3.13-security-resilience | No | No |
| 3.2-ai-risk-framework | No | No |
| 3.3-ethical-review-process | No | No |
| 3.4-bias-mitigation | No | No |
| 3.5-explainability-transparency | No | No |
| 3.6-human-oversight | No | No |
| 3.7-ai-incident-management | No | No |
| 3.8-third-party-ai-risk | No | No |
| 3.9-data-provenance | No | No |

## Warm-hit behaviour (inferred from measured cost)

- Cold made **147** LLM calls; warm made **1**. Warm issued fewer calls ⇒ the in-process verdict cache served hits and skipped paid scoring. The warm calls that remain are the uncached upstream stages (translation / summarisation / retrieval), which the verdict Map does not cache and which therefore repeat on warm.

## Scope & honesty

- **Code identity:** the real production `analyzeCompanyMeasures` was invoked with the production environment (API keys, workspace settings read live from the prod DB). No production code or defaults were modified; the cache was **not** enabled in production.
- **Isolation:** `analyzeCompanyMeasures` does not persist companies or measure_scores, so the user's live dashboard run was never touched. The only prod writes are append-only `llm_usage_events` rows tagged with synthetic batch ids (cold 990135001, warm 990135002), which cannot collide with live accounting and can be removed.
- **Real measurements:** wall-clock is `Date.now()` around each run; cost is summed from the `llm_usage_events` rows the runs actually emitted (buffer drained before reading). No number is interpolated; missing cost is reported as *not captured*.
- **freshScoring=false** was used for both runs — prod-identical for ws3 (`verdict_cache_enabled=true`). The DB fingerprint-reuse override therefore applies identically to cold and warm, leaving the cold-vs-warm flip comparison valid while cold still pays full scoring cost.
- **Caveat (provenance pre-filter not replicated):** the full pipeline applies a U17 provenance document filter (network/SEC lookups) before scoring; to keep inputs deterministic and network-free this run passed the RAW `batch_corpus` docs (ORDER BY id). This does **not** affect the cold-vs-warm comparison (both runs use identical inputs); it only means verdicts here are not meant to match prod's stored verdicts one-for-one.
