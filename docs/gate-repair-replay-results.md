# Gate-repair offline replay results

_Generated 2026-10-23T18:20:57.803Z by `scripts/gate-repair-replay.ts`._

Replayed offline over the production snapshots **1289** (baseline) and **1304** (degraded)
using the persisted per-quote `evidence-gate` audit blobs. No LLM, no network, no DB.

**Universe:** 1764 (company × measure) cells common to 1289 and 1304.

## Yes-rate by variant

| Variant | Yes | Yes-rate |
|---|---:|---:|
| 1289 baseline (gate never ran) | 372 | 21.1% |
| 1304 baseline (source-attribution ON, strip-and-flip) | 143 | 8.1% |
| source-attribution OFF | 379 | 21.5% |
| **repair ON (Option A+C, relabel only)** | 379 | 21.5% |

## Gate-flip recovery (Yes-in-1289 → No-via-gate-in-1304)

| Metric | Count |
|---|---:|
| Gate flips (downgraded & Yes in 1289) | 204 |
| Recovered by source-attribution OFF | 202 |
| Recovered by repair ON (relabel; present pack-wide) | 202 |
| Residual re-search candidates (all quotes failed provenance) | 0 |

Repair's relabel step recovers the same flips as source-attribution OFF, but
**keeps full per-document attribution** by relabelling each quote to the segment
that actually contains its verbatim text (recorded in `repairs[]`), rather than
disabling the dimension wholesale. The 0 residual flip(s) whose quotes
all failed pack-wide provenance are routed to the corpus re-search (Option C step 3);
its outcome depends on the pack text, which the audit blob does not persist, so this
harness conservatively does NOT count them as recovered.

## No-hallucination-regression invariant

| Check | Value | Expected | Pass |
|---|---:|---:|:--:|
| Quotes failing pack-wide provenance (in 1304 audit) | 30 | — | — |
| …of those PROMOTED to valid by the repair path | 0 | 0 | ✅ |

The repair path forgives **source-attribution-only** failures (quotes already
present pack-wide); it never forgives a provenance failure, so no quote that
fails pack-wide provenance is ever newly passed. Invariant holds:
**PASS**.

