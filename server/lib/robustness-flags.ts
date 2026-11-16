// ─── Framework Robustness Flags (FRAMEWORK_ROBUSTNESS_PLAN_20261116) ─────────
//
// Central registry for the env flags introduced by the robustness workstreams
// (W1..W8). Every change that touches the production scoring / discovery path is
// reversible via one of these flags. See DEPLOYED_FLAGS.md for the authoritative
// table of name / default / effect.
//
// Convention (matches server/lib/adaptive-concurrency.ts envFlag):
//   - default-ON flags are disabled only by an explicit "false" / "0"
//   - default-OFF flags are enabled only by an explicit "true" / "1"

function envFlagDefaultOn(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return true;
  const v = raw.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "off" && v !== "no";
}

function envFlagDefaultOff(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}

// W2 — Relevance-gate hardening
/** On persistent gate LLM error, KEEP the batch (defer to post-fetch content stage) instead of dropping 20 candidates. */
export const GATE_FAILOPEN = () => envFlagDefaultOn("GATE_FAILOPEN");
/** Split entity-disambiguation (strict) from topic-relevance (loosened); docType-matching candidates pass on identity alone. */
export const GATE_SPLIT_IDENTITY_TOPIC = () => envFlagDefaultOn("GATE_SPLIT_IDENTITY_TOPIC");

// W5 — Doc-type-aware discovery
/** Guarantee dedicated queries per declared disclosure vehicle AND a ranking boost so they survive the pre-gate cap / near-dup collapse. */
export const DOCTYPE_AWARE_DISCOVERY = () => envFlagDefaultOn("DOCTYPE_AWARE_DISCOVERY");

// W3 — Framework readiness gate
/** Enforce the framework readiness gate on activation (block / require override when a framework would fall to the generic 6-query fallback). */
export const FRAMEWORK_READINESS_GATE = () => envFlagDefaultOn("FRAMEWORK_READINESS_GATE");

// W1 — Frozen-corpus development workflow
/** Enable the frozen-corpus (lock / replay / re-discover) development controls on framework drafts. */
export const FROZEN_CORPUS_DEV = () => envFlagDefaultOn("FROZEN_CORPUS_DEV");

// W7 — Stalled-batch detection & auto-requeue
/** Detect zero-retrieval terminal companies (unresolved_gaps + coverage denominator 0) and auto-requeue instead of persisting false zeros. */
export const STALLED_BATCH_REQUEUE = () => envFlagDefaultOn("STALLED_BATCH_REQUEUE");

// W8 — Variance harness
/** Expose the framework variance report endpoint / view. */
export const VARIANCE_HARNESS = () => envFlagDefaultOn("VARIANCE_HARNESS");

// W6 — Multilingual evidence translation (DEFAULT OFF — spends money per passage)
/** Translate RETRIEVED EVIDENCE PASSAGES (not whole corpora) to English before grading. Costs per-passage LLM calls. */
export const MULTILINGUAL_EVIDENCE_TRANSLATE = () => envFlagDefaultOff("MULTILINGUAL_EVIDENCE_TRANSLATE");

// Shared helpers (exported for tests / reuse)
export { envFlagDefaultOn, envFlagDefaultOff };
