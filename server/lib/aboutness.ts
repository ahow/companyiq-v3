// Proposal A (part 2): post-fetch "primary-subject" aboutness scorer.
//
// The pre-fetch relevance gate only sees url/title/snippet, so it cannot tell an
// issuer's own analyst report from a peer benchmark the issuer happens to host.
// This scorer runs on the already-fetched body text (cheap string counting, no
// LLM) and generalises the pipeline's name-mention fallback into a graded
// decision. Policy is deliberately LENIENT: borderline documents are only
// down-weighted ("deprioritize"); a hard "reject" requires no cover-page anchoring,
// at most one target mention AND another entity outnumbering the target by
// ABOUTNESS_DOMINANCE_REJECT×. An over-tight gate would recreate keystone misses.
// Topic-agnostic: keys only off company identity (name/aliases/peers).

export const ABOUTNESS_ENABLED = (process.env.ABOUTNESS_ENABLED || "true").toLowerCase() !== "false";
export const ABOUTNESS_MIN_DENSITY = (() => {
  const v = parseFloat(process.env.ABOUTNESS_MIN_DENSITY || "0.5"); // weighted hits / 1k words
  return Number.isFinite(v) && v >= 0 ? v : 0.5;
})();
export const ABOUTNESS_DOMINANCE_REJECT = (() => {
  const v = parseFloat(process.env.ABOUTNESS_DOMINANCE_REJECT || "8"); // other:target
  return Number.isFinite(v) && v > 0 ? v : 8;
})();
/** Ranking multiplier applied to passages from "deprioritize" documents. */
export const ABOUTNESS_DEPRIORITIZE_WEIGHT = (() => {
  const v = parseFloat(process.env.ABOUTNESS_DEPRIORITIZE_WEIGHT || "0.5");
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.5;
})();

export interface AboutnessResult {
  density: number;          // weighted target mentions per 1,000 words (anchoring-boosted)
  dominanceRatio: number;   // targetHits / max(targetHits, topOtherHits), in [0,1]
  anchored: boolean;        // target named in the first ~2,000 chars (cover/title page)
  targetHits: number;
  topOther?: string;
  topOtherHits: number;
  decision: "keep" | "deprioritize" | "reject";
}

const STOP = new Set(["inc", "ltd", "plc", "corp", "group", "the", "and", "company", "limited",
  "corporation", "holdings", "international", "sa", "ag", "nv", "se"]);
const ORG_RE = /\b([A-Z][\w&.\-]+(?:\s+[A-Z][\w&.\-]+){0,4})\s+(?:S\.A\.|SA|plc|PLC|Inc\.?|AG|N\.V\.|SE|Ltd\.?|LLC|Corp\.?)(?![\w])/g;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function countTerm(hay: string, term: string): number {
  if (term.length < 3) return 0;
  const m = hay.match(new RegExp(`(?<![\\p{L}\\p{N}])${esc(term)}(?![\\p{L}\\p{N}])`, "giu"));
  return m ? m.length : 0;
}

export function scoreAboutness(
  text: string,
  companyName: string,
  aliases: string[] = [],
  peerCompanyNames: string[] = [],
): AboutnessResult {
  const body = (text || "").slice(0, 400_000);
  const words = Math.max(1, body.split(/\s+/).filter(Boolean).length);
  const lower = body.toLowerCase();

  // Target terms = full name + aliases + distinctive name tokens (same filter as
  // the pipeline's legacy name-mention fallback).
  const nameLower = (companyName || "").toLowerCase().trim();
  const nameTokens = nameLower.split(/[\s,.\-&]+/).filter(w => w.length >= 4 && !STOP.has(w));
  const targetTerms = [...new Set([nameLower, ...aliases.map(a => (a || "").toLowerCase().trim()), ...nameTokens])]
    .filter(t => t.length >= 3);
  const targetHits = targetTerms.length > 0 ? Math.max(0, ...targetTerms.map(t => countTerm(lower, t))) : 0;

  const head = lower.slice(0, 2000);
  const anchored = targetTerms.some(t => countTerm(head, t) > 0);
  const early = lower.slice(0, 3000);
  const namedEarly = anchored || targetTerms.some(t => countTerm(early, t) > 0);
  const firstPerson = namedEarly ? (lower.match(/\b(we|our|us)\b/g)?.length ?? 0) : 0;

  let density = ((targetHits + 0.25 * firstPerson) / words) * 1000;
  if (anchored) density *= 2;

  // Competing entities: workspace peers + generic legal-form organisation names.
  const isTarget = (s: string) => {
    const l = s.toLowerCase();
    return targetTerms.some(t => l.includes(t));
  };
  const others = new Map<string, number>();
  for (const p of peerCompanyNames) {
    const pl = (p || "").toLowerCase().trim();
    if (pl.length < 4 || isTarget(pl) || targetTerms.some(t => t.includes(pl))) continue;
    const n = countTerm(lower, pl);
    if (n > 0) others.set(pl, n);
  }
  for (const m of body.matchAll(ORG_RE)) {
    const org = m[1].trim();
    if (isTarget(org)) continue;
    const key = org.toLowerCase();
    others.set(key, (others.get(key) ?? 0) + 1);
  }
  let topOther: string | undefined;
  let topOtherHits = 0;
  for (const [k, v] of others) if (v > topOtherHits) { topOther = k; topOtherHits = v; }

  const dominanceRatio = targetHits / Math.max(1, targetHits, topOtherHits);

  let decision: AboutnessResult["decision"] = "keep";
  if (!anchored && targetHits <= 1 && topOtherHits >= ABOUTNESS_DOMINANCE_REJECT * Math.max(1, targetHits)) {
    decision = "reject";        // lenient floor: clearly about someone else
  } else if (density < ABOUTNESS_MIN_DENSITY || dominanceRatio < 0.5) {
    decision = "deprioritize";  // still graded, lower ranking weight
  }
  return { density, dominanceRatio, anchored, targetHits, topOther, topOtherHits, decision };
}

// ─── Per-company document weight registry (in-process) ──────────────────────
// The analyze phase registers a weight per document URL for the company it is
// assembling; passage retrieval multiplies each chunk's blended score by it.
// Keyed by companyId so concurrent companies never collide. Absent => 1.
const weightRegistry = new Map<string, Map<string, number>>();
const normUrl = (u: string) => (u || "").trim().toLowerCase().replace(/\/+$/, "");

export function setAboutnessDocWeights(companyId: number | string, weights: Map<string, number>): void {
  const m = new Map<string, number>();
  for (const [u, w] of weights) if (w > 0 && w < 1) m.set(normUrl(u), w);
  if (m.size > 0) weightRegistry.set(String(companyId), m);
  else weightRegistry.delete(String(companyId));
}

export function getAboutnessDocWeight(companyId: number | string | undefined, docUrl: string | undefined): number {
  if (companyId === undefined || companyId === null || !docUrl) return 1;
  return weightRegistry.get(String(companyId))?.get(normUrl(docUrl)) ?? 1;
}
