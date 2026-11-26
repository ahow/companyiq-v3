// ─── W3 — Framework readiness gate (preflight) ───────────────────────────────
//
// Scores a framework's completeness over its QUERY-DRIVING fields. The goal is a
// structural guarantee that no framework ships under-configured — i.e. silently
// falling back to the six-query generic fallback in discovery.buildGeneralQueries
// (FRAMEWORK_ROBUSTNESS_PLAN_20261116 §1.4 / W3).
//
// A framework falls to the generic fallback when it has NO legacyQueryTemplates
// AND NO searchTemplates AND NO requiredDocTypes — then discovery runs on the 6
// generic queries only. That is the hard failure this gate blocks on.
//
// This module is framework-agnostic and pure (no DB / network). It is consumed by
// the activation endpoint, the frameworks list API, and the variance/readiness UI.

import type { Framework } from "../../shared/schema.js";

export interface ReadinessField {
  key: string;
  label: string;
  present: boolean;
  count: number;
  weight: number;
}

export interface FrameworkReadiness {
  /** 0..100 weighted completeness score over query-driving fields. */
  score: number;
  /** true when the framework would NOT fall to the generic 6-query fallback. */
  ready: boolean;
  /** true when the framework WOULD run on the generic fallback (hard block). */
  genericFallback: boolean;
  /** human-readable blocking reasons (empty when ready). */
  blockers: string[];
  /** advisory, non-blocking recommendations. */
  warnings: string[];
  /** per-field breakdown for UI. */
  fields: ReadinessField[];
}

function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && String(x).trim() !== "").length : 0;
}

/**
 * Compute a readiness report for a framework.
 *
 * Weighted fields (query-driving, per W3):
 *   - legacyQueryTemplates   (strong — primary breadth driver)
 *   - searchTemplates        (strong — author-authored framework-specific)
 *   - requiredDocTypes       (strong — drives buildDisclosureVehicleQueries + W5)
 *   - multiDocumentQueryTemplates
 *   - documentPriorityUrlPatterns
 *   - authoritativeRegistries
 *   - authoritativeFilingTypes
 */
export function frameworkReadiness(framework: Framework): FrameworkReadiness {
  const f = framework as any;
  const fields: ReadinessField[] = [
    { key: "legacyQueryTemplates", label: "Legacy query templates", count: arrLen(f.legacyQueryTemplates), weight: 25, present: false },
    { key: "searchTemplates", label: "Search templates", count: arrLen(f.searchTemplates), weight: 20, present: false },
    { key: "requiredDocTypes", label: "Required document types", count: arrLen(f.requiredDocTypes), weight: 25, present: false },
    { key: "multiDocumentQueryTemplates", label: "Multi-document query templates", count: arrLen(f.multiDocumentQueryTemplates), weight: 8, present: false },
    { key: "documentPriorityUrlPatterns", label: "Document priority URL patterns", count: arrLen(f.documentPriorityUrlPatterns), weight: 7, present: false },
    { key: "authoritativeRegistries", label: "Authoritative registries", count: arrLen(f.authoritativeRegistries), weight: 8, present: false },
    { key: "authoritativeFilingTypes", label: "Authoritative filing types", count: arrLen(f.authoritativeFilingTypes), weight: 7, present: false },
  ];
  for (const fld of fields) fld.present = fld.count > 0;

  const totalWeight = fields.reduce((s, fld) => s + fld.weight, 0);
  const gotWeight = fields.reduce((s, fld) => s + (fld.present ? fld.weight : 0), 0);
  const score = Math.round((gotWeight / totalWeight) * 100);

  // Hard block: would discovery fall to the generic 6-query fallback?
  // buildGeneralQueries uses legacyQueryTemplates for Layer 2; when empty it drops
  // to the generic fallback. searchTemplates (Layer 1) and requiredDocTypes
  // (Layer 3) ADD queries but do not replace the fallback — HOWEVER if either is
  // present the framework is no longer running "almost entirely on the generic
  // fallback". We treat the framework as genericFallback ONLY when ALL THREE
  // query-driving layers are empty.
  const hasLayer1 = arrLen(f.searchTemplates) > 0;
  const hasLayer2 = arrLen(f.legacyQueryTemplates) > 0;
  const hasLayer3 = arrLen(f.requiredDocTypes) > 0;
  const genericFallback = !hasLayer1 && !hasLayer2 && !hasLayer3;

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (genericFallback) {
    blockers.push(
      "Framework has no searchTemplates, no legacyQueryTemplates, and no requiredDocTypes — discovery would run on the 6-query generic fallback only. Populate at least requiredDocTypes (and ideally legacyQueryTemplates) before activating.",
    );
  }
  // Even if not strictly generic-fallback, warn when the primary breadth driver is absent.
  if (!hasLayer2) {
    warnings.push("No legacyQueryTemplates — discovery breadth relies on searchTemplates / requiredDocTypes only.");
  }
  if (!hasLayer3) {
    warnings.push("No requiredDocTypes — disclosure-vehicle-targeted discovery (W5) is disabled for this framework.");
  }
  if (arrLen(f.dataPatterns) < 2) {
    warnings.push("Fewer than 2 dataPatterns — corpus-validity (≥2-distinct-hits) checks will be weak.");
  }

  // W8 integration: a framework's run-to-run variance should be known AND
  // acceptable before it is trusted/activated. The variance harness persists a
  // report onto the framework (varianceReport). Unknown variance is a warning by
  // default; set VARIANCE_GATE_STRICT=true to make it a hard blocker. A KNOWN-BAD
  // variance report is always a blocker.
  const variance = f.varianceReport;
  const strictVariance = ["true", "1"].includes((process.env.VARIANCE_GATE_STRICT || "").toLowerCase());
  if (!variance) {
    const msg = "Variance is unknown — run the variance harness (W8) to measure run-to-run flip rate before trusting/activating this framework.";
    if (strictVariance) blockers.push(msg);
    else warnings.push(msg);
  } else if (variance.acceptable === false) {
    blockers.push(
      `Variance exceeds acceptable thresholds (max flip rate ${(Number(variance.maxFlipRate ?? 0) * 100).toFixed(1)}% vs ${(Number(variance.thresholds?.maxFlipRate ?? 0) * 100).toFixed(1)}%, ` +
      `mean score stddev ${Number(variance.meanScoreStddev ?? 0).toFixed(2)} vs ${Number(variance.thresholds?.maxScoreStddev ?? 0).toFixed(2)}). ` +
      `Stabilise the rubric/discovery before activating.`,
    );
  }

  const ready = blockers.length === 0;
  return { score, ready, genericFallback, blockers, warnings, fields };
}

// ─── WS5 — Framework onboarding gate (config readiness + dry-run probe) ───────
//
// Problem: the robustness of a NEW framework depends on config DATA being
// populated before it is activated — entity relationships (parent / subsidiary /
// peer with aliases + domains), a recency window, a per-company document cap, and
// the required-for-tracks gate list. When any of these is absent the downstream
// WS1–WS4 safeguards silently become no-ops (fail-open by data), so a framework
// can activate and run "clean" while delivering unguarded results.
//
// This gate makes that structural: a readiness CHECKLIST over those required
// config items (each present / missing / waived), plus a pure dry-run PROBE that
// summarises sampled per-company evidence stats into a pre-flight robustness
// score. Both are framework-agnostic and PURE (no DB / network) — the probe
// inputs are supplied by the caller so the logic stays unit-testable and
// fail-open. No company / framework / measure names appear here.
//
// Separate from the W3 `frameworkReadiness` gate above (which guards the
// QUERY-DRIVING fields so discovery does not fall to the generic fallback). WS5
// guards the SCORING-ROBUSTNESS config consumed by WS1–WS4. Both can run.

/** Status of a single onboarding config check. */
export type OnboardingCheckStatus = "ok" | "missing" | "waived";

/** One required-config check in the onboarding readiness checklist. */
export interface OnboardingReadinessCheck {
  /** Stable machine key (also the waiver key). */
  key: string;
  /** Human-readable label for UI. */
  label: string;
  /** ok = present, missing = absent, waived = absent but explicitly waived. */
  status: OnboardingCheckStatus;
  /** Detail: what was found, or the actionable "how to set it" message. */
  detail: string;
}

/** Structured result of the onboarding readiness checklist. */
export interface OnboardingReadinessResult {
  /** true only when EVERY check is ok or waived. */
  ready: boolean;
  /** per-item breakdown. */
  checks: OnboardingReadinessCheck[];
  /** actionable messages, one per missing (non-waived) item. Empty when ready. */
  blockingReasons: string[];
  /** true when the result came from the fail-open safety path (never blocks). */
  failOpen?: boolean;
}

/** The onboarding check keys, in checklist order. */
export const ONBOARDING_CHECK_KEYS = [
  "entityRelationships",
  "recencyWindow",
  "perCompanyCap",
  "requiredTracks",
] as const;

/** Count non-blank entries of an array-ish value (mirrors W3 arrLen). */
function onboardingArrLen(v: unknown): number {
  return Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && String(x).trim() !== "").length : 0;
}

/** A framework config value counts as a populated entity graph when it is a
 *  non-empty array (flat list) OR a non-empty object (per-company map). */
function entityConfigPopulated(v: unknown): boolean {
  if (Array.isArray(v)) return onboardingArrLen(v) > 0;
  if (v && typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
  return false;
}

/** Read the explicit waiver list off a framework config. Accepts
 *  `onboardingWaivers` or `onboarding_waivers` as an array of check keys.
 *  Anything else ⇒ no waivers. Normalised to a Set of trimmed keys. */
export function readOnboardingWaivers(frameworkConfig: any): Set<string> {
  const fw: any = frameworkConfig || {};
  const raw = fw.onboardingWaivers ?? fw.onboarding_waivers;
  const set = new Set<string>();
  if (Array.isArray(raw)) {
    for (const k of raw) {
      if (typeof k === "string" && k.trim()) set.add(k.trim());
    }
  }
  return set;
}

/**
 * Compute the onboarding readiness checklist for a framework config object.
 *
 * Required config items (each present / missing / waived):
 *   - entityRelationships : at least one of parent / subsidiary / related-listed
 *                           entity config is populated.
 *   - recencyWindow       : recencyWindowYears declared and > 0.
 *   - perCompanyCap       : perCompanyDocCap declared and > 0.
 *   - requiredTracks      : requiredForTracks declared as a non-empty list.
 *
 * An item that is absent but whose key is in the config's waiver list is marked
 * `waived` (not blocking). `ready` is true only when every check is ok or waived.
 * PURE and total: a null / malformed config never throws — unreadable items are
 * simply reported as missing.
 */
export function computeOnboardingReadiness(frameworkConfig: any): OnboardingReadinessResult {
  const fw: any = frameworkConfig || {};
  const waivers = readOnboardingWaivers(fw);

  const resolve = (
    key: string,
    label: string,
    present: boolean,
    okDetail: string,
    missingDetail: string,
  ): OnboardingReadinessCheck => {
    if (present) return { key, label, status: "ok", detail: okDetail };
    if (waivers.has(key)) return { key, label, status: "waived", detail: `Waived via onboardingWaivers. ${missingDetail}` };
    return { key, label, status: "missing", detail: missingDetail };
  };

  // 1) Entity relationships (parent / subsidiary / peer).
  const parentPop = entityConfigPopulated(fw.parentEntities ?? fw.parent_entities);
  const subsidiaryPop = entityConfigPopulated(fw.subsidiaryEntities ?? fw.subsidiary_entities);
  const peerPop = entityConfigPopulated(fw.relatedListedCompanies ?? fw.related_listed_companies);
  const entityPresent = parentPop || subsidiaryPop || peerPop;
  const entityParts: string[] = [];
  if (parentPop) entityParts.push("parent");
  if (subsidiaryPop) entityParts.push("subsidiary");
  if (peerPop) entityParts.push("related-listed");

  // 2) Recency window.
  const recencyRaw = fw.recencyWindowYears ?? fw.recency_window_years;
  const recencyPresent = typeof recencyRaw === "number" && Number.isFinite(recencyRaw) && recencyRaw > 0;

  // 3) Per-company document cap.
  const capRaw = fw.perCompanyDocCap ?? fw.per_company_doc_cap;
  const capPresent = typeof capRaw === "number" && Number.isFinite(capRaw) && capRaw > 0;

  // 4) Required-for-tracks gate list.
  const tracksRaw = fw.requiredForTracks ?? fw.required_for_tracks;
  const tracksCount = onboardingArrLen(tracksRaw);
  const tracksPresent = tracksCount > 0;

  const checks: OnboardingReadinessCheck[] = [
    resolve(
      "entityRelationships",
      "Entity relationships",
      entityPresent,
      `Declared: ${entityParts.join(", ")} entities.`,
      "No parent_entities, subsidiary_entities, or related_listed_companies declared — entity-attribution (WS1) is inert. Populate at least one entity-relationship list (names with aliases/domains).",
    ),
    resolve(
      "recencyWindow",
      "Recency window",
      recencyPresent,
      `recencyWindowYears = ${recencyRaw}.`,
      "No recencyWindowYears (> 0) declared — the recency final-date gate (FIX 3) is inert. Set recencyWindowYears to the number of years of acceptable evidence age.",
    ),
    resolve(
      "perCompanyCap",
      "Per-company document cap",
      capPresent,
      `perCompanyDocCap = ${capRaw}.`,
      "No perCompanyDocCap (> 0) declared — the per-company corpus cap (FIX 2) is inert. Set perCompanyDocCap to bound each company's evidence corpus.",
    ),
    resolve(
      "requiredTracks",
      "Required tracks",
      tracksPresent,
      `requiredForTracks = [${(Array.isArray(tracksRaw) ? tracksRaw : []).map((t: any) => String(t)).join(", ")}].`,
      "No requiredForTracks declared — the track completeness gate never fires. Set requiredForTracks to the list of tracks a measure must satisfy (e.g. [\"physical_climate\"]).",
    ),
  ];

  const blockingReasons = checks.filter((c) => c.status === "missing").map((c) => c.detail);
  const ready = checks.every((c) => c.status === "ok" || c.status === "waived");
  return { ready, checks, blockingReasons };
}

/**
 * Fail-open wrapper around computeOnboardingReadiness.
 *
 * Any exception in the checklist logic is swallowed and a SAFE "proceed" result
 * is returned (ready = true, failOpen = true, no blocking reasons) so a bug in
 * the gate can NEVER hard-block a framework operation. The caller still logs the
 * underlying error.
 */
export function safeComputeOnboardingReadiness(
  frameworkConfig: any,
  onError?: (err: unknown) => void,
): OnboardingReadinessResult {
  try {
    return computeOnboardingReadiness(frameworkConfig);
  } catch (err) {
    try {
      onError?.(err);
    } catch {
      /* never let the error handler itself throw */
    }
    return {
      ready: true,
      checks: [],
      blockingReasons: [],
      failOpen: true,
    };
  }
}

/** Sampled per-company evidence stats fed to the dry-run probe. All optional and
 *  guarded — missing / malformed values fall back to safe defaults. */
export interface OnboardingPreflightStats {
  /** Fraction (0..1) of sampled docs correctly entity-attributed to the target. */
  entityAttributionCoverage?: number;
  /** Fraction (0..1) of sampled docs that are near-duplicates. */
  duplicateRate?: number;
  /** Average sampled corpus depth (docs) per company. */
  corpusDepth?: number;
  /** The framework's per-company document cap (docs). */
  perCompanyCap?: number;
  /** Count of sampled cells whose evidence sits near the verdict boundary. */
  nearBoundaryCount?: number;
}

/** Pure dry-run robustness summary produced by the probe. */
export interface OnboardingReadinessProbe {
  /** Clamped entity-attribution coverage (0..1). */
  coverage: number;
  /** Clamped near-duplicate rate (0..1). */
  duplicateRate: number;
  /** corpusDepth / perCompanyCap ratio (>= 0; 0 when cap unknown). */
  corpusDepthVsCap: number;
  /** Non-negative integer near-boundary cell count. */
  nearBoundaryCount: number;
  /** Composite pre-flight robustness score (0..1). Higher is healthier. */
  preflightScore: number;
}

/** Clamp a value to [0, 1], with a safe default for NaN / non-numbers. */
function clamp01(v: unknown, dflt = 0): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Non-negative finite number, else default. */
function nonNeg(v: unknown, dflt = 0): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return n < 0 ? 0 : n;
}

/**
 * PURE dry-run readiness probe.
 *
 * Collapses sampled per-company evidence stats into a pre-flight robustness
 * summary. Deterministic and total: every input is guarded (NaN / null / missing
 * → safe default), division by zero is guarded, and the composite score is a
 * bounded weighted blend clamped to [0, 1]:
 *
 *   preflightScore = 0.40 * coverage
 *                  + 0.30 * (1 - duplicateRate)
 *                  + 0.20 * min(1, corpusDepthVsCap)   (depth health, capped)
 *                  + 0.10 * 1 / (1 + nearBoundaryCount) (boundary health)
 *
 * Never throws.
 */
export function computeReadinessProbe(stats: OnboardingPreflightStats | null | undefined): OnboardingReadinessProbe {
  const s: OnboardingPreflightStats = stats && typeof stats === "object" ? stats : {};
  const coverage = clamp01(s.entityAttributionCoverage);
  const duplicateRate = clamp01(s.duplicateRate);
  const depth = nonNeg(s.corpusDepth);
  const cap = nonNeg(s.perCompanyCap);
  const corpusDepthVsCap = cap > 0 ? depth / cap : 0;
  const nearBoundaryCount = Math.floor(nonNeg(s.nearBoundaryCount));

  const depthHealth = Math.min(1, corpusDepthVsCap);
  const boundaryHealth = 1 / (1 + nearBoundaryCount);
  const preflightScore = clamp01(
    0.4 * coverage + 0.3 * (1 - duplicateRate) + 0.2 * depthHealth + 0.1 * boundaryHealth,
  );

  return { coverage, duplicateRate, corpusDepthVsCap, nearBoundaryCount, preflightScore };
}
