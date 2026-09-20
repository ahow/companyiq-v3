// Stable-identity resolution of edit proposals for /v2/improvement/apply.
//
// Background: the client accepts proposals from ITS snapshot of the edits bundle,
// then the server re-derives a FRESH bundle (proposeEditsForFlags) which may be
// shorter or reordered (flags that no longer fire after rescore drop out). The
// old contract passed a positional index ("P<n>") into the client's array, which
// no longer lines up with the server's re-derived array — causing silent
// mis-application or bogus "proposal not found" skips.
//
// This resolver matches a proposal purely by its stable identity tuple:
//   measureId + flagRule + patch.op + patch.path
// It is fully generic: it branches only on proposal METADATA, never on any
// framework / company / topic / measure id.

export interface ProposalIdentityAttrs {
  measure?: string;
  flagRule?: string;
  op?: string;
  path?: string;
  proposal?: string; // legacy positional label, e.g. "P3"
  [k: string]: unknown;
}

export type ProposalMatch<P> =
  | { status: "matched"; proposal: P }
  | { status: "ambiguous"; candidates: P[] }
  | { status: "absent" }
  | { status: "no-identity" };

// Minimal shape we need from a proposal to match on identity.
interface IdentifiableProposal {
  measureId: string;
  flagRule: string;
  patch?: { op?: string; path?: string } | null;
}

/**
 * Resolve a proposal from a (freshly re-derived) bundle by its stable identity.
 *
 * - No identity fields at all (attrs.measure absent) → "no-identity": the caller
 *   should fall back to the legacy positional P<idx> lookup for old clients.
 * - Identity present: filter by measureId + flagRule.
 *     - If attrs.op AND attrs.path are both provided, prefer the exact full-tuple
 *       match. Exactly one → matched. Zero → absent.
 *     - If op/path not sent (older client that DOES send measure+flagRule), match
 *       on measureId + flagRule only: exactly one → matched, zero → absent,
 *       more than one → ambiguous.
 */
// ─── Shared resolved-proposal identity key ─────────────────────────────────
//
// deriveProposalBundle must suppress any proposal whose edit has already been
// APPLIED (measure_edits.applied=true) or explicitly DISMISSED
// (measure_edits.skip_reason='dismissed'). Both the SUPPRESS path (keying a
// freshly derived proposal) and the RECORD path (keying a persisted
// measure_edits row) MUST compute the identical key, or resolved proposals
// leak back into the results view. This ONE routine is that shared key so the
// two paths can never drift.
//
// The key is (measureId, field, op): the same tuple the apply loop audits with
// (recordMeasureEdit writes field = patch.path, op = patch.op for a proposal),
// which is exactly what a proposal exposes via patch.path / patch.op. flagRule
// is deliberately NOT part of the key — the audit row has no dedicated flagRule
// column, and once a measure's field has been changed by one flag's proposal,
// a second proposal targeting the same field+op is the same resolved edit.
// GENERIC: no framework / company / topic / id is referenced.

function normKeyPart(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

/** Build the shared identity key from its raw (measureId, field, op) parts. */
export function proposalIdentityKeyParts(parts: {
  measureId?: unknown;
  field?: unknown;
  op?: unknown;
}): string {
  return [normKeyPart(parts.measureId), normKeyPart(parts.field), normKeyPart(parts.op)].join("::");
}

/** Shape we need from a derived proposal to compute its resolved-identity key. */
interface KeyableProposal {
  measureId: string;
  fieldPath?: string;
  patch?: { op?: string; path?: string } | null;
}

/**
 * Key a freshly DERIVED proposal. field is taken from patch.path (falling back
 * to fieldPath — they are equal for every builder) so it lines up with the
 * measure_edits.field the apply loop records.
 */
export function proposalKeyFromProposal(p: KeyableProposal): string {
  return proposalIdentityKeyParts({
    measureId: p.measureId,
    field: p.patch?.path ?? p.fieldPath,
    op: p.patch?.op,
  });
}

/** Shape we need from a persisted measure_edits row (snake_case from SQL). */
interface KeyableEditRow {
  measure_id?: string;
  measureId?: string;
  field?: string;
  op?: string | null;
}

/** Key a persisted measure_edits row with the SAME routine as the proposal. */
export function proposalKeyFromEditRow(row: KeyableEditRow): string {
  return proposalIdentityKeyParts({
    measureId: row.measure_id ?? row.measureId,
    field: row.field,
    op: row.op,
  });
}

export function resolveProposalByIdentity<P extends IdentifiableProposal>(
  bundleProposals: P[],
  attrs: ProposalIdentityAttrs | undefined,
): ProposalMatch<P> {
  const measure = attrs?.measure;
  if (measure === undefined || measure === null || measure === "") {
    return { status: "no-identity" };
  }

  const flagRule = attrs?.flagRule ?? "";
  const byMeasureAndRule = bundleProposals.filter(
    (p) => p.measureId === measure && p.flagRule === flagRule,
  );

  const op = attrs?.op ?? "";
  const path = attrs?.path ?? "";
  const hasOpPath = op !== "" && path !== "";

  if (hasOpPath) {
    // Prefer exact full-tuple match; identity tuple is unique per proposal.
    const exact = byMeasureAndRule.filter(
      (p) => (p.patch?.op ?? "") === op && (p.patch?.path ?? "") === path,
    );
    if (exact.length === 1) return { status: "matched", proposal: exact[0] };
    if (exact.length > 1) return { status: "ambiguous", candidates: exact };
    return { status: "absent" };
  }

  // Older client: only measureId + flagRule available.
  if (byMeasureAndRule.length === 1) {
    return { status: "matched", proposal: byMeasureAndRule[0] };
  }
  if (byMeasureAndRule.length > 1) {
    return { status: "ambiguous", candidates: byMeasureAndRule };
  }
  return { status: "absent" };
}
