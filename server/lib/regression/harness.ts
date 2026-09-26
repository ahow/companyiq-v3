/**
 * Change #5 — Generic Scoring Regression Harness
 * ══════════════════════════════════════════════
 * Re-scores a set of ADJUDICATED gold cells — each a (company, measure,
 * expected verdict, human sign-off) — against their FROZEN evidence bundle
 * (via the Change #2 replay ledger) and reports pass/fail vs the gold verdict.
 * This catches scoring drift: a code/prompt change that flips a signed-off cell
 * is surfaced loudly by a failing regression row.
 *
 * TOPIC/COMPANY-AGNOSTIC: nothing here hardcodes any framework or topic. The
 * gold set is external DATA (gold-set.json). The one 3i control row lives in
 * that data file, never in this logic.
 *
 * Pure/deterministic: the scorer is injected, so this module runs with no DB,
 * no network and no LLM. It never mutates anything and is a test/audit tool
 * only — it is never on the live scoring path.
 */
import { readFileSync } from "fs";

// ─── Gold-set types ─────────────────────────────────────────────────────────

export type Verdict = "Yes" | "No" | "Partial" | "Insufficient evidence" | "Scoring error";

export interface GoldCell {
  companyId: number;
  companyName?: string;
  measureId: string;
  measureTitle?: string;
  expectedVerdict: Verdict;
  note?: string;
  signedOffBy?: string;
  signedOffAt?: string;
}

export interface GoldSet {
  description?: string;
  cells: GoldCell[];
}

export interface RegressionRow {
  companyId: number;
  measureId: string;
  expectedVerdict: string;
  actualVerdict: string;
  pass: boolean;
  error?: string;
}

export interface RegressionReport {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  allPass: boolean;
  rows: RegressionRow[];
}

/**
 * A scorer replays a single gold cell and returns the verdict it produces.
 * The caller wires this to the real replay-ledger + analyzer path; tests inject
 * a stub. It may throw (e.g. LedgerIntegrityError on a hash mismatch); the
 * harness records that as an errored (failing) row without aborting the run.
 */
export type ReplayScorer = (cell: GoldCell) => Promise<string> | string;

// ─── Loading / importing gold sets ──────────────────────────────────────────

/** Normalise a raw verdict string for comparison (trim + case-fold). */
function normVerdict(v: string): string {
  return (v || "").trim().toLowerCase();
}

export function parseGoldSet(json: string): GoldSet {
  const obj = JSON.parse(json);
  if (!obj || !Array.isArray(obj.cells)) {
    throw new Error("Malformed gold set: expected { cells: [...] }");
  }
  for (const c of obj.cells) {
    if (typeof c.companyId !== "number" || typeof c.measureId !== "string" || typeof c.expectedVerdict !== "string") {
      throw new Error(`Malformed gold cell: ${JSON.stringify(c).slice(0, 120)}`);
    }
  }
  return obj as GoldSet;
}

export function loadGoldSet(path: string): GoldSet {
  return parseGoldSet(readFileSync(path, "utf8"));
}

/**
 * Importer for the reviewer's adjudications workbook exported as CSV.
 * Expected header (case-insensitive, order-free):
 *   company_id, company_name, measure_id, measure_title, expected_verdict, note, signed_off_by, signed_off_at
 * Minimal, dependency-free CSV parser (handles quoted fields + embedded commas).
 * See README.md — this is how the full 80-cell gold set is dropped in later.
 */
export function importGoldSetFromCsv(csv: string): GoldSet {
  const rows = parseCsv(csv);
  if (rows.length < 2) return { cells: [] };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const ci = idx("company_id");
  const mi = idx("measure_id");
  const ev = idx("expected_verdict");
  if (ci < 0 || mi < 0 || ev < 0) {
    throw new Error("CSV must have company_id, measure_id and expected_verdict columns");
  }
  const cn = idx("company_name"), mt = idx("measure_title"), nt = idx("note");
  const sb = idx("signed_off_by"), sa = idx("signed_off_at");
  const cells: GoldCell[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0].trim() === "") continue; // blank line
    const companyId = parseInt((row[ci] || "").trim(), 10);
    if (!Number.isFinite(companyId)) continue;
    cells.push({
      companyId,
      companyName: cn >= 0 ? row[cn]?.trim() : undefined,
      measureId: (row[mi] || "").trim(),
      measureTitle: mt >= 0 ? row[mt]?.trim() : undefined,
      expectedVerdict: ((row[ev] || "").trim() as Verdict),
      note: nt >= 0 ? row[nt]?.trim() : undefined,
      signedOffBy: sb >= 0 ? row[sb]?.trim() : undefined,
      signedOffAt: sa >= 0 ? row[sa]?.trim() : undefined,
    });
  }
  return { cells };
}

/** Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, embedded commas/newlines). */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); field = ""; out.push(row); row = [];
    } else field += ch;
  }
  row.push(field);
  out.push(row);
  return out;
}

// ─── Runner ─────────────────────────────────────────────────────────────────

/**
 * Run the regression harness: replay-score each gold cell and compare to its
 * expected verdict. A thrown scorer error (e.g. ledger hash mismatch) becomes a
 * failing, errored row — never an aborted run. Verdict comparison is
 * case-insensitive and whitespace-tolerant.
 */
export async function runRegressionHarness(
  goldSet: GoldSet,
  score: ReplayScorer,
): Promise<RegressionReport> {
  const rows: RegressionRow[] = [];
  for (const cell of goldSet.cells) {
    let actualVerdict = "";
    let error: string | undefined;
    let pass = false;
    try {
      actualVerdict = await score(cell);
      pass = normVerdict(actualVerdict) === normVerdict(cell.expectedVerdict);
    } catch (e: any) {
      error = String(e?.message ?? e);
      actualVerdict = "";
      pass = false;
    }
    rows.push({
      companyId: cell.companyId,
      measureId: cell.measureId,
      expectedVerdict: cell.expectedVerdict,
      actualVerdict,
      pass,
      error,
    });
  }
  const errored = rows.filter(r => r.error).length;
  const passed = rows.filter(r => r.pass).length;
  const failed = rows.length - passed;
  return {
    total: rows.length,
    passed,
    failed,
    errored,
    allPass: failed === 0 && rows.length > 0,
    rows,
  };
}

/** Human-readable one-line-per-row report (for the CLI runner). */
export function formatRegressionReport(report: RegressionReport): string {
  const lines = report.rows.map(r =>
    `  [${r.pass ? "PASS" : "FAIL"}] company=${r.companyId} measure=${r.measureId} ` +
    `expected=${r.expectedVerdict} actual=${r.actualVerdict || "-"}` +
    (r.error ? ` error=${r.error}` : ""));
  return [
    `Regression harness: ${report.passed}/${report.total} passed ` +
    `(${report.failed} failed, ${report.errored} errored)`,
    ...lines,
  ].join("\n");
}
