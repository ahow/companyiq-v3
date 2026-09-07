import { buildBinaryScoringPrompt } from "../lib/analyzer.js";
import { completeScoring } from "../lib/ai-providers.js";
const { system, prompt } = buildBinaryScoringPrompt({
  companyName:"TestCo",
  measure:{ measureId:"t1", title:"Board oversight of nature-related issues", definition:"The board oversees nature and biodiversity risks.", category:"Governance", categoryNumber:1, displayOrder:1 } as any,
  evidenceText:"\n\n--- DOCUMENT: Sustainability Report [http://x/a] ---\n\nThe Board of Directors, through its Sustainability Committee, has direct oversight of nature and biodiversity-related risks and reviews the TNFD-aligned strategy annually.",
  topicDescription:"Nature and biodiversity disclosure",
});
const { text, provider } = await completeScoring("deepseek", { system, prompt, json:true, maxTokens:2000, seed:42 });
console.log("provider:", provider);
console.log("raw:", text.slice(0,400));
