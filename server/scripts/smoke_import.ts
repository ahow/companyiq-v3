import { buildEvidencePacksForCategory, deriveTopicTerms } from "../lib/passage-retrieval.js";
import { buildBinaryScoringPrompt } from "../lib/analyzer.js";
import { completeScoring } from "../lib/ai-providers.js";
console.log("imports OK");
console.log("deriveTopicTerms sample:", deriveTopicTerms("nature and biodiversity risks", "Nature Framework").slice(0,5));
const packs = buildEvidencePacksForCategory({
  measures: [{ measureId:"t1", title:"Board oversight of nature", definition:"Does the board oversee nature?", category:"Gov", categoryNumber:1, displayOrder:1 } as any],
  combinedText: "\n\n--- DOCUMENT: Test Doc [http://x/a] ---\n\nThe board of directors oversees biodiversity and nature-related risks across the value chain. ".repeat(50),
  topicTerms: ["biodiversity","nature","board oversight"],
});
console.log("pack chunkCount:", packs[0].chunkCount, "topicHits:", packs[0].topicHits, "chars:", packs[0].totalChars);
console.log("SMOKE OK");
