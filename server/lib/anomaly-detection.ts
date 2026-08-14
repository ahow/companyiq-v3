/**
 * Expected-Score Anomaly Detection (v2 — framework-scoped)
 *
 * After each batch completes, computes expected scores for each company based on
 * sector × country peer medians, then flags outliers using a robust MAD-based
 * z-score (Leys et al. 2013) for human review.
 *
 * KEY FIX (Financed Emissions robustness review): The peer universe is now scoped
 * to companies scored on the SAME FRAMEWORK, computed from measure_scores rather
 * than the stale cross-framework companies.totalScore. This prevents comparing
 * Financed Emissions scores against AI Governance scores.
 *
 * Statistical approach:
 * - Peer groups: sector × country (fallback: sector-only if cross-group < MIN_PEER_GROUP_SIZE)
 * - Central tendency: median (robust to skew)
 * - Dispersion: MAD (Median Absolute Deviation) × 1.4826 (consistency factor for normal)
 * - Flagging: |actual − median| / (1.4826 × MAD) > Z_THRESHOLD (default 2.5)
 * - Minimum peer group: 8 (below this, medians are too noisy to trust)
 */

import { db } from "../db.js";
import { companies, measureScores, scoreAnomalies } from "../../shared/schema.js";
import { eq, and, inArray, sql } from "drizzle-orm";

// Robust z-score threshold (2.5 ≈ p < 0.01 for normal; conservative for skewed data)
const Z_THRESHOLD = 2.5;
// Minimum peer group size for reliable median/MAD estimation
const MIN_PEER_GROUP_SIZE = 8;
// Fallback: if MAD is 0 (all peers have same score), use fixed 10pp as dispersion floor
const MAD_FLOOR = 10;

interface AnomalyInput {
  batchId: number;
  workspaceId: number;
  frameworkId: number;
  companyIds: number[]; // companies in this batch
}

function peerKey(sector: string | null | undefined, country: string | null | undefined): string {
  return `${(sector || "Unknown").toLowerCase()}|${(country || "Unknown").toLowerCase()}`;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mad(arr: number[]): number {
  if (arr.length === 0) return 0;
  const med = median(arr);
  const deviations = arr.map(x => Math.abs(x - med));
  return median(deviations);
}

/**
 * Compute expected scores and flag anomalies for a completed batch.
 * Called from maybeHandleBatchCompletion after the batch is finalised.
 *
 * The peer universe is derived from measure_scores for the SAME frameworkId,
 * ensuring we only compare like-with-like (e.g., Financed Emissions scores
 * against other Financed Emissions scores, never against AI Governance).
 */
export async function detectScoreAnomalies(input: AnomalyInput): Promise<number> {
  const { batchId, workspaceId, frameworkId, companyIds } = input;

  if (companyIds.length === 0) return 0;

  // 1. Compute per-company scores for THIS FRAMEWORK from measure_scores.
  //    This replaces the stale companies.totalScore (which is overwritten each run
  //    and mixes frameworks). We compute: (measures with score > 0) / total measures × 100.
  const frameworkScores = await db
    .select({
      companyId: measureScores.companyId,
      totalMeasures: sql<number>`count(*)`.as("total_measures"),
      metMeasures: sql<number>`count(*) filter (where ${measureScores.score} > 0)`.as("met_measures"),
      avgScore: sql<number>`round(100.0 * count(*) filter (where ${measureScores.score} > 0) / nullif(count(*), 0), 1)`.as("avg_score"),
    })
    .from(measureScores)
    .where(eq(measureScores.frameworkId, frameworkId))
    .groupBy(measureScores.companyId);

  if (frameworkScores.length < MIN_PEER_GROUP_SIZE) return 0;

  // 2. Join with company metadata (sector, country, name) for peer grouping
  const scoredCompanyIds = frameworkScores.map(s => s.companyId);
  const companyMeta = await db
    .select({
      id: companies.id,
      name: companies.name,
      sector: companies.sector,
      country: companies.country,
    })
    .from(companies)
    .where(
      and(
        eq(companies.workspaceId, workspaceId),
        inArray(companies.id, scoredCompanyIds)
      )
    );

  // Build a lookup map
  const metaMap = new Map(companyMeta.map(c => [c.id, c]));
  const scoreMap = new Map(frameworkScores.map(s => [s.companyId, s]));

  // 3. Build peer-group score arrays (sector × country and sector-only)
  const peerGroups = new Map<string, number[]>();
  const sectorGroups = new Map<string, number[]>();

  for (const s of frameworkScores) {
    const meta = metaMap.get(s.companyId);
    if (!meta) continue;
    const score = Number(s.avgScore);
    if (isNaN(score)) continue;

    const key = peerKey(meta.sector, meta.country);
    if (!peerGroups.has(key)) peerGroups.set(key, []);
    peerGroups.get(key)!.push(score);

    const sKey = (meta.sector || "Unknown").toLowerCase();
    if (!sectorGroups.has(sKey)) sectorGroups.set(sKey, []);
    sectorGroups.get(sKey)!.push(score);
  }

  // 4. For each company in this batch, compute robust z-score and flag outliers
  const anomalies: Array<{
    companyId: number;
    companyName: string;
    sector: string | null;
    country: string | null;
    actualScore: number;
    expectedScore: number;
    residual: number;
    peerGroupSize: number;
    peerGroupMedian: number;
    reason: string;
  }> = [];

  for (const cId of companyIds) {
    const s = scoreMap.get(cId);
    const meta = metaMap.get(cId);
    if (!s || !meta) continue;

    const actualPct = Number(s.avgScore);
    if (isNaN(actualPct)) continue;

    const key = peerKey(meta.sector, meta.country);
    let peerScores = peerGroups.get(key) || [];
    let groupLabel = `${meta.sector || "Unknown"} × ${meta.country || "Unknown"}`;

    // Fall back to sector-only if sector×country peer group is too small
    if (peerScores.length < MIN_PEER_GROUP_SIZE) {
      const sKey = (meta.sector || "Unknown").toLowerCase();
      peerScores = sectorGroups.get(sKey) || [];
      groupLabel = `${meta.sector || "Unknown"} (all countries)`;
    }

    // Still too small? Skip — can't make a meaningful comparison
    if (peerScores.length < MIN_PEER_GROUP_SIZE) continue;

    const peerMedian = median(peerScores);
    const peerMAD = mad(peerScores);
    // Robust scale estimate: 1.4826 × MAD (consistent estimator for σ under normality)
    const robustScale = 1.4826 * Math.max(peerMAD, MAD_FLOOR);
    const residual = actualPct - peerMedian;
    const zScore = Math.abs(residual) / robustScale;

    if (zScore > Z_THRESHOLD) {
      const direction = residual > 0 ? "above" : "below";
      const reason = `Score ${actualPct.toFixed(0)}% is ${Math.abs(residual).toFixed(0)}pp ${direction} peer median ${peerMedian.toFixed(0)}% (z=${zScore.toFixed(1)}, ${groupLabel}, n=${peerScores.length})`;

      anomalies.push({
        companyId: cId,
        companyName: meta.name,
        sector: meta.sector,
        country: meta.country,
        actualScore: actualPct,
        expectedScore: peerMedian,
        residual,
        peerGroupSize: peerScores.length,
        peerGroupMedian: peerMedian,
        reason,
      });
    }
  }

  // 5. Persist anomalies (delete prior anomalies for this batch first, in case of re-run)
  if (anomalies.length > 0) {
    await db.delete(scoreAnomalies).where(
      and(
        eq(scoreAnomalies.batchId, batchId),
        eq(scoreAnomalies.workspaceId, workspaceId)
      )
    );

    await db.insert(scoreAnomalies).values(
      anomalies.map(a => ({
        workspaceId,
        batchId,
        frameworkId,
        companyId: a.companyId,
        companyName: a.companyName,
        sector: a.sector,
        country: a.country,
        actualScore: a.actualScore,
        expectedScore: a.expectedScore,
        residual: a.residual,
        peerGroupSize: a.peerGroupSize,
        peerGroupMedian: a.peerGroupMedian,
        reason: a.reason,
        status: "pending",
      }))
    );

    console.log(`[AnomalyDetection] Batch ${batchId} (framework ${frameworkId}): flagged ${anomalies.length} outliers from ${frameworkScores.length} peers (MAD z > ${Z_THRESHOLD}, min n=${MIN_PEER_GROUP_SIZE})`);
  } else {
    console.log(`[AnomalyDetection] Batch ${batchId} (framework ${frameworkId}): no outliers detected among ${frameworkScores.length} peers`);
  }

  return anomalies.length;
}
