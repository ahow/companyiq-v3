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
  const fw: Record<string, any> = {};
  for (const [k, v] of Object.entries(framework ?? {})) {
    if (FRAMEWORK_STRIP_FIELDS.has(k)) continue;
    fw[k] = v;
  }
  const ms = (Array.isArray(measures) ? measures : []).map((m) => {
    const mc: Record<string, any> = {};
    for (const [k, v] of Object.entries(m ?? {})) {
      if (MEASURE_STRIP_FIELDS.has(k)) continue;
      mc[k] = v;
    }
    return mc;
  });
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

  const framework = fwCopy as InsertFramework;

  const rawMeasures = Array.isArray(payload.measures) ? payload.measures : [];
  const measures = rawMeasures
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

  return { framework, measures };
}
