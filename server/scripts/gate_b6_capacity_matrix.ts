/**
 * gate_b6_capacity_matrix.ts — B6 / WP14 one-variable capacity matrix.
 *
 * GIVEN a connection budget (+ overhead + connections-per-job + hard max) this prints,
 * for a sweep of replica counts, the computed per-replica worker concurrency and the
 * resulting worst-case total DB-connection load — so the operator can read the SAFE
 * operating point for ANY replica count WITHOUT touching production.
 *
 * It does NOT connect to the DB, does NOT change replica count, and does NOT mutate any
 * prod state. Pure read-out of the capacity-config module.
 *
 * Usage:
 *   npx tsx server/scripts/gate_b6_capacity_matrix.ts
 *   npx tsx server/scripts/gate_b6_capacity_matrix.ts --budget 90 --overhead 10 --cpj 2 --hardmax 10 --max-replicas 40
 */

import {
  DEFAULT_CAPACITY_CONFIG,
  computeDynamicConcurrency,
  maxSafeReplicas,
  totalConnectionLoad,
  checkCeilingInvariant,
  type CapacityConfig,
} from "../lib/capacity-config.js";

function argInt(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) {
    const n = parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

const budget = argInt("--budget", DEFAULT_CAPACITY_CONFIG.dbConnectionBudget);
const overhead = argInt("--overhead", DEFAULT_CAPACITY_CONFIG.reservedOverhead);
const cpj = argInt("--cpj", DEFAULT_CAPACITY_CONFIG.connectionsPerJob);
const hardMax = argInt("--hardmax", DEFAULT_CAPACITY_CONFIG.hardMax);
const maxReplicasToShow = argInt("--max-replicas", 40);

const base: Omit<CapacityConfig, "replicaCount"> = {
  dbConnectionBudget: budget,
  reservedOverhead: overhead,
  connectionsPerJob: cpj,
  hardMax,
  staticConcurrency: hardMax,
};

const safe = maxSafeReplicas({ ...base, replicaCount: 1 });

console.log("B6 / WP14 — one-variable capacity matrix");
console.log(
  `budget=${budget}  reservedOverhead=${overhead}  connectionsPerJob=${cpj}  ` +
    `HARD_MAX=${hardMax}  usable-DB-ceiling=97`,
);
console.log(
  `maxSafeReplicas = floor((${budget} - ${overhead}) / ${cpj}) = ${safe}  ` +
    `(beyond this, cut replicas — concurrency-1 would breach the ceiling)\n`,
);
console.log("replicas | per-replica concurrency | total DB load | within budget?");
console.log("---------|-------------------------|---------------|---------------");

const rows = new Set<number>([1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40]);
for (let r = 1; r <= maxReplicasToShow; r++) rows.add(r);

for (const r of [...rows].sort((a, b) => a - b)) {
  if (r > maxReplicasToShow) continue;
  const c: CapacityConfig = { ...base, replicaCount: r };
  const eff = computeDynamicConcurrency(c);
  const load = totalConnectionLoad(c, eff, r);
  const ok = checkCeilingInvariant(c, eff, r);
  console.log(
    `${String(r).padStart(8)} | ${String(eff).padStart(23)} | ${String(load).padStart(13)} | ${ok ? "yes" : "NO — cut replicas"}`,
  );
}
