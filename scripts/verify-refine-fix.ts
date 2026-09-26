/**
 * Empirical verification of the refine-guidance fix.
 * Uses the REAL failing draft/intake from prod job 33cd966d-376c-4c5c-9386-7814a890dc25
 * saved at /tmp/refine_result.json + /tmp/refine_intake.json.
 *
 * Proves:
 *  (a) baseline: fixture reproduces prod flags (27 distinctiveness warnings, C4=1, C11=6).
 *  (b) token-set alignment: my guidance's nonDistinctiveTokens set is computed with the
 *      SAME primitives the validator uses (tokenize + GENERIC_FILLER_TOKENS + docFreq),
 *      so tokens I tell the model to ADD are genuinely distinctive by the validator's rule.
 *  (c) solution-design validation: a COMPLIANT rewrite (following exactly my guidance)
 *      clears the warnings and the C4 error. This proves the guidance is sufficient in
 *      principle; it does NOT prove the LLM will comply (that needs a live run).
 */
import { readFileSync } from "node:fs";
import { analyzeEvidenceKeywordDistinctiveness, GENERIC_FILLER_TOKENS } from "../server/lib/framework-v2/evidence-keyword-distinctiveness.js";
import { validateAll } from "../server/lib/framework-v2/rules.js";
import { tokenize } from "../server/lib/passage-retrieval.js";

const result = JSON.parse(readFileSync("/tmp/refine_result.json", "utf8"));
const intake = JSON.parse(readFileSync("/tmp/refine_intake.json", "utf8"));
const draft = result.draft;

// ---- Build fw faithfully (mirror flattenMeasures + buildFrameworkDraft) ----
function flatten(d: any): any[] {
  const out: any[] = [];
  for (const cat of d.categories || []) {
    for (const m of cat.measures || []) out.push({ ...m });
  }
  return out;
}
function buildFw(d: any) {
  return {
    name: d.framework?.name,
    topicTerm: d.framework?.topicTerm,
    topicSynonyms: d.framework?.topicSynonyms || [],
    adjacentTopics: d.framework?.adjacentTopics || [],
    anchorFrameworks: d.framework?.anchorFrameworks || [],
    sensitivityPreference: d.framework?.sensitivityPreference,
    negativeKeywords: d.framework?.negativeKeywords || [],
    antiInferenceRules: d.framework?.antiInferenceRules || [],
    measures: flatten(d),
  };
}

const fw = buildFw(draft);
console.log(`[setup] measures=${fw.measures.length}  topicSynonyms=${fw.topicSynonyms.length}`);

// ================= (a) BASELINE =================
const baseAnalyzer = analyzeEvidenceKeywordDistinctiveness(fw.measures as any, fw.topicSynonyms);
const baseVal = validateAll(fw as any);
const baseErrors = baseVal.violations.filter((v: any) => v.severity === "error");
const c4 = baseErrors.filter((v: any) => v.rule === "C4");
const c11 = baseErrors.filter((v: any) => v.rule === "C11");
console.log("\n===== (a) BASELINE (fixture vs prod) =====");
console.log(`distinctiveness warnings flagged: ${baseAnalyzer.summary.measuresBelowMin}  (prod: 27)`);
console.log(`errors total: ${baseErrors.length}  C4=${c4.length} (prod 1)  C11=${c11.length} (prod 6)`);
const nullEk = fw.measures.filter((m: any) => !m.evidenceKeywords || m.evidenceKeywords.length === 0).length;
console.log(`measures with NO evidenceKeywords: ${nullEk} / ${fw.measures.length}`);

// ================= (b) TOKEN-SET ALIGNMENT =================
// Reproduce EXACTLY the nonDistinctiveTokens computation from my fix.
const allMeasures = fw.measures;
const topicLexiconTokens = new Set<string>();
for (const s of [intake.topicTerm, intake.topic, ...(intake.topicSynonyms || [])]) {
  if (typeof s === "string") for (const t of tokenize(s)) topicLexiconTokens.add(t);
}
// also include draft.framework.topicSynonyms (what validator uses)
for (const s of fw.topicSynonyms) for (const t of tokenize(s)) topicLexiconTokens.add(t);
const measureCount = allMeasures.length;
const sharedThreshold = Math.max(2, Math.ceil(0.5 * measureCount));
const docFreq = new Map<string, number>();
for (const m of allMeasures) {
  const seen = new Set<string>();
  for (const kw of (m as any).evidenceKeywords || []) for (const t of tokenize(kw)) seen.add(t);
  for (const t of seen) docFreq.set(t, (docFreq.get(t) || 0) + 1);
}
const sharedTokens = new Set<string>();
for (const [t, f] of docFreq) if (f >= sharedThreshold) sharedTokens.add(t);
const nonDistinctiveTokens = new Set<string>([...topicLexiconTokens, ...GENERIC_FILLER_TOKENS, ...sharedTokens]);
console.log("\n===== (b) TOKEN-SET ALIGNMENT =====");
console.log(`topicLexicon=${topicLexiconTokens.size}  filler=${GENERIC_FILLER_TOKENS.size}  shared(df>=${sharedThreshold})=${sharedTokens.size}  union=${nonDistinctiveTokens.size}`);
// Assert: coined tokens are outside the set; sampled topic/filler tokens are inside.
const coined = ["dkw0alpha", "dkw1beta", "dkw2gamma", "dkw3delta", "dkw4eps"];
const coinedOutside = coined.every((t) => !nonDistinctiveTokens.has(t));
const fillerInside = ["strategy", "business", "solution"].every((t) => nonDistinctiveTokens.has(t));
console.log(`coined tokens all OUTSIDE nonDistinctive set: ${coinedOutside}  (expect true)`);
console.log(`sample filler tokens INSIDE nonDistinctive set: ${fillerInside}  (expect true)`);

// ================= (c) SOLUTION-DESIGN VALIDATION =================
// Deep-copy, then apply a COMPLIANT rewrite exactly as my guidance instructs.
const fixedDraft = JSON.parse(JSON.stringify(draft));
const flaggedIds = new Set(baseAnalyzer.summary.flaggedMeasureIds);
let ekPatched = 0;
for (const cat of fixedDraft.categories) {
  for (const m of cat.measures) {
    if (flaggedIds.has(m.measureId)) {
      // ADD >=5 distinctive single-token terms outside nonDistinctiveTokens (keep any existing).
      const add = [0, 1, 2, 3, 4].map((j) => `dkw${ekPatched}${j}uniqx`);
      m.evidenceKeywords = [...(m.evidenceKeywords || []), ...add];
      ekPatched++;
    }
  }
}
// C4: rewrite 4.1-ai-ethical-principles fallback to have >=3 numbered top-level conditions.
for (const cat of fixedDraft.categories) {
  for (const m of cat.measures) {
    if (m.measureId === "4.1-ai-ethical-principles") {
      m.fallback_yes_criterion =
        "1. The company names at least one AI ethical principle in a published document. " +
        "2. The company assigns a named owner or committee accountable for that principle. " +
        "3. The company reports at least one dated action taken under that principle in the disclosure year.";
    }
    // C11: rewrite one offending measure removing 'sufficient' as the decider.
    // Reconciliation clause: keep >=3 numbered conditions (C4) while making each
    // condition decidable via a counted/named-artefact test (C11), and anchor to topic.
    if (m.measureId === "1.7-ai-use-case-examples") {
      m.fallback_yes_criterion =
        "1. The company lists at least two distinct named AI use cases in its disclosures. " +
        "2. For at least one AI use case the company names the deploying business unit or product. " +
        "3. The company states at least one dated deployment or pilot for an AI use case in the disclosure year.";
    }
  }
}
const fixedFw = buildFw(fixedDraft);
const fixAnalyzer = analyzeEvidenceKeywordDistinctiveness(fixedFw.measures as any, fixedFw.topicSynonyms);
const fixVal = validateAll(fixedFw as any);
const fixErrors = fixVal.violations.filter((v: any) => v.severity === "error");
const fixC4 = fixErrors.filter((v: any) => v.rule === "C4");
const fixC11After = fixErrors.filter((v: any) => v.rule === "C11" && v.measureId === "1.7-ai-use-case-examples");
console.log("\n===== (c) SOLUTION-DESIGN VALIDATION (compliant rewrite) =====");
console.log(`distinctiveness warnings: ${baseAnalyzer.summary.measuresBelowMin} -> ${fixAnalyzer.summary.measuresBelowMin}  (expect ->0)`);
console.log(`C4 errors: ${c4.length} -> ${fixC4.length}  (expect ->0)`);
console.log(`C11 on 1.7-ai-use-case-examples: ${c11.filter((v:any)=>v.measureId==="1.7-ai-use-case-examples").length} -> ${fixC11After.length}  (expect ->0)`);
console.log(`total errors: ${baseErrors.length} -> ${fixErrors.length}`);
console.log("\n[honesty] This proves a compliant rewrite following the guidance clears the checks.");
console.log("[honesty] It does NOT prove the LLM will produce a compliant rewrite — that requires a live refine run after deploy.");

// ---- Diagnose remaining C4 ----
console.log("\n[diag] post-fix C4 messages:");
for (const v of fixC4) console.log(`  ${v.measureId}: ${v.message}`);
console.log(`[diag] topicTerm="${fixedFw.topicTerm}"  synonyms sample=${JSON.stringify((fixedFw.topicSynonyms||[]).slice(0,6))}`);
