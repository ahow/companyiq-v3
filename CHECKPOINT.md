# Implementation Checkpoint — Framework-Scoped Isolation & Durable Terminal Acceptance

**Commit base:** b619363 (HEAD of main)
**Date:** 2026-08-21
**Batch 1057:** ACTIVE — not modified, not reset, not aggregated. Provenance preserved.

## Files to Change

| File | Change Summary |
|---|---|
| `server/storage.ts` | Add `clearMeasureScoresForFramework(companyId, frameworkId)` — framework-scoped DELETE. Make `markReliabilityRunAccepted` verify artifactId is non-null and snapshot row exists before flipping acceptance_state. |
| `server/lib/pipeline.ts` | Replace both `clearMeasureScores(companyId)` calls with `clearMeasureScoresForFramework(companyId, framework.id)` so fw3 scores survive when fw8 runs and vice versa. |
| `server/worker.ts` | In `saveAnalysisResultsForBatch`: (1) verify snapshot persisted with non-null artifactId before calling `markReliabilityRunAccepted`; (2) make finalization idempotent — re-entering with same batchId returns existing snapshot; (3) scope `getMeasureScores` call to frameworkId. |
| `server/lib/reliability.ts` | Add `selectTerminalBatchPerFramework()` helper that picks one accepted terminal batch per framework, rejecting pending/overwritten/mixed/partial rows. |
| `server/lib/reliability.test.ts` | Add deterministic tests: cross-framework score isolation, terminal snapshot persistence before acceptance, idempotent finalization, rejection of mixed/pending batches. No hardcoded company names/topics/framework IDs. |
| `server/routes/api.ts` | Scope `clearMeasureScores` calls in reset endpoints to framework when framework context is available; keep workspace-wide reset as-is (intentional full wipe). |

## Current Implementation Status

- **Analysis complete:** All defect sites identified
- **Code changes:** Not yet written — checkpoint published first per user request
- **Tests:** Not yet written
- **Build:** Not yet run

## Excluded Batches (No KPI Aggregation Valid)

| Batch | Reason |
|---|---|
| 1049 | Pre-fix batch, overwritten scores, no valid provenance |
| 1053 | Pre-fix batch, overwritten scores, no valid provenance |
| 1054 | Pre-fix batch, overwritten scores, no valid provenance |
| 1055 (fw3-A) | acceptanceState=pending, artifactId=None — snapshot not persisted before acceptance; scores overwritten by fw8 run |
| 1057 (fw8-B) | ACTIVE with fresh heartbeats — must reach terminal state on its own; not aggregated |

**A fresh fw3-A / fw3-B rerun is required after this fix deploys.**

## Provider-Resilience Semantics Preserved

- Provider failures continue to pause/classify and never become scores or zeros
- All Battery Reliability Rules remain intact
- No changes to credit-breaker, provider-resilience, or failure-event persistence
