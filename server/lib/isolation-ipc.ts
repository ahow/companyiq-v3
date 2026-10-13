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

// ─── Descendant process groups ───────────────────────────────────────────────
// Puppeteer launches Chromium with detached:true (@puppeteer/browsers launch.js),
// i.e. in its OWN process group, so killing the job child's group does not reach
// it. A child registers every such group here: the parent kills them on child
// exit/kill, and the child's parent-death watchdog kills them if the parent dies.
const groupListeners: Array<(pid: number) => void> = [];
export function onDescendantGroup(fn: (pid: number) => void): void { groupListeners.push(fn); }
/** Register a detached descendant (its pid == its process-group id). No-op outside a child. */
export function registerDescendantGroup(pid: number | undefined | null): void {
  if (!pid || !isIsolatedChild()) return;
  sendToParent({ t: "pgroup", pid });
  for (const fn of groupListeners) { try { fn(pid); } catch { /* best effort */ } }
}

/** Test/diagnostic view of the child-side permit bookkeeping. */
export function remotePermitState(): { pending: number; outstanding: Record<PermitKind, number> } {
  return {
    pending: pending.size,
    outstanding: { llm: outstanding.llm.length, browser: outstanding.browser.length, proc: outstanding.proc.length },
  };
}

// ─── Operation / lease events (batch-1277 timeout explainability) ─────────────
// Compact events that let a future timeout be explained AFTER the fact: which
// operation (job/attempt/op id, origin, URL count) was queued for / holding /
// released the browser permit and when. They are sent SYNCHRONOUSLY over the IPC
// channel (process.send writes to the pipe immediately) so the last event
// survives a subsequent child SIGKILL — the parent keeps the latest child stage
// plus the set of still-outstanding operations (job-isolation.ts).
export type LeaseEventKind = "acquire" | "granted" | "released" | "settled";
export interface LeaseEvent {
  ev: LeaseEventKind;
  op: string;                 // operation id (unique within the child)
  kind?: PermitKind;          // permit kind (browser)
  origin?: string | null;     // request origin, when known
  urls?: number;              // URL count for a batch recovery op
  job?: number | null;        // owning job id
  attempt?: number | null;    // owning attempt number
  outcome?: string;           // settle/release outcome (ok / aborted / error …)
  at: number;                 // wall-clock ms
}

let leaseSeq = 0;
/** Unique-within-this-child operation id for lease correlation. */
export function nextOpId(prefix = "op"): string {
  return `${prefix}-${process.pid}-${++leaseSeq}`;
}

/**
 * Emit a compact lease event to the parent. No-op outside an isolated child.
 * Synchronous IPC write (sendToParent → process.send) so the event is on the
 * wire before the caller can be SIGKILLed.
 */
export function emitLeaseEvent(e: Omit<LeaseEvent, "at"> & { at?: number }): void {
  if (!isIsolatedChild()) return;
  sendToParent({ t: "lease", ...e, at: e.at ?? Date.now() });
}
