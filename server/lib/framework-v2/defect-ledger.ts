/**
 * STEP 3 — Append-only recurring-defect ledger (Detector D2).
 *
 * Faithful TypeScript port of the behaviour described in
 * `skills/framework-review/SKILL.md` §8.2. Every framework review appends defect
 * records to an append-only ledger. When a defect CLASS (rule + field) recurs
 * across `PROMOTE_THRESHOLD` (default 3) DISTINCT measures/frameworks, the class
 * is PROMOTED from a per-framework content fix to a BUILDER-level proposal that
 * feeds the Step-1 "builder changes" list.
 *
 * Design constraints honoured here:
 *  - Append-only JSONL (one JSON record per line); never rewrites prior records.
 *  - Store path is CONFIGURABLE via env `DEFECT_LEDGER_PATH`; otherwise defaults
 *    to `<repo>/server/data/defect-ledger.jsonl`.
 *  - Fail-loud on write error (the caller must know the ledger did not persist).
 *  - Topic-agnostic: no hardcoded topic tokens or company names.
 *
 * implemented != verified-fixed: a promotion is a *hypothesis* that the builder
 * is the root cause. It is only VERIFIED after an operator-triggered
 * regeneration shows the defect class gone on a live validator run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** One append-only ledger record. `count` is the number of occurrences this
 *  record represents within a single review (usually 1 per measure). */
export interface DefectRecord {
  frameworkId: string;
  topicTerm: string;
  timestamp: string; // ISO-8601
  defectClass: string; // canonical `${rule}:${field}` — derived if omitted
  rule: string;
  field: string;
  measureId: string; // "framework-level" when not measure-scoped
  measureIdentity?: string; // internal: `${frameworkId}::${measureId}` for distinct-counting
  count: number;
}

/** A builder-level proposal promoted from recurrence (feeds Step-1 list (a)). */
export interface LedgerPromotion {
  id: string;
  defectClass: string;
  rule: string;
  field: string;
  distinctSites: number; // number of distinct measures/frameworks the class recurred across
  totalOccurrences: number;
  frameworks: string[]; // distinct frameworkIds involved
  rationale: string;
  proposedBuilderEdit: string;
}

/** Default PROMOTE_THRESHOLD (SKILL §8.2) — overridable via env. */
export function promoteThreshold(): number {
  const raw = process.env.DEFECT_PROMOTE_THRESHOLD;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/**
 * Resolve the ledger file path. Priority:
 *   1. explicit arg (tests / callers that manage their own file)
 *   2. env `DEFECT_LEDGER_PATH`
 *   3. default `<repo>/server/data/defect-ledger.jsonl`
 */
export function resolveLedgerPath(explicit?: string): string {
  if (explicit && explicit.trim()) return path.resolve(explicit);
  const fromEnv = process.env.DEFECT_LEDGER_PATH;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  // __dirname === <repo>/server/lib/framework-v2 → default data dir is <repo>/server/data
  return path.resolve(__dirname, "..", "..", "data", "defect-ledger.jsonl");
}

/** Canonical defect class key. SKILL §8.2 defines a class as rule + field. */
export function defectClassOf(rule: string, field: string): string {
  return `${String(rule || "?").trim()}:${String(field || "?").trim()}`;
}

/** Internal distinct-site key: one measure of one framework counts once. */
function siteKey(r: Pick<DefectRecord, "frameworkId" | "measureId">): string {
  return `${r.frameworkId}::${r.measureId}`;
}

/**
 * Normalise a loosely-shaped record into a full DefectRecord, deriving the
 * defectClass/timestamp/count where omitted. Topic-agnostic.
 */
export function normaliseRecord(partial: Partial<DefectRecord>): DefectRecord {
  const rule = String(partial.rule ?? "?");
  const field = String(partial.field ?? "?");
  return {
    frameworkId: String(partial.frameworkId ?? "unknown"),
    topicTerm: String(partial.topicTerm ?? ""),
    timestamp: partial.timestamp || new Date().toISOString(),
    defectClass: partial.defectClass || defectClassOf(rule, field),
    rule,
    field,
    measureId: String(partial.measureId ?? "framework-level"),
    count: typeof partial.count === "number" && partial.count > 0 ? partial.count : 1,
  };
}

/**
 * Append records to the append-only JSONL ledger. FAIL-LOUD: any filesystem
 * error is re-thrown with context so the caller knows the ledger did not persist
 * (SKILL §8.2 — the ledger is the anti-overfit gate and must not fail silently).
 */
export function appendDefectRecords(
  records: Array<Partial<DefectRecord>>,
  ledgerPath?: string,
): { appended: number; path: string } {
  const file = resolveLedgerPath(ledgerPath);
  const normalised = records.map(normaliseRecord);
  if (normalised.length === 0) return { appended: 0, path: file };
  const lines = normalised.map((r) => JSON.stringify(r)).join("\n") + "\n";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines, "utf-8");
  } catch (e: any) {
    throw new Error(
      `[defect-ledger] FAILED to append ${normalised.length} record(s) to ${file}: ${e?.message || e}`,
    );
  }
  return { appended: normalised.length, path: file };
}

/**
 * Read all ledger records. Missing file → empty array (nothing recorded yet).
 * A malformed line is fail-loud (the ledger is authoritative; a corrupt line
 * must be surfaced, not silently skipped).
 */
export function readLedger(ledgerPath?: string): DefectRecord[] {
  const file = resolveLedgerPath(ledgerPath);
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e: any) {
    throw new Error(`[defect-ledger] FAILED to read ${file}: ${e?.message || e}`);
  }
  const out: DefectRecord[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    try {
      out.push(JSON.parse(ln) as DefectRecord);
    } catch (e: any) {
      throw new Error(
        `[defect-ledger] corrupt JSONL at ${file}:${i + 1}: ${e?.message || e}`,
      );
    }
  }
  return out;
}

/**
 * Compute builder-level promotions from a set of ledger records. A defect CLASS
 * (rule:field) is promoted when it recurs across >= threshold DISTINCT sites
 * (a distinct measure of a distinct framework counts once). Returns proposals in
 * a stable order (highest recurrence first, then class name) so the Step-1 list
 * and tests are deterministic.
 */
export function computeRecurrencePromotions(
  records: DefectRecord[],
  threshold: number = promoteThreshold(),
): LedgerPromotion[] {
  const byClass = new Map<
    string,
    { rule: string; field: string; sites: Set<string>; frameworks: Set<string>; total: number }
  >();
  for (const r of records) {
    const cls = r.defectClass || defectClassOf(r.rule, r.field);
    if (!byClass.has(cls)) {
      byClass.set(cls, { rule: r.rule, field: r.field, sites: new Set(), frameworks: new Set(), total: 0 });
    }
    const agg = byClass.get(cls)!;
    agg.sites.add(siteKey(r));
    agg.frameworks.add(r.frameworkId);
    agg.total += typeof r.count === "number" && r.count > 0 ? r.count : 1;
  }

  const promotions: LedgerPromotion[] = [];
  for (const [cls, agg] of byClass) {
    const distinctSites = agg.sites.size;
    if (distinctSites < threshold) continue; // anti-overfit gate: one-offs never mutate the builder
    promotions.push({
      id: `ledger-${slug(cls)}`,
      defectClass: cls,
      rule: agg.rule,
      field: agg.field,
      distinctSites,
      totalOccurrences: agg.total,
      frameworks: Array.from(agg.frameworks).sort(),
      rationale:
        `Defect class ${cls} recurred across ${distinctSites} distinct measures/frameworks ` +
        `(>= PROMOTE_THRESHOLD ${threshold}). A recurring content defect at this scale indicates ` +
        `the BUILDER under-specifies ${agg.rule} (${agg.field}), so every generated framework inherits it. ` +
        `Fixing it once in the builder is cheaper and more general than repairing each framework.`,
      proposedBuilderEdit:
        `Strengthen the builder's instruction for ${agg.rule} so the generator pre-satisfies the ` +
        `${agg.field} requirement that is repeatedly failing downstream. GATED: review, apply, then ` +
        `VERIFY by an operator-triggered regeneration (implemented != verified-fixed).`,
    });
  }
  // Deterministic order: most-recurrent first, then by class name.
  promotions.sort((a, b) => b.distinctSites - a.distinctSites || a.defectClass.localeCompare(b.defectClass));
  return promotions;
}

function slug(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}
