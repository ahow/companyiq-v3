/**
 * Sprint 10 P3 — Two-step named-entity + quantum verifier
 *
 * Ported from workspace Python (companyiq-runs/two_step_verifier.py). Called
 * from analyzer.ts when a measure specifies:
 *   scoring_strategy: "two_step_named_entity_quantum"
 *   entity_role: "revenue_line" | "cost_claim"
 *
 * Framework-agnostic. The topic term is the framework's topicTerm (e.g. "AI",
 * "modern slavery"). Step 1 asks the LLM to identify named entities/categories
 * disclosed on that topic; step 2 asks whether a quantum (dollar figure /
 * growth % / share %) is attached.
 *
 * A Yes verdict requires BOTH steps to succeed. If step 1 fails, we return
 * verdict=No with a specific reason. If step 1 succeeds but step 2 fails,
 * we return verdict=Partial (a topic-attributed disclosure exists but is
 * un-quantified).
 */

import { completeWithFallback } from "../ai-providers.js";

export interface TwoStepInput {
  companyName: string;
  evidenceText: string;
  topicTerm: string;
  entityRole: "revenue_line" | "cost_claim";
  providerName?: string;
}

export interface TwoStepResult {
  verdict: "Yes" | "No" | "Partial";
  step1: {
    found: boolean;
    named_entities: string[];
    reason?: string;
  };
  step2: {
    found: boolean;
    quantum_type?: "dollar" | "growth_pct" | "share_pct";
    quantum_value?: string;
    reason?: string;
  };
  quotes: Array<{ text: string; source?: string }>;
  provider?: string;
}

function step1Prompt(input: TwoStepInput): { system: string; prompt: string } {
  const roleDesc =
    input.entityRole === "revenue_line"
      ? "a named revenue category, product line, or business segment"
      : "a specific cost/productivity/margin claim";
  return {
    system: `You are extracting evidence from corporate disclosures. Your task is ONE STEP ONLY: identify whether the entity discloses ${roleDesc} specifically attributed to "${input.topicTerm}".

Return strict JSON:
{
  "found": true | false,
  "named_entities": ["exact named entity/category/claim, verbatim from evidence", ...],
  "reason": "brief reason if not found"
}

Rules:
- The entity must be NAMED (a specific programme, category, product, initiative, or line item — not "we do X")
- The attribution must be to "${input.topicTerm}" or a substantively-equivalent term
- If multiple named entities appear, list up to 3
- DO NOT infer beyond what is explicitly disclosed
- DO NOT accept generic statements about the topic`,
    prompt: `Company: ${input.companyName}
Topic: ${input.topicTerm}

Evidence:
${input.evidenceText || "[No evidence found]"}

Return strict JSON.`,
  };
}

function step2Prompt(input: TwoStepInput, namedEntities: string[]): { system: string; prompt: string } {
  return {
    system: `You are verifying whether a specific quantum (dollar figure, growth %, or share %) is disclosed for at least ONE of the named entities identified in step 1.

Return strict JSON:
{
  "found": true | false,
  "quantum_type": "dollar" | "growth_pct" | "share_pct" | null,
  "quantum_value": "verbatim value from evidence (e.g. '$1.2B', '15%', '30% of revenue')" | null,
  "reason": "brief reason if not found"
}

Rules:
- Accept ANY of: dollar figure ($X, XM, XB), growth % (grew X%, up X%), share % (X% of revenue, X% share)
- The quantum must be attached to at least one of the named entities from step 1
- DO NOT accept generic "significant" or "material" — a numerical value is required`,
    prompt: `Company: ${input.companyName}
Topic: ${input.topicTerm}
Named entities from step 1: ${namedEntities.map((e) => `"${e}"`).join(", ")}

Evidence:
${input.evidenceText || "[No evidence found]"}

Return strict JSON.`,
  };
}

export async function verifyTwoStep(input: TwoStepInput): Promise<TwoStepResult> {
  const providerName = input.providerName || "deepseek";

  // Step 1: named entity/category identification
  const s1 = step1Prompt(input);
  let step1Result: any = null;
  let providerUsed: string | undefined;
  try {
    const { text, provider } = await completeWithFallback(providerName, {
      system: s1.system,
      prompt: s1.prompt,
      maxTokens: 800,
      temperature: 0,
      json: true,
    });
    providerUsed = provider;
    step1Result = extractJson(text);
  } catch (err: any) {
    return {
      verdict: "No",
      step1: { found: false, named_entities: [], reason: `step1 error: ${err?.message || err}` },
      step2: { found: false, reason: "step1 failed" },
      quotes: [],
    };
  }

  const found1 = Boolean(step1Result?.found);
  const namedEntities: string[] = Array.isArray(step1Result?.named_entities)
    ? step1Result.named_entities.filter((s: any) => typeof s === "string")
    : [];

  if (!found1 || namedEntities.length === 0) {
    return {
      verdict: "No",
      step1: {
        found: false,
        named_entities: [],
        reason: step1Result?.reason || `No named ${input.entityRole.replace("_", " ")} attributed to "${input.topicTerm}" found in evidence.`,
      },
      step2: { found: false, reason: "step1 did not find named entity" },
      quotes: [],
      provider: providerUsed,
    };
  }

  // Step 2: quantum verification for at least one named entity
  const s2 = step2Prompt(input, namedEntities);
  let step2Result: any = null;
  try {
    const { text } = await completeWithFallback(providerName, {
      system: s2.system,
      prompt: s2.prompt,
      maxTokens: 400,
      temperature: 0,
      json: true,
    });
    step2Result = extractJson(text);
  } catch (err: any) {
    // Step 1 succeeded but step 2 failed — err on Partial rather than No
    return {
      verdict: "Partial",
      step1: { found: true, named_entities: namedEntities },
      step2: { found: false, reason: `step2 error: ${err?.message || err}` },
      quotes: namedEntities.map((e) => ({ text: e })),
      provider: providerUsed,
    };
  }

  const found2 = Boolean(step2Result?.found);
  if (!found2) {
    return {
      verdict: "Partial",
      step1: { found: true, named_entities: namedEntities },
      step2: {
        found: false,
        reason: step2Result?.reason || `Named entity found but no quantum (dollar / growth % / share %) attached.`,
      },
      quotes: namedEntities.map((e) => ({ text: e })),
      provider: providerUsed,
    };
  }

  return {
    verdict: "Yes",
    step1: { found: true, named_entities: namedEntities },
    step2: {
      found: true,
      quantum_type: step2Result?.quantum_type,
      quantum_value: step2Result?.quantum_value,
    },
    quotes: [
      ...namedEntities.map((e) => ({ text: e })),
      ...(step2Result?.quantum_value ? [{ text: step2Result.quantum_value }] : []),
    ],
    provider: providerUsed,
  };
}

function extractJson(text: string): any {
  // Try fenced first
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fence ? fence[1] : text;
  try {
    return JSON.parse(source);
  } catch {
    // Fallback: find first { ... }
    const first = source.indexOf("{");
    const last = source.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(source.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
