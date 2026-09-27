/**
 * Deterministic framework import/export transforms (NO LLM).
 *
 * The v2 "Export Full" markdown is meant to be pasted back into the AI builder,
 * which RE-DERIVES measures and therefore never reproduces a framework exactly.
 * These helpers instead round-trip a framework through a machine-readable JSON
 * payload so an import recreates it field-for-field, deterministically.
 *
 * Both directions are pure functions over plain objects so they can be unit
 * tested without a database or an LLM:
 *   - buildFrameworkExport(framework, measures) -> JSON payload
 *   - buildFrameworkInserts(payload, workspaceId, existingNames)
 *       -> { InsertFramework, Omit<InsertFrameworkMeasure,"frameworkId">[] }
 */
import type { InsertFramework, InsertFrameworkMeasure } from "../../../shared/schema.js";
import { promoteHardeningFields } from "./promote-hardening-fields.js";
import { resolveConfig } from "./reliability/resolve-config.js";

/**
 * Overlay the canonical, fully-resolved anchor / scope / lexicon surfaces onto a
 * framework-shaped object so the EXPORT is literally the resolved config for those
 * surfaces rather than an independent re-derivation. This is what makes the
 * canonical JSON export, the Markdown exports, and the runtime agree: they all read
 * the same `resolveConfig` output. Every other field is preserved verbatim.
 */
function overlayResolvedCanonicalSurfaces(
  fw: Record<string, any>,
  measures: Record<string, any>[],
): Record<string, any> {
  const resolved = resolveConfig({ framework: fw, measures });
  return {
    ...fw,
    anchorFrameworks: resolved.anchorFrameworks,
    entityType: resolved.entityType,
    sectorScope: resolved.sectorScope,
    universe: resolved.universe,
    reportingPeriod: resolved.reportingPeriod,
    topicSynonyms: resolved.topicSynonyms,
    evidenceKeywords: resolved.evidenceKeywords,
    documentFilingHints: resolved.documentFilingHints,
    retrievalQueryTerms: resolved.retrievalQueryTerms ?? [],
    negativeKeywords: resolved.negativeKeywords,
    antiInferenceRules: resolved.antiInferenceRules,
  };
}

/** Schema marker + version stamped onto every export payload. */
export const FRAMEWORK_EXPORT_MARKER = "companyiqFrameworkExport";
export const FRAMEWORK_EXPORT_VERSION = 1;

/**
 * Identity / ownership / audit columns that must NEVER be copied from an
 * incoming payload — they are assigned by the DB or the importing session.
 * Snake_case variants are included so a hand-edited payload can't sneak them in.
 */
const FRAMEWORK_STRIP_FIELDS = new Set([
  "id",
  "workspaceId",
  "workspace_id",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
]);
const MEASURE_STRIP_FIELDS = new Set(["id", "frameworkId", "framework_id"]);

export interface FrameworkExportPayload {
  /** Present on exports we produce; tolerated-absent on raw {framework,measures}. */
  companyiqFrameworkExport?: number;
  framework: Record<string, any>;
  measures: Record<string, any>[];
}

/**
 * True when `body` is a recognizable framework export: a `framework` object plus
 * a `measures` array. The marker is NOT required — we tolerate a raw
 * `{ framework, measures }` object so pasted/legacy payloads still import.
 */
export function isFrameworkExportPayload(body: any): body is FrameworkExportPayload {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const fw = (body as any).framework;
  const measures = (body as any).measures;
  return (
    !!fw &&
    typeof fw === "object" &&
    !Array.isArray(fw) &&
    Array.isArray(measures)
  );
}

/**
 * Build the downloadable export payload from a persisted framework + measures.
 * Strips identity/ownership/audit columns; keeps every other persisted field so
 * the round-trip is exact.
 */
export function buildFrameworkExport(
  framework: Record<string, any>,
  measures: Record<string, any>[],
): FrameworkExportPayload {
  const fw0: Record<string, any> = {};
  for (const [k, v] of Object.entries(framework ?? {})) {
    if (FRAMEWORK_STRIP_FIELDS.has(k)) continue;
    fw0[k] = v;
  }
  // Ensure the exported framework carries its hardening in top-level fields (not
  // only buried in the intake artefact) so an import round-trip is faithful even
  // for a source framework whose top-level columns were never populated.
  const { framework: fwPromoted } = promoteHardeningFields(fw0);
  const ms = (Array.isArray(measures) ? measures : []).map((m) => {
    const mc: Record<string, any> = {};
    for (const [k, v] of Object.entries(m ?? {})) {
      if (MEASURE_STRIP_FIELDS.has(k)) continue;
      mc[k] = v;
    }
    return mc;
  });
  // Overlay the canonical resolved anchor/scope/lexicon surfaces so the exported
  // JSON IS the resolved config for those surfaces (single source of truth), not a
  // second independent derivation. All other fields remain verbatim.
  const fw = overlayResolvedCanonicalSurfaces(fwPromoted, ms);
  return {
    [FRAMEWORK_EXPORT_MARKER]: FRAMEWORK_EXPORT_VERSION,
    framework: fw,
    measures: ms,
  };
}

export interface FrameworkInserts {
  framework: InsertFramework;
  /** frameworkId is assigned by the caller after the framework row is created. */
  measures: Omit<InsertFrameworkMeasure, "frameworkId">[];
}

/** Options controlling how an import materialises measures. */
export interface BuildFrameworkInsertsOptions {
  /**
   * WS-C: when true, the imported measure SET is retained VERBATIM — identical
   * titles, identical order, identical count. Measures are copied in the exact
   * order they appear in the payload (no re-sort), and an assertion guard verifies
   * the result is byte-identical to the source on those three axes. ADDITIVE
   * criteria hardening (adding/strengthening scoring criteria fields) is still
   * permitted — the guard checks ONLY titles/order/count, never criteria content —
   * but no measure may be regenerated, reworded, reordered, split, merged, or
   * dropped. Topic-agnostic: nothing here depends on any specific framework/measure.
   */
  preserveMeasures?: boolean;
}

/**
 * WS-C fail-loud guard. Thrown when a keep-same-measures import would alter the
 * measure SET (title text, ordering, or count). This protects data integrity; it
 * is NOT a user-facing save block on the builder.
 */
export class PreserveMeasuresViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreserveMeasuresViolation";
  }
}

/** Normalise a measure title to the exact string used for byte-identical compare. */
function measureTitleOf(m: any): string {
  return typeof m?.title === "string" ? m.title : m?.title == null ? "" : String(m.title);
}

/**
 * WS-C: assert the resulting measure set is byte-identical to the source on the
 * three protected axes — count, per-position title text, and order. Criteria
 * fields are intentionally NOT compared (additive hardening is allowed). Throws
 * PreserveMeasuresViolation on any divergence. Pure; topic-agnostic.
 */
export function assertMeasureSetPreserved(
  sourceMeasures: any[],
  resultMeasures: any[],
): void {
  const src = Array.isArray(sourceMeasures) ? sourceMeasures : [];
  const out = Array.isArray(resultMeasures) ? resultMeasures : [];

  if (src.length !== out.length) {
    throw new PreserveMeasuresViolation(
      `keep-same-measures: measure count changed (source ${src.length} → result ${out.length}). ` +
        `Measures must not be added, dropped, split, or merged.`,
    );
  }

  for (let i = 0; i < src.length; i++) {
    const a = measureTitleOf(src[i]);
    const b = measureTitleOf(out[i]);
    if (a !== b) {
      throw new PreserveMeasuresViolation(
        `keep-same-measures: measure title at position ${i} changed (source ${JSON.stringify(a)} → ` +
          `result ${JSON.stringify(b)}). Titles and order must be preserved byte-for-byte.`,
      );
    }
  }
}

/**
 * Pure transform: export payload -> DB insert shapes for a NEW framework in the
 * current workspace. Deterministic and LLM-free.
 *
 * - Strips id/workspace_id/created_at/updated_at from the framework and
 *   id/framework_id from each measure.
 * - Sets workspaceId from the importing session and forces isActive=false (never
 *   auto-activate an import / disturb the workspace's active framework).
 * - Keeps the original name verbatim, appending " (imported)" ONLY when a
 *   same-named framework already exists in the workspace.
 * - Preserves every other persisted field and the original measure order
 *   (sorted by displayOrder, with a stable index fallback).
 */
export function buildFrameworkInserts(
  payload: FrameworkExportPayload,
  workspaceId: number,
  existingNames: string[] = [],
  options: BuildFrameworkInsertsOptions = {},
): FrameworkInserts {
  const rawFw = payload.framework ?? {};
  const fwCopy: Record<string, any> = {};
  for (const [k, v] of Object.entries(rawFw)) {
    if (FRAMEWORK_STRIP_FIELDS.has(k)) continue;
    fwCopy[k] = v;
  }
  // Ownership + activation are decided by the importing session, never copied.
  fwCopy.workspaceId = workspaceId;
  fwCopy.isActive = false;

  const baseName =
    typeof rawFw.name === "string" && rawFw.name.trim()
      ? rawFw.name
      : "Imported framework";
  const taken = new Set(existingNames);
  fwCopy.name = taken.has(baseName) ? `${baseName} (imported)` : baseName;

  // Promote hardening fields from the incoming intake artefact into the top-level
  // columns when the payload left them empty, so an imported framework is hardened
  // for the scorer regardless of how the source payload was shaped. Non-destructive.
  const { framework: fwPromoted } = promoteHardeningFields(fwCopy);
  const framework = fwPromoted as InsertFramework;

  const rawMeasures = Array.isArray(payload.measures) ? payload.measures : [];

  let measures: Omit<InsertFrameworkMeasure, "frameworkId">[];
  if (options.preserveMeasures) {
    // WS-C: keep the measure SET verbatim. Copy in the EXACT payload order (no
    // re-sort), stamping a monotonic displayOrder so the preserved sequence is
    // persisted deterministically. Every field is copied faithfully — titles are
    // never touched — so additive criteria hardening applied to the payload before
    // import survives untouched.
    measures = rawMeasures.map((m, idx) => {
      const mc: Record<string, any> = {};
      for (const [k, v] of Object.entries(m ?? {})) {
        if (MEASURE_STRIP_FIELDS.has(k)) continue;
        mc[k] = v;
      }
      mc.displayOrder = idx;
      return mc as Omit<InsertFrameworkMeasure, "frameworkId">;
    });
    // Fail-loud: the materialised set must be byte-identical to the source on
    // count, per-position title, and order. Throws PreserveMeasuresViolation.
    assertMeasureSetPreserved(rawMeasures, measures);
  } else {
    measures = rawMeasures
      .map((m, idx) => {
        const mc: Record<string, any> = {};
        for (const [k, v] of Object.entries(m ?? {})) {
          if (MEASURE_STRIP_FIELDS.has(k)) continue;
          mc[k] = v;
        }
        const order =
          typeof mc.displayOrder === "number" ? mc.displayOrder : idx;
        if (mc.displayOrder == null) mc.displayOrder = order;
        return { order, idx, measure: mc };
      })
      .sort((a, b) => a.order - b.order || a.idx - b.idx)
      .map((e) => e.measure as Omit<InsertFrameworkMeasure, "frameworkId">);
  }

  return { framework, measures };
}
