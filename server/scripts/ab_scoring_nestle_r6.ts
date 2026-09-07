/**
 * Stage 3 A/B scoring harness (Nestle, framework 3).
 * For each measure x arm, builds the REAL binary scoring prompt
 * (buildBinaryScoringPrompt) over that arm's retrieved evidence pack, and runs
 * completeScoring("deepseek") with N=3 self-consistency. Majority-vote + confidence
 * logic replicated verbatim from analyzer.ts scoreSingleMeasure (L2455-2485) and the
 * parse logic from scoreSingleMeasurePass (L2595-2621). Deterministic per-pass seeds
 * via the real deterministicSeed formula. Arm A and Arm B are graded with identical
 * prompts, seeds and vote logic — only the evidenceText (retrieved pack) differs.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { buildBinaryScoringPrompt } from "../lib/analyzer.js";
import { completeScoring } from "../lib/ai-providers.js";

const HOME = "/home/ubuntu";
const OUT = `${HOME}/ab_stage3_scoring_nestle_r6.json`;
const framework = JSON.parse(readFileSync(`${HOME}/ab_framework.json`, "utf8"));
const stage2 = JSON.parse(readFileSync(`${HOME}/ab_stage2_retrieval_nestle_r6.json`, "utf8"));
const measuresById = new Map<string, any>(
  JSON.parse(readFileSync(`${HOME}/ab_measures.json`, "utf8")).map((m: any) => [m.measureId, m])
);

const COMPANY = "Nestlé";
const COMPANY_ID = 1;
const PROVIDER = "deepseek";
const PASSES = 3;
const topicDescription: string = framework.topicDescription || framework.name;

function deterministicSeed(measureId: string, companyId: number, providerIndex: number): number {
  return createHash("sha256").update(`${measureId}:${companyId}:${providerIndex}`).digest().readUInt32BE(0);
}
function extractAndParseJSON(text: string): any {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const fb = text.indexOf("{"), lb = text.lastIndexOf("}");
  if (fb !== -1 && lb > fb) { try { return JSON.parse(text.slice(fb, lb + 1)); } catch {} }
  try { return JSON.parse(text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()); } catch {}
  throw new Error("Failed to parse JSON from LLM response");
}

type Pass = { score: number; verdict: string; quotes: any[]; evidenceSummary: string };

async function onePass(measure: any, evidenceText: string, providerIndex: number): Promise<Pass> {
  const { system, prompt } = buildBinaryScoringPrompt({
    companyName: COMPANY, measure, evidenceText, terminology: undefined, topicDescription, framework,
  });
  const seed = deterministicSeed(measure.measureId, COMPANY_ID, providerIndex);
  const { text } = await completeScoring(PROVIDER, { system, prompt, json: true, maxTokens: 2000, seed });
  const parsed = extractAndParseJSON(text);
  const validVerdict = ["Yes", "No", "Partial"];
  const score = parsed.score === 1 ? 1 : 0; // binary mode
  let verdict: string;
  if (parsed.verdict && validVerdict.includes(parsed.verdict)) verdict = parsed.verdict;
  else verdict = score === 1 ? "Yes" : "No";
  const quotes = Array.isArray(parsed.quotes) ? parsed.quotes.filter((q: any) => q && typeof q.text === "string" && q.text.length > 0) : [];
  return { score, verdict, quotes, evidenceSummary: String(parsed.evidenceSummary || parsed.reasoning || "") };
}

// majority vote + confidence, verbatim from scoreSingleMeasure
function vote(passResults: Pass[]) {
  const tally = new Map<number, Pass[]>();
  for (const r of passResults) { if (!tally.has(r.score)) tally.set(r.score, []); tally.get(r.score)!.push(r); }
  let winningBucket = passResults[0].score, winningCount = 0;
  for (const [bucket, rs] of tally) {
    if (rs.length > winningCount || (rs.length === winningCount && bucket > winningBucket)) { winningBucket = bucket; winningCount = rs.length; }
  }
  const winners = tally.get(winningBucket)!;
  winners.sort((a, b) => {
    if (a.quotes.length !== b.quotes.length) return b.quotes.length - a.quotes.length;
    const ae = a.evidenceSummary?.length || 0, be = b.evidenceSummary?.length || 0;
    if (ae !== be) return be - ae;
    return (a.evidenceSummary || "").localeCompare(b.evidenceSummary || "");
  });
  const chosen = winners[0];
  const unanimous = winningCount === PASSES;
  const confidence = unanimous ? "High" : winningCount >= Math.ceil(PASSES / 2) ? "Medium" : "Low";
  return { verdict: chosen.verdict, score: chosen.score, confidence, winningCount, passes: PASSES,
    perPass: passResults.map((p) => ({ score: p.score, verdict: p.verdict, quotes: p.quotes.length })) };
}

async function scoreArm(measure: any, evidenceText: string) {
  const passes: Pass[] = [];
  for (let i = 0; i < PASSES; i++) passes.push(await onePass(measure, evidenceText, i));
  return vote(passes);
}

async function main() {
  const results: any[] = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")).results || [] : [];
  const done = new Set(results.map((r) => r.measureId));
  for (const m of stage2.measures) {
    if (done.has(m.measureId)) { console.error(`skip ${m.measureId} (done)`); continue; }
    const measure = measuresById.get(m.measureId);
    try {
      const A = await scoreArm(measure, m.A.text);
      const B = await scoreArm(measure, m.B.text);
      const row = { measureId: m.measureId, title: m.title, category: m.category, A, B };
      results.push(row);
      writeFileSync(OUT, JSON.stringify({ meta: { company: COMPANY, provider: PROVIDER, passes: PASSES }, results }, null, 2));
      console.error(`${m.measureId.padEnd(28)} A:${A.verdict}/${A.confidence}(${A.winningCount}/3)  B:${B.verdict}/${B.confidence}(${B.winningCount}/3)`);
    } catch (e: any) {
      console.error(`ERR ${m.measureId}: ${e?.message || e}`);
    }
  }
  console.error(`\nDONE ${results.length}/20 -> ${OUT}`);
}
main();
