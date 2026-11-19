/**
 * Priority 2 — execute the framework's OWN structured rules.
 *
 * Every function here is PURE and reads its rule shape FROM FRAMEWORK/MEASURE
 * DATA (never a hardcoded company, framework or measure name). All behaviour is
 * gated at the call sites by the default-OFF flags in scoring-fix-flags.ts, so
 * with the flags unset none of this runs and production behaviour is unchanged.
 *
 * Covers:
 *   2.1 applicability   — evaluateApplicability()
 *   2.2 coverage        — evaluateCoverage()
 *   2.3 reporting period — evidenceWithinReportingPeriod()
 *   2.4 entity scope    — documentInEntityScope()
 */

// ── 2.1 Applicability ────────────────────────────────────────────────────────

export type ApplicabilityMode = "always" | "if_material" | "if_event_occurred";

export interface ApplicabilityRule {
  mode?: ApplicabilityMode | string | null;
  /** The measure applies if the company profile asserts ANY of these facts. */
  requiresAny?: string[] | null;
  /** The measure applies only if the company profile asserts ALL of these. */
  requiresAll?: string[] | null;
  rationale?: string | null;
}

export interface ApplicabilityResult {
  applicable: boolean;
  /** Facts from the profile that were considered (audit trail). */
  factsUsed: string[];
  rationale: string;
}

/**
 * Evaluate a measure's structured applicabilityRule against a company profile.
 * `profileFacts` is the set of boolean facts the profile asserts as TRUE
 * (e.g. "material_facility_footprint", "long_lived_assets", a disclosed event
 * key for if_event_occurred). Unknown / missing rule => applicable (fail-open),
 * which preserves "all measures apply" when the framework has not authored a
 * rule for the measure.
 */
export function evaluateApplicability(
  rule: ApplicabilityRule | null | undefined,
  profileFacts: Iterable<string> | null | undefined,
): ApplicabilityResult {
  const facts = new Set<string>();
  for (const f of profileFacts || []) {
    if (typeof f === "string" && f.trim()) facts.add(f.trim().toLowerCase());
  }
  const factsUsed = Array.from(facts);

  const mode = (rule?.mode ?? "always").toString().trim().toLowerCase();
  const requiresAny = (rule?.requiresAny || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const requiresAll = (rule?.requiresAll || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);

  // No authored rule, or explicit "always": the measure always applies.
  if (!rule || mode === "always" || (mode === "" && requiresAny.length === 0 && requiresAll.length === 0)) {
    return { applicable: true, factsUsed, rationale: rule?.rationale || "always-applicable" };
  }

  // if_material / if_event_occurred both reduce to the predicate over facts.
  const anyOk = requiresAny.length === 0 || requiresAny.some((k) => facts.has(k));
  const allOk = requiresAll.length === 0 || requiresAll.every((k) => facts.has(k));
  const applicable = anyOk && allOk;

  const reasonBits: string[] = [];
  if (requiresAny.length) reasonBits.push(`requiresAny[${requiresAny.join(",")}]=${anyOk}`);
  if (requiresAll.length) reasonBits.push(`requiresAll[${requiresAll.join(",")}]=${allOk}`);
  const rationale = applicable
    ? rule?.rationale || `applicable under ${mode}`
    : `not applicable under ${mode}: ${reasonBits.join("; ")}` + (rule?.rationale ? ` — ${rule.rationale}` : "");

  return { applicable, factsUsed, rationale };
}

// ── 2.2 Coverage ─────────────────────────────────────────────────────────────

export interface CoverageRule {
  populationDefinition?: string | null;
  acceptedDenominators?: string[] | null;
  thresholdMode?: string | null;
  defaultThreshold?: number | null;
  acceptedPhrases?: string[] | null;
  doesNotCount?: string[] | null;
  nonApplicableHandling?: string | null;
}

export interface CoverageResult {
  /** true only when a disclosed denominator clears the threshold. */
  covered: boolean;
  /** the numeric fraction we could extract (0..1) or null if none disclosed. */
  disclosedFraction: number | null;
  /** phrase the decision was based on, for the audit trail. */
  matchedPhrase: string | null;
  rationale: string;
}

const PCT_RE = /(\d{1,3}(?:\.\d+)?)\s*%/;
const N_OF_M_RE = /\b(\d[\d,]*)\s*(?:of|\/|out of)\s*(\d[\d,]*)\b/i;

function toNum(s: string): number {
  return Number(s.replace(/,/g, ""));
}

/**
 * Compute a coverage verdict from disclosed text against a structured
 * coverageRule + coverageWhitelist. An UNDISCLOSED denominator can never pass:
 * vague company-wide phrasing (`doesNotCount`) is rejected, and a measure that
 * declares a coverageRule but whose text discloses no quantified denominator
 * returns covered=false. `coverageWhitelist` is an explicit allow-list of
 * company-specific phrases that count as a disclosed denominator even without a
 * parseable number (e.g. "all 14 material plants").
 */
export function evaluateCoverage(
  rule: CoverageRule | null | undefined,
  coverageWhitelist: string[] | null | undefined,
  disclosedText: string | null | undefined,
): CoverageResult {
  const text = (disclosedText || "").toString();
  const lower = text.toLowerCase();
  const threshold = typeof rule?.defaultThreshold === "number" ? rule.defaultThreshold : 0.5;

  // Reject explicitly vague phrasing first — it can never establish a denominator.
  const vague = (rule?.doesNotCount || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  const hitVague = vague.find((p) => lower.includes(p));

  // Whitelisted exact phrases count as a disclosed, qualifying denominator.
  const whitelist = [
    ...(coverageWhitelist || []),
    ...(rule?.acceptedPhrases || []),
  ].map((s) => String(s)).filter(Boolean);
  const wlHit = whitelist.find((p) => lower.includes(p.toLowerCase()));
  if (wlHit) {
    return { covered: true, disclosedFraction: null, matchedPhrase: wlHit, rationale: `whitelisted denominator: "${wlHit}"` };
  }

  // Try to parse an explicit fraction: "310 of 356", "82%".
  let frac: number | null = null;
  let matched: string | null = null;
  const nom = text.match(N_OF_M_RE);
  if (nom && toNum(nom[2]) > 0) {
    frac = toNum(nom[1]) / toNum(nom[2]);
    matched = nom[0];
  } else {
    const pct = text.match(PCT_RE);
    if (pct) {
      frac = toNum(pct[1]) / 100;
      matched = pct[0];
    }
  }

  if (frac == null) {
    return {
      covered: false,
      disclosedFraction: null,
      matchedPhrase: null,
      rationale: hitVague
        ? `undisclosed denominator — only vague phrasing ("${hitVague}")`
        : "undisclosed denominator — no quantified coverage found",
    };
  }

  const covered = frac >= threshold;
  return {
    covered,
    disclosedFraction: frac,
    matchedPhrase: matched,
    rationale: `disclosed ${(frac * 100).toFixed(1)}% ${covered ? "≥" : "<"} threshold ${(threshold * 100).toFixed(0)}% (from "${matched}")`,
  };
}

// ── 2.3 Reporting period ─────────────────────────────────────────────────────

export interface ReportingPeriod {
  /** inclusive ISO start of the qualifying window, e.g. "2023-01-01". */
  start?: string | null;
  /** inclusive ISO end, e.g. "2025-12-31". */
  end?: string | null;
  /** alternatively, a rolling age limit in months from `asOf`. */
  maxAgeMonths?: number | null;
}

/**
 * Whether a piece of evidence is recent enough to support a Yes, per a
 * framework-level reportingPeriod window. All dates come from framework data;
 * nothing is hardcoded. A missing/unparseable evidence date fails CLOSED only
 * when a window is actually configured (so with no window — the default — every
 * date qualifies). `asOf` defaults to now and is injectable for tests.
 */
export function evidenceWithinReportingPeriod(
  period: ReportingPeriod | null | undefined,
  evidenceDateIso: string | null | undefined,
  asOf: Date = new Date(),
): boolean {
  const hasWindow = !!(period && (period.start || period.end || (period.maxAgeMonths && period.maxAgeMonths > 0)));
  if (!hasWindow) return true; // no configured window → no enforcement

  const t = evidenceDateIso ? Date.parse(evidenceDateIso) : NaN;
  if (!Number.isFinite(t)) return false; // window configured but date unknown → cannot support a Yes

  if (period!.start) {
    const s = Date.parse(period!.start);
    if (Number.isFinite(s) && t < s) return false;
  }
  if (period!.end) {
    const e = Date.parse(period!.end);
    if (Number.isFinite(e) && t > e) return false;
  }
  if (period!.maxAgeMonths && period!.maxAgeMonths > 0) {
    const cutoff = new Date(asOf);
    cutoff.setMonth(cutoff.getMonth() - period!.maxAgeMonths);
    if (t < cutoff.getTime()) return false;
  }
  return true;
}

// ── 2.4 Entity scope ─────────────────────────────────────────────────────────

export type EntityType = "group" | "parent" | "subsidiary" | "operating_company" | string;

export interface EntityScopeContext {
  /** the framework/company declared entity type being assessed. */
  entityType?: EntityType | null;
  /** the universe/list identifier (audit only). */
  universe?: string | null;
  /** canonical trusted domains for the parent/group (from 1.3 resolution). */
  trustedDomains?: string[] | null;
  /** known subsidiary domains whose solo docs must be excluded. */
  subsidiaryDomains?: string[] | null;
}

export interface DocScopeInput {
  url?: string | null;
  sourceType?: string | null;
  /** true if the doc is a consolidated/group-level disclosure. */
  consolidated?: boolean | null;
  /** domain, if already parsed (else derived from url). */
  domain?: string | null;
}

function domainOf(url?: string | null, fallback?: string | null): string {
  if (fallback) return fallback.toLowerCase();
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function domainMatches(host: string, list: string[]): boolean {
  return list.some((d) => {
    const dd = String(d).replace(/^www\./, "").toLowerCase();
    return dd && (host === dd || host.endsWith("." + dd));
  });
}

/**
 * Apply the parent/subsidiary scope rule when assessing a group/parent entity:
 * group/parent disclosures only; a subsidiary's solo document is excluded UNLESS
 * it is a consolidated/group-level disclosure. Integrates with the 1.3 trusted
 * source resolution via `trustedDomains`. When the entity being assessed is not
 * a group/parent, or no scope data is present, every document is in scope
 * (fail-open → unchanged behaviour).
 */
export function documentInEntityScope(
  ctx: EntityScopeContext | null | undefined,
  doc: DocScopeInput | null | undefined,
): { inScope: boolean; rationale: string } {
  const entityType = (ctx?.entityType || "").toString().trim().toLowerCase();
  const isGroupParent = entityType === "group" || entityType === "parent";
  const subs = (ctx?.subsidiaryDomains || []).map(String).filter(Boolean);
  const trusted = (ctx?.trustedDomains || []).map(String).filter(Boolean);

  if (!isGroupParent || (subs.length === 0 && trusted.length === 0)) {
    return { inScope: true, rationale: "no entity-scope restriction" };
  }

  const host = domainOf(doc?.url, doc?.domain);

  // Consolidated/group disclosures always qualify.
  if (doc?.consolidated) return { inScope: true, rationale: "consolidated/group-level disclosure" };

  // A trusted (parent/group) domain qualifies.
  if (trusted.length && host && domainMatches(host, trusted)) {
    return { inScope: true, rationale: `parent/group trusted domain (${host})` };
  }

  // A subsidiary solo domain is excluded unless consolidated (handled above).
  if (subs.length && host && domainMatches(host, subs)) {
    return { inScope: false, rationale: `subsidiary solo disclosure excluded (${host})` };
  }

  // Default: if we have a trusted list, require membership; otherwise keep.
  if (trusted.length) {
    return host
      ? { inScope: false, rationale: `outside parent/group trusted domains (${host})` }
      : { inScope: true, rationale: "no parseable domain; kept" };
  }
  return { inScope: true, rationale: "not a known subsidiary domain" };
}
