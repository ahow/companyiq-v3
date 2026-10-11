/**
 * Worker isolation — CHILD-side IPC client (docs/worker-isolation/DESIGN.md §5–§6).
 *
 * Leaf module: imports nothing from the pipeline, so ai-providers / processor /
 * llm-usage / adaptive-concurrency / credit-breaker can import it without cycles.
 *
 * In a normal (non-isolated) process every function here is inert:
 * isIsolatedChild() is false, so the hooked semaphores, usage buffer, adaptive
 * signals and credit breaker run their original local code paths unchanged.
 *
 * In an isolated job child (CIQ_ISOLATED_CHILD=1, forked with an IPC channel by
 * job-isolation.ts) the per-replica semaphores are BROKERED by the parent so
 * LLM_MAX_CONCURRENCY / MAX_CONCURRENT_BROWSER / MAX_CONCURRENT_SUBPROC stay
 * per-replica limits (not per-child), and telemetry/breaker events are forwarded
 * to the parent that owns the shared state.
 */

export type PermitKind = "llm" | "browser" | "proc";

export function isIsolatedChild(): boolean {
  return process.env.CIQ_ISOLATED_CHILD === "1" && typeof process.send === "function";
}

/** Fire-and-forget message to the parent. Never throws (channel may be closing). */
export function sendToParent(msg: unknown): void {
  try {
    if (process.connected) process.send!(msg as any);
  } catch { /* parent gone: the child exits on 'disconnect' */ }
}

// Broadcasts from the parent (e.g. another child's credit-breaker trip) are
// applied locally with forwarding suppressed, so they are never echoed back.
let suppressDepth = 0;
export function withForwardingSuppressed<T>(fn: () => T): T {
  suppressDepth++;
  try { return fn(); } finally { suppressDepth--; }
}
/** True when a hooked call site should forward to the parent instead of / in addition to acting locally. */
export function shouldForwardToParent(): boolean {
  return suppressDepth === 0 && isIsolatedChild();
}

// ─── Brokered permits ────────────────────────────────────────────────────────
// Releases at the call sites are argument-less (releaseLlmSlot() etc.), so the
// child keeps a FIFO of outstanding grant ids per kind; a release returns the
// oldest one. Permits are fungible within a kind, so which id is returned does
// not matter — only the count, which the parent enforces.

let seq = 0;
interface Pending { kind: PermitKind; resolve: () => void; cleanup: () => void }
const pending = new Map<number, Pending>();
const outstanding: Record<PermitKind, number[]> = { llm: [], browser: [], proc: [] };
let listening = false;

function ensureListener(): void {
  if (listening) return;
  listening = true;
  process.on("message", (m: any) => {
    if (!m || m.t !== "granted") return;
    const p = pending.get(m.id);
    if (!p) {
      // Granted after we cancelled the wait: hand the permit straight back.
      sendToParent({ t: "release", id: m.id });
      return;
    }
    pending.delete(m.id);
    p.cleanup();
    outstanding[p.kind].push(m.id);
    p.resolve();
  });
}

/**
 * Acquire one permit of `kind` from the parent. With a signal (LLM scoring
 * path) a queued wait is cancellable exactly like the local semaphore: on abort
 * the request is withdrawn and the promise rejects with `abortError()`.
 */
export function remoteAcquire(kind: PermitKind, signal?: AbortSignal | null, abortError?: () => Error): Promise<void> {
  ensureListener();
  const mkErr = () => (abortError ? abortError() : new Error(`${kind} permit wait aborted`));
  if (signal?.aborted) return Promise.reject(mkErr());
  const id = ++seq;
  return new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const cleanup = () => { if (onAbort && signal) signal.removeEventListener("abort", onAbort); };
    pending.set(id, { kind, resolve, cleanup });
    if (signal) {
      onAbort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        cleanup();
        sendToParent({ t: "cancelAcquire", id });
        reject(mkErr());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    sendToParent({ t: "acquire", id, kind });
  });
}

/** Return the oldest outstanding permit of `kind` to the parent (no-op if none). */
export function remoteRelease(kind: PermitKind): void {
  const id = outstanding[kind].shift();
  if (id !== undefined) sendToParent({ t: "release", id });
}

/** Test/diagnostic view of the child-side permit bookkeeping. */
export function remotePermitState(): { pending: number; outstanding: Record<PermitKind, number> } {
  return {
    pending: pending.size,
    outstanding: { llm: outstanding.llm.length, browser: outstanding.browser.length, proc: outstanding.proc.length },
  };
}
