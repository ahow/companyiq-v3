// ─── WP15 / A9 — Truthful publication & release-evidence governance ───────────
// Plan: docs/quality-and-efficiency-improvement-plan.md
//   "A9. Publish truthful results & maintain release evidence (WP15)" (line ~205)
//   summary-table row (line ~82); WP23 measurement definitions (line ~244);
//   CV01–CV07 coverage/research-state concepts (line ~125).
//   Tests PU01–PU06 (line ~209).
//
// WHAT THIS IS
// ------------
// A pure, framework-level REPORTING / GOVERNANCE layer. It is the single accessor
// every reader surface (API, UI, CSV, Word, PDF) routes through so a verdict, its
// evidence and its research/coverage status can never diverge between surfaces, and
// so that a reviewer can always tell an UNCHANGED score from one whose research
// quietly became INCOMPLETE. It also records release evidence HONESTLY: immutable
// published snapshots with explicit revisions (never a silent recompute of
// history), candidate-review / approval / merge / deploy / validation / acceptance
// kept as SEPARATE record types (a commit message is not an approval), and a
// release gate that keeps RAW (non-deduped) evidence so a deduped signature can
// never hide an occurrence.
//
// HARD SCOPE GUARD (why cell-flips are 0/0 BY CONSTRUCTION)
// --------------------------------------------------------
// This module reads and formats published data; it NEVER produces, mutates, or
// re-derives a verdict/score. The only verdict transform it applies is the
// EXISTING canonical `normalizeVerdict` from shared/verdict.ts (already applied by
// every current surface), so the shipped default is byte-identical to today's
// output. No analyzer / evidence / scoring path is touched ⇒ no published-score
// surface is mutated ⇒ Total cells Y→N = 0, N→Y = 0, Total Flips = 0.
//
// REUSE (no parallel provenance invented)
// ---------------------------------------
//   - shared/verdict.ts          → normalizeVerdict / isMet / normalizedScore
//   - shared/research-state.ts   → ResearchStatus / summarizeResearchStatus /
//                                   researchStatusCsvColumns (CV01–CV07)
//   - server/lib/run-manifest.ts → hashObject / canonicalize / RunManifest fields
//                                   (framework/corpus/code-tree/repro-limit provenance)

import { createHash } from "node:crypto";
import { normalizeVerdict, isMet } from "../../shared/verdict.js";
import {
  summarizeResearchStatus,
  researchStatusCsvColumns,
  type ResearchStatus,
} from "../../shared/research-state.js";
import { hashObject, canonicalize, type RunManifest } from "./run-manifest.js";

// ─── Kill-switch (mirrors the WP13/B5 + WP14/B6 pattern exactly) ──────────────

/**
 * PUBLICATION_POLICY controls how much governance metadata the shared accessor
 * SURFACES to a reader.
 *   - passthrough (DEFAULT): emit exactly what each surface emits today — the
 *     canonical verdict + evidence + existing columns, and NOTHING new. Byte-
 *     identical to current production; a reader sees no added/changed field.
 *   - annotate: additionally APPEND the research/coverage + provenance columns
 *     (never altering an existing field — purely additive trailing columns).
 *   - shadow: compute the full governance view for telemetry/logging but return
 *     the passthrough view to the reader (observe-only, like B5/B6 shadow).
 */
export type PublicationPolicy = "passthrough" | "annotate" | "shadow";

/** SHIPPED DEFAULT — non-mutating passthrough (byte-identical to current prod). */
export const DEFAULT_PUBLICATION_POLICY: PublicationPolicy = "passthrough";

/** Env var name for the kill-switch (documented in the ledger). */
export const PUBLICATION_POLICY_ENV = "PUBLICATION_POLICY";

/** Bump when resolve/serialization semantics change (mirrors other WP versions). */
export const PUBLICATION_POLICY_VERSION = 1;

/**
 * Resolve the active policy: explicit arg > env PUBLICATION_POLICY > default.
 * Any unrecognised/empty value falls back to the shipped default ("passthrough" —
 * fail-safe to standing production behaviour, so a typo can never silently change
 * what a reader sees). Total: never throws.
 */
export function resolvePublicationPolicy(
  explicit?: PublicationPolicy | null,
): PublicationPolicy {
  if (explicit === "passthrough" || explicit === "annotate" || explicit === "shadow") {
    return explicit;
  }
  try {
    const env = (process.env[PUBLICATION_POLICY_ENV] || "").trim().toLowerCase();
    if (env === "passthrough" || env === "annotate" || env === "shadow") {
      return env as PublicationPolicy;
    }
  } catch {
    /* process.env unavailable — fall through to default */
  }
  return DEFAULT_PUBLICATION_POLICY;
}

// ─── (a) The publication record — one canonical shape for every surface ───────

/** Source scope + as-of travelling with every published assessment. */
export interface PublicationScope {
  /** Framework version/id the score was produced under. */
  frameworkVersion: string | number | null;
  frameworkHash: string | null;
  /** As-of date of the assessment (temporal scope). */
  asOf: string | null;
  /** Entity boundary (company id / list id). */
  entityScope: { companyId?: number | null; listId?: number | null } | null;
}

/** Run provenance, reusing run-manifest fields (NOT a parallel system). */
export interface PublicationProvenance {
  runId: string | null;
  runMode: RunManifest["runMode"] | null;
  manifestHash: string | null;
  codeTreeHash: string | null;
  gitSha: string | null;
  /** Honest reproducibility limits carried verbatim from the run manifest. */
  reproducibilityLimits: RunManifest["reproducibilityLimits"];
}

/** The input a caller assembles once per company×measure cell. */
export interface PublicationInput {
  companyId?: number | null;
  measureId: string;
  /** Raw stored verdict (pre-normalisation). */
  verdict?: string | null;
  /** Raw numeric score, if the verdict string is absent. */
  score?: number | null;
  /** Short reader-facing rationale/evidence summary. */
  evidenceSummary?: string | null;
  /** Supporting quote shown to the reader. */
  supportingQuote?: string | null;
  /** Stable evidence/passage IDs backing the verdict (ordering preserved). */
  evidenceIds?: string[] | null;
  /** Source document title + link shown to the reader. */
  sourceDocument?: string | null;
  sourceLink?: string | null;
  scope: PublicationScope;
  provenance?: Partial<PublicationProvenance> | null;
  /** The cell's research/coverage status (CV01–CV07). */
  researchStatus?: ResearchStatus | null;
}

/**
 * The canonical, surface-independent publication record. EVERY reader surface
 * derives its output from this object, so verdict / evidence / status cannot
 * diverge between API, UI, CSV, Word and PDF (PU01 / CV07).
 */
export interface PublicationRecord {
  companyId: number | null;
  measureId: string;
  /** Canonical binary verdict (shared/verdict.ts) — the one every surface shows. */
  verdict: string;
  /** Met = counts toward Total Score (%). */
  met: boolean;
  evidenceSummary: string;
  supportingQuote: string;
  evidenceIds: string[];
  sourceDocument: string;
  sourceLink: string;
  scope: PublicationScope;
  provenance: PublicationProvenance;
  researchStatus: ResearchStatus | null;
  /** One-line research/coverage label (summarizeResearchStatus). */
  researchStatusLabel: string;
  /** TRUE only when research is comprehensive AND nothing is unresolved. */
  comprehensive: boolean;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Build the canonical publication record. Pure + deterministic. The ONLY verdict
 * transform is the existing canonical normalizeVerdict (already applied by every
 * current surface) ⇒ the verdict field is byte-identical to what surfaces show
 * today. Research status is carried through unchanged (additive).
 */
export function buildPublicationRecord(input: PublicationInput): PublicationRecord {
  const verdict = normalizeVerdict(input.verdict);
  const prov = input.provenance || {};
  const researchStatus = input.researchStatus ?? null;
  return {
    companyId: input.companyId ?? null,
    measureId: input.measureId,
    verdict,
    met: isMet(input.verdict, input.score),
    evidenceSummary: str(input.evidenceSummary),
    supportingQuote: str(input.supportingQuote),
    evidenceIds: Array.isArray(input.evidenceIds) ? [...input.evidenceIds] : [],
    sourceDocument: str(input.sourceDocument),
    sourceLink: str(input.sourceLink),
    scope: {
      frameworkVersion: input.scope?.frameworkVersion ?? null,
      frameworkHash: input.scope?.frameworkHash ?? null,
      asOf: input.scope?.asOf ?? null,
      entityScope: input.scope?.entityScope ?? null,
    },
    provenance: {
      runId: prov.runId ?? null,
      runMode: prov.runMode ?? null,
      manifestHash: prov.manifestHash ?? null,
      codeTreeHash: prov.codeTreeHash ?? null,
      gitSha: prov.gitSha ?? null,
      reproducibilityLimits: prov.reproducibilityLimits ?? [],
    },
    researchStatus,
    researchStatusLabel: summarizeResearchStatus(researchStatus),
    comprehensive: researchStatus ? researchStatus.comprehensive : false,
  };
}

// ─── (b) Never display an incomplete assessment as comprehensive ──────────────

/**
 * Guard: an incomplete assessment must NEVER be rendered/exported as
 * "comprehensive", and history is never silently relabelled. Returns the list of
 * violations (empty = safe). Pure; callers decide whether to throw or drop.
 */
export function assertTruthfulCompleteness(
  record: PublicationRecord,
  claimedComprehensive: boolean,
): string[] {
  const problems: string[] = [];
  if (claimedComprehensive && !record.comprehensive) {
    problems.push(
      `cell ${record.companyId ?? "?"}/${record.measureId}: claimed comprehensive but research is ${
        record.researchStatus?.state ?? "unknown"
      } (${record.researchStatusLabel})`,
    );
  }
  return problems;
}

// ─── Surface serializers — all derive from the SAME record (PU01 / CV07) ──────

/** Fields shared by API/UI/Word/PDF — the single verdict/evidence/status view. */
export interface PublicationView {
  companyId: number | null;
  measureId: string;
  verdict: string;
  met: boolean;
  evidenceSummary: string;
  supportingQuote: string;
  sourceDocument: string;
  sourceLink: string;
  /** Present only under annotate (additive governance block); null otherwise. */
  governance: {
    researchStatus: string;
    comprehensive: boolean;
    evidenceIds: string[];
    frameworkVersion: string | number | null;
    asOf: string | null;
    runId: string | null;
    manifestHash: string | null;
    gitSha: string | null;
    reproducibilityLimits: string[];
  } | null;
}

function governanceBlock(r: PublicationRecord): NonNullable<PublicationView["governance"]> {
  return {
    researchStatus: r.researchStatusLabel,
    comprehensive: r.comprehensive,
    evidenceIds: [...r.evidenceIds],
    frameworkVersion: r.scope.frameworkVersion,
    asOf: r.scope.asOf,
    runId: r.provenance.runId,
    manifestHash: r.provenance.manifestHash,
    gitSha: r.provenance.gitSha,
    reproducibilityLimits: r.provenance.reproducibilityLimits.map((l) => `${l.field}: ${l.reason}`),
  };
}

/**
 * Canonical view for API/UI/Word/PDF. passthrough/shadow → NO governance block
 * (byte-identical to today). annotate → additive governance block, existing
 * fields untouched. One function so no surface can diverge.
 */
export function toPublicationView(
  record: PublicationRecord,
  policy: PublicationPolicy = resolvePublicationPolicy(),
): PublicationView {
  const base: PublicationView = {
    companyId: record.companyId,
    measureId: record.measureId,
    verdict: record.verdict,
    met: record.met,
    evidenceSummary: record.evidenceSummary,
    supportingQuote: record.supportingQuote,
    sourceDocument: record.sourceDocument,
    sourceLink: record.sourceLink,
    governance: null,
  };
  if (policy === "annotate") base.governance = governanceBlock(record);
  return base;
}

/** A single CSV column (header + value), order-preserving. */
export interface CsvColumn {
  header: string;
  value: string;
}

/**
 * Canonical CSV columns for the Python/TS CSV exporters. The per-measure base
 * columns (verdict/rationale/quote/source) are emitted identically under every
 * policy — byte-identical to today's CSV. Under annotate the research-status
 * columns (researchStatusCsvColumns — reused, CV07) are APPENDED after the base
 * columns; existing columns are never reordered or changed.
 */
export function toPublicationCsvColumns(
  record: PublicationRecord,
  policy: PublicationPolicy = resolvePublicationPolicy(),
): CsvColumn[] {
  const base: CsvColumn[] = [
    { header: "Score", value: record.verdict },
    { header: "Rationale", value: record.evidenceSummary },
    { header: "Supporting Quote", value: record.supportingQuote },
    { header: "Source Document", value: record.sourceDocument },
    { header: "Source Link", value: record.sourceLink },
  ];
  if (policy === "annotate") {
    for (const c of researchStatusCsvColumns(record.researchStatus)) base.push(c);
  }
  return base;
}

// ─── (c) Immutable published snapshots + explicit revisions ───────────────────

export interface PublishedSnapshot {
  snapshotId: string;
  /** SHA-256 over the canonical record payload (the immutability anchor). */
  contentHash: string;
  /** The frozen record payload (deep-copied; never mutated after publish). */
  records: PublicationRecord[];
  publishedAt: string;
  /** Monotonic revision number within a lineage (1 = original publish). */
  revisionNumber: number;
  /** snapshotId of the snapshot this one revises (null for the original). */
  revisionOf: string | null;
  /** Explicit, human reason for a revision (required when revisionOf != null). */
  revisionReason: string | null;
}

/** Deep structural clone that is safe for our plain-JSON records. */
function freezeClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function snapshotContentHash(records: PublicationRecord[]): string {
  // Canonical (key-sorted) over the records array — order of records IS meaningful.
  return hashObject(records);
}

/**
 * Publish an IMMUTABLE snapshot (revision 1 of a new lineage). The records are
 * deep-cloned so a later mutation of the caller's objects cannot alter history.
 */
export function publishSnapshot(
  records: PublicationRecord[],
  opts?: { snapshotId?: string; now?: string },
): PublishedSnapshot {
  const frozen = freezeClone(records);
  const contentHash = snapshotContentHash(frozen);
  return {
    snapshotId: opts?.snapshotId || `snap_${contentHash.slice(0, 16)}`,
    contentHash,
    records: frozen,
    publishedAt: opts?.now || new Date().toISOString(),
    revisionNumber: 1,
    revisionOf: null,
    revisionReason: null,
  };
}

/**
 * Correct a published snapshot by creating an EXPLICIT new revision. The prior
 * snapshot object is returned UNCHANGED (immutable); the new revision links back
 * to it via revisionOf and carries a required reason. History is never silently
 * recomputed — a correction is always a new, dated, linked revision.
 */
export function reviseSnapshot(
  previous: PublishedSnapshot,
  newRecords: PublicationRecord[],
  reason: string,
  opts?: { snapshotId?: string; now?: string },
): PublishedSnapshot {
  if (!reason || !reason.trim()) {
    throw new Error("reviseSnapshot requires an explicit revision reason (no silent recompute)");
  }
  const frozen = freezeClone(newRecords);
  const contentHash = snapshotContentHash(frozen);
  return {
    snapshotId: opts?.snapshotId || `snap_${contentHash.slice(0, 16)}_r${previous.revisionNumber + 1}`,
    contentHash,
    records: frozen,
    publishedAt: opts?.now || new Date().toISOString(),
    revisionNumber: previous.revisionNumber + 1,
    revisionOf: previous.snapshotId,
    revisionReason: reason.trim(),
  };
}

/**
 * Verify a snapshot is intact: recompute the content hash over its records and
 * compare to the stored contentHash. Returns true iff byte-for-byte unchanged.
 */
export function verifySnapshotIntegrity(snapshot: PublishedSnapshot): boolean {
  return snapshotContentHash(snapshot.records) === snapshot.contentHash;
}

// ─── (d) Separate release record types (commit message ≠ approval) ────────────

export type ReleaseRecordType =
  | "candidate-review"
  | "approval"
  | "merge"
  | "deploy"
  | "validation"
  | "acceptance";

export const RELEASE_RECORD_TYPES: ReleaseRecordType[] = [
  "candidate-review",
  "approval",
  "merge",
  "deploy",
  "validation",
  "acceptance",
];

export interface ReleaseRecord {
  type: ReleaseRecordType;
  /** Stable id for this record. */
  id: string;
  /** ISO timestamp — every record is dated history. */
  at: string;
  /** Who/what produced it (a person for approval; a system for deploy). */
  actor: string;
  /** Freeform detail (test output ref, PR number, SHA, roster id, …). */
  detail: string;
  /** TRUE when the text is preserved as HISTORY, not current status. */
  historical: boolean;
  /** Optional link to the record it supersedes (dated lineage). */
  supersedes?: string | null;
}

/**
 * A commit message is NOT an approval. This classifier refuses to mint an
 * `approval` record from a commit message / merge text, no matter what the text
 * claims ("approved", "LGTM", …). It returns a `merge` record flagged historical
 * so a merged release carrying embedded "feature-branch-only" / "approved" text
 * is preserved as DATED HISTORY, never promoted to current approval status.
 */
export function classifyCommitAsReleaseEvidence(input: {
  commitSha: string;
  message: string;
  at: string;
  author: string;
}): ReleaseRecord {
  return {
    type: "merge",
    id: `merge_${input.commitSha.slice(0, 12)}`,
    at: input.at,
    actor: input.author,
    detail: input.message,
    historical: true,
    supersedes: null,
  };
}

/**
 * Mint an explicit approval record. Approval can ONLY come from an out-of-band
 * approval act (a named approver + reference), never inferred from code/commit
 * text. Throws if asked to approve on the strength of a commit message alone.
 */
export function recordApproval(input: {
  approver: string;
  approvalRef: string;
  at: string;
  fromCommitMessage?: boolean;
}): ReleaseRecord {
  if (input.fromCommitMessage) {
    throw new Error("A commit message is not approval — supply an explicit approver + approvalRef");
  }
  if (!input.approver?.trim() || !input.approvalRef?.trim()) {
    throw new Error("recordApproval requires a named approver and an approvalRef");
  }
  return {
    type: "approval",
    id: `approval_${input.approvalRef}`,
    at: input.at,
    actor: input.approver.trim(),
    detail: `approvalRef=${input.approvalRef.trim()}`,
    historical: false,
    supersedes: null,
  };
}

/**
 * Preserve "feature-branch-only" text found embedded in a merged release as a
 * dated HISTORY record, so it can never be read as current deployment status.
 */
export function preserveFeatureBranchText(input: {
  text: string;
  mergeSha: string;
  at: string;
}): ReleaseRecord {
  return {
    type: "merge",
    id: `fb_hist_${input.mergeSha.slice(0, 12)}`,
    at: input.at,
    actor: "system",
    detail: `[historical feature-branch-only text preserved] ${input.text}`,
    historical: true,
    supersedes: null,
  };
}

/** The current (non-historical) status for each record type, if any. */
export function currentReleaseStatus(
  records: ReleaseRecord[],
): Partial<Record<ReleaseRecordType, ReleaseRecord>> {
  const out: Partial<Record<ReleaseRecordType, ReleaseRecord>> = {};
  for (const r of records) {
    if (r.historical) continue;
    const existing = out[r.type];
    if (!existing || r.at > existing.at) out[r.type] = r;
  }
  return out;
}

// ─── (e) Release-gate evidence — RAW, non-deduped (nothing can hide) ──────────

/** One raw test occurrence (kept even when its signature duplicates another). */
export interface TestOccurrence {
  suite: string;
  name: string;
  status: "pass" | "fail" | "skip";
  /** Why a test was skipped (a skip is NEVER silently counted as a pass). */
  skipReason?: string | null;
}

/** One raw TS diagnostic occurrence (multiplicity preserved). */
export interface TsDiagnosticOccurrence {
  file: string;
  line: number;
  code: string;
  message: string;
}

/** A mutation-sensitivity probe: injecting `mutation` MUST make `guardTest` fail. */
export interface MutationCheck {
  mutation: string;
  guardTest: string;
  /** Did the guard test actually FAIL when the mutation was injected? */
  guardFailedAsExpected: boolean;
}

/** A required packaging asset under the ACTUAL service layout. */
export interface PackagingAsset {
  path: string;
  present: boolean;
  /** e.g. "worker-subprocess", "chromium", "ocr-binary". */
  role: string;
}

export interface ReleaseGateEvidenceInput {
  /** RAW test list — every occurrence, not a deduped set. */
  tests: TestOccurrence[];
  /** RAW TS diagnostics — every occurrence (multiplicity kept). */
  tsDiagnostics: TsDiagnosticOccurrence[];
  /** Baseline diagnostic count the gate accepts (e.g. 62). */
  tsBaseline: number;
  mutationChecks: MutationCheck[];
  packaging: PackagingAsset[];
  /** Chromium presence — a MISSING Chromium must FAIL the gate (PU04). */
  chromiumPresent: boolean;
}

export interface ReleaseGateEvidence {
  /** RAW evidence, preserved verbatim (deduped signatures can't hide these). */
  raw: {
    tests: TestOccurrence[];
    tsDiagnostics: TsDiagnosticOccurrence[];
    mutationChecks: MutationCheck[];
    packaging: PackagingAsset[];
    chromiumPresent: boolean;
  };
  /** A dedup SUMMARY shown alongside — never INSTEAD OF — the raw lists. */
  summary: {
    testsTotal: number;
    testsPassed: number;
    testsFailed: number;
    testsSkipped: number;
    /** Count of DISTINCT diagnostic signatures (file:line:code). */
    tsDistinctSignatures: number;
    /** RAW diagnostic count (multiplicity) — kept so dedup can't hide repeats. */
    tsRawOccurrences: number;
  };
  pass: boolean;
  failures: string[];
}

function diagSignature(d: TsDiagnosticOccurrence): string {
  return `${d.file}:${d.line}:${d.code}`;
}

/**
 * Record + evaluate the release gate from RAW evidence. The dedup summary is
 * computed FOR DISPLAY but the raw lists are always preserved. The gate FAILS
 * (never a silent exit-0 skip) when:
 *   - any mandatory test failed, OR a skip has no explicit reason;
 *   - TS diagnostics exceed the accepted baseline (by RAW count);
 *   - Chromium is missing (PU04);
 *   - any mutation guard did NOT fail as expected (PU05);
 *   - any required packaging asset is absent (PU06).
 * Pure + total.
 */
export function evaluateReleaseGate(input: ReleaseGateEvidenceInput): ReleaseGateEvidence {
  const tests = input.tests || [];
  const diags = input.tsDiagnostics || [];
  const failures: string[] = [];

  const testsPassed = tests.filter((t) => t.status === "pass").length;
  const testsFailed = tests.filter((t) => t.status === "fail").length;
  const skipped = tests.filter((t) => t.status === "skip");

  if (testsFailed > 0) failures.push(`${testsFailed} mandatory test(s) failed`);
  for (const s of skipped) {
    if (!s.skipReason || !s.skipReason.trim()) {
      failures.push(`test skipped without an explicit reason: ${s.suite}/${s.name}`);
    }
  }

  const distinct = new Set(diags.map(diagSignature));
  if (diags.length > input.tsBaseline) {
    failures.push(`TS diagnostics ${diags.length} exceed accepted baseline ${input.tsBaseline} (raw count)`);
  }

  // PU04 — missing Chromium FAILS the gate (not an exit-0 skip).
  if (!input.chromiumPresent) {
    failures.push("Chromium is missing — release gate FAILS (not an exit-0 skip)");
  }

  // PU05 — a mutation guard that did not fail as expected is a blind spot.
  for (const m of input.mutationChecks || []) {
    if (!m.guardFailedAsExpected) {
      failures.push(
        `mutation-sensitivity blind spot: injecting "${m.mutation}" did NOT fail guard "${m.guardTest}"`,
      );
    }
  }

  // PU06 — required subprocess/worker assets must be present under real layout.
  for (const a of input.packaging || []) {
    if (!a.present) failures.push(`packaging asset missing (${a.role}): ${a.path}`);
  }

  return {
    raw: {
      tests: [...tests],
      tsDiagnostics: [...diags],
      mutationChecks: [...(input.mutationChecks || [])],
      packaging: [...(input.packaging || [])],
      chromiumPresent: input.chromiumPresent,
    },
    summary: {
      testsTotal: tests.length,
      testsPassed,
      testsFailed,
      testsSkipped: skipped.length,
      tsDistinctSignatures: distinct.size,
      tsRawOccurrences: diags.length,
    },
    pass: failures.length === 0,
    failures,
  };
}

/**
 * Reconcile the runtime tree with the tested tree (PU03): the deployed commit
 * SHA must equal the tested commit SHA. Returns the match + a reason.
 */
export function reconcileRuntimeWithTested(input: {
  deployedSha: string | null | undefined;
  testedSha: string | null | undefined;
}): { reconciled: boolean; reason: string } {
  const d = (input.deployedSha || "").trim();
  const t = (input.testedSha || "").trim();
  if (!d || !t) {
    return { reconciled: false, reason: "missing deployed or tested SHA — cannot reconcile" };
  }
  // Accept short/long SHA equivalence (one a prefix of the other).
  const match = d === t || d.startsWith(t) || t.startsWith(d);
  return {
    reconciled: match,
    reason: match ? `runtime SHA ${d} reconciles with tested ${t}` : `runtime SHA ${d} ≠ tested ${t}`,
  };
}

// ─── (f) WP23 measurement baseline — keyed by framework/topic/language/sector ─

/** Composite key so a global average can't hide small-issuer / non-English gaps. */
export interface MeasurementKey {
  framework: string;
  topic: string;
  language: string;
  sector: string;
}

/** The WP23 measurement set. incompleteResearchRate is tracked SEPARATELY. */
export interface MeasurementRow {
  essentialSourceRecall: number;
  criticalPassageRecall: number;
  positivePrecision: number;
  positiveRecall: number;
  /** Separate from positive precision/recall (never folded in). */
  incompleteResearchRate: number;
  quoteValidity: number;
  acceptedThroughput: number;
  allInAcceptedUnitCost: number;
  wastedWorkRatio: number;
  latencyP50: number;
  latencyP95: number;
  latencyMax: number;
  /** Number of accepted units this row aggregates (the denominator). */
  sampleSize: number;
}

/** Stable key string for a measurement row (sorted, lower-cased segments). */
export function measurementKeyString(k: MeasurementKey): string {
  return [k.framework, k.topic, k.language, k.sector]
    .map((s) => str(s).trim().toLowerCase() || "(unspecified)")
    .join(" | ");
}

/** A permanent baseline table keyed by framework/topic/language/sector. */
export class MeasurementBaseline {
  private rows = new Map<string, { key: MeasurementKey; row: MeasurementRow }>();

  upsert(key: MeasurementKey, row: MeasurementRow): void {
    this.rows.set(measurementKeyString(key), { key: { ...key }, row: { ...row } });
  }

  get(key: MeasurementKey): MeasurementRow | null {
    return this.rows.get(measurementKeyString(key))?.row ?? null;
  }

  /** All rows, sorted by key — the permanent per-subgroup baseline table. */
  all(): Array<{ key: MeasurementKey; keyString: string; row: MeasurementRow }> {
    return Array.from(this.rows.entries())
      .map(([keyString, v]) => ({ key: v.key, keyString, row: v.row }))
      .sort((a, b) => a.keyString.localeCompare(b.keyString));
  }

  /** Serialize to a plain, round-trippable object (canonical ordering). */
  serialize(): string {
    return canonicalize(
      this.all().map((r) => ({ key: r.key, row: r.row })),
    );
  }

  /** Rebuild a baseline from its serialized form. */
  static deserialize(json: string): MeasurementBaseline {
    const b = new MeasurementBaseline();
    const parsed = JSON.parse(json) as Array<{ key: MeasurementKey; row: MeasurementRow }>;
    for (const { key, row } of parsed) b.upsert(key, row);
    return b;
  }
}

// ─── Round-trip serialization for a publication record (PU + integrity) ───────

/** Canonical JSON for a publication record (stable key ordering). */
export function serializePublicationRecord(r: PublicationRecord): string {
  return canonicalize(r);
}

/** Parse back a publication record (round-trip safe). */
export function deserializePublicationRecord(json: string): PublicationRecord {
  return JSON.parse(json) as PublicationRecord;
}

/** SHA-256 over a record's canonical form (used by snapshots / integrity). */
export function publicationRecordHash(r: PublicationRecord): string {
  return createHash("sha256").update(serializePublicationRecord(r)).digest("hex");
}
