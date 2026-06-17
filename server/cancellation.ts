/**
 * Cross-process batch cancellation.
 *
 * The web service handles POST /api/batch/cancel, but analysis runs in
 * separate worker replicas. An in-memory Set in the web process is invisible
 * to those workers, so a cancelled batch used to keep running until every
 * already-claimed / delayed job drained (observed as a multi-minute lag where
 * the "done" counter kept climbing after Cancel).
 *
 * This module stores the cancel signal in Redis so ALL replicas see it, and
 * exposes a *synchronous* `isBatchCancelledCached` for the pipeline's
 * `cancelCheck: () => boolean` contract. Each worker keeps a tiny local cache
 * that refreshes from Redis in the background (every CACHE_TTL_MS), so the hot
 * pipeline checkpoints never block on a network round-trip but still observe a
 * cancel within a couple of seconds.
 */

import { redis } from "./redis.js";

const KEY_PREFIX = "cancelled:batch:";
const REDIS_TTL_SECONDS = 60 * 60; // remember a cancel for 1 hour
const CACHE_TTL_MS = 2000; // refresh local cache at most every 2s

function key(batchId: number): string {
  return `${KEY_PREFIX}${batchId}`;
}

/** Persist the cancel signal so every replica can observe it. */
export async function markBatchCancelled(batchId: number): Promise<void> {
  try {
    await redis.set(key(batchId), "1", "EX", REDIS_TTL_SECONDS);
    // Update local cache immediately for the process that issued the cancel.
    cache.set(batchId, { cancelled: true, ts: Date.now() });
  } catch (err: any) {
    console.error(`[Cancellation] Failed to mark batch ${batchId} cancelled: ${err.message}`);
  }
}

/** Authoritative async check against Redis. */
export async function isBatchCancelled(batchId: number): Promise<boolean> {
  try {
    const v = await redis.get(key(batchId));
    const cancelled = v === "1";
    cache.set(batchId, { cancelled, ts: Date.now() });
    return cancelled;
  } catch (err: any) {
    console.error(`[Cancellation] Failed to read cancel flag for batch ${batchId}: ${err.message}`);
    // Fail open (treat as not cancelled) so a transient Redis blip doesn't kill a healthy run.
    return cache.get(batchId)?.cancelled ?? false;
  }
}

// ─── Synchronous cached view for the pipeline cancelCheck ────────────────────

const cache = new Map<number, { cancelled: boolean; ts: number }>();

/**
 * Synchronous, non-blocking cancel check for use inside the pipeline.
 * Returns the last known value and triggers a background refresh when stale.
 */
export function isBatchCancelledCached(batchId: number): boolean {
  const entry = cache.get(batchId);
  const now = Date.now();
  if (!entry || now - entry.ts > CACHE_TTL_MS) {
    // Kick off a non-blocking refresh; current call returns last known value
    // (false if never seen). The next checkpoint will observe the fresh value.
    void isBatchCancelled(batchId).catch(() => {});
    if (!entry) {
      // Seed an optimistic "not cancelled" so we don't spam refreshes.
      cache.set(batchId, { cancelled: false, ts: now });
      return false;
    }
  }
  return entry?.cancelled ?? false;
}

/** Drop local cache entry (e.g. after a batch finishes). */
export function forgetBatchCancellation(batchId: number): void {
  cache.delete(batchId);
}
