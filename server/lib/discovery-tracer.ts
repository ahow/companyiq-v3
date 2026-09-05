// Discovery-to-Corpus per-URL trace.
//
// Purpose: when `DISCOVERY_TRACE_URLS` env var is set to a comma-separated list
// of substrings, log every time a matching URL enters or exits any filter/cap
// stage in the discovery pipeline. Off by default (zero runtime cost).
//
// Usage (in a Railway deploy, session env or one-off run):
//   DISCOVERY_TRACE_URLS="d812514d20f,newmont-approach-to-biodiversity,api.mziq.com/mzfilemanager/v2/d/c8182463"
//
// Substring matching is case-insensitive so callers can supply the discriminating
// portion of a truth-doc URL without worrying about scheme/host case.
//
// The tracer records lines like:
//   [TRACE] BHP Group | STAGE:addCandidate lane=general | KEEP | https://www.sec.gov/Archives/...
//   [TRACE] BHP Group | STAGE:preGateCap | DROP: excluded (unprotected, over cap) | ...
// Every DROP is annotated with the exact reason. Every KEEP is annotated with
// the current lane and any lane upgrade. Every stage transition is logged.

const rawList = (process.env.DISCOVERY_TRACE_URLS || "").trim();
const TRACE_SUBSTRINGS: string[] = rawList
  ? rawList.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
  : [];

export const TRACE_ENABLED = TRACE_SUBSTRINGS.length > 0;

export function traceMatches(url: string): boolean {
  if (!TRACE_ENABLED) return false;
  const lower = (url || "").toLowerCase();
  for (const needle of TRACE_SUBSTRINGS) if (lower.includes(needle)) return true;
  return false;
}

export function traceEvent(company: string, stage: string, verdict: "KEEP" | "DROP" | "INFO", detail: string, url: string): void {
  if (!TRACE_ENABLED) return;
  if (!traceMatches(url)) return;
  const tag = verdict === "DROP" ? "\u274c" : verdict === "KEEP" ? "\u2705" : "\u2139\ufe0f";
  // Keep the format machine-parseable so downstream scripts can slice by stage.
  console.log(`[TRACE] ${tag} ${company} | STAGE:${stage} | ${verdict}: ${detail} | ${url}`);
}

// Convenience wrappers for common patterns.
export function traceKeep(company: string, stage: string, url: string, detail = ""): void {
  traceEvent(company, stage, "KEEP", detail, url);
}
export function traceDrop(company: string, stage: string, url: string, reason: string): void {
  traceEvent(company, stage, "DROP", reason, url);
}
export function traceInfo(company: string, stage: string, url: string, detail: string): void {
  traceEvent(company, stage, "INFO", detail, url);
}

// One-shot summary for callers that want to log the whole traced-URL set once
// per run so grepping logs is easy.
export function traceSessionHeader(company: string, framework: string): void {
  if (!TRACE_ENABLED) return;
  console.log(`[TRACE] ================= ${company} \u00d7 ${framework} =================`);
  console.log(`[TRACE] Tracing ${TRACE_SUBSTRINGS.length} URL substrings: ${TRACE_SUBSTRINGS.join(", ")}`);
}
