/**
 * STEP 2 — `builder_improve` semantic pass over the combined D1 + D2 + D3
 * findings, via the existing LLM client, under a Goodhart / anti-homogenisation
 * guard (SKILL.md §8.4).
 *
 * What this adds over the deterministic detectors: a qualitative pass that spots
 * builder weaknesses the regexes cannot (instructions phrased for one topic but
 * presented as general rules; a construction rule that is technically present but
 * under-specified). It REUSES the repo LLM client (`completeWithFallback`); the
 * provider and model are configurable. When no provider is available it falls
 * back to a direct Abacus LLM-gateway HTTP call (base URL env-configurable).
 *
 * Guard (SKILL §8.4) — non-negotiable, enforced deterministically AFTER the model
 * returns, so a chatty model cannot bypass it:
 *  - Every accepted proposal MUST carry a STRUCTURAL root cause (a validator rule
 *    it contradicts/omits, or a referenced D1/D2/D3 finding id) — never merely
 *    "the reviewer prefers X". This keeps the deterministic validators, not the
 *    LLM, as ground truth.
 *  - The compliance % stays ADVISORY; blocking errors from the deterministic
 *    validators remain the real gate.
 *  - Anti-homogenisation: reject any proposal that would push all frameworks
 *    toward the same measurable proxy / increase cross-framework uniformity /
 *    reduce topic fit.
 *
 * implemented != verified-fixed: accepted proposals are hypotheses; only an
 * operator-triggered regeneration verifies them on a live validator run.
 */

export interface StructuralFinding {
  id: string; // e.g. "bd-C4", "ledger-c5-...", "ga-167-TCFD"
  source: "D1" | "D2" | "D3";
  rule: string; // validator rule code or defect class
  field?: string;
  summary: string;
}

export interface SemanticProposal {
  id: string;
  targetRule: string;
  field: string;
  rationale: string;
  proposedBuilderEdit: string;
  // The structural anchor: a finding id from the input set, or a validator rule
  // code. REQUIRED by the guard; a proposal without a resolvable anchor is
  // rejected as "reviewer preference".
  rootCauseRef: string;
  // Optional self-declared basis; "reviewer-preference" is always rejected.
  basis?: "structural-drift" | "recurrence" | "generalisation" | "reviewer-preference";
}

export interface GuardRejection {
  proposal: SemanticProposal;
  reason: string;
}

export interface BuilderImproveResult {
  accepted: SemanticProposal[];
  rejected: GuardRejection[];
  provider: string | null;
  model: string;
  guard: {
    structuralRootCauseRequired: true;
    complianceScoreAdvisoryOnly: true;
    antiHomogenisationApplied: true;
  };
  note: string;
  raw?: string; // raw model text, for debugging (never auto-applied)
}

export interface CompleteFn {
  (opts: { system: string; prompt: string; maxTokens?: number; json?: boolean; temperature?: number }):
    Promise<{ text: string; provider: string }>;
}

export interface BuilderImproveOptions {
  provider?: string; // default env BUILDER_REVIEW_PROVIDER || "claude"
  model?: string; // default env BUILDER_REVIEW_MODEL || "claude-sonnet-4-5-20250929"
  complete?: CompleteFn; // injectable for tests; defaults to the repo LLM client
}

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

const GUARD_NOTE =
  "Goodhart guard active (SKILL §8.4): every proposal is anchored to a structural " +
  "root cause (a validator rule or a D1/D2/D3 finding); the compliance score is " +
  "advisory only and deterministic validators remain ground truth; anti-" +
  "homogenisation rejects edits that increase cross-framework uniformity. " +
  "implemented != verified-fixed — an operator regeneration verifies any applied edit.";

// Phrases in a proposed edit that indicate it would homogenise frameworks toward
// a single measurable proxy (reduces topic fit / increases uniformity). Topic-
// agnostic — these are about SAMENESS, not about any particular topic.
const HOMOGENISATION_MARKERS = [
  /\ball frameworks\b.*\b(same|identical|single|one)\b/i,
  /\b(force|make|require)\b.*\ball (topics|frameworks)\b/i,
  /\bsame (measurable )?(proxy|metric|threshold|wording|template)\b.*\b(every|all)\b/i,
  /\b(uniform|identical|homogen\w*)\b/i,
  /\bidentical (across|for all)\b/i,
  /\bone-size-fits-all\b/i,
];

const REVIEWER_PREFERENCE_MARKERS = [
  /\b(reviewer|i|we) (prefer|would prefer|like|think it reads better|feel)\b/i,
  /\b(stylistic|cosmetic|nicer|cleaner wording)\b/i,
];

/** Does a proposal carry a resolvable structural root cause? (Goodhart ground-truth rule.) */
export function hasStructuralRootCause(
  p: SemanticProposal,
  knownFindingIds: Set<string>,
  knownRules: Set<string>,
): boolean {
  if (p.basis === "reviewer-preference") return false;
  const ref = String(p.rootCauseRef || "").trim();
  if (!ref) return false;
  if (knownFindingIds.has(ref)) return true;
  // A bare validator rule code (e.g. "C4", "DEF") is also a structural anchor.
  if (knownRules.has(ref)) return true;
  if (knownRules.has(String(p.targetRule || "").trim())) return true;
  return false;
}

/** Would this proposal homogenise frameworks toward a single proxy? (Anti-homogenisation.) */
export function isHomogenising(p: SemanticProposal): boolean {
  const hay = `${p.proposedBuilderEdit || ""} ${p.rationale || ""}`;
  return HOMOGENISATION_MARKERS.some((re) => re.test(hay));
}

function looksLikeReviewerPreference(p: SemanticProposal): boolean {
  const hay = `${p.rationale || ""}`;
  return REVIEWER_PREFERENCE_MARKERS.some((re) => re.test(hay));
}

/**
 * Apply the Goodhart / anti-homogenisation guard to a set of candidate semantic
 * proposals. Pure and deterministic — this is the part under test, independent
 * of the model. Returns accepted + rejected (with reasons).
 */
export function applyGoodhartGuard(
  proposals: SemanticProposal[],
  findings: StructuralFinding[],
): { accepted: SemanticProposal[]; rejected: GuardRejection[] } {
  const knownFindingIds = new Set(findings.map((f) => f.id));
  const knownRules = new Set<string>();
  for (const f of findings) if (f.rule) knownRules.add(f.rule);
  const accepted: SemanticProposal[] = [];
  const rejected: GuardRejection[] = [];
  for (const p of proposals) {
    if (!hasStructuralRootCause(p, knownFindingIds, knownRules) || looksLikeReviewerPreference(p)) {
      rejected.push({
        proposal: p,
        reason:
          "No structural root cause: not anchored to a validator rule or a D1/D2/D3 finding " +
          "(or self-declared as reviewer preference). The deterministic validators remain ground truth.",
      });
      continue;
    }
    if (isHomogenising(p)) {
      rejected.push({
        proposal: p,
        reason:
          "Anti-homogenisation guard: this edit would push frameworks toward the same measurable " +
          "proxy / increase cross-framework uniformity, reducing topic fit.",
      });
      continue;
    }
    accepted.push(p);
  }
  return { accepted, rejected };
}

function buildSystemPrompt(): string {
  return [
    "You are auditing a CompanyIQ v3 framework BUILDER prompt (a topic-agnostic generator).",
    "You are given deterministic findings from three detectors:",
    "  D1 = builder<->validator drift, D2 = recurring-defect ledger promotions, D3 = generalisation audit.",
    "Your job: propose BUILDER improvements the regex detectors cannot catch (instructions phrased",
    "for one topic but presented as general rules; a rule that is present but under-specified).",
    "",
    "HARD CONSTRAINTS (your output is filtered deterministically; violations are discarded):",
    "1. Every proposal MUST set `rootCauseRef` to the id of one of the supplied findings, or to a",
    "   validator rule code it contradicts/omits. Proposals without a structural anchor are rejected.",
    "2. NEVER propose a change merely because it reads better/you prefer it. Structural root cause only.",
    "3. NEVER propose an edit that makes all frameworks use the same measurable proxy, the same wording,",
    "   or otherwise increases cross-framework uniformity / reduces topic fit.",
    "4. Topic-agnostic: never name a specific company or topic; use placeholders.",
    "5. These are GATED proposals; they are never auto-applied. implemented != verified-fixed.",
    "",
    "Return STRICT JSON only: {\"proposals\":[{\"id\":string,\"targetRule\":string,\"field\":string,",
    "\"rationale\":string,\"proposedBuilderEdit\":string,\"rootCauseRef\":string,\"basis\":string}]}",
  ].join("\n");
}

function buildUserPrompt(findings: StructuralFinding[]): string {
  return (
    "FINDINGS (structural, from the deterministic detectors):\n" +
    JSON.stringify(findings, null, 2) +
    "\n\nPropose builder improvements per the constraints. Return ONLY the JSON object."
  );
}

/** Extract the outermost JSON object from a model response (mirrors the PoC). */
export function extractJsonObject(text: string): any {
  const t = String(text || "").trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) throw new Error("no JSON object found in model output");
  return JSON.parse(t.slice(s, e + 1));
}

/**
 * Default LLM completion: reuse the repo client (`completeWithFallback`) and, if
 * no provider is available, fall back to a direct Abacus LLM-gateway HTTP call.
 * Lazy-imported so unit tests (which inject `complete`) never touch the network.
 */
async function defaultComplete(provider: string, model: string): Promise<CompleteFn> {
  return async (opts) => {
    try {
      const { completeWithFallback } = await import("../ai-providers.js");
      const r = await completeWithFallback(provider, {
        system: opts.system,
        prompt: opts.prompt,
        maxTokens: opts.maxTokens ?? 4000,
        json: opts.json ?? true,
        temperature: opts.temperature ?? 0.2,
        callType: "builder-improve",
      });
      return { text: r.text, provider: r.provider };
    } catch (primaryErr: any) {
      // Fallback: direct Abacus gateway (base URL env-configurable).
      const base = (process.env.ABACUS_LLM_BASE_URL || "https://routellm.abacus.ai/v1").replace(/\/$/, "");
      const key = process.env.ABACUS_API_KEY;
      if (!key) {
        throw new Error(
          `[builder-improve] LLM client failed (${primaryErr?.message || primaryErr}) and no ABACUS_API_KEY for gateway fallback`,
        );
      }
      const resp = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.prompt },
          ],
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 4000,
        }),
      });
      if (!resp.ok) throw new Error(`[builder-improve] gateway HTTP ${resp.status}`);
      const j: any = await resp.json();
      return { text: j?.choices?.[0]?.message?.content ?? "", provider: `abacus-gateway:${model}` };
    }
  };
}

/**
 * Run the semantic pass and return guard-filtered proposals. The LLM call is
 * injectable (`opts.complete`) so the guard can be tested without a network call.
 */
export async function builderImprove(
  findings: StructuralFinding[],
  opts: BuilderImproveOptions = {},
): Promise<BuilderImproveResult> {
  const provider = opts.provider || process.env.BUILDER_REVIEW_PROVIDER || "claude";
  const model = opts.model || process.env.BUILDER_REVIEW_MODEL || DEFAULT_MODEL;
  const complete = opts.complete || (await defaultComplete(provider, model));

  const result = await complete({
    system: buildSystemPrompt(),
    prompt: buildUserPrompt(findings),
    maxTokens: 4000,
    json: true,
    temperature: 0.2,
  });

  let candidates: SemanticProposal[] = [];
  let raw = result.text;
  try {
    const obj = extractJsonObject(result.text);
    candidates = Array.isArray(obj?.proposals) ? obj.proposals : [];
  } catch {
    candidates = []; // fail-safe: a malformed model reply yields zero proposals, never a crash
  }

  const { accepted, rejected } = applyGoodhartGuard(candidates, findings);
  return {
    accepted,
    rejected,
    provider: result.provider ?? provider,
    model,
    guard: {
      structuralRootCauseRequired: true,
      complianceScoreAdvisoryOnly: true,
      antiHomogenisationApplied: true,
    },
    note: GUARD_NOTE,
    raw,
  };
}
