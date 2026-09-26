/**
 * eligibility-flags.ts — Change #3: advisory evidence-integrity flags.
 *
 * WHY (audit §2 "Errors that cannot reasonably be dismissed", §3.D, §4):
 *   The reviewer's third recommendation is to "add deterministic evidence gates:
 *   validate entity attribution, date eligibility, live/pilot/planned status,
 *   quote location and source-link consistency before scoring. A model can
 *   extract these fields, but it should not silently supply missing facts."
 *   The concrete failure cases the audit could not dismiss map one-to-one onto
 *   five checks:
 *     1. entity attribution   — Hyundai Glovis scored Yes on a Boston Dynamics
 *        (group affiliate) partnership; a group affiliate is not the issuer.
 *     2. date-window          — Obayashi scored Yes for a 2026 partnership whose
 *        linked passage is a 2020 report, outside the relevant window.
 *     3. planned-vs-live      — Industrial Bank scored Yes where the bank "plans
 *        to establish" a body (intention narrated as an implemented control).
 *     4. author-vs-adopter    — Paychex-authored guidance TO customers scored as
 *        Paychex's own internal practice (author/vendor vs actual adopter).
 *     5. claim-level source-link — ~32% of positive cells carry no claim-level
 *        HTTP source link backing the verdict.
 *
 * DESIGN CONSTRAINT (standing user requirement — non-blocking, fail-loud):
 *   These are ADVISORY ONLY. They are dismissible integrity warnings attached to
 *   a positive cell's output. They MUST NEVER change a verdict, block a run, or
 *   block saving. This module therefore only READS a result and RETURNS flags —
 *   it never mutates the verdict/score. It is the visible-but-not-a-gate layer
 *   that sits ALONGSIDE the existing hard gates (provenance-gate.ts,
 *   evidence-gate.ts, temporal-validation.ts), whose behaviour is left intact.
 *
 * GENERIC / TOPIC-AGNOSTIC: the checks are driven by (a) the target company's
 * own identity (name/aliases/ticker/domains), (b) a framework-supplied date
 * window, and (c) generic linguistic cues — never by any hardcoded company or by
 * the AI-governance topic. Pure, deterministic, DB-free, unit-testable.
 */

import { deriveAliases } from "./issuer-resolver.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type EligibilityFlagId =
  | "entity-attribution"
  | "date-window"
  | "planned-vs-live"
  | "author-vs-adopter"
  | "claim-level-source-link";

export interface EligibilityFlag {
  id: EligibilityFlagId;
  /** Short human label. */
  label: string;
  /** True when the integrity concern is present (the flag "fires"). */
  triggered: boolean;
  /** Always "advisory" — these are never hard gates. */
  severity: "advisory";
  /** Always true — every flag is user-dismissible. */
  dismissible: true;
  /** Why the flag fired (or why it is clear), for the analyst. */
  reason: string;
}

export interface EligibilityFlagsResult {
  /** All five flags, always returned (triggered or not) so the UI is stable. */
  flags: EligibilityFlag[];
  /** Count of triggered flags — convenience for badges/telemetry. */
  triggeredCount: number;
  /** Explicit, load-bearing invariant: advisory flags never gate. */
  advisoryOnly: true;
}

export interface QuoteLike {
  text: string;
  source?: string;
  sourceUrl?: string;
  page?: number;
}

export interface CompanyIdentity {
  name: string;
  ticker?: string | null;
  aliases?: string[] | null;
  domain?: string | null;
  relatedDomains?: string[] | null;
}

export interface EligibilityFlagsInput {
  /** The verdict on the cell. Flags are only meaningful for positive cells. */
  verdict: string;
  /** The supporting quotes / passages that back the verdict. */
  quotes: QuoteLike[];
  /** Optional evidence summary / rationale text (adds passage signal). */
  evidenceSummary?: string | null;
  /** Target company identity — drives entity attribution & author/adopter. */
  company: CompanyIdentity;
  /** Date window the framework considers relevant. */
  window?: {
    /** Most recent relevant year (defaults to current UTC year). */
    currentYear?: number;
    /** How many years back count as in-window (defaults to 3). */
    yearsBack?: number;
  };
}

// ─── Generic linguistic cue sets (topic-agnostic) ─────────────────────────────

// Forward-looking / planned intent — NOT implemented/live. Kept generic: these
// are cross-topic English cues, never topic terms.
const PLANNED_CUES: RegExp[] = [
  /\bplans?\s+to\b/i,
  /\bplanned\b/i,
  /\bintends?\s+to\b/i,
  /\bintention\s+to\b/i,
  /\baims?\s+to\b/i,
  /\baspires?\s+to\b/i,
  /\bwill\s+(?:establish|create|launch|introduce|develop|implement|roll\s*out|build|deploy|adopt)\b/i,
  /\bis\s+(?:planning|exploring|considering|evaluating|developing|piloting)\b/i,
  /\b(?:by|before)\s+20\d{2}\b/i,
  /\b(?:upcoming|future|forthcoming|proposed|to\s+be\s+(?:established|launched|introduced|rolled\s*out))\b/i,
  /\bpilot(?:ing)?\b/i,
  /\bproof[-\s]of[-\s]concept\b/i,
  /\btrial(?:ling|ing)?\b/i,
];

// Implemented / live cues — presence of these OFFSETS a planned-cue hit.
const LIVE_CUES: RegExp[] = [
  /\b(?:has|have|had)\s+(?:established|created|launched|introduced|implemented|rolled\s*out|built|deployed|adopted|developed)\b/i,
  /\b(?:established|launched|introduced|implemented|deployed|adopted|operates?|operating|maintains?|in\s+place|currently)\b/i,
  /\b(?:since|in)\s+20\d{2}\b/i,
  /\b(?:we|the\s+(?:company|group|bank|firm))\s+(?:operate|run|maintain|use|apply)\b/i,
];

// Author / vendor cues — the company is producing guidance FOR others, not
// disclosing its own adoption. Generic across topics/industries.
const AUTHOR_CUES: RegExp[] = [
  /\bguidance\s+(?:for|to)\s+(?:our\s+)?(?:customers|clients|users|members|partners)\b/i,
  /\b(?:helps?|helping|enables?|enabling|allows?|supports?|assist(?:s|ing)?)\s+(?:our\s+)?(?:customers|clients|users|businesses|organ[iz]ations|companies)\b/i,
  /\b(?:for|to)\s+(?:our\s+)?(?:customers|clients)\b.*\b(?:can|to)\b/i,
  /\boffer(?:s|ing)?\s+(?:our\s+)?(?:customers|clients)\b/i,
  /\bour\s+(?:product|platform|solution|service|software|tool)\s+(?:helps?|enables?|allows?|lets?)\b/i,
  /\b(?:whitepaper|best[-\s]practice|recommendations?)\s+(?:for|to)\b/i,
  /\bwe\s+(?:advise|recommend|guide)\s+(?:our\s+)?(?:customers|clients)\b/i,
];

// Adopter cues — the company describes its OWN internal adoption. Offsets an
// author-cue hit.
const ADOPTER_CUES: RegExp[] = [
  /\b(?:we|our\s+(?:company|group|firm|organ[iz]ation|business))\s+(?:have|has|adopted|implemented|established|use|operate|maintain|apply)\b/i,
  /\bour\s+(?:own\s+)?(?:internal|corporate|employee|workforce|governance|board|policy|policies|programme|program)\b/i,
  /\b(?:internally|across\s+(?:our|the)\s+(?:company|group|organ))/i,
];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function nonEmpty(s: any): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/** Distinctive identity tokens for the target company (lowercased). Generic. */
function identityTokens(company: CompanyIdentity): string[] {
  const toks = new Set<string>();
  const name = (company.name || "").trim();
  if (name) {
    // Distinctive alias tokens (drops corporate-form / geo / generic words).
    for (const a of deriveAliases(name, company.ticker ?? null)) {
      const t = a.toLowerCase().trim();
      if (t.length >= 3) toks.add(t);
    }
    // Also keep individual distinctive words of the raw name (length >= 4).
    for (const w of name.toLowerCase().replace(/[/\\,.'()&]+/g, " ").split(/\s+/)) {
      if (w.length >= 4) toks.add(w);
    }
  }
  const tkr = (company.ticker || "").toLowerCase().trim();
  if (tkr.length >= 2) toks.add(tkr);
  for (const a of company.aliases || []) {
    if (nonEmpty(a) && a.trim().length >= 3) toks.add(a.toLowerCase().trim());
  }
  return Array.from(toks);
}

function anyCueHits(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

function collectText(input: EligibilityFlagsInput): string {
  const parts: string[] = [];
  for (const q of input.quotes || []) if (nonEmpty(q?.text)) parts.push(q.text);
  if (nonEmpty(input.evidenceSummary)) parts.push(input.evidenceSummary as string);
  return parts.join(" \n ");
}

function isHttpUrl(u: any): boolean {
  return typeof u === "string" && /^https?:\/\/\S+/i.test(u.trim());
}

const POSITIVE_VERDICTS = new Set(["Yes", "Partial"]);

/** Is this a positive cell (the only kind these advisory flags apply to)? */
export function isPositiveVerdict(verdict: string): boolean {
  return POSITIVE_VERDICTS.has((verdict || "").trim());
}

// ─── Individual flag computations ─────────────────────────────────────────────

function flagEntityAttribution(input: EligibilityFlagsInput, text: string): EligibilityFlag {
  const base = { id: "entity-attribution" as const, label: "Entity attribution", severity: "advisory" as const, dismissible: true as const };
  const toks = identityTokens(input.company);
  if (toks.length === 0) {
    return { ...base, triggered: false, reason: "No distinctive identity tokens available for the target company — attribution not assessed." };
  }
  const lower = text.toLowerCase();
  const mentionsTarget = toks.some((t) => lower.includes(t));
  if (mentionsTarget) {
    return { ...base, triggered: false, reason: "Supporting passage(s) mention the target company's own name/alias/ticker." };
  }
  return {
    ...base,
    triggered: true,
    reason:
      "None of the target company's distinctive name/alias/ticker tokens appear in the supporting passage(s) — the evidence may describe a different entity (e.g. a group affiliate, vendor, or partner) rather than the assessed company.",
  };
}

function flagDateWindow(input: EligibilityFlagsInput, text: string): EligibilityFlag {
  const base = { id: "date-window" as const, label: "Date window", severity: "advisory" as const, dismissible: true as const };
  const currentYear = input.window?.currentYear ?? new Date().getUTCFullYear();
  const yearsBack = input.window?.yearsBack ?? 3;
  const earliest = currentYear - yearsBack;
  // Find 4-digit years in a plausible range (1990..currentYear+1).
  const years = Array.from(text.matchAll(/\b(19\d{2}|20\d{2})\b/g))
    .map((m) => parseInt(m[1], 10))
    .filter((y) => y >= 1990 && y <= currentYear + 1);
  if (years.length === 0) {
    return { ...base, triggered: false, reason: "No explicit publication/reporting year found in the passage(s) — date-window not assessed (not penalised)." };
  }
  const newest = Math.max(...years);
  if (newest >= earliest) {
    return { ...base, triggered: false, reason: `Most recent year in the passage(s) is ${newest}, within the ${earliest}–${currentYear} window.` };
  }
  return {
    ...base,
    triggered: true,
    reason: `The most recent year found in the supporting passage(s) is ${newest}, which is outside the relevant ${earliest}–${currentYear} window — the evidence may be stale for this assessment.`,
  };
}

function flagPlannedVsLive(input: EligibilityFlagsInput, text: string): EligibilityFlag {
  const base = { id: "planned-vs-live" as const, label: "Planned vs live", severity: "advisory" as const, dismissible: true as const };
  const planned = anyCueHits(PLANNED_CUES, text);
  const live = anyCueHits(LIVE_CUES, text);
  if (planned && !live) {
    return {
      ...base,
      triggered: true,
      reason:
        "The supporting passage(s) use planned/intended/forward-looking language (e.g. 'plans to', 'will establish', 'by <year>', 'pilot') without matching implemented/live language — a positive verdict may be crediting an intention rather than an in-place practice.",
    };
  }
  if (planned && live) {
    return { ...base, triggered: false, reason: "Passage(s) contain both forward-looking and implemented/live language; treated as live (not flagged)." };
  }
  return { ...base, triggered: false, reason: "No planned-only language detected in the supporting passage(s)." };
}

function flagAuthorVsAdopter(input: EligibilityFlagsInput, text: string): EligibilityFlag {
  const base = { id: "author-vs-adopter" as const, label: "Author vs adopter", severity: "advisory" as const, dismissible: true as const };
  const author = anyCueHits(AUTHOR_CUES, text);
  const adopter = anyCueHits(ADOPTER_CUES, text);
  if (author && !adopter) {
    return {
      ...base,
      triggered: true,
      reason:
        "The supporting passage(s) read as guidance/products the company authors FOR its customers/clients rather than a disclosure of the company's OWN adoption — a positive verdict may be crediting authored/vendor material as the assessed entity's internal practice.",
    };
  }
  if (author && adopter) {
    return { ...base, triggered: false, reason: "Passage(s) contain both authored-for-others and own-adoption language; treated as adopter (not flagged)." };
  }
  return { ...base, triggered: false, reason: "No author/vendor-for-customers framing detected without matching own-adoption language." };
}

function flagClaimLevelSourceLink(input: EligibilityFlagsInput): EligibilityFlag {
  const base = { id: "claim-level-source-link" as const, label: "Claim-level source link", severity: "advisory" as const, dismissible: true as const };
  const quotes = input.quotes || [];
  const hasQuoteWithHttp = quotes.some((q) => nonEmpty(q?.text) && isHttpUrl(q?.sourceUrl));
  if (hasQuoteWithHttp) {
    return { ...base, triggered: false, reason: "At least one supporting quote carries a claim-level HTTP source link." };
  }
  return {
    ...base,
    triggered: true,
    reason:
      "No supporting quote carries a claim-level HTTP source link — the verdict cannot be reproduced from a passage-level citation (a measure-level or inventory source may still exist elsewhere).",
  };
}

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Compute the five advisory eligibility flags for a positive cell. ADVISORY
 * ONLY: this NEVER changes the verdict or score and NEVER blocks — the caller
 * attaches the returned flags to the cell output and may render them as
 * dismissible warnings. For a non-positive verdict, all flags are returned
 * untriggered (the checks are only meaningful for a positive claim).
 *
 * Never throws; on any unexpected input it returns all-untriggered flags.
 */
export function computeEligibilityFlags(input: EligibilityFlagsInput): EligibilityFlagsResult {
  const makeUntriggered = (reason: string): EligibilityFlagsResult => ({
    flags: (
      [
        ["entity-attribution", "Entity attribution"],
        ["date-window", "Date window"],
        ["planned-vs-live", "Planned vs live"],
        ["author-vs-adopter", "Author vs adopter"],
        ["claim-level-source-link", "Claim-level source link"],
      ] as Array<[EligibilityFlagId, string]>
    ).map(([id, label]) => ({ id, label, triggered: false, severity: "advisory" as const, dismissible: true as const, reason })),
    triggeredCount: 0,
    advisoryOnly: true,
  });

  try {
    if (!input || typeof input !== "object" || !input.company || !nonEmpty(input.company.name)) {
      return makeUntriggered("Insufficient input to assess eligibility (advisory only — nothing gated).");
    }
    if (!isPositiveVerdict(input.verdict)) {
      return makeUntriggered("Non-positive verdict — advisory eligibility checks apply to positive cells only.");
    }
    const text = collectText(input);
    const flags: EligibilityFlag[] = [
      flagEntityAttribution(input, text),
      flagDateWindow(input, text),
      flagPlannedVsLive(input, text),
      flagAuthorVsAdopter(input, text),
      flagClaimLevelSourceLink(input),
    ];
    return {
      flags,
      triggeredCount: flags.filter((f) => f.triggered).length,
      advisoryOnly: true,
    };
  } catch {
    return makeUntriggered("Eligibility computation error — flags suppressed (advisory only, never blocking).");
  }
}
