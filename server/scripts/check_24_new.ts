import { readFileSync } from "fs";
import { analyzeEvidenceKeywordDistinctiveness } from "../lib/framework-v2/evidence-keyword-distinctiveness.js";
const HOME = process.env.HOME || "/home/ubuntu";
const measures = JSON.parse(readFileSync(`${HOME}/ab_measures.json`, "utf8"));
const framework = JSON.parse(readFileSync(`${HOME}/ab_framework.json`, "utf8"));
const NEW_24 = ["biomimicry","regenerative","restoration","reforestation","rewilding",
  "bioprospecting","ecotourism","nature-based solutions","payment for ecosystem services",
  "natural climate solutions","biodiversity credits","nature-positive","pollinator","genetic resources"];
const patched = measures.map((m:any)=> String(m.measureId).includes("2.4") ? {...m, evidenceKeywords: NEW_24} : m);
const res = analyzeEvidenceKeywordDistinctiveness(patched, framework.topicSynonyms||[]);
const m24:any = res.perMeasure.find((x:any)=>String(x.measureId).includes("2.4"));
console.log("2.4 with sharpened list:");
console.log("  distinctiveCount:", m24.distinctiveCount, "  flagged:", !!m24.warning);
console.log("  distinctive:", JSON.stringify(m24.distinctiveTokens));
console.log("  generic:   ", JSON.stringify(m24.genericTokens));
console.log("  framework measuresBelowMin:", res.summary.measuresBelowMin, res.summary.flaggedMeasureIds);
