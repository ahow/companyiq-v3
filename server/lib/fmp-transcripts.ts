/**
 * FMP earnings-call transcript lane with executive-only speaker attribution.
 *
 * Design: /home/ubuntu/shared/companyiq-programme/fmp_transcripts_design_note.md
 *
 * Why this module exists
 * ----------------------
 * Earnings-call transcripts are where management speaks most directly to AI
 * strategy, governance and risk, but today they barely reach the scorer: the
 * only sites that host them (seekingalpha.com, fool.com) are blocked aggregators,
 * so transcripts are gate-rejected as third-party. This lane pulls transcripts
 * directly from FMP (keyed by ticker symbol), bypassing the blocked-aggregator
 * web path entirely.
 *
 * The hard requirement (§3): an earnings-call transcript is a MIXED-AUTHORSHIP
 * document — analyst questions and operator chatter sit alongside management's
 * words. Only words spoken by COMPANY EXECUTIVES count as valid issuer evidence.
 * So we attribute every speaker turn, keep ONLY executive turns as scored
 * content, and discard analyst/operator/unknown turns. A valid executive ANSWER
 * in the Q&A is kept; the analyst QUESTION that prompted it is not.
 *
 * Fail-safe (§3.4): mis-attribution (scoring an analyst's words as the company's)
 * is a worse failure than omission. So when no roster can be built, the structure
 * is unparseable, or zero executive turns are found, the WHOLE transcript is
 * excluded (not ingested as first-party evidence).
 *
 * FMP format reality (verified against the live API with the production key):
 *   - content is a SINGLE STRING of `Speaker Name: text` turns, one turn per
 *     newline-separated line. There is NO "Company Participants" header block,
 *     and speaker labels are BARE NAMES with no inline titles.
 *   - The roster therefore comes from the key-executives endpoint + the FMP
 *     profile `ceo` field (design note §3.1 sources 2 and 3), not from a header.
 */

import { fmpGet, FMP_STABLE_BASE } from "./fmp-resolver.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** One available quarter from /earning-call-transcript-dates. */
export interface TranscriptQuarter {
  quarter: number;
  fiscalYear: number;
  date: string | null;
}

/** Raw transcript as returned by /earning-call-transcript. */
export interface RawTranscript {
  symbol: string;
  period: string | null; // e.g. "Q2"
  year: number | null;
  quarter: number | null;
  date: string | null;
  content: string;
}

/** A key executive entry from /key-executives. */
export interface KeyExecutive {
  title: string | null;
  name: string | null;
  active?: boolean | null;
}

/** An entry in the executive allow-list (valid speakers). */
export interface RosterEntry {
  name: string;
  title: string | null;
}

export type SpeakerRole = "executive" | "analyst" | "operator" | "unknown";

/** A single segmented speaker turn. */
export interface SpeakerTurn {
  speaker: string;
  text: string;
}

/** Per-turn attribution record (stored for auditability — no body text). */
export interface AttributedTurn {
  speaker: string;
  title: string | null; // matched roster title when executive, else null
  role: SpeakerRole;
  kept: boolean;
}

/** Full attribution result for one transcript. */
export interface TranscriptAttribution {
  /** Whether the transcript is ingested as first-party evidence at all. */
  kept: boolean;
  /** When not kept, why (fail-safe reason). */
  excludeReason?: "no_roster" | "unparseable" | "no_executive_turns";
  turns: AttributedTurn[];
  rosterSize: number;
  totalTurnCount: number;
  executiveTurnCount: number;
}

/** Output of attributeTranscript: attribution + the executive-only scored text. */
export interface AttributionResult {
  attribution: TranscriptAttribution;
  /** Concatenated executive turns — the document's scored content. Empty when excluded. */
  executiveContent: string;
}

/** A transcript document ready to ingest into the corpus (executive-only). */
export interface TranscriptDocument {
  symbol: string;
  year: number;
  quarter: number;
  period: string | null;
  date: string | null;
  url: string;
  title: string;
  /** Executive-only scored content. */
  content: string;
  attribution: TranscriptAttribution;
}

// ─── Client functions ────────────────────────────────────────────────────────

/** List the fiscal quarters for which FMP has a transcript, newest first. */
export async function listTranscriptQuarters(symbol: string): Promise<TranscriptQuarter[]> {
  if (!symbol || !symbol.trim()) return [];
  const resp = await fmpGet(`${FMP_STABLE_BASE}/earning-call-transcript-dates`, { symbol: symbol.trim().toUpperCase() });
  const arr = Array.isArray(resp) ? resp : [];
  return arr
    .map((r: any) => ({
      quarter: Number(r.quarter),
      fiscalYear: Number(r.fiscalYear ?? r.year),
      date: r.date ?? null,
    }))
    .filter((r: TranscriptQuarter) => Number.isFinite(r.quarter) && Number.isFinite(r.fiscalYear));
}

/** Fetch a single transcript for a symbol/year/quarter. Returns null if absent. */
export async function fetchTranscript(symbol: string, year: number, quarter: number): Promise<RawTranscript | null> {
  if (!symbol || !symbol.trim()) return null;
  const resp = await fmpGet(`${FMP_STABLE_BASE}/earning-call-transcript`, {
    symbol: symbol.trim().toUpperCase(),
    year,
    quarter,
  });
  const arr = Array.isArray(resp) ? resp : [];
  if (arr.length === 0) return null;
  const r = arr[0] || {};
  const content = typeof r.content === "string" ? r.content : "";
  if (!content.trim()) return null;
  return {
    symbol: r.symbol ?? symbol.trim().toUpperCase(),
    period: r.period ?? null,
    year: r.year != null ? Number(r.year) : year,
    quarter: r.quarter != null ? Number(r.quarter) : quarter,
    date: r.date ?? null,
    content,
  };
}

/** Fetch the key-executives roster for a symbol. */
export async function fetchKeyExecutives(symbol: string): Promise<KeyExecutive[]> {
  if (!symbol || !symbol.trim()) return [];
  const resp = await fmpGet(`${FMP_STABLE_BASE}/key-executives`, { symbol: symbol.trim().toUpperCase() });
  const arr = Array.isArray(resp) ? resp : [];
  return arr.map((e: any) => ({
    title: e.title ?? null,
    name: e.name ?? null,
    active: e.active ?? null,
  }));
}

// ─── Name matching (nickname + initial tolerant) ─────────────────────────────

// Canonical-first-name map: every variant → its canonical/formal form, so a
// transcript label "Bill Brown" matches a roster entry "William Brown". Verified
// necessary by real 3M data: the Q1 2025 transcript labels the CEO "Bill Brown"
// while the key-executives roster lists "William Brown".
const NICKNAME_TO_CANONICAL: Record<string, string> = {
  bill: "william", billy: "william", will: "william", willy: "william", liam: "william",
  bob: "robert", bobby: "robert", rob: "robert", robby: "robert", robbie: "robert",
  mike: "michael", mick: "michael", mikey: "michael",
  jim: "james", jimmy: "james", jamie: "james",
  chris: "christopher",
  dick: "richard", rich: "richard", rick: "richard", richie: "richard", ricky: "richard",
  tom: "thomas", tommy: "thomas",
  chuck: "charles", charlie: "charles", chas: "charles",
  joe: "joseph", joey: "joseph",
  dan: "daniel", danny: "daniel",
  matt: "matthew",
  tony: "anthony",
  steve: "stephen", steven: "stephen", stevie: "stephen",
  andy: "andrew", drew: "andrew",
  jeff: "jeffrey", geoff: "geoffrey",
  ed: "edward", eddie: "edward", ted: "edward", teddy: "edward",
  ben: "benjamin", benny: "benjamin",
  sam: "samuel", sammy: "samuel",
  nick: "nicholas",
  greg: "gregory",
  ron: "ronald", ronnie: "ronald",
  ken: "kenneth", kenny: "kenneth",
  dave: "david", davey: "david",
  pat: "patrick", patty: "patrick",
  fred: "frederick", freddie: "frederick",
  gabe: "gabriel",
  nate: "nathaniel",
  alex: "alexander",
  vince: "vincent",
  phil: "philip", philip: "phillip", phillip: "philip",
  abby: "abigail",
  beth: "elizabeth", liz: "elizabeth", lizzie: "elizabeth", betsy: "elizabeth",
  kate: "katherine", katie: "katherine", kathy: "katherine", cathy: "catherine",
  peggy: "margaret", meg: "margaret", maggie: "margaret",
  sue: "susan", suzy: "susan",
  jen: "jennifer", jenny: "jennifer",
  cindy: "cynthia",
  deb: "deborah", debbie: "deborah",
};

const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

/** Collapse a raw name to a canonical first name (nickname-resolved, lowercased). */
export function canonFirstName(first: string): string {
  const f = (first || "").toLowerCase().replace(/[.,]/g, "").trim();
  if (!f) return "";
  return NICKNAME_TO_CANONICAL[f] || f;
}

/** Tokenize a person name: lowercase words, suffixes removed, punctuation stripped. */
function nameTokens(name: string): string[] {
  return (name || "")
    .toLowerCase()
    .replace(/[,]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-z]+|[^a-z.]+$/g, "").trim())
    .filter((t) => t && !NAME_SUFFIXES.has(t.replace(/\./g, "")) && !NAME_SUFFIXES.has(t));
}

/** Is one first-name token compatible with another (exact / initial / nickname)? */
function firstNamesCompatible(a: string, b: string): boolean {
  const ca = a.replace(/[.]/g, "");
  const cb = b.replace(/[.]/g, "");
  if (!ca || !cb) return false;
  // Initial match: "w" matches "william" / "will".
  if (ca.length === 1 || cb.length === 1) {
    return ca[0] === cb[0];
  }
  if (ca === cb) return true;
  return canonFirstName(ca) === canonFirstName(cb);
}

/**
 * Do a transcript speaker label and a roster name refer to the same person?
 * Rule: surnames (last token) must be EQUAL; first tokens must be compatible
 * (exact, initial, or nickname). Middle names/initials are ignored. This tolerates
 * "Bill Brown" vs "William Brown", "Bobby George" vs "Bobby K. George", and
 * "W. Brown" vs "William Brown".
 */
export function namesMatch(label: string, rosterName: string): boolean {
  const la = nameTokens(label);
  const lb = nameTokens(rosterName);
  if (la.length < 2 || lb.length < 2) {
    // Single-token names are too ambiguous to match safely.
    if (la.length === 1 && lb.length >= 1 && lb.includes(la[0]) && la[0].length > 1) return true;
    return false;
  }
  const surnameA = la[la.length - 1];
  const surnameB = lb[lb.length - 1];
  if (surnameA !== surnameB) return false;
  return firstNamesCompatible(la[0], lb[0]);
}

// ─── Roster + attribution ────────────────────────────────────────────────────

/** Patterns in a label that mark the call operator (never an executive). */
const OPERATOR_LABELS = new Set(["operator", "moderator", "conference operator", "coordinator"]);

/**
 * Build the executive allow-list from the FMP key-executives roster plus the
 * profile `ceo` field (design note §3.1 sources 2 and 3). Inactive officers are
 * dropped. The `ceo` name is added when not already represented.
 */
export function buildExecutiveRoster(keyExecs: KeyExecutive[], ceo?: string | null): RosterEntry[] {
  const roster: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const e of keyExecs || []) {
    if (!e || !e.name || !e.name.trim()) continue;
    if (e.active === false) continue;
    const key = e.name.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    roster.push({ name: e.name.trim(), title: e.title ?? null });
  }
  if (ceo && ceo.trim()) {
    const already = roster.some((r) => namesMatch(ceo, r.name));
    if (!already) roster.push({ name: ceo.trim(), title: "Chief Executive Officer" });
  }
  return roster;
}

/**
 * Segment a transcript body into ordered speaker turns. Each turn is a single
 * newline-delimited line of the form `Speaker Name: text` (the FMP format).
 * Lines without a recognizable `Name:` prefix are appended to the previous turn's
 * text (continuation), so multi-line turns are preserved if the format varies.
 */
export function segmentTranscript(content: string): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  if (!content || !content.trim()) return turns;
  // A speaker label: start of line, 1-6 capitalized/initial words, then ": ".
  const labelRe = /^([A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){0,5}):\s+(.*)$/;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const m = line.match(labelRe);
    if (m) {
      turns.push({ speaker: m[1].trim(), text: m[2].trim() });
    } else if (turns.length > 0) {
      // Continuation of the previous speaker's turn.
      turns[turns.length - 1].text += "\n" + line.trim();
    }
    // A leading non-label line before any speaker is dropped (header noise).
  }
  return turns;
}

/** Classify a speaker label against the roster. */
function classifySpeaker(speaker: string, roster: RosterEntry[]): { role: SpeakerRole; title: string | null } {
  const norm = (speaker || "").toLowerCase().replace(/[.]/g, "").trim();
  if (!norm) return { role: "unknown", title: null };
  if (OPERATOR_LABELS.has(norm)) return { role: "operator", title: null };
  for (const r of roster) {
    if (namesMatch(speaker, r.name)) return { role: "executive", title: r.title };
  }
  // A named, non-roster, non-operator speaker is an analyst (or other external).
  // A single-token / unparseable label is "unknown". Both are excluded.
  const tokenCount = nameTokens(speaker).length;
  return { role: tokenCount >= 2 ? "analyst" : "unknown", title: null };
}

/**
 * Attribute a transcript and produce executive-only scored content.
 *
 * Fail-safe (§3.4): returns kept=false (and empty executiveContent) when the
 * roster is empty, the body is unparseable (no turns), or no executive turns are
 * found. Mis-attribution is worse than omission, so we exclude when uncertain.
 */
export function attributeTranscript(content: string, roster: RosterEntry[]): AttributionResult {
  const baseAttr: TranscriptAttribution = {
    kept: false,
    turns: [],
    rosterSize: roster.length,
    totalTurnCount: 0,
    executiveTurnCount: 0,
  };

  if (!roster || roster.length === 0) {
    return { attribution: { ...baseAttr, excludeReason: "no_roster" }, executiveContent: "" };
  }

  const turns = segmentTranscript(content);
  if (turns.length === 0) {
    return { attribution: { ...baseAttr, excludeReason: "unparseable" }, executiveContent: "" };
  }

  const attributed: AttributedTurn[] = [];
  const executiveTexts: string[] = [];
  for (const t of turns) {
    const { role, title } = classifySpeaker(t.speaker, roster);
    const kept = role === "executive";
    attributed.push({ speaker: t.speaker, title, role, kept });
    if (kept && t.text.trim()) executiveTexts.push(`${t.speaker}: ${t.text.trim()}`);
  }

  const executiveTurnCount = attributed.filter((t) => t.kept).length;
  if (executiveTurnCount === 0) {
    return {
      attribution: {
        ...baseAttr,
        excludeReason: "no_executive_turns",
        turns: attributed,
        totalTurnCount: attributed.length,
        executiveTurnCount: 0,
      },
      executiveContent: "",
    };
  }

  return {
    attribution: {
      kept: true,
      turns: attributed,
      rosterSize: roster.length,
      totalTurnCount: attributed.length,
      executiveTurnCount,
    },
    executiveContent: executiveTexts.join("\n\n"),
  };
}

/** Stable, key-free pseudo-URL identifying a transcript document (unique per company). */
export function transcriptUrl(symbol: string, year: number, quarter: number): string {
  return `fmp-transcript://${symbol.toUpperCase()}/${year}/Q${quarter}`;
}

// ─── High-level orchestration ────────────────────────────────────────────────

export interface FetchExecutiveOnlyOptions {
  symbol: string;
  /** FMP profile ceo field, used to corroborate the roster. */
  ceo?: string | null;
  /** How many most-recent quarters to pull. Default 4. */
  historyQuarters?: number;
}

/** Default transcript history depth (quarters). */
export const DEFAULT_TRANSCRIPT_HISTORY_QUARTERS = 4;

/**
 * Pull the last N quarters of transcripts for a symbol, attribute speakers, and
 * return executive-only transcript documents ready to ingest. Transcripts that
 * fail the §3.4 fail-safe are omitted from the returned list (never ingested).
 */
export async function fetchExecutiveOnlyTranscripts(opts: FetchExecutiveOnlyOptions): Promise<TranscriptDocument[]> {
  const symbol = (opts.symbol || "").trim().toUpperCase();
  if (!symbol) return [];
  const historyQuarters = opts.historyQuarters ?? DEFAULT_TRANSCRIPT_HISTORY_QUARTERS;

  // Roster is required by the fail-safe; build it once per symbol.
  const keyExecs = await fetchKeyExecutives(symbol).catch(() => [] as KeyExecutive[]);
  const roster = buildExecutiveRoster(keyExecs, opts.ceo ?? null);

  const quarters = await listTranscriptQuarters(symbol).catch(() => [] as TranscriptQuarter[]);
  // Newest first; FMP already sorts descending but sort defensively.
  quarters.sort((a, b) => (b.fiscalYear - a.fiscalYear) || (b.quarter - a.quarter));
  const wanted = quarters.slice(0, Math.max(0, historyQuarters));

  const docs: TranscriptDocument[] = [];
  for (const q of wanted) {
    const raw = await fetchTranscript(symbol, q.fiscalYear, q.quarter).catch(() => null);
    if (!raw) continue;
    const { attribution, executiveContent } = attributeTranscript(raw.content, roster);
    if (!attribution.kept || !executiveContent.trim()) {
      // Fail-safe: excluded transcript is not ingested.
      continue;
    }
    const period = raw.period || `Q${q.quarter}`;
    docs.push({
      symbol,
      year: q.fiscalYear,
      quarter: q.quarter,
      period,
      date: raw.date ?? q.date,
      url: transcriptUrl(symbol, q.fiscalYear, q.quarter),
      title: `${symbol} Earnings Call Transcript — ${period} ${q.fiscalYear} (executives only)`,
      content: executiveContent,
      attribution,
    });
  }
  return docs;
}
