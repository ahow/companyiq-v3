// Framework Builder v2 — measure edit-audit helper (observability only).
//
// `recordMeasureEdit` appends one row to `measure_edits` for every attempted
// field change in the /v2/improvement/apply loop: `applied=true` rows carry
// before/after values, `applied=false` rows carry a `skip_reason` so that
// silently-skipped accepts (e.g. an LLM batch that returns no updates) leave a
// durable, per-measure trace instead of vanishing into an in-memory list.
//
// This is deliberately DEFENSIVE: the apply flow must never break or roll back
// because auditing failed, and the app must keep working even if the
// `measure_edits` table does not exist yet. Every write is wrapped in try/catch
// and only ever `console.warn`s — it never throws.
//
// GENERIC: nothing here knows about any specific framework, company, topic, or
// measure. `field`/`op`/`source` are supplied by the caller from proposal
// metadata (op, path, flagRule) and generic field lists.

import { sql } from "drizzle-orm";

// Loosely typed to avoid an import cycle with ../../db.ts. In practice this is
// the drizzle instance exported from ../../db.ts (it has `.execute(sql\`...\`)`).
type Db = { execute: (query: any) => Promise<any> };

export interface MeasureEditRecord {
  workspaceId?: number | null;
  frameworkId: number;
  listId?: number | null;
  measureId: string;
  /** Logical field touched, e.g. "substantive_definition", "synonyms". */
  field: string;
  /** Operation, e.g. "rewrite_countable", "replace", "custom_edit". */
  op?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
  /** Provenance, e.g. `proposal:${flagRule}`, "custom_edit", "add_synonyms". */
  source: string;
  applied: boolean;
  /** Present (and human-readable) whenever `applied === false`. */
  skipReason?: string | null;
}

/**
 * Normalise an arbitrary value to the TEXT column shape. Strings pass through
 * unchanged; null/undefined become NULL; everything else (arrays, objects,
 * numbers, booleans) is JSON-stringified so the audit row is always readable.
 */
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Append one audit row. Never throws — on any failure it warns and resolves,
 * so a missing table or a transient DB error can never break the apply flow.
 */
export async function recordMeasureEdit(db: Db, rec: MeasureEditRecord): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO measure_edits (
        workspace_id, framework_id, list_id, measure_id, field, op,
        before_value, after_value, source, applied, skip_reason
      ) VALUES (
        ${rec.workspaceId ?? null},
        ${rec.frameworkId},
        ${rec.listId ?? null},
        ${rec.measureId},
        ${rec.field},
        ${rec.op ?? null},
        ${toText(rec.beforeValue)},
        ${toText(rec.afterValue)},
        ${rec.source},
        ${rec.applied},
        ${rec.skipReason ?? null}
      )
    `);
  } catch (err: any) {
    console.warn(
      `[measure-audit] failed to record edit (framework=${rec.frameworkId} measure=${rec.measureId} field=${rec.field} applied=${rec.applied}): ${err?.message || err}`,
    );
  }
}
