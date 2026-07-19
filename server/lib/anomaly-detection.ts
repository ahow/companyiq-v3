/**
 * Expected-Score Anomaly Detection
 *
 * After each batch completes, computes expected scores for each company based on
 * sector × country peer medians, then flags outliers (|residual| > threshold)
 * for human review. Topic-agnostic — works for any framework.
 */

import { db } from "../db.js";
import { companies, measureScores, scoreAnomalies } from "../../shared/schema.js";
import { eq, and, inArray, isNotNull, sql } from "drizzle-orm";

const RESIDUAL_THRESHOLD = 15; // percentage points — flag if |actual - expected| > 15pp
const MIN_PEER_GROUP_SIZE = 3; // don't flag if peer group is too small to be meaningful

interface AnomalyInput {
  batchId: number;
  workspaceId: number;
  frameworkId: number;
  companyIds: number[]; // companies in this batch
}

interface PeerKey {
  sector: string;
  country: string;
}

function peerKey(sector: string | null | undefined, country: string | null | undefined): string {
  return `${(sector || "Unknown").toLowerCase()}|${(country || "Unknown").toLowerCase()}`;
}

/**
 * Compute expected scores and flag anomalies for a completed batch.
 * Called from maybeHandleBatchCompletion after the batch is finalised.
 */
export async function detectScoreAnomalies(input: AnomalyInput): Promise<number> {
  const { batchId, workspaceId, frameworkId, companyIds } = input;

  if (companyIds.length === 0) return 0;

  // 1. Load ALL completed companies in this workspace+framework (the full peer universe)
  const allCompanies = await db
    .select({
      id: companies.id,
      name: companies.name,
      sector: companies.sector,
      country: companies.country,
      totalScore: companies.totalScore,
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

  // 2. Build peer-group medians: sector × country
  const peerGroups = new Map<string, number[]>();
  for (const c of allCompanies) {
    const key = peerKey(c.sector, c.country);
    if (!peerGroups.has(key)) peerGroups.set(key, []);
    peerGroups.get(key)!.push(c.totalScore! * 100); // stored as 0-1, display as 0-100%
  }

  // Also build sector-only fallback groups (for when sector×country is too small)
  const sectorGroups = new Map<string, number[]>();
  for (const c of allCompanies) {
    const sKey = (c.sector || "Unknown").toLowerCase();
    if (!sectorGroups.has(sKey)) sectorGroups.set(sKey, []);
    sectorGroups.get(sKey)!.push(c.totalScore! * 100);
  }

  function median(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  // 3. For each company in this batch, compute expected score and residual
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
    const actualPct = c.totalScore * 100;
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

    const expectedPct = median(peerScores);
    const residual = actualPct - expectedPct;

    if (Math.abs(residual) > RESIDUAL_THRESHOLD) {
      const direction = residual > 0 ? "above" : "below";
      const reason = `Score ${actualPct.toFixed(0)}% is ${Math.abs(residual).toFixed(0)}pp ${direction} peer median ${expectedPct.toFixed(0)}% (${groupLabel}, n=${peerScores.length})`;

      anomalies.push({
        companyId: c.id,
        companyName: c.name,
        sector: c.sector,
        country: c.country,
        actualScore: actualPct,
        expectedScore: expectedPct,
        residual,
        peerGroupSize: peerScores.length,
        peerGroupMedian: expectedPct,
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

    console.log(`[AnomalyDetection] Batch ${batchId}: flagged ${anomalies.length} outliers (threshold ±${RESIDUAL_THRESHOLD}pp)`);
  } else {
    console.log(`[AnomalyDetection] Batch ${batchId}: no outliers detected`);
  }

  return anomalies.length;
}
