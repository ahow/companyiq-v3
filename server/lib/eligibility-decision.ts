/**
 * eligibility-decision.ts — A3 / WP04: preserve entity, provenance and temporal
 * eligibility end to end.
 *
 * WHY (plan §"A3. Preserve entity, provenance and temporal eligibility end to
 * end (WP04)"):
 *   The app ALREADY has identity/provenance controls — classifyProvenance()
 *   (issuer vs third_party), applyProvenanceGate() (scoring-time downgrade when
 *   every quote is third-party), the chunk-sanity entity/vintage gate, and the
 *   five advisory eligibility flags. The A3 concern is NOT that any single one
 *   of those is broken; it is their COMPOSITION across stages:
 *     - a decision made at discovery can be re-derived differently (or dropped)
 *       by the time it reaches the arbiter, so there is no ONE immutable
 *       eligibility fact travelling with a passage;
 *     - a fallback that "repairs" a missing sourceUrl/provenance could silently
 *       turn a third-party EXCLUSION back into support;
 *     - shared source bytes reused across targets (Lane B / WP12 caching) could
 *       carry a decision computed for a DIFFERENT target;
 *     - the framework's own parent/subsidiary scope is not applied uniformly (a
 *       group policy may count for a subsidiary in one framework but not
 *       another).
 *
 * WHAT THIS MODULE IS:
 *   A deterministic, pure, DB-free COMPOSITION GUARDRAIL that produces a single
 *   IMMUTABLE (frozen) EligibilityDecision per (source, target) pair, with four
 *   load-bearing invariants:
 *     (I1) PER-TARGET RECOMPUTE — a decision is bound to the target it was
 *          computed for; reused source bytes are ALWAYS recomputed for the new
 *          target and a decision from another target can never be inherited.
 *     (I2) MONOTONIC EXCLUSION — a fallback/repair may fill UNKNOWN provenance
 *          (review -> eligible) but can NEVER override an EXCLUSION
 *          (excluded -> eligible/review is impossible).
 *     (I3) SCOPE RULES — a subsidiary passage supports a parent-wide claim only
 *          when the framework's scopePolicy is "group_consolidated".
 *     (I4) INCOMPLETE -> REVIEW, NOT AUTHORITY — missing provenance yields
 *          `review` (repair/human), never a silent assumption of eligibility.
 *
 * It COMPOSES the existing classifyProvenance() control rather than replacing
 * it, so entity/issuer recognition stays single-sourced.
 *
 * VERSIONING (mirrors the A2 EVIDENCE_GATE_POLICY precedent):
 *   resolveEligibilityPolicy() reads env ELIGIBILITY_POLICY (default "v2").
 *     - v2 (default): compose + enforce the four invariants above.
 *     - v1 (kill switch): legacy passthrough — every decision is "eligible"
 *       (advisory), reproducing pre-A3 behaviour with no composition enforced.
 *   This lets the behavioural layer be disabled without a redeploy.
 *
 * SAFETY: every exported function is total (never throws on bad input) and
 * returns a frozen object, so a carried decision cannot be mutated downstream.
 */

import { classifyProvenance } from "./provenance.js";
import { deriveAliases } from "./issuer-resolver.js";

// ─── Policy version ──────────────────────────────────────────────────────────

export type EligibilityPolicyVersion = "v1" | "v2";

export const DEFAULT_ELIGIBILITY_POLICY: EligibilityPolicyVersion = "v2";

/**
 * Resolve the active policy: explicit arg > env ELIGIBILITY_POLICY > default v2.
 * Any unrecognised value falls back to the default (fail-safe to hardened).
 */
export function resolveEligibilityPolicy(
  explicit?: EligibilityPolicyVersion | null,
): EligibilityPolicyVersion {
  if (explicit === "v1" || explicit === "v2") return explicit;
  const env = (process.env.ELIGIBILITY_POLICY || "").trim().toLowerCase();
  if (env === "v1") return "v1";
  if (env === "v2") return "v2";
  return DEFAULT_ELIGIBILITY_POLICY;
}

// ─── Core types ──────────────────────────────────────────────────────────────

export type EligibilityStatus = "eligible" | "excluded" | "review";

/**
 * Source class — how the source relates to being authoritative FOR the target.
 *   issuer_self        — on the target's own domain / IR identity.
 *   issuer_filed       — filed by the issuer on a regulator host (counts as issuer).
 *   analyst_commentary — third-party coverage/commentary ABOUT the target.
 *   third_party        — any other third-party source.
 *   unknown            — provenance could not be determined (missing url etc.).
 */
export type SourceClass =
  | "issuer_self"
  | "issuer_filed"
  | "analyst_commentary"
  | "third_party"
  | "unknown";

/**
 * Entity relation — how the ENTITY the source speaks about relates to the target.
 *   self             — the target itself.
 *   subsidiary       — a subsidiary of the target (scope-dependent, see I3).
 *   parent           — the target's parent (a parent-wide claim is not the target's).
 *   affiliate        — sibling/affiliate in the same group.
 *   supplier_customer— a supplier/customer mention (never the issuer's own practice).
 *   unrelated        — a different, unrelated entity (e.g. similarly named company).
 *   unknown          — relation could not be determined.
 */
export type EntityRelation =
  | "self"
  | "subsidiary"
  | "parent"
  | "affiliate"
  | "supplier_customer"
  | "unrelated"
  | "unknown";

/**
 * Framework scope policy for parent/subsidiary attribution.
 *   entity_only        — only the assessed entity's own disclosures count.
 *   group_consolidated — group/parent policies apply to the subsidiary and
 *                        subsidiary disclosures may support a group-wide claim.
 */
export type ScopePolicy = "entity_only" | "group_consolidated";

export const DEFAULT_SCOPE_POLICY: ScopePolicy = "entity_only";

/** The immutable eligibility fact that travels with a document/passage. */
export interface EligibilityDecision {
  readonly policyVersion: EligibilityPolicyVersion;
  /** Stable key of the TARGET this decision was computed FOR (I1 guard). */
  readonly targetKey: string;
  readonly entityRelation: EntityRelation;
  readonly sourceClass: SourceClass;
  /** Publication / as-of year of the source, when known. */
  readonly asOfYear: number | null;
  /** Source version tag, when known. */
  readonly version: string | null;
  /** Id/URL of a newer version that supersedes this source, when known. */
  readonly supersededBy: string | null;
  readonly scopePolicy: ScopePolicy;
  readonly status: EligibilityStatus;
  /** Ordered, append-only audit reasons. */
  readonly reasons: readonly string[];
  /** Whether a repair filled previously-missing provenance. */
  readonly repaired: boolean;
}

export interface EligibilityTarget {
  /** Stable id (company id). Used to bind the decision to the target (I1). */
  id?: number | string | null;
  name: string;
  ticker?: string | null;
  aliases?: string[] | null;
  domain?: string | null;
  relatedDomains?: string[] | null;
  isin?: string | null;
  secCik?: string | null;
  isUnlisted?: boolean;
}

export interface EligibilitySource {
  url?: string | null;
  title?: string | null;
  content?: string | null;
  /** Explicit as-of/publication year if the caller already knows it. */
  asOfYear?: number | null;
  version?: string | null;
  /** When set, a newer source supersedes this one (temporal exclusion, I3). */
  supersededBy?: string | null;
  /**
   * Caller-supplied entity relation when it is already known from the corpus
   * (e.g. a subsidiary/supplier mention detected upstream). When omitted the
   * relation is inferred from provenance + identity tokens.
   */
  entityRelation?: EntityRelation;
}

export interface EligibilityFrameworkScope {
  scopePolicy?: ScopePolicy;
  /** Most-recent relevant year (defaults to current UTC year). */
  currentYear?: number;
  /** How many years back count as in-window (defaults to 3). */
  yearsBack?: number;
  /**
   * When true the measure is a CURRENT-STATE question: a superseded / out-of-
   * window source cannot satisfy it (EP03). Defaults to false (historical facts
   * tolerated) so the guardrail never over-fires on undated evidence.
   */
  currentStateRequired?: boolean;
  /**
   * When true the measure requires ISSUER-authored evidence; third-party
   * analyst commentary alone cannot satisfy it (EP04). Defaults to false.
   */
  requiresIssuerSource?: boolean;
}

export interface EligibilityDecisionInput {
  target: EligibilityTarget;
  source: EligibilitySource;
  framework?: EligibilityFrameworkScope;
  policyVersion?: EligibilityPolicyVersion | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nonEmpty(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/** Stable, deterministic key for a target (id preferred, else name+ticker). */
export function targetKeyOf(target: EligibilityTarget): string {
  const id = target?.id;
  if (id !== undefined && id !== null && String(id).trim() !== "") {
    return `id:${String(id).trim()}`;
  }
  const name = (target?.name || "").trim().toLowerCase();
  const tkr = (target?.ticker || "").trim().toLowerCase();
  return `nm:${name}|tk:${tkr}`;
}

/** Distinctive lowercase identity tokens for a target. */
function identityTokens(target: EligibilityTarget): string[] {
  const toks = new Set<string>();
  const name = (target.name || "").trim();
  if (name) {
    for (const a of deriveAliases(name, target.ticker ?? null)) {
      const t = a.toLowerCase().trim();
      if (t.length >= 3) toks.add(t);
    }
    for (const w of name.toLowerCase().replace(/[/\\,.'()&]+/g, " ").split(/\s+/)) {
      if (w.length >= 4) toks.add(w);
    }
  }
  const tkr = (target.ticker || "").toLowerCase().trim();
  if (tkr.length >= 2) toks.add(tkr);
  for (const a of target.aliases || []) {
    if (nonEmpty(a) && a.trim().length >= 3) toks.add(a.toLowerCase().trim());
  }
  return Array.from(toks);
}

/** Extract a plausible 4-digit year from explicit field, then url/title. */
function inferAsOfYear(source: EligibilitySource, currentYear: number): number | null {
  if (typeof source.asOfYear === "number" && Number.isFinite(source.asOfYear)) {
    return source.asOfYear;
  }
  const hay = `${source.url || ""} ${source.title || ""}`;
  const years = Array.from(hay.matchAll(/\b(19\d{2}|20\d{2})\b/g))
    .map((m) => parseInt(m[1], 10))
    .filter((y) => y >= 1990 && y <= currentYear + 1);
  if (years.length === 0) return null;
  return Math.max(...years);
}

function freeze(d: EligibilityDecision): EligibilityDecision {
  return Object.freeze({ ...d, reasons: Object.freeze([...d.reasons]) }) as EligibilityDecision;
}

// ─── Composition ─────────────────────────────────────────────────────────────

/**
 * Compose the immutable eligibility decision for one (source, target) pair.
 * Pure and total. Under policy v1 this is a legacy passthrough that always
 * returns `eligible` (advisory); under v2 it enforces the four invariants.
 */
export function composeEligibilityDecision(
  input: EligibilityDecisionInput,
): EligibilityDecision {
  const policy = resolveEligibilityPolicy(input?.policyVersion);
  const target = input?.target ?? ({ name: "" } as EligibilityTarget);
  const source = input?.source ?? ({} as EligibilitySource);
  const fw = input?.framework ?? {};
  const scopePolicy: ScopePolicy = fw.scopePolicy ?? DEFAULT_SCOPE_POLICY;
  const currentYear = fw.currentYear ?? new Date().getUTCFullYear();
  const yearsBack = fw.yearsBack ?? 3;
  const targetKey = targetKeyOf(target);
  const asOfYear = inferAsOfYear(source, currentYear);
  const reasons: string[] = [];

  // ── v1 kill switch: legacy advisory passthrough ───────────────────────────
  if (policy === "v1") {
    return freeze({
      policyVersion: "v1",
      targetKey,
      entityRelation: source.entityRelation ?? "unknown",
      sourceClass: "unknown",
      asOfYear,
      version: source.version ?? null,
      supersededBy: source.supersededBy ?? null,
      scopePolicy,
      status: "eligible",
      reasons: ["v1 legacy passthrough — A3 composition disabled (ELIGIBILITY_POLICY=v1)"],
      repaired: false,
    });
  }

  // ── v2 composition ────────────────────────────────────────────────────────

  // (1) Provenance / source class — composed over the existing classifier.
  const hasUrl = nonEmpty(source.url);
  let sourceClass: SourceClass = "unknown";
  let provIssuer = false;
  let regulator = false;
  if (hasUrl) {
    try {
      const prov = classifyProvenance({
        url: source.url as string,
        title: source.title ?? null,
        content: source.content ?? null,
        companyDomain: target.domain ?? null,
        relatedDomains: target.relatedDomains ?? null,
        companyName: target.name ?? null,
        companyTicker: target.ticker ?? null,
        companyAliases: target.aliases ?? null,
        companyIsin: target.isin ?? null,
        companySecCik: target.secCik ?? null,
      });
      provIssuer = prov.provenance === "issuer";
      regulator = !!prov.regulatorHost;
      sourceClass = provIssuer
        ? regulator
          ? "issuer_filed"
          : "issuer_self"
        : "analyst_commentary";
      reasons.push(`provenance=${prov.provenance} (${prov.reason})`);
    } catch {
      sourceClass = "unknown";
      reasons.push("provenance classification error — treated as unknown");
    }
  } else {
    reasons.push("no source url — provenance unknown");
  }

  // (2) Entity relation — caller-supplied wins; else infer from provenance +
  //     identity-token presence in title/content.
  let entityRelation: EntityRelation = source.entityRelation ?? "unknown";
  if (!source.entityRelation) {
    if (provIssuer) {
      entityRelation = "self";
    } else if (hasUrl) {
      const toks = identityTokens(target);
      const hay = `${source.title || ""} ${source.content || ""}`.toLowerCase();
      const mentionsTarget = toks.length > 0 && toks.some((t) => hay.includes(t));
      // Third-party that does mention the target → commentary about it (self
      // subject but non-issuer source). Third-party that does NOT mention the
      // target → likely a different/unrelated entity.
      entityRelation = mentionsTarget ? "self" : "unrelated";
    }
  }
  reasons.push(`entityRelation=${entityRelation}`);

  // (3) Compose status. Start optimistic, then apply exclusions and review.
  let status: EligibilityStatus = "eligible";

  // 3a. Wrong-entity exclusions — never infer the issuer's practice from a
  //     supplier/customer reference, an unrelated company, or a parent-wide
  //     claim. These are hard exclusions.
  if (entityRelation === "supplier_customer" || entityRelation === "unrelated" || entityRelation === "parent") {
    status = "excluded";
    reasons.push(`EXCLUDED: entity relation '${entityRelation}' is not the assessed issuer`);
  }

  // 3b. Subsidiary scope (I3). A subsidiary passage supports a parent/group
  //     claim only when the framework consolidates the group.
  if (status === "eligible" && (entityRelation === "subsidiary" || entityRelation === "affiliate")) {
    if (scopePolicy === "group_consolidated") {
      reasons.push(`scope: '${entityRelation}' admitted under group_consolidated scope`);
    } else {
      status = "excluded";
      reasons.push(`EXCLUDED: '${entityRelation}' cannot support an entity_only claim (scopePolicy=entity_only)`);
    }
  }

  // 3c. Temporal — a current-state question cannot be satisfied by a superseded
  //     or out-of-window source (EP03).
  if (status === "eligible" && fw.currentStateRequired) {
    if (nonEmpty(source.supersededBy)) {
      status = "excluded";
      reasons.push(`EXCLUDED: source superseded by '${source.supersededBy}' for a current-state question`);
    } else if (asOfYear !== null && asOfYear < currentYear - yearsBack) {
      status = "excluded";
      reasons.push(`EXCLUDED: source year ${asOfYear} is outside the current window ${currentYear - yearsBack}-${currentYear}`);
    }
  }

  // 3d. Source authority — a measure that requires issuer-authored evidence is
  //     not satisfied by analyst commentary alone (EP01/EP04).
  if (status === "eligible" && fw.requiresIssuerSource) {
    // Any non-issuer, non-unknown class (analyst commentary / other third party)
    // cannot satisfy an issuer-source requirement. `unknown` is left to fall
    // through to the review branch (3e) rather than being hard-excluded here.
    const isIssuerSource = sourceClass === "issuer_self" || sourceClass === "issuer_filed";
    if (!isIssuerSource && sourceClass !== "unknown") {
      status = "excluded";
      reasons.push(`EXCLUDED: measure requires issuer source but sourceClass='${sourceClass}'`);
    }
  }

  // 3e. Incomplete provenance → REVIEW, never a silent assumption of authority
  //     (I4/EP06). Only downgrade to review when not already excluded.
  if (status === "eligible" && sourceClass === "unknown") {
    status = "review";
    reasons.push("REVIEW: provenance incomplete — repair or human review required, authority not assumed");
  }

  return freeze({
    policyVersion: "v2",
    targetKey,
    entityRelation,
    sourceClass,
    asOfYear,
    version: source.version ?? null,
    supersededBy: source.supersededBy ?? null,
    scopePolicy,
    status,
    reasons,
    repaired: false,
  });
}

/**
 * I1 — PER-TARGET RECOMPUTE. Always compose a FRESH decision for `target` from
 * the raw `source` bytes/signals, regardless of any decision previously
 * computed for another target. If `priorDecision` is supplied (e.g. from a
 * cache keyed on source bytes) it is accepted ONLY when it was computed for the
 * SAME target key AND the same policy; otherwise it is discarded and the
 * decision is recomputed. This is the guard that makes Lane-B byte reuse safe.
 */
export function recomputeForTarget(
  input: EligibilityDecisionInput,
  priorDecision?: EligibilityDecision | null,
): EligibilityDecision {
  const fresh = composeEligibilityDecision(input);
  if (
    priorDecision &&
    priorDecision.targetKey === fresh.targetKey &&
    priorDecision.policyVersion === fresh.policyVersion
  ) {
    // Same target + policy: the prior decision is legitimately reusable, but we
    // still return the freshly composed one (identical by construction) so a
    // stale cached object can never leak in. The equality check documents that
    // reuse is only ever same-target.
    return fresh;
  }
  // Different target (or no prior): the prior decision MUST NOT be inherited.
  return fresh;
}

/**
 * I2 — MONOTONIC REPAIR. A fallback may supply provenance that was previously
 * missing, turning a `review` into `eligible`, but it can NEVER override an
 * EXCLUSION. An excluded decision is returned unchanged. The repair recomposes
 * for the SAME target only (a repair carrying a different target is ignored).
 */
export function mergeEligibilityRepair(
  decision: EligibilityDecision,
  repair: EligibilityDecisionInput,
): EligibilityDecision {
  if (!decision) return composeEligibilityDecision(repair);

  // v1 passthrough: nothing to enforce.
  if (decision.policyVersion === "v1") return decision;

  // I2: an exclusion is final. No repair can resurrect it.
  if (decision.status === "excluded") {
    return freeze({
      ...decision,
      reasons: [...decision.reasons, "repair ignored: exclusion is monotonic and final (I2)"],
    });
  }

  const repaired = composeEligibilityDecision(repair);

  // The repair must be for the same target; otherwise ignore it (I1).
  if (repaired.targetKey !== decision.targetKey) {
    return freeze({
      ...decision,
      reasons: [...decision.reasons, `repair ignored: target mismatch (${repaired.targetKey} != ${decision.targetKey})`],
    });
  }

  // If the repair itself resolves to an exclusion, that exclusion stands
  // (repair can tighten, never loosen past an exclusion).
  if (repaired.status === "excluded") {
    return freeze({
      ...repaired,
      repaired: true,
      reasons: [...decision.reasons, "repair surfaced an exclusion", ...repaired.reasons],
    });
  }

  // Only a review decision can be upgraded by a repair (missing provenance
  // filled in). An already-eligible decision is left as-is.
  if (decision.status === "review" && repaired.status === "eligible") {
    return freeze({
      ...repaired,
      repaired: true,
      reasons: [...decision.reasons, "repair filled missing provenance → eligible", ...repaired.reasons],
    });
  }

  return decision;
}

/** True only when the decision admits the source as eligible evidence. */
export function isEligible(decision: EligibilityDecision | null | undefined): boolean {
  return !!decision && decision.status === "eligible";
}

/** Compact, stable serialization for persistence / export carry-through. */
export function serializeEligibilityDecision(d: EligibilityDecision): {
  policyVersion: EligibilityPolicyVersion;
  targetKey: string;
  entityRelation: EntityRelation;
  sourceClass: SourceClass;
  asOfYear: number | null;
  version: string | null;
  supersededBy: string | null;
  scopePolicy: ScopePolicy;
  status: EligibilityStatus;
  repaired: boolean;
  reasons: string[];
} {
  return {
    policyVersion: d.policyVersion,
    targetKey: d.targetKey,
    entityRelation: d.entityRelation,
    sourceClass: d.sourceClass,
    asOfYear: d.asOfYear,
    version: d.version,
    supersededBy: d.supersededBy,
    scopePolicy: d.scopePolicy,
    status: d.status,
    repaired: d.repaired,
    reasons: [...d.reasons],
  };
}
