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
