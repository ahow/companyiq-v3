/**
 * Priority 3 — retrieval robustness + first-run comprehensiveness.
 *
 * Pure, side-effect-free helpers gated by the default-OFF flags in
 * scoring-fix-flags.ts. No company/framework/measure names hardcoded — all
 * inputs (seed URLs, exclusion keywords, quote-sharing policy) come from
 * framework/measure data.
 *
 * Covers:
 *   3.2a seed known URLs          — seedKnownDisclosureUrls()
 *   3.2b vehicle-agnostic gate    — requiredSourceTypesBlocking()
 *   3.2c relaxable exclusions     — applyExclusionKeywords()
 *   3.3a single-use quotes        — QuoteLedger
 *   3.3b adjacent-passage span    — passagesAreAdjacent(), spanSatisfies()
 *   3.4a funnel instrumentation   — RetrievalFunnel
 */

// ── 3.2a Seed known disclosure URLs ──────────────────────────────────────────

export interface CompanySeed {
  companyId?: number | string | null;
  companyName?: string | null;
  /** framework-supplied known disclosure URLs for this company. */
  knownDisclosureUrls?: string[] | null;
}

/**
 * Merge framework-supplied known disclosure URLs into an existing seed list,
 * de-duplicated and normalised, preserving the already-seeded URLs first. Reads
 * URLs ONLY from the per-company framework data — never fabricated.
 */
export function seedKnownDisclosureUrls(
  existing: string[] | null | undefined,
  seed: CompanySeed | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: unknown) => {
    const s = typeof u === "string" ? u.trim() : "";
    if (!s) return;
    const key = s.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const u of existing || []) push(u);
  for (const u of seed?.knownDisclosureUrls || []) push(u);
  return out;
}

// ── 3.2b Vehicle-agnostic retrieval ──────────────────────────────────────────

/**
 * When RETRIEVAL_VEHICLE_AGNOSTIC is ON, requiredSourceTypes becomes a
 * RANKING signal, not a blocking filter — so a material document is never
 * excluded purely because of its vehicle. Returns whether the required-source
 * constraint should BLOCK (exclude) a doc. Off → blocking preserved (original).
 */
export function requiredSourceTypesBlocking(vehicleAgnosticEnabled: boolean): boolean {
  return !vehicleAgnosticEnabled;
}

// ── 3.2c Relaxable exclusion keywords ────────────────────────────────────────

/**
 * Apply transition-risk exclusion keywords to a candidate. When `relaxed` is ON,
 * a candidate that ALSO carries a relevant on-theme keyword is NOT excluded
 * (so sustainability/TCFD/CDP docs aren't down-ranked away). All keyword lists
 * come from framework data.
 */
export function shouldExcludeByKeywords(
  text: string | null | undefined,
  exclusionKeywords: string[] | null | undefined,
  onThemeKeywords: string[] | null | undefined,
  relaxed: boolean,
): boolean {
  const lower = (text || "").toLowerCase();
  const excl = (exclusionKeywords || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  const hitExcl = excl.some((k) => lower.includes(k));
  if (!hitExcl) return false;
  if (!relaxed) return true; // original behaviour: any exclusion keyword excludes
  const onTheme = (onThemeKeywords || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  const hasOnTheme = onTheme.some((k) => lower.includes(k));
  return !hasOnTheme; // relaxed: keep if the doc is also on-theme
}

// ── 3.3a Single-use quotes ───────────────────────────────────────────────────

/**
 * Ledger that enforces each quote counting toward ONE measure unless the measure
 * explicitly allows sharing. Quotes are normalised (whitespace/punctuation) so
 * trivially-different copies of the same sentence collide.
 */
export class QuoteLedger {
  private claimed = new Map<string, string>(); // normQuote -> measureId

  private norm(q: string): string {
    return q.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
  }

  /**
   * Try to claim a quote for a measure.
   * @returns true if the quote may count toward `measureId`.
   */
  claim(quote: string, measureId: string, allowSharing: boolean): boolean {
    const key = this.norm(quote);
    if (!key) return true;
    if (allowSharing) return true;
    const owner = this.claimed.get(key);
    if (owner == null) {
      this.claimed.set(key, measureId);
      return true;
    }
    return owner === measureId;
  }
}

// ── 3.3b Adjacent-passage span ───────────────────────────────────────────────

export interface PassageSpan {
  docId: string | number;
  start: number;
  end: number;
  text: string;
}

/** Two passages are adjacent when they are in the SAME document and the gap
 *  between them is within `maxGap` characters (overlap counts as adjacent). */
export function passagesAreAdjacent(a: PassageSpan, b: PassageSpan, maxGap: number): boolean {
  if (String(a.docId) !== String(b.docId)) return false;
  const gap = a.end <= b.start ? b.start - a.end : a.start >= b.end ? a.start - b.end : 0;
  return gap <= Math.max(0, maxGap);
}

/**
 * Whether the concatenation of two ADJACENT same-document passages satisfies a
 * predicate that neither passage satisfies alone. `predicate` is supplied by the
 * caller (e.g. "all required condition tokens present"). Returns false when the
 * passages are not adjacent, so this only ever RELAXES by spanning a boundary.
 */
export function spanSatisfies(
  a: PassageSpan,
  b: PassageSpan,
  maxGap: number,
  predicate: (text: string) => boolean,
): boolean {
  if (predicate(a.text) || predicate(b.text)) return true;
  if (!passagesAreAdjacent(a, b, maxGap)) return false;
  const joined = a.start <= b.start ? `${a.text} ${b.text}` : `${b.text} ${a.text}`;
  return predicate(joined);
}

// ── 3.4a Discovery → extraction → in-evidence funnel instrumentation ──────────

/**
 * ADDITIVE per-run counters. Pure accumulation; never alters a verdict. Emit
 * with toJSON() to logs/telemetry when RETRIEVAL_FUNNEL_INSTRUMENTATION is on.
 */
export class RetrievalFunnel {
  discovered = 0;
  fetched = 0;
  extracted = 0;
  passedToScorer = 0;
  /** per-vehicle extraction failures, e.g. {"pdf-behind-link": 7}. */
  failuresByVehicle: Record<string, number> = {};

  countDiscovered(n = 1) { this.discovered += n; }
  countFetched(n = 1) { this.fetched += n; }
  countExtracted(n = 1) { this.extracted += n; }
  countPassedToScorer(n = 1) { this.passedToScorer += n; }
  countFailure(vehicle: string, n = 1) {
    const k = vehicle || "unknown";
    this.failuresByVehicle[k] = (this.failuresByVehicle[k] || 0) + n;
  }

  /** Fraction of discovered docs whose text reached the scorer (0..1). */
  get throughput(): number {
    return this.discovered > 0 ? this.passedToScorer / this.discovered : 0;
  }

  toJSON() {
    return {
      discovered: this.discovered,
      fetched: this.fetched,
      extracted: this.extracted,
      passedToScorer: this.passedToScorer,
      throughput: Number(this.throughput.toFixed(3)),
      failuresByVehicle: this.failuresByVehicle,
    };
  }
}

// ── 3.4b Bounded extraction-retry decision ───────────────────────────────────

/**
 * Decide whether a failed extraction may be retried. STRICTLY BOUNDED by
 * `budget` and only for the dominant recoverable vehicle(s) the caller lists —
 * so it can neither loop nor inflate cost. Returns false once attempts reach the
 * budget or the vehicle isn't in the recoverable set.
 */
export function mayRetryExtraction(
  vehicle: string | null | undefined,
  attemptsSoFar: number,
  budget: number,
  recoverableVehicles: string[],
): boolean {
  if (budget <= 0) return false;
  if (attemptsSoFar >= budget) return false;
  const v = (vehicle || "").toLowerCase();
  return recoverableVehicles.map((s) => s.toLowerCase()).includes(v);
}
