/**
 * Framework Builder V2 — requiredSourceTypes derivation (Deliverable B, change a)
 *
 * Newly-built frameworks used to persist `requiredSourceTypes = null` on every
 * measure, so the live abstain gate (analyzer.ts ~L2942 — abstain iff a measure's
 * requiredSourceTypes is non-empty AND none are in the corpus) never fired. A run
 * that was merely MISSING a load-bearing document then emitted a hard "No" that
 * flipped to "Yes" the next run once the document was fetched.
 *
 * This derives a per-measure requiredSourceTypes list from the measure's OWN
 * declared `disclosureVehicles` (plus a universal annual/regulatory backbone) so a
 * freshly-built framework arrives WITH a live abstain gate. It is deterministic,
 * pure, and fully topic/company/framework-agnostic — it maps whatever disclosure
 * vehicles the measure declares; it hardcodes no framework, company, measure, or
 * sector name.
 *
 * Vocabulary note: the live engine (discovery.ts corpusSourceTypes /
 * detectSourceTypes) accepts DECLARED source types by substring-token matching, so
 * a disclosure-vehicle LABEL carried through verbatim is matchable against a real
 * document's url+title. The backbone tokens are ones the engine classifier
 * PRODUCES directly:
 *   - "Annual Report"     — declared label; self-matches annual-report doc urls/titles
 *   - "annual-report"     — periodicFilingType() token (fires for annual AND integrated reports)
 *   - "regulatory-filing" — detectSourceTypes() token (fires for 10-K/20-F/40-F and regulator hosts)
 * Including all three guarantees the gate can NEVER abstain-forever when a company
 * has ANY primary disclosure (annual report, integrated report, or a regulatory
 * filing); it abstains only on a corpus with no primary disclosure at all.
 */

/** Universal primary-disclosure backbone appended to every measure's list. */
export const REQUIRED_SOURCE_TYPE_BACKBONE: readonly string[] = [
  "Annual Report",
  "annual-report",
  "regulatory-filing",
];

/**
 * Derive a conservative requiredSourceTypes list for one measure from its declared
 * disclosure vehicles plus the universal backbone. Returns a de-duplicated list
 * (declared vehicles first, in declared order, then any backbone tokens not
 * already present). Empty/whitespace vehicle entries are dropped. When the measure
 * declares no vehicles the backbone alone is returned (still a live gate that only
 * abstains on a corpus with no primary disclosure).
 */
export function deriveRequiredSourceTypes(
  disclosureVehicles: unknown,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const v = raw.trim();
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };

  if (Array.isArray(disclosureVehicles)) {
    for (const dv of disclosureVehicles) push(dv);
  }
  for (const b of REQUIRED_SOURCE_TYPE_BACKBONE) push(b);

  return out;
}
