# Rollback Marker — Worker Isolation Deployment

**Recorded (UTC):** 2026-10-12T00:03:19Z
**Operator:** Andy Howard (andyhoward@me.com)

## Baseline (rollback target)
- **Production commit at start:** `35884eeac8314114df924b8dc303ae2bdd64ed25` (branch `main`)
- app + worker both SUCCESS on `35884ee` (deployed 2026-10-11T12:23:44Z)
- Worker vars at baseline: WORKER_ISOLATION_ENABLED **absent (off)**; WORKER_CONCURRENCY=4, LLM_MAX_CONCURRENCY=8, ADAPTIVE_CONCURRENCY_ENABLED=true, ADAPTIVE_CONCURRENCY_MIN=2, INCOMPANY_FETCH_CONCURRENCY=4
- Worker runtime topology: **2/2 running** (service config numReplicas=3; actual running=2) — left UNCHANGED
- Worker startCommand: `node --import tsx server/worker-main.ts` (unchanged)

## Candidate (deployment target)
- **Target commit:** `b676c2ddf37512dad0e18c6e812a4dc7e58a12a2` (clean fast-forward from 35884ee; 11 commits ahead)
- Runtime files (Dockerfile, railway.json, Procfile, package.json): byte-identical to baseline
- Isolation activated by setting WORKER_ISOLATION_ENABLED=true on the worker service ONLY

## Rollback procedure (if systemic failure)
1. Cancel in-flight batch; verify child/permit settlement (no orphaned children, no leaked browser permits).
2. Set `WORKER_ISOLATION_ENABLED=false` on the worker service (flag flip only — no schema/migration rollback needed; candidate default-off == baseline behaviour).
3. If code rollback also required: fast-forward is non-destructive; `git push origin 35884ee:main --force-with-lease` restores baseline commit, triggering app+worker redeploy to 35884ee.
4. No migrations/backfills/dedup/db:push were run, so there is nothing to undo at the data layer.
