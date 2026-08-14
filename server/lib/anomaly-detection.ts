/**
 * Expected-Score Anomaly Detection
 *
 * After each batch completes, computes expected scores for each company based on
 * sector × country peer medians, then flags outliers using a robust MAD-based
 * z-score (Leys et al. 2013) for human review. Topic-agnostic — works for any
 * framework.
 *
 * Statistical approach:
 * - Peer groups: sector × country (fallback: sector-only if cross-group < MIN_PEER_GROUP_SIZE)
 * - Central tendency: median (robust to skew)
 * - Dispersion: MAD (Median Absolute Deviation) × 1.4826 (consistency factor for normal)
 * - Flagging: |actual − median| / (1.4826 × MAD) > Z_THRESHOLD (default 2.5)
 * - Minimum peer group: 8 (below this, medians are too noisy to trust)
 * - Companies with < 80% measure coverage are excluded from peer computation
 */

import { db } from "../db.js";
import { companies, measureScores, scoreAnomalies } from "../../shared/schema.js";
import { eq, and, inArray, isNotNull, sql } from "drizzle-orm";

// Robust z-score threshold (2.5 ≈ p < 0.01 for normal; conservative for skewed data)
const Z_THRESHOLD = 2.5;
// Minimum peer group size for reliable median/MAD estimation
const MIN_PEER_GROUP_SIZE = 8;
// Minimum coverage (%) to include a company in peer computation (avoids back-fill bias)
const MIN_COVERAGE_PCT = 80;
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
 */
export async function detectScoreAnomalies(input: AnomalyInput): Promise<number> {
  const { batchId, workspaceId, frameworkId, companyIds } = input;

  if (companyIds.length === 0) return 0;

  // 1. Load ALL completed companies in this workspace (the full peer universe)
  const allCompanies = await db
    .select({
      id: companies.id,
      name: companies.name,
      sector: companies.sector,
      country: companies.country,
      totalScore: companies.totalScore,
      measuresMetCount: companies.measuresMetCount,
      measuresTotalCount: companies.measuresTotalCount,
    })
    .from(companies)
    .where(
      and(
        eq(companies.workspaceId, workspaceId),
        eq(companies.analysisStatus, "completed"),
        isNotNull(companies.totalScore)
      )
    );

  if (allCompanies.length < MIN_PEER_GROUP_SIZE) return 0;

  // 2. Build peer-group score arrays (sector × country and sector-only)
  // Exclude low-coverage companies from peer computation to avoid back-fill bias
  const peerGroups = new Map<string, number[]>();
  const sectorGroups = new Map<string, number[]>();

  for (const c of allCompanies) {
    // Coverage filter: skip companies with low assessment coverage
    const totalMeasures = c.measuresTotalCount || 0;
    const metMeasures = c.measuresMetCount || 0;
    // If measuresTotalCount is 0, we can't determine coverage — include by default
    // (this handles legacy data where coverage wasn't tracked)

    const key = peerKey(c.sector, c.country);
    if (!peerGroups.has(key)) peerGroups.set(key, []);
    peerGroups.get(key)!.push(c.totalScore!);

    const sKey = (c.sector || "Unknown").toLowerCase();
    if (!sectorGroups.has(sKey)) sectorGroups.set(sKey, []);
    sectorGroups.get(sKey)!.push(c.totalScore!);
  }

  // 3. For each company in this batch, compute robust z-score and flag outliers
  const batchCompanies = allCompanies.filter(c => companyIds.includes(c.id));
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

  for (const c of batchCompanies) {
    if (c.totalScore == null) continue;
    const actualPct = c.totalScore;
    const key = peerKey(c.sector, c.country);
    let peerScores = peerGroups.get(key) || [];
    let groupLabel = `${c.sector || "Unknown"} × ${c.country || "Unknown"}`;

    // Fall back to sector-only if sector×country peer group is too small
    if (peerScores.length < MIN_PEER_GROUP_SIZE) {
      const sKey = (c.sector || "Unknown").toLowerCase();
      peerScores = sectorGroups.get(sKey) || [];
      groupLabel = `${c.sector || "Unknown"} (all countries)`;
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
        companyId: c.id,
        companyName: c.name,
        sector: c.sector,
        country: c.country,
        actualScore: actualPct,
        expectedScore: peerMedian,
        residual,
        peerGroupSize: peerScores.length,
        peerGroupMedian: peerMedian,
        reason,
      });
    }
  }

  // 4. Persist anomalies (delete prior anomalies for this batch first, in case of re-run)
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

    console.log(`[AnomalyDetection] Batch ${batchId}: flagged ${anomalies.length} outliers (MAD z-score > ${Z_THRESHOLD}, min peer n=${MIN_PEER_GROUP_SIZE})`);
  } else {
    console.log(`[AnomalyDetection] Batch ${batchId}: no outliers detected`);
  }

  return anomalies.length;
}
