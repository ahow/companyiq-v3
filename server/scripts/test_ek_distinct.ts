/**
 * test_ek_distinct.ts — validate analyzeEvidenceKeywordDistinctiveness on the
 * live Nature framework (id 3) measures + topicSynonyms.
 */
import { readFileSync } from "fs";
import { analyzeEvidenceKeywordDistinctiveness } from "../lib/framework-v2/evidence-keyword-distinctiveness.js";

const HOME = process.env.HOME || "/home/ubuntu";
const measures = JSON.parse(readFileSync(`${HOME}/ab_measures.json`, "utf8"));
const framework = JSON.parse(readFileSync(`${HOME}/ab_framework.json`, "utf8"));
const topicSynonyms: string[] = framework.topicSynonyms || [];

const res = analyzeEvidenceKeywordDistinctiveness(measures, topicSynonyms);

console.log("=== SUMMARY ===");
console.log(JSON.stringify(res.summary, null, 2));
console.log("\n=== FLAGGED MEASURES ===");
for (const d of res.perMeasure.filter((x) => x.warning)) {
  console.log(`\n${d.measureId}  (distinctive=${d.distinctiveCount}/${d.totalTokens})`);
  console.log(`  distinctive: [${d.distinctiveTokens.join(", ")}]`);
  console.log(`  generic:     [${d.genericTokens.join(", ")}]`);
}
console.log("\n=== 2.4 detail ===");
const m24 = res.perMeasure.find((x) => x.measureId.includes("2.4"));
console.log(JSON.stringify(m24, null, 2));

console.log("\n=== ALL measures (distinctiveCount) ===");
for (const d of res.perMeasure) {
  console.log(`  ${d.measureId.padEnd(30)} distinctive=${d.distinctiveCount}  [${d.distinctiveTokens.slice(0,6).join(", ")}]`);
}
