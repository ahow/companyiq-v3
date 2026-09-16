/**
 * recall_test.ts — DESIGN-TIME diagnostic (single-shot, no LLM, no deploy).
 *
 * Runs the REAL corpus-assembly stage (summarizeDocuments) ONCE for a company and
 * measures how much of each VERIFIED ground-truth qualifying quote survives into
 * the framework-level combinedText (the candidate pool that feeds every downstream
 * per-measure BM25 pack). Run once per variant:
 *   baseline : RETRIEVAL_SPECIFICITY_RESERVE_CHARS=0   (production-identical)
 *   floor    : RETRIEVAL_SPECIFICITY_RESERVE_CHARS=N   (generic specificity reserve)
 *
 * Cache is busted by setting a UNIQUE RAILWAY_GIT_COMMIT_SHA BEFORE importing the
 * analyzer (PIPELINE_VERSION salts the summary-cache key), so each run recomputes.
 *
 * usage: RECALL_VARIANT=baseline RETRIEVAL_SPECIFICITY_RESERVE_CHARS=0 \
 *          tsx server/scripts/recall_test.ts <companyId>
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";

const HOME = process.env.HOME || "/home/ubuntu";
const companyId = parseInt(process.argv[2] || "", 10);
if (!companyId) { console.error("usage: recall_test.ts <companyId>"); process.exit(1); }
const VARIANT = process.env.RECALL_VARIANT || "baseline";
const RESERVE = process.env.RETRIEVAL_SPECIFICITY_RESERVE_CHARS || "0";

// ---- bust summary cache: unique PIPELINE_VERSION per process ----
process.env.RAILWAY_GIT_COMMIT_SHA = `recall-${VARIANT}-${companyId}-${Date.now()}`;

// ---- normalization + survival metric ----
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
// Longest run of CONSECUTIVE quote-words found verbatim (as a padded substring)
// in the normalized combinedText, plus k-word shingle coverage.
function survival(quote: string, hayNorm: string): {
  words: number; maxRun: number; shingleCov: number; full: boolean; klass: string;
} {
  const qn = norm(quote);
  const qw = qn.split(" ").filter(Boolean);
  const words = qw.length;
  const hayPad = " " + hayNorm + " ";
  const full = words > 0 && hayPad.includes(" " + qn + " ");
  // max contiguous run
  let maxRun = 0;
  for (let i = 0; i < qw.length; i++) {
    for (let j = qw.length; j > i + maxRun; j--) {
      const sub = qw.slice(i, j).join(" ");
      if (hayPad.includes(" " + sub + " ")) { if (j - i > maxRun) maxRun = j - i; break; }
    }
  }
  // k-word shingle coverage (k=6, or fewer for short quotes)
  const k = Math.min(6, Math.max(2, words));
  let total = 0, hit = 0;
  for (let i = 0; i + k <= qw.length; i++) {
    total++;
    const sh = qw.slice(i, i + k).join(" ");
    if (hayPad.includes(" " + sh + " ")) hit++;
  }
  const shingleCov = total > 0 ? hit / total : (full ? 1 : 0);
  let klass = "lost";
  if (full || shingleCov >= 0.8) klass = "survived";
  else if (shingleCov >= 0.3 || maxRun >= Math.min(8, Math.ceil(words * 0.4))) klass = "partial";
  return { words, maxRun, shingleCov: Math.round(shingleCov * 100) / 100, full, klass };
}

async function main() {
  // dynamic import AFTER setting RAILWAY_GIT_COMMIT_SHA so PIPELINE_VERSION picks it up
  const { summarizeDocuments } = await import("../lib/analyzer.js");

  const rawFw = JSON.parse(readFileSync(`${HOME}/var_framework.json`, "utf8"));
  // var_framework.json is a RAW snake_case DB export; production reads a Drizzle-mapped
  // camelCase object. Map the fields corpus assembly actually reads so the harness's
  // allQueryTerms/dataPatterns/requiredDocTypes match production exactly (data-source parity).
  const framework = {
    ...rawFw,
    topicDescription: rawFw.topicDescription ?? rawFw.topic_description ?? null,
    dataPatterns: rawFw.dataPatterns ?? rawFw.data_patterns ?? null,
    requiredDocTypes: rawFw.requiredDocTypes ?? rawFw.required_doc_types ?? null,
    topicTerm: rawFw.topicTerm ?? rawFw.topic_term ?? null,
    topicSynonyms: rawFw.topicSynonyms ?? rawFw.topic_synonyms ?? null,
    // Baseline variant runs with NO curated corpus-selection vocabulary (production
    // parity for frameworks that predate Approach 2). The expansion variant below
    // overrides this with the real, DF-validated retrievalQueryTerms set.
    retrievalQueryTerms: [] as string[],
  };
  const gt = JSON.parse(readFileSync(`${HOME}/recall_groundtruth.json`, "utf8"));
  const gtCompany = gt.find((c: any) => c.company_id === companyId);
  if (!gtCompany) { console.error(`no ground-truth for company ${companyId}`); process.exit(1); }

  let corpus: Array<{ url: string; title: string; text: string }>;
  const corpusPath = `${HOME}/var_corpus/${companyId}.json`;
  const { createReadStream, existsSync } = await import("fs");
  const ndjsonPath = corpusPath.replace(/\.json$/, ".ndjson");
  const loadNdjson = async () => {
    const readline = await import("readline");
    const out: Array<{ url: string; title: string; text: string }> = [];
    const rl = readline.createInterface({ input: createReadStream(ndjsonPath), crlfDelay: Infinity });
    for await (const line of rl) { const s = line.trim(); if (s) out.push(JSON.parse(s)); }
    return out;
  };
  if (!existsSync(corpusPath) && existsSync(ndjsonPath)) {
    // Giant corpus exported as NDJSON only (>536M JSON exceeds V8 string limit).
    corpus = await loadNdjson();
  } else {
    try {
      corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
    } catch (e: any) {
      if (!/string longer than|ERR_STRING_TOO_LONG/i.test(String(e?.message)) || !existsSync(ndjsonPath)) throw e;
      corpus = await loadNdjson();
    }
  }
  const documentTexts = corpus.map((d) => d.text || "");
  const documentUrls = corpus.map((d) => d.url || "");
  const documentTitles = corpus.map((d) => d.title || "");
  const totalChars = documentTexts.reduce((s, t) => s + t.length, 0);
  const baseTopicDescription: string = framework.topicDescription || framework.name;

  // ---- QUERY-EXPANSION variant (RECALL_QUERY_EXPANSION=1) ----
  // Exercises the REAL corpus-selection lever exactly as production does: the
  // framework's curated, DF-validated `retrievalQueryTerms` set is fed (weighted)
  // into summarizeDocuments' allQueryTerms by analyzer.ts. This replaces the old
  // prototype that appended topicTerm+topicSynonyms to topicDescription — here we
  // do NOT touch topicDescription at all; we populate framework.retrievalQueryTerms
  // (the field production reads) and let the analyzer consume it.
  //
  // Terms are generated ONCE via generateRetrievalQueryTerms() (the same generator
  // used at framework creation and in the storage back-fill) and cached to
  // var_retrieval_terms_<frameworkId>.json. The cache is REUSED when present so
  // repeated runs are deterministic and cheap (a single LLM call on first run only).
  // The baseline variant leaves framework.retrievalQueryTerms = [] (set above).
  const EXPAND = process.env.RECALL_QUERY_EXPANSION === "1";
  const topicDescription = baseTopicDescription; // never mutated — real field path only
  let expansionTerms: string[] = [];
  if (EXPAND) {
    const fwId = framework.id ?? rawFw.id ?? "unknown";
    const termsCachePath = `${HOME}/var_retrieval_terms_${fwId}.json`;
    if (existsSync(termsCachePath)) {
      try {
        const cached = JSON.parse(readFileSync(termsCachePath, "utf8"));
        expansionTerms = Array.isArray(cached)
          ? cached.filter((t: any) => typeof t === "string" && t.trim().length > 0).map((t: string) => t.trim())
          : Array.isArray(cached?.terms)
            ? cached.terms.filter((t: any) => typeof t === "string" && t.trim().length > 0).map((t: string) => t.trim())
            : [];
        console.log(`[recall_test] reusing cached retrievalQueryTerms (${expansionTerms.length}) from ${termsCachePath}`);
      } catch {
        expansionTerms = [];
      }
    }
    if (expansionTerms.length === 0) {
      const { completeWithFallback } = await import("../lib/ai-providers.js");
      const { generateRetrievalQueryTerms } = await import("../lib/framework-v2/retrieval-query-terms.js");
      const gen = await generateRetrievalQueryTerms(
        {
          topicTerm: framework.topicTerm ?? null,
          topicSynonyms: Array.isArray(framework.topicSynonyms) ? framework.topicSynonyms : [],
          topicDescription: framework.topicDescription ?? null,
          frameworkName: framework.name ?? null,
        },
        completeWithFallback as any,
      );
      expansionTerms = gen.terms;
      writeFileSync(termsCachePath, JSON.stringify(gen.terms, null, 2));
      console.log(
        `[recall_test] generated retrievalQueryTerms: ${gen.terms.length} kept, ${gen.validation.dropped.length} dropped (of ${gen.raw.length} candidates) -> cached ${termsCachePath}`,
      );
    }
    // Feed the curated set into the REAL field the analyzer reads for corpus selection.
    (framework as any).retrievalQueryTerms = expansionTerms;
  }
  console.log(`[recall_test] retrievalQueryTerms used for corpus selection: ${expansionTerms.length}`);

  const summ = await summarizeDocuments({
    companyName: gtCompany.company, companyId, documentTexts, documentUrls, documentTitles,
    topicDescription, framework, retrievalV2: true,
  });
  const combinedText: string = summ.text;
  const hayNorm = norm(combinedText);
  const combinedHash = createHash("sha256").update(combinedText).digest("hex").slice(0, 12);

  // doc-URL provenance present in combinedText (from re-emitted headers)
  const urlSet = new Set<string>();
  const re = /--- DOCUMENT: .*? \[(.*?)\] ---/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(combinedText)) !== null) urlSet.add(m[1]);

  // ---- LOSS-CHANNEL instrumentation ----
  // For each marker locate it in the RAW corpus (which document, at what char offset)
  // and check whether that document's header survived into combinedText. This attributes
  // each miss to a specific channel WITHOUT replicating analyzer internals:
  //   not-in-raw            -> upstream data / retrieval issue (marker never in corpus)
  //   whole-doc-drop        -> doc did not make it into combinedText at all
  //                            (MAX_DOCS_RETURNED cap OR class/precision filtering at concat)
  //   within-doc-truncation -> doc IS in combinedText but marker offset is beyond a
  //                            plausible per-class cap (regulatory 480k / proxy 360k /
  //                            topic-primary 160k / other 120k) -> per-document cap slice
  //   chunk-ranking-loss    -> doc in combinedText, marker offset within caps, but marker
  //                            absent -> BM25 560k budget dropped that chunk
  //   survived              -> marker present in combinedText
  const CAPS = { min: 120000, topicPrimary: 160000, proxy: 360000, regulatory: 480000 };
  function findMarkerRaw(marker: string): { docIdx: number; offset: number; docLen: number; url: string } | null {
    const mlc = marker.toLowerCase();
    for (let i = 0; i < documentTexts.length; i++) {
      const lc = documentTexts[i].toLowerCase();
      const idx = lc.indexOf(mlc);
      if (idx >= 0) return { docIdx: i, offset: idx, docLen: documentTexts[i].length, url: documentUrls[i] };
    }
    // flexible fallback: tolerate punctuation/whitespace differences between marker tokens
    const mn = norm(marker);
    const words = mn.split(" ").filter(Boolean);
    if (words.length) {
      const pat = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^a-z0-9]+"), "i");
      for (let i = 0; i < documentTexts.length; i++) {
        const mm = pat.exec(documentTexts[i]);
        if (mm) return { docIdx: i, offset: mm.index, docLen: documentTexts[i].length, url: documentUrls[i] };
      }
    }
    return null;
  }

  const cases = (gtCompany.cases || []).map((cs: any) => {
    const s = survival(cs.quote, hayNorm);
    // MARKER survival: the short distinctive qualifying phrase (named product /
    // quantified figure) verified as a substring of the cited quote. This is the
    // precise recall signal — did the QUALIFYING evidence reach combinedText —
    // independent of how long a block the grader happened to cite.
    const markerNorm = cs.marker ? norm(cs.marker) : "";
    const markerPresent = markerNorm ? (" " + hayNorm + " ").includes(" " + markerNorm + " ") : null;

    // loss-channel attribution
    let lossChannel: string | null = null;
    let rawDocIdx: number | null = null, rawDocOffset: number | null = null, rawDocLen: number | null = null;
    let docInFinal: boolean | null = null;
    if (cs.marker) {
      const loc = findMarkerRaw(cs.marker);
      if (!loc) {
        lossChannel = markerPresent ? "survived" : "not-in-raw";
      } else {
        rawDocIdx = loc.docIdx; rawDocOffset = loc.offset; rawDocLen = loc.docLen;
        docInFinal = urlSet.has(loc.url);
        if (markerPresent) lossChannel = "survived";
        else if (!docInFinal) lossChannel = "whole-doc-drop";
        else if (loc.offset >= CAPS.min) lossChannel = "within-doc-truncation"; // beyond smallest per-class cap
        else lossChannel = "chunk-ranking-loss";
      }
    }

    return {
      measureId: cs.measureId, yesRun: cs.yesRun,
      marker: cs.marker || null, markerStrength: cs.markerStrength || null,
      markerPresent, lossChannel,
      rawDocIdx, rawDocOffset, rawDocLen, docInFinal,
      quotePreview: cs.quote.slice(0, 120),
      ...s,
    };
  });

  const out = {
    companyId, company: gtCompany.company, variant: VARIANT,
    reserveChars: parseInt(RESERVE, 10),
    corpusChars: totalChars, combinedChars: combinedText.length,
    combinedHash, docsInCorpus: corpus.length, docsInCombined: urlSet.size,
    queryExpansion: EXPAND, expansionTermCount: expansionTerms.length,
    model: summ.model, cases,
  };
  mkdirSync(`${HOME}/var_recall_out`, { recursive: true });
  const path = `${HOME}/var_recall_out/${companyId}_${VARIANT}.json`;
  writeFileSync(path, JSON.stringify(out, null, 2));
  const surv = cases.filter((c: any) => c.klass === "survived").length;
  const part = cases.filter((c: any) => c.klass === "partial").length;
  const lost = cases.filter((c: any) => c.klass === "lost").length;
  console.log(`[recall_test] ${gtCompany.company} (${companyId}) variant=${VARIANT} reserve=${RESERVE} | combined=${combinedText.length} docs=${urlSet.size}/${corpus.length} | cases: survived=${surv} partial=${part} lost=${lost} -> ${path}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
