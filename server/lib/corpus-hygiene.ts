/**
 * Opt2 — Corpus hygiene (near-duplicate dedup + recency filter).
 *
 * A generic, jurisdiction-agnostic, data-driven transform applied to the loaded
 * corpus BEFORE chunking / evidence-pack assembly, for every company and every
 * framework. It removes:
 *
 *   1) Near-duplicate documents — multiple copies of the same disclosure (e.g.
 *      the same ESEF/iXBRL year-package fetched under several URLs). Dedup is
 *      keyed on a normalized text-prefix SIGNATURE; on a collision the LONGER
 *      (more complete) copy is kept.
 *   2) Stale versions — where several documents share a title stem but differ by
 *      a 4-digit year (e.g. an annual/integrated report published every year),
 *      only the newest two years are kept.
 *
 * This is a CORPUS-INPUT cleanup only. It does NOT touch scoring, the rubric,
 * the evidence gate, provenance filtering, or the DB. It is conservative by
 * design: the recency filter only ever fires on stem groups with MORE THAN TWO
 * members (so the single most-recent primary of any type is always retained),
 * and dedup keeps the longer of two near-identical copies.
 *
 * The logic here is a faithful reproduction of the validated harness transform
 * `applyHygiene` from the read-only retrieval experiment
 * (/home/ubuntu/retrieval_experiment/setup.ts), extended to carry a per-drop
 * reason (and optional document id) so every removed document is auditable.
 *
 * Flag: env var CORPUS_HYGIENE. Defaults ON; set CORPUS_HYGIENE="false" to
 * disable (mirrors the repo's U17_PROVENANCE_FILTER / RETRIEVAL_LLM_RESCORE
 * "!== 'false'" default-on convention).
 */

/** A single input document considered for hygiene. */
export interface HygieneDoc {
  /** Optional DB document id, threaded through for audit logging when available. */
  id?: number;
  url: string;
  title: string;
  text: string;
}

/** Record of a dropped document and why it was removed. */
export interface HygieneDropped {
  id?: number;
  url: string;
  title: string;
  /** "near-duplicate" | "stale-version" */
  reason: string;
}

/** Result of applying corpus hygiene: surviving docs + audit trail of drops. */
export interface HygieneResult {
  kept: HygieneDoc[];
  dropped: HygieneDropped[];
}

/**
 * Whether corpus hygiene is enabled. Default ON; disabled only when the env var
 * is explicitly "false" (matches U17_PROVENANCE_FILTER / RETRIEVAL_LLM_RESCORE).
 */
export function isCorpusHygieneEnabled(): boolean {
  return process.env.CORPUS_HYGIENE !== "false";
}

// Tunables — kept identical to the validated harness transform.
const SIG_PREFIX_CHARS = 2000; // signature is the first N normalized chars
const SIG_MIN_CHARS = 200;     // only dedup docs whose signature is long enough
const STEM_PREFIX_CHARS = 40;  // title/url stem length used to group versions
const KEEP_NEWEST_YEARS = 2;   // recency filter keeps the newest N per stem

/**
 * Apply corpus hygiene: near-duplicate dedup followed by a recency filter.
 * Pure and side-effect-free — returns the surviving docs plus a full audit
 * trail of what was dropped and why. Input order of survivors is preserved.
 */
export function applyCorpusHygiene(docs: HygieneDoc[]): HygieneResult {
  const dropped: HygieneDropped[] = [];

  // 1) Near-duplicate dedup by normalized text-prefix signature.
  //    On collision, keep the LONGER of the two (more complete document).
  const seen = new Map<string, number>();
  const kept: HygieneDoc[] = [];
  for (const d of docs) {
    const norm = (d.text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const sig = norm.slice(0, SIG_PREFIX_CHARS);
    if (sig.length >= SIG_MIN_CHARS && seen.has(sig)) {
      const idx = seen.get(sig)!;
      const incumbent = kept[idx];
      if ((d.text || "").length > (incumbent.text || "").length) {
        // New doc is more complete: drop the incumbent, keep the new one.
        dropped.push({ id: incumbent.id, url: incumbent.url, title: incumbent.title, reason: "near-duplicate" });
        kept[idx] = d;
      } else {
        dropped.push({ id: d.id, url: d.url, title: d.title, reason: "near-duplicate" });
      }
      continue;
    }
    if (sig.length >= SIG_MIN_CHARS) seen.set(sig, kept.length);
    kept.push(d);
  }

  // 2) Recency filter: if multiple surviving docs share a title stem but differ
  //    by a 4-digit year, keep only the newest KEEP_NEWEST_YEARS. This only ever
  //    fires on stem groups with MORE THAN 2 members, so the single most-recent
  //    primary of any type is always retained.
  const byStem = new Map<string, { year: number; idx: number }[]>();
  kept.forEach((d, idx) => {
    const ym = ((d.title || "") + " " + (d.url || "")).match(/\b(19|20)\d{2}\b/);
    if (!ym) return; // no detectable year -> never a recency-drop candidate
    const year = parseInt(ym[0], 10);
    const stem = (d.title || d.url)
      .replace(/\b(19|20)\d{2}\b/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .slice(0, STEM_PREFIX_CHARS);
    if (!stem) return;
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem)!.push({ year, idx });
  });

  const dropIdx = new Set<number>();
  for (const [, arr] of byStem) {
    if (arr.length <= KEEP_NEWEST_YEARS) continue;
    arr.sort((a, b) => b.year - a.year); // newest first
    for (const e of arr.slice(KEEP_NEWEST_YEARS)) {
      dropIdx.add(e.idx);
      const d = kept[e.idx];
      dropped.push({ id: d.id, url: d.url, title: d.title, reason: "stale-version" });
    }
  }

  const final = kept.filter((_, i) => !dropIdx.has(i));
  return { kept: final, dropped };
}
