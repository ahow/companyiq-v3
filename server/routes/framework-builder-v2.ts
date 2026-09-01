/**
 * Framework Creation v2 — REST endpoints
 *
 * Mounted at /api/framework-builder/v2/* alongside the existing v1 route.
 * v1 is left completely untouched during rollout.
 */

import { Router, Request, Response } from "express";
import { requireWorkspace, getSessionContext } from "../middleware/auth.js";
import { validateAll, summariseViolations, type FrameworkDraft } from "../lib/framework-v2/rules.js";
import { evaluateRobustness, type IntakeArtefact } from "../lib/framework-v2/robustness-gate.js";
import { INTAKE_SYSTEM_PROMPT, DRAFTING_SYSTEM_PROMPT_HEAD, CHUNKED_SKELETON_SYSTEM_PROMPT, CHUNKED_MEASURES_SYSTEM_PROMPT } from "../lib/framework-v2/intake-prompt.js";
import { exportFrameworkAsSeedTemplate, type ExistingFrameworkForExport } from "../lib/framework-v2/export-as-seed.js";
import { analyseTestDrive, buildSampleSelectionPrompt, type TestDriveCompanyResult, type TestDriveSampleRequest } from "../lib/framework-v2/test-drive.js";
import { computeRobustnessCriteria, type CompanyLabel } from "../lib/framework-v2/robustness-criteria.js";
import { proposeEditsForFlags } from "../lib/framework-v2/edit-proposer.js";
import { diagnoseRootCauses, type CompanyCorpusStats } from "../lib/framework-v2/root-cause-diagnostic.js";
import { buildImprovementChatSystemPrompt, extractActionsFromReply, type ImprovementChatContext, type ImprovementChatMessage } from "../lib/framework-v2/improvement-chat.js";
import { batchTightenDefinitions, batchAppendExclusions, batchRegenerateExamples, groupProposalsByPatch, type FrameworkContext, type MeasureBefore } from "../lib/framework-v2/edit-applier.js";
import * as storage from "../storage.js";
import { db } from "../db.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";

const router = Router();

// ─── POST /v2/chat — intake conversation ─────────────────────────────────
// Runs one turn of the v2 intake conversation. The client passes the
// conversation history so far; the server returns the next assistant message
// plus the current robustness-gate state.

router.post("/v2/chat", async (req: Request, res: Response) => {
  try {
    const { messages, intake, providerName } = req.body as {
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      intake?: IntakeArtefact;
      providerName?: string;
    };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    // Lazy-import ai-providers so tests that don't hit LLMs don't require it
    const { completeWithFallback } = await import("../lib/ai-providers.js");

    const history = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const currentGate = intake ? evaluateRobustness(intake) : null;
    const gateContext = currentGate
      ? `\n\nCurrent robustness gate state: ${currentGate.passedItems}/${currentGate.totalItems} items resolved.\n${currentGate.summaryForUser}`
      : "";

    const { text: response } = await completeWithFallback(providerName || "claude", {
      system: INTAKE_SYSTEM_PROMPT + gateContext,
      prompt: history,
      maxTokens: 4000,
      temperature: 0.2,
    });

    // Try to extract a full intake JSON block if the assistant emitted one this turn
    const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
    let emittedIntake: IntakeArtefact | null = null;
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed && typeof parsed === "object" && parsed.topicTerm) {
          emittedIntake = parsed as IntakeArtefact;
        }
      } catch {
        // ignore; caller can re-parse
      }
    }

    // Also try to extract a partial gate_state snapshot the LLM emits every turn.
    // Merge with the existing intake so the UI gate advances turn-by-turn.
    let partialIntake: Partial<IntakeArtefact> | null = null;
    const gateStateMatch = response.match(/```gate_state\s*([\s\S]*?)```/);
    if (gateStateMatch) {
      try {
        const parsed = JSON.parse(gateStateMatch[1]);
        if (parsed && typeof parsed === "object") {
          partialIntake = parsed as Partial<IntakeArtefact>;
        }
      } catch {
        // best-effort only
      }
    }

    // Merge: prior intake < partial snapshot < full emitted intake (right wins)
    const mergedIntake: IntakeArtefact | null =
      emittedIntake ??
      (partialIntake
        ? ({ ...(intake ?? {}), ...partialIntake } as IntakeArtefact)
        : intake ?? null);

    const gateAfter = mergedIntake ? evaluateRobustness(mergedIntake) : currentGate;

    // Strip machine-readable blocks from the user-visible message. The gate_state
    // block is not meant to be read by the user; only the prose gate summary is.
    const displayMessage = response.replace(/```gate_state\s*[\s\S]*?```\s*/g, "").trim();

    return res.json({
      assistantMessage: displayMessage,
      intake: mergedIntake,
      robustnessGate: gateAfter,
      readyToDraft: Boolean(gateAfter?.ready),
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /chat] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── Draft execution helper (used by both sync and async paths) ──────────

// Build a FrameworkDraft view over an LLM draft object + intake for validation.
// (Previously included mechanical post-fixes that appended boilerplate when the
// LLM omitted exclusion clauses or scoring-guidance context language. Those
// were removed on user feedback: they hid the LLM's compliance gap instead of
// exposing it. Compliance is now driven purely by the drafting prompt + the
// auto-repair loop.)
function buildFrameworkDraft(draft: any, intake: IntakeArtefact): FrameworkDraft {
  const measures = flattenMeasures(draft);
  const normalisedAdjacent = (() => {
    const intakeAdj = intake.adjacentTopics;
    if (Array.isArray(intakeAdj) && intakeAdj.length > 0) return intakeAdj;
    const drAdj = draft.framework?.adjacentTopics;
    if (Array.isArray(drAdj)) {
      return drAdj.map((a: any) => (typeof a === "string" ? { name: a, example_phrases: [] } : a));
    }
    return undefined;
  })();
  return {
    name: draft.framework?.name || intake.topic || "unnamed",
    topicTerm: draft.framework?.topicTerm || intake.topicTerm,
    topicSynonyms: (Array.isArray(draft.framework?.topicSynonyms) ? draft.framework.topicSynonyms : null) || intake.topicSynonyms || [],
    adjacentTopics: normalisedAdjacent,
    anchorFrameworks: (Array.isArray(draft.framework?.anchorFrameworks) ? draft.framework.anchorFrameworks : null) || intake.anchorFrameworks,
    sensitivityPreference: draft.framework?.sensitivityPreference || intake.sensitivityPreference,
    measures,
  };
}

// Threshold above which we switch to chunked drafting to avoid Claude's
// per-call output-token ceiling. Configurable via env for tuning.
// Chunk-drafting threshold. Set conservatively: even 25 measures with rich
// C1-C10 fields regularly hits Claude's ~32K output-token ceiling in a single
// call. Anything at or above 20 gets chunked for safety.
const CHUNKED_DRAFT_THRESHOLD = Number(process.env.FRAMEWORK_V2_CHUNK_THRESHOLD || 15);

// Robust JSON extractor + parser used across all drafting phases. Handles
// fenced ```json blocks, bare JSON, and truncation-recovery.
function parseDraftJson(response: string): { ok: true; draft: any } | { ok: false; error: string; recovered?: boolean; raw?: string } {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) || response.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : response;
  try {
    return { ok: true, draft: JSON.parse(candidate) };
  } catch (e: any) {
    const salvaged = trySalvageTruncatedFramework(candidate);
    if (salvaged) {
      (salvaged as any).__truncationRecovered = true;
      return { ok: true, draft: salvaged };
    }
    const looksTruncated = response.trim().length > 20000 && !response.trim().endsWith("}") && !response.trim().endsWith("```");
    const err = looksTruncated
      ? `The framework was too large for the model's output limit and got cut off (${response.length} chars generated). Try a smaller target measure count.`
      : `Could not parse framework JSON from LLM response: ${e?.message || e}`;
    return { ok: false, error: err, raw: response };
  }
}

// ─── Chunked drafting: skeleton + per-category batches in parallel ───────

async function callChunkedDraftingLLM(intake: IntakeArtefact, providerName?: string): Promise<{ draft: any; truncationRecovered: boolean } | { error: string; raw?: string }> {
  const { completeWithFallback } = await import("../lib/ai-providers.js");

  // Phase 1: skeleton (framework metadata + category outlines).
  const skeletonPrompt = `Intake artefact (JSON):\n${JSON.stringify(intake, null, 2)}\n\nProduce the framework skeleton now.`;
  const skeletonResp = await completeWithFallback(providerName || "claude", {
    system: CHUNKED_SKELETON_SYSTEM_PROMPT,
    prompt: skeletonPrompt,
    maxTokens: 6000,
    temperature: 0.2,
    json: true,
  });
  const skeletonParsed = parseDraftJson(skeletonResp.text);
  if (!skeletonParsed.ok) {
    return { error: `Skeleton phase failed: ${skeletonParsed.error}`, raw: skeletonParsed.raw };
  }
  const skeleton = skeletonParsed.draft;
  if (!Array.isArray(skeleton?.categories) || skeleton.categories.length === 0) {
    return { error: `Skeleton phase produced no categories.`, raw: skeletonResp.text };
  }

  // Phase 2: for each category, expand outlines into full measures. Run in parallel.
  const perCategoryPromises = skeleton.categories.map(async (cat: any, idx: number) => {
    const outlines = Array.isArray(cat.measureOutlines) ? cat.measureOutlines : [];
    if (outlines.length === 0) return { categoryName: cat.name, measures: [], skipped: true };

    // Slim skeleton reference so the LLM has enough context but not too much.
    const skeletonRef = {
      framework: skeleton.framework,
      currentCategory: { name: cat.name, purpose: cat.purpose, index: idx + 1, measureOutlines: outlines },
      otherCategories: skeleton.categories.filter((_: any, i: number) => i !== idx).map((c: any) => ({ name: c.name, purpose: c.purpose })),
    };
    const categoryPrompt = `Intake artefact (JSON):\n${JSON.stringify(intake, null, 2)}\n\nSkeleton reference (JSON):\n${JSON.stringify(skeletonRef, null, 2)}\n\nDraft the full measures for the category "${cat.name}" only. Return the JSON object described in the system prompt.`;
    const catResp = await completeWithFallback(providerName || "claude", {
      system: CHUNKED_MEASURES_SYSTEM_PROMPT,
      prompt: categoryPrompt,
      maxTokens: 16000,
      temperature: 0.2,
      json: true,
    });
    const catParsed = parseDraftJson(catResp.text);
    if (!catParsed.ok) {
      // Non-fatal: return an empty category so assembly continues, and record the error.
      console.warn(`[framework-builder v2] Chunked-drafting category "${cat.name}" failed: ${catParsed.error}`);
      return { categoryName: cat.name, measures: [], failed: true, error: catParsed.error };
    }
    return {
      categoryName: catParsed.draft?.categoryName || cat.name,
      measures: Array.isArray(catParsed.draft?.measures) ? catParsed.draft.measures : [],
      truncationRecovered: Boolean((catParsed.draft as any)?.__truncationRecovered),
    };
  });

  const categoryResults = await Promise.all(perCategoryPromises);
  const anyTruncationRecovered = categoryResults.some((r: any) => r.truncationRecovered);
  const failedCategories = categoryResults.filter((r: any) => r.failed);
  if (failedCategories.length === categoryResults.length) {
    return { error: `All ${failedCategories.length} category-drafting sub-calls failed.`, raw: undefined };
  }

  // Assemble the final framework in the shape the existing validator expects.
  const assembled: any = {
    framework: skeleton.framework,
    categories: skeleton.categories.map((cat: any, idx: number) => {
      const catResult = categoryResults[idx];
      return {
        name: cat.name,
        purpose: cat.purpose,
        measures: catResult.measures || [],
      };
    }),
    searchTemplates: skeleton.searchTemplates || [],
    evidenceKeywords: skeleton.evidenceKeywords || [],
  };
  if (anyTruncationRecovered) assembled.__truncationRecovered = true;

  const totalMeasures = assembled.categories.reduce((s: number, c: any) => s + (c.measures?.length || 0), 0);
  console.log(`[framework-builder v2] Chunked drafting complete: ${assembled.categories.length} categories, ${totalMeasures} measures, ${failedCategories.length} failed categories.`);

  return { draft: assembled, truncationRecovered: anyTruncationRecovered };
}

async function callDraftingLLM(intake: IntakeArtefact, providerName?: string, priorAttempt?: { draft: any; violations: any[] }): Promise<{ draft: any; truncationRecovered?: boolean } | { error: string; raw?: string }> {
  // Route to chunked drafting when the target count exceeds the threshold and
  // this is a fresh attempt (repair passes always use single-shot with the
  // prior draft as context).
  const targetCount = (intake as any).targetMeasureCount;
  if (!priorAttempt && typeof targetCount === "number" && targetCount > CHUNKED_DRAFT_THRESHOLD) {
    console.log(`[framework-builder v2] Chunked drafting activated (target=${targetCount}, threshold=${CHUNKED_DRAFT_THRESHOLD}).`);
    return callChunkedDraftingLLM(intake, providerName);
  }
  return callSingleShotDraftingLLM(intake, providerName, priorAttempt);
}

async function callSingleShotDraftingLLM(intake: IntakeArtefact, providerName?: string, priorAttempt?: { draft: any; violations: any[] }): Promise<{ draft: any } | { error: string; raw?: string }> {
  const { completeWithFallback } = await import("../lib/ai-providers.js");

  let userPrompt: string;
  if (priorAttempt) {
    // Repair prompt: give the LLM the exact violations to fix.
    const violationSummary = priorAttempt.violations
      .map((v: any) => `- [${v.rule}][${v.severity}] ${v.measureId ? `${v.measureId}: ` : ""}${v.message}${v.suggestion ? ` — SUGGESTION: ${v.suggestion}` : ""}`)
      .join("\n");
    userPrompt = `Intake artefact (JSON):\n${JSON.stringify(intake, null, 2)}\n\nPrior attempt draft (JSON, has validation errors):\n${JSON.stringify(priorAttempt.draft, null, 2)}\n\nViolations to fix (do NOT change measures that are already valid — only edit the fields that trigger these violations):\n${violationSummary}\n\nReturn a corrected framework JSON. Preserve measureId values from the prior attempt. Every construction rule C1–C10 must pass this time.`;
  } else {
    const tgt = (intake as any).targetMeasureCount;
    const countClause = typeof tgt === "number" && tgt > 0
      ? `The user requested approximately ${tgt} measures in total across all categories. Distribute measures roughly evenly across the sub-areas from the intake, weighting more heavily toward higher-priority sub-areas if the user's purpose emphasises them. Do not fall short by more than 15% or exceed by more than 15%.`
      : `Produce approximately 20–30 measures in total across all categories — enough to give balanced coverage but not so many as to become fatiguing to review.`;
    userPrompt = `Intake artefact (JSON):\n${JSON.stringify(intake, null, 2)}\n\nDraft the framework now, following construction rules C1–C10 exactly. ${countClause} Every measure must comply with C1–C10 — in particular: every measure's substantive_definition MUST include an explicit adjacent-topic exclusion clause naming at least one adjacent topic from the intake list; every measure's fallback_yes_criterion MUST have at least 3 numbered conditions each referencing the topic term or a synonym; every measure MUST have whatConstitutesEvidence AND whatDoesNotConstituteEvidence AND positive_examples (>=2) AND negative_examples (>=2).`;
  }

  const { text: response } = await completeWithFallback(providerName || "claude", {
    system: DRAFTING_SYSTEM_PROMPT_HEAD,
    prompt: userPrompt,
    maxTokens: 24000,
    temperature: 0.2,
    json: true,
  });

  // Truncation-aware parse with partial-recovery fallback. Claude sometimes
  // stops generating mid-JSON at the token cap. When that happens, response
  // ends without balancing braces and JSON.parse throws. We attempt to
  // salvage the partial framework by locating the last complete measure and
  // trimming everything after it.
  let draft: any = null;
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) || response.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : response;
  try {
    draft = JSON.parse(candidate);
  } catch (e: any) {
    const salvaged = trySalvageTruncatedFramework(candidate);
    if (salvaged) {
      console.warn(`[framework-builder v2] Salvaged truncated draft (${response.length} chars, ${salvaged.categories?.length || 0} categories, ${countMeasures(salvaged)} measures preserved).`);
      draft = salvaged;
      (draft as any).__truncationRecovered = true;
    } else {
      const looksTruncated = response.trim().length > 20000 && !response.trim().endsWith("}") && !response.trim().endsWith("```");
      const msg = looksTruncated
        ? `The framework was too large for the model's output limit and got cut off (${response.length} chars generated). Try a smaller target measure count (e.g. Compact or Balanced) or split the framework by sub-area.`
        : `Could not parse framework JSON from LLM response: ${e?.message || e}`;
      return { error: msg, raw: response };
    }
  }
  return { draft };
}

// Attempt to salvage a partial framework from a truncated JSON string.
// Strategy: find the position of the last complete measure object (looks
// for `"measureId":` occurrences, walks backward to find a balanced object,
// then closes the enclosing arrays and top-level object).
function trySalvageTruncatedFramework(raw: string): any | null {
  try {
    // Find the last well-formed "measures": [ ... ] chunk we can complete.
    // Simplest approach: progressively trim trailing chars, close open braces
    // and brackets, and try to parse.
    let text = raw;
    // Find the last comma that separates measures. Look for `},\s*{` inside a
    // measures array. We chop after the last complete `}` closing a measure.
    const closingMeasureRe = /\}\s*(,|\])/g;
    let lastGood = -1;
    let m: RegExpExecArray | null;
    while ((m = closingMeasureRe.exec(text)) !== null) {
      lastGood = m.index + 1;
    }
    if (lastGood <= 0) return null;
    // Trim everything after the last complete measure closing brace.
    text = text.slice(0, lastGood);
    // Now close open structures: count unbalanced { [ and append matching
    // closers. This is a heuristic but works for the shape our drafter emits.
    let openBrace = 0;
    let openBracket = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === "{") openBrace++;
      else if (c === "}") openBrace--;
      else if (c === "[") openBracket++;
      else if (c === "]") openBracket--;
    }
    // Close open brackets first (arrays close before their parent object),
    // then open braces.
    let closer = "";
    // If the trim ended with a trailing comma, strip it.
    text = text.replace(/,\s*$/, "");
    for (let i = 0; i < openBracket; i++) closer += "]";
    for (let i = 0; i < openBrace; i++) closer += "}";
    return JSON.parse(text + closer);
  } catch {
    return null;
  }
}

function countMeasures(draft: any): number {
  if (!draft?.categories) return 0;
  return draft.categories.reduce((sum: number, c: any) => sum + (Array.isArray(c?.measures) ? c.measures.length : 0), 0);
}

async function executeDraft(intake: IntakeArtefact, providerName?: string): Promise<{ draft: any; measures: any[]; validation: any; summary: string; repairAttempts: number; truncationRecovered?: boolean } | { error: string; raw?: string }> {
  // Attempt 1: initial draft.
  const first = await callDraftingLLM(intake, providerName);
  if ("error" in first) return first;
  let draft = first.draft;

  const validate = (d: any) => {
    const fwDraft = buildFrameworkDraft(d, intake);
    try {
      return validateAll(fwDraft);
    } catch (e: any) {
      console.error("[framework-builder v2 /draft] validator crashed:", e);
      return {
        passed: false,
        violations: [
          { rule: "internal", severity: "error" as const, message: `Validator threw: ${e?.message || e}. Draft is displayed for review but should be re-drafted.` },
        ],
      };
    }
  };

  let validation: any = validate(draft);

  // Up to 2 repair passes for hard errors. Warnings don't trigger a repair.
  //
  // For chunked drafts (>15 measures), the repair loop is DISABLED because
  // a single-shot repair prompt containing the full assembled draft exceeds
  // Claude's 10-min non-streaming limit ("Streaming is required for operations
  // that may take longer than 10 minutes"). Chunked drafts already run
  // per-category so per-category repair should be handled separately; for now
  // we accept that a chunked draft's errors flow to the user's review pane
  // where they can hit "Re-draft with corrections" for a targeted repair.
  let repairAttempts = 0;
  const MAX_REPAIRS = Number(process.env.FRAMEWORK_V2_MAX_REPAIRS || 2);
  const wasChunked = Boolean((first as any).truncationRecovered) || (Array.isArray((draft as any).categories) && (draft as any).categories.some((c: any) => Array.isArray(c.measures) && c.measures.length > 0)) && (intake as any).targetMeasureCount > 15;
  while (
    !wasChunked &&
    repairAttempts < MAX_REPAIRS &&
    validation.violations.some((v: any) => v.severity === "error")
  ) {
    repairAttempts++;
    const errors = validation.violations.filter((v: any) => v.severity === "error").slice(0, 30);
    const repair = await callDraftingLLM(intake, providerName, { draft, violations: errors });
    if ("error" in repair) {
      // If the repair pass fails to parse, keep the previous draft and stop.
      console.warn(`[framework-builder v2] Repair attempt ${repairAttempts} failed to parse; keeping prior draft.`);
      break;
    }
    draft = repair.draft;
    validation = validate(draft);
  }

  const measures = flattenMeasures(draft);
  const truncationRecovered = Boolean((draft as any).__truncationRecovered);
  return { draft, measures, validation, summary: summariseViolations(validation.violations), repairAttempts, truncationRecovered };
}

// ─── POST /v2/draft — draft the framework from a confirmed intake (SYNC) ───
// Kept for backward compatibility — also enqueues a job so the client can
// choose to poll if the socket dies before the response arrives.

router.post("/v2/draft", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const { intake, providerName } = req.body as { intake: IntakeArtefact; providerName?: string };
    if (!intake || !intake.topicTerm) {
      return res.status(400).json({ error: "intake with topicTerm required" });
    }
    const gate = evaluateRobustness(intake);
    if (!gate.ready && !intake.confirmed) {
      return res.status(400).json({
        error: "Intake robustness gate not satisfied and intake.confirmed is not set to true",
        robustnessGate: gate,
      });
    }
    const result = await executeDraft(intake, providerName);
    if ("error" in result) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (err: any) {
    console.error("[framework-builder v2 /draft] error:", err);
    return res.status(500).json({ error: err?.message || "internal error", stack: err?.stack });
  }
});

// ─── POST /v2/draft/refine — iterative repair on an existing draft ───────
// Runs the same fire-and-forget job pattern as /v2/draft/start, but starts
// from an existing draft + its validation output and asks the LLM to fix the
// listed violations. Returns { jobId } so the client polls /v2/draft/status.

router.post("/v2/draft/refine", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const { draft, intake, providerName } = req.body as { draft: any; intake: IntakeArtefact; providerName?: string };
    if (!draft || !intake) return res.status(400).json({ error: "draft + intake required" });
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId || !ctx.userId) return res.status(401).json({ error: "session context missing" });

    const jobId = randomUUID();
    await db.execute(sql`
      INSERT INTO framework_v2_jobs (id, workspace_id, user_id, kind, status, intake, provider_name)
      VALUES (${jobId}, ${ctx.workspaceId}, ${ctx.userId}, 'refine', 'running', ${JSON.stringify(intake)}::jsonb, ${providerName || null})
    `);

    (async () => {
      try {
        // Compute current violations from the incoming draft, then hand it to
        // the auto-repair loop by seeding executeDraft with a starting draft.
        // Simplest: use callDraftingLLM with priorAttempt = { draft, violations }.
        const fwDraft = buildFrameworkDraft(draft, intake);
        let currentValidation: any;
        try { currentValidation = validateAll(fwDraft); }
        catch (e: any) { currentValidation = { passed: false, violations: [{ rule: "internal", severity: "error", message: e?.message }] }; }
        const errorsFound = (currentValidation.violations || []).filter((v: any) => v.severity === "error" || v.severity === "warning").slice(0, 30);
        if (errorsFound.length === 0) {
          // Nothing to refine — just return the current draft.
          await db.execute(sql`
            UPDATE framework_v2_jobs
            SET status = 'succeeded', result = ${JSON.stringify({ draft, measures: fwDraft.measures, validation: currentValidation, summary: "No violations to refine.", repairAttempts: 0 })}::jsonb, updated_at = NOW()
            WHERE id = ${jobId}
          `);
          return;
        }
        // Call the LLM with the exact violation list as a repair prompt.
        const repairCall = await callSingleShotDraftingLLM(intake, providerName, { draft, violations: errorsFound });
        if ("error" in repairCall) {
          await db.execute(sql`
            UPDATE framework_v2_jobs
            SET status = 'failed', error_message = ${repairCall.error}, error_stack = ${repairCall.raw || null}, updated_at = NOW()
            WHERE id = ${jobId}
          `);
          return;
        }
        // Re-validate the refined draft.
        const refinedDraft = repairCall.draft;
        const refinedFwDraft = buildFrameworkDraft(refinedDraft, intake);
        let refinedValidation: any;
        try { refinedValidation = validateAll(refinedFwDraft); }
        catch (e: any) { refinedValidation = { passed: false, violations: [{ rule: "internal", severity: "error", message: e?.message }] }; }
        const result = {
          draft: refinedDraft,
          measures: refinedFwDraft.measures,
          validation: refinedValidation,
          summary: summariseViolations(refinedValidation.violations),
          repairAttempts: 1,
        };
        await db.execute(sql`
          UPDATE framework_v2_jobs
          SET status = 'succeeded', result = ${JSON.stringify(result)}::jsonb, updated_at = NOW()
          WHERE id = ${jobId}
        `);
      } catch (err: any) {
        console.error(`[framework-builder v2 /draft/refine] job ${jobId} threw:`, err);
        await db.execute(sql`
          UPDATE framework_v2_jobs
          SET status = 'failed', error_message = ${err?.message || String(err)}, error_stack = ${err?.stack || null}, updated_at = NOW()
          WHERE id = ${jobId}
        `).catch(() => {});
      }
    })();

    return res.json({ jobId, status: "running" });
  } catch (err: any) {
    console.error("[framework-builder v2 /draft/refine] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/draft/start — kick off draft as an async job ─────────────
// Returns immediately with a job id. Draft runs in the background and
// writes result / error to framework_v2_jobs. Client polls /v2/draft/status.

router.post("/v2/draft/start", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const { intake, providerName } = req.body as { intake: IntakeArtefact; providerName?: string };
    if (!intake || !intake.topicTerm) {
      return res.status(400).json({ error: "intake with topicTerm required" });
    }
    const gate = evaluateRobustness(intake);
    if (!gate.ready && !intake.confirmed) {
      return res.status(400).json({
        error: "Intake robustness gate not satisfied and intake.confirmed is not set to true",
        robustnessGate: gate,
      });
    }
    const ctx = getSessionContext(req);
    if (!ctx || !ctx.workspaceId || !ctx.userId) {
      return res.status(401).json({ error: "session context missing" });
    }

    const jobId = randomUUID();
    await db.execute(sql`
      INSERT INTO framework_v2_jobs (id, workspace_id, user_id, kind, status, intake, provider_name)
      VALUES (${jobId}, ${ctx.workspaceId}, ${ctx.userId}, 'draft', 'running', ${JSON.stringify(intake)}::jsonb, ${providerName || null})
    `);

    // Fire-and-forget. Store the result/error on the row when it settles.
    // We do NOT await; the client polls /v2/draft/status/:jobId.
    (async () => {
      try {
        const result = await executeDraft(intake, providerName);
        if ("error" in result) {
          await db.execute(sql`
            UPDATE framework_v2_jobs
            SET status = 'failed', error_message = ${result.error}, error_stack = ${result.raw || null}, updated_at = NOW()
            WHERE id = ${jobId}
          `);
          return;
        }
        await db.execute(sql`
          UPDATE framework_v2_jobs
          SET status = 'succeeded', result = ${JSON.stringify(result)}::jsonb, updated_at = NOW()
          WHERE id = ${jobId}
        `);
      } catch (err: any) {
        console.error(`[framework-builder v2 /draft/start] job ${jobId} threw:`, err);
        await db.execute(sql`
          UPDATE framework_v2_jobs
          SET status = 'failed', error_message = ${err?.message || String(err)}, error_stack = ${err?.stack || null}, updated_at = NOW()
          WHERE id = ${jobId}
        `).catch(() => {});
      }
    })();

    return res.json({ jobId, status: "running" });
  } catch (err: any) {
    console.error("[framework-builder v2 /draft/start] error:", err);
    return res.status(500).json({ error: err?.message || "internal error", stack: err?.stack });
  }
});

// ─── GET /v2/draft/status/:jobId ─────────────────────────────────────

router.get("/v2/draft/status/:jobId", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx || !ctx.workspaceId) return res.status(401).json({ error: "session context missing" });
    const jobId = req.params.jobId;
    const rows = await db.execute(sql`
      SELECT id, status, result, error_message, error_stack, created_at, updated_at
      FROM framework_v2_jobs
      WHERE id = ${jobId} AND workspace_id = ${ctx.workspaceId}
    `);
    const row = (rows as any).rows?.[0];
    if (!row) return res.status(404).json({ error: "job not found" });
    return res.json({
      jobId: row.id,
      status: row.status,
      result: row.result || null,
      errorMessage: row.error_message || null,
      errorStack: row.error_stack || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /draft/status] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/validate — re-validate an edited draft ─────────────────────

router.post("/v2/validate", async (req: Request, res: Response) => {
  try {
    const { draft } = req.body as { draft: any };
    if (!draft) return res.status(400).json({ error: "draft required" });
    const measures = flattenMeasures(draft);
    const fwDraft: FrameworkDraft = {
      name: draft.framework?.name || "unnamed",
      topicTerm: draft.framework?.topicTerm,
      topicSynonyms: draft.framework?.topicSynonyms || [],
      adjacentTopics: draft.framework?.adjacentTopics,
      anchorFrameworks: draft.framework?.anchorFrameworks,
      sensitivityPreference: draft.framework?.sensitivityPreference,
      measures,
    };
    const validation = validateAll(fwDraft);
    return res.json({
      validation,
      summary: summariseViolations(validation.violations),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/save — persist a validated v2 framework ────────────────────
// Called by the client after the user has drafted + validated + (optionally)
// test-driven the framework. Writes framework + measures with builder_version="v2"
// and all C1-C10 fields populated.

router.post("/v2/save", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const { draft, intake, testDriveSummary, testDriveWarnings, productionReady } = req.body as {
      draft: any;
      intake: IntakeArtefact;
      testDriveSummary?: any;
      testDriveWarnings?: any[];
      productionReady?: boolean;
    };
    if (!draft?.framework || !Array.isArray(draft?.categories)) {
      return res.status(400).json({ error: "draft with framework + categories required" });
    }
    if (!intake?.topicTerm) {
      return res.status(400).json({ error: "intake with topicTerm required" });
    }

    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });

    // Re-validate before persisting — server-authoritative
    const fwDraft: FrameworkDraft = buildFrameworkDraft(draft, intake);
    const measures = fwDraft.measures;
    let validation: any;
    try {
      validation = validateAll(fwDraft);
    } catch (e: any) {
      validation = { passed: false, violations: [{ rule: "internal", severity: "error", message: `Validator threw: ${e?.message || e}` }] };
    }

    // Only block save-as-production-ready when validation fails. Save-as-draft
    // is allowed even with errors so the user can test-drive an imperfect
    // framework, then edit or repair before promoting.
    if (productionReady && !validation.passed) {
      return res.status(400).json({
        error: "Framework fails C1-C10 validation and cannot be saved as production-ready. Save as draft instead.",
        validation,
        summary: summariseViolations(validation.violations),
      });
    }

    // Create framework row
    const created = await storage.createFramework({
      workspaceId: ctx.workspaceId,
      name: fwDraft.name,
      topicDescription: draft.framework.topicDescription || intake.topic || "",
      isActive: false,
      searchTemplates: draft.searchTemplates || null,
      // v2 fields
      builderVersion: "v2",
      topicTerm: fwDraft.topicTerm,
      topicSynonyms: fwDraft.topicSynonyms || null,
      adjacentTopics: (fwDraft.adjacentTopics as any) || null,
      anchorFrameworks: (fwDraft.anchorFrameworks as any) || null,
      sensitivityPreference: fwDraft.sensitivityPreference || "balanced",
      subAreaStructure: (intake.subAreaStructure as any) || null,
      pushbackRecord: (intake.pushbackRecord as any) || null,
      residualWarnings: (intake.residualWarnings as any) || null,
      testDriveSummary: testDriveSummary || null,
      testDriveWarnings: testDriveWarnings || null,
      productionReady: Boolean(productionReady),
      rulesActive: draft.framework.rulesActive || {
        C1: true, C2: true, C3: true, C4: true, C5: true,
        C6: true, C7: true, C8: true, C9: true, C10: true,
      },
      intakeArtefact: intake as any,
    } as any);

    // Create measures
    let categoryNumber = 1;
    for (const category of draft.categories) {
      let displayOrder = 1;
      for (const measure of category.measures || []) {
        await storage.createFrameworkMeasure({
          frameworkId: created.id,
          measureId: measure.measureId || `${categoryNumber}.${displayOrder}`,
          title: measure.title,
          definition: measure.definition || "",
          scoringGuidance:
            typeof measure.scoringGuidance === "string"
              ? measure.scoringGuidance
              : JSON.stringify(measure.scoringGuidance || {}),
          evidenceKeywords: measure.evidenceKeywords || [],
          category: category.name,
          categoryNumber,
          displayOrder,
          // v2 fields
          primaryAssessmentTarget: measure.primary_assessment_target || null,
          substantiveDefinition: measure.substantive_definition || null,
          whatConstitutesEvidence:
            typeof measure.whatConstitutesEvidence === "string"
              ? measure.whatConstitutesEvidence
              : Array.isArray(measure.whatConstitutesEvidence)
                ? measure.whatConstitutesEvidence.join("\n")
                : null,
          whatDoesNotConstituteEvidence:
            typeof measure.whatDoesNotConstituteEvidence === "string"
              ? measure.whatDoesNotConstituteEvidence
              : Array.isArray(measure.whatDoesNotConstituteEvidence)
                ? measure.whatDoesNotConstituteEvidence.join("\n")
                : null,
          fallbackYesCriterion: measure.fallback_yes_criterion || null,
          positiveExamples: measure.positive_examples || null,
          negativeExamples: measure.negative_examples || null,
          coverageWhitelist: measure.coverage_whitelist || null,
          c1AchievementGuidance: measure.c1_achievement_guidance || null,
          minQuoteContextChars: measure.min_quote_context_chars || null,
          expectedYesRate: typeof measure.expected_yes_rate === "number" ? measure.expected_yes_rate : null,
          disclosureVehicles: measure.disclosure_vehicles || null,
          r31ExceptionMetrics: Boolean(measure.r3_1_exception_metrics),
          r31ExceptionCoverage: Boolean(measure.r3_1_exception_coverage),
        } as any);
        displayOrder++;
      }
      categoryNumber++;
    }

    return res.json({
      frameworkId: created.id,
      name: created.name,
      builderVersion: "v2",
      measureCount: measures.length,
      productionReady: Boolean(productionReady),
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /save] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/test-drive/select — propose 10-company sample ──────────────

router.post("/v2/test-drive/select", async (req: Request, res: Response) => {
  try {
    const { frameworkName, topicTerm, topicSynonyms, sectorScope, stage1ResearchSummary, providerName } = req.body as TestDriveSampleRequest & { providerName?: string };
    if (!frameworkName || !topicTerm) return res.status(400).json({ error: "frameworkName and topicTerm required" });

    const { system, user } = buildSampleSelectionPrompt({
      frameworkName,
      topicTerm,
      topicSynonyms: topicSynonyms || [],
      sectorScope: sectorScope || "agnostic",
      stage1ResearchSummary,
    });
    const { completeWithFallback } = await import("../lib/ai-providers.js");
    const { text: response } = await completeWithFallback(providerName || "claude", {
      system,
      prompt: user,
      maxTokens: 3000,
      temperature: 0.2,
      json: true,
    });

    let companies: any[] = [];
    try {
      const m = response.match(/\[[\s\S]*\]/);
      companies = m ? JSON.parse(m[0]) : JSON.parse(response);
    } catch (e) {
      return res.status(500).json({ error: "Could not parse company list from LLM response", raw: response });
    }
    return res.json({ companies });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/test-drive/run — create companies + list, kick off scoring ───
// Frontend calls this AFTER /v2/save (which returns a frameworkId) and
// /v2/test-drive/select (which returned the 10 candidate companies).
// The endpoint:
//   1. Ensures each proposed company exists in the workspace (create if missing)
//   2. Creates a new company list "Test-drive: <framework name>"
//   3. Adds the companies to the list
//   4. Returns { listId, companyIds } so the client can POST /api/analyze itself
// We do not call /analyze internally because it depends on session context and
// req.body shape that varies with the caller.

router.post("/v2/test-drive/run", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const { frameworkId, companies, frameworkName } = req.body as {
      frameworkId: number;
      frameworkName?: string;
      companies: Array<{ name: string; ticker?: string; sector?: string; country?: string; isKnownDiscloser?: boolean }>;
    };
    if (!frameworkId || !Array.isArray(companies) || companies.length === 0) {
      return res.status(400).json({ error: "frameworkId and companies[] required" });
    }
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });

    // 1. For each proposed company, either find existing (by exact name match)
    //    or create. Company creation is idempotent-ish: duplicate names are OK,
    //    the test-drive just uses whichever record exists first.
    const companyIds: number[] = [];
    for (const c of companies) {
      const existing = await db.execute(sql`
        SELECT id FROM companies
        WHERE workspace_id = ${ctx.workspaceId} AND LOWER(name) = LOWER(${c.name})
        LIMIT 1
      `);
      const existingRow = (existing as any).rows?.[0];
      if (existingRow?.id) {
        companyIds.push(existingRow.id);
        continue;
      }
      const created = await storage.createCompany({
        workspaceId: ctx.workspaceId,
        name: c.name,
        ticker: c.ticker || null,
        sector: c.sector || null,
        country: c.country || null,
      } as any);
      companyIds.push((created as any).id);
    }

    // 2. Create a test-drive list.
    const listName = `Test-drive: ${frameworkName || "framework " + frameworkId} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const list = await storage.createCompanyList(ctx.workspaceId, listName, "Auto-generated v2 test-drive sample");
    // 3. Add companies to the list.
    for (const cid of companyIds) {
      try { await storage.addCompanyToList((list as any).id, cid); } catch { /* dup add — ignore */ }
    }

    // 4. Persist signal/edge labels for later robustness analysis (discrimination criterion).
    const labels = companies.map((c, i) => ({
      companyId: companyIds[i],
      isKnownDiscloser: c.isKnownDiscloser === true,
    }));
    try {
      await db.execute(sql`
        UPDATE company_lists SET test_drive_labels = ${JSON.stringify(labels)}::jsonb WHERE id = ${(list as any).id}
      `);
    } catch (e: any) {
      console.warn("[framework-builder v2 /test-drive/run] label persist failed (non-fatal):", e?.message);
    }

    return res.json({
      listId: (list as any).id,
      listName,
      companyIds,
      companyCount: companyIds.length,
      hint: "POST /api/analyze with { frameworkId, listId } to kick off scoring, or navigate to Results with these IDs.",
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /test-drive/run] error:", err);
    return res.status(500).json({ error: err?.message || "internal error", stack: err?.stack });
  }
});

// ─── GET /v2/test-drive/results — fetch scored results + auto-analyse ──────
// Given ?frameworkId=&listId=, aggregates measure_scores across the list's
// companies, produces per-company + per-measure summaries, and runs the
// flag-analysis rules. Also reports batch-run status so the UI can show
// progress while scoring is still in flight.

router.get("/v2/test-drive/results", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });

    const frameworkId = Number(req.query.frameworkId);
    const listId = Number(req.query.listId);
    if (!frameworkId || !listId) {
      return res.status(400).json({ error: "frameworkId and listId query params required" });
    }

    // 1. Batch-run progress.
    const batchRow = await db.execute(sql`
      SELECT id, status, total_jobs, completed_jobs, failed_jobs, started_at, completed_at
      FROM batch_runs
      WHERE framework_id = ${frameworkId} AND list_id = ${listId} AND workspace_id = ${ctx.workspaceId}
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const batch = (batchRow as any).rows?.[0] || null;

    // 2. Fetch measure_scores for the list's companies + framework.
    const scoresQuery = await db.execute(sql`
      SELECT ms.company_id, c.name AS company_name, ms.measure_id, ms.verdict,
             ms.confidence, ms.quotes, ms.verdict_nuance, ms.score
      FROM measure_scores ms
      JOIN companies c ON c.id = ms.company_id
      JOIN company_list_members clm ON clm.company_id = c.id AND clm.list_id = ${listId}
      WHERE ms.framework_id = ${frameworkId}
      ORDER BY c.name, ms.measure_id
    `);
    const rows = ((scoresQuery as any).rows || []) as Array<any>;

    // 3. Assemble TestDriveCompanyResult[]
    const byCompany: Record<string, TestDriveCompanyResult> = {};
    for (const r of rows) {
      const key = String(r.company_id);
      if (!byCompany[key]) {
        byCompany[key] = { companyId: r.company_id, companyName: r.company_name, measures: [] };
      }
      const quotes = Array.isArray(r.quotes) ? r.quotes : [];
      const nuance = String(r.verdict_nuance || "");
      byCompany[key].measures.push({
        measureId: r.measure_id,
        verdict: (r.verdict || "No") as any,
        confidence: r.confidence || "Medium",
        quoteCount: quotes.length,
        adjacentTopicHits: 0, // could be enhanced by parsing quotes for adjacent-topic markers
        r33Flipped: /R3\.3 flipped/i.test(nuance),
      });
    }
    const results: TestDriveCompanyResult[] = Object.values(byCompany);

    // 4. Fetch measure metadata (expected_yes_rate + full definition for edit proposals).
    const measureMetaQuery = await db.execute(sql`
      SELECT measure_id, expected_yes_rate, title, substantive_definition,
             fallback_yes_criterion, positive_examples, negative_examples,
             min_quote_context_chars
      FROM framework_measures
      WHERE framework_id = ${frameworkId}
    `);
    const measureRows = ((measureMetaQuery as any).rows || []) as any[];
    const measureMetadata = measureRows.map((m: any) => ({
      measureId: m.measure_id,
      expected_yes_rate: typeof m.expected_yes_rate === "number" ? m.expected_yes_rate : 0.35,
      title: m.title,
    }));
    // Full measure definitions keyed by measure_id, for edit-proposal generation.
    const measuresById: Record<string, any> = {};
    for (const m of measureRows) {
      measuresById[m.measure_id] = {
        substantive_definition: m.substantive_definition,
        fallback_yes_criterion: m.fallback_yes_criterion,
        positive_examples: m.positive_examples,
        negative_examples: m.negative_examples,
        min_quote_context_chars: m.min_quote_context_chars,
      };
    }

    // 4b. Load signal/edge labels from company_lists.test_drive_labels.
    let labels: CompanyLabel[] = [];
    try {
      const labelQuery = await db.execute(sql`
        SELECT test_drive_labels FROM company_lists WHERE id = ${listId} AND workspace_id = ${ctx.workspaceId}
      `);
      const raw = (labelQuery as any).rows?.[0]?.test_drive_labels;
      if (Array.isArray(raw)) {
        labels = raw.map((r: any) => ({
          companyId: Number(r.companyId),
          isKnownDiscloser: !!r.isKnownDiscloser,
        }));
      }
    } catch (e: any) {
      console.warn("[framework-builder v2 /test-drive/results] label load failed (non-fatal):", e?.message);
    }
    // Fallback heuristic when labels are missing (legacy batches like framework 3):
    // top-quartile Yes-rate companies are treated as "signal", bottom-quartile as
    // "edge". This is inference from results themselves and MUST NOT be used to
    // claim discrimination pass; it exists so the criterion still renders.
    let labelsInferred = false;
    if (labels.length === 0 && Object.values(byCompany).length > 0) {
      labelsInferred = true;
      const perC = Object.values(byCompany).map((r) => ({
        companyId: r.companyId,
        yesRate: r.measures.length > 0 ? r.measures.filter((m) => m.verdict === "Yes").length / r.measures.length : 0,
      })).sort((a, b) => b.yesRate - a.yesRate);
      const n = perC.length;
      const topN = Math.max(1, Math.floor(n / 2));
      for (let i = 0; i < n; i++) {
        labels.push({ companyId: perC[i].companyId, isKnownDiscloser: i < topN });
      }
    }

    // 5. Compute per-company summaries.
    const perCompany = results.map((r) => {
      const yes = r.measures.filter((m) => m.verdict === "Yes").length;
      const no = r.measures.filter((m) => m.verdict === "No").length;
      const partial = r.measures.filter((m) => m.verdict === "Partial").length;
      const insufficient = r.measures.filter((m) => (m.verdict as string).toLowerCase().includes("insufficient")).length;
      return {
        companyId: r.companyId,
        companyName: r.companyName,
        yesCount: yes,
        noCount: no,
        partialCount: partial,
        insufficientCount: insufficient,
        totalMeasures: r.measures.length,
        yesRate: r.measures.length > 0 ? yes / r.measures.length : 0,
      };
    });

    // 6. Run flag analysis + 6 robustness criteria + edit proposals
    //    when scoring has completed and there are results.
    const scoringComplete = batch?.status === "completed" && results.length > 0;
    let report: any = null;
    let robustness: any = null;
    let edits: any = null;
    let rootCauses: any = null;
    if (scoringComplete) {
      report = analyseTestDrive(results, measureMetadata);
      robustness = computeRobustnessCriteria(results, measureMetadata, labels);
      edits = proposeEditsForFlags(report.flags || [], measuresById);

      // 6b. Compute per-company corpus stats + per-measure topic-rich coverage
      //     so we can separate doc-collection failures from framework issues.
      try {
        // Fetch framework topic terms for topic-mention detection.
        const fwRow = await db.execute(sql`
          SELECT topic_term, topic_synonyms FROM frameworks WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}
        `);
        const fwMeta = ((fwRow as any).rows || [])[0] || {};
        const topicTerm = String(fwMeta.topic_term || "").trim();
        const topicSynonyms = Array.isArray(fwMeta.topic_synonyms) ? fwMeta.topic_synonyms : [];
        const terms = [topicTerm, ...topicSynonyms].filter((t) => t && typeof t === "string" && t.length > 1);
        const termsLc = terms.map((t) => t.toLowerCase());

        // Pull document text via batch_corpus for this batch only. Batch_corpus
        // was populated by the analysis pipeline, so this is the exact set of
        // documents the LLM actually saw.
        const corpusRows = await db.execute(sql`
          SELECT bc.company_id, c.name AS company_name, d.id AS doc_id, d.type, d.title,
                 LENGTH(COALESCE(d.content, dc.content, '')) AS len,
                 COALESCE(d.content, dc.content, '') AS text
          FROM batch_corpus bc
          JOIN companies c ON c.id = bc.company_id
          JOIN documents d ON d.id = bc.document_id
          LEFT JOIN document_content dc ON dc.id = d.content_id
          WHERE bc.batch_id = ${batch.id}
        `);
        const perCompany: Record<string, CompanyCorpusStats> = {};
        for (const r of ((corpusRows as any).rows || [])) {
          const cid = Number(r.company_id);
          const key = String(cid);
          if (!perCompany[key]) {
            perCompany[key] = {
              companyId: cid,
              companyName: r.company_name,
              docCount: 0,
              totalChars: 0,
              pdfCount: 0,
              thematicReportCount: 0,
              topicTermMentions: 0,
              topicMentioningDocs: 0,
              yesCount: 0,
              totalMeasures: 0,
            };
          }
          const stats = perCompany[key];
          stats.docCount++;
          stats.totalChars += Number(r.len || 0);
          if (String(r.type || "").toLowerCase() === "pdf") stats.pdfCount++;
          const titleLc = String(r.title || "").toLowerCase();
          const isThematic =
            titleLc.includes("sustainability") ||
            titleLc.includes("tcfd") ||
            titleLc.includes("tnfd") ||
            titleLc.includes("esg report") ||
            titleLc.includes("climate report") ||
            titleLc.includes("nature report") ||
            (topicTerm && titleLc.includes(topicTerm.toLowerCase()));
          if (isThematic) stats.thematicReportCount++;
          // Topic mentions across doc text (case-insensitive).
          const textLc = String(r.text || "").toLowerCase();
          let docMentions = 0;
          for (const t of termsLc) {
            if (!t) continue;
            let idx = textLc.indexOf(t);
            while (idx !== -1) {
              docMentions++;
              idx = textLc.indexOf(t, idx + t.length);
            }
          }
          stats.topicTermMentions += docMentions;
          if (docMentions > 0) stats.topicMentioningDocs++;
        }
        // Populate yesCount from results.
        for (const r of results) {
          const key = String(r.companyId);
          if (perCompany[key]) {
            perCompany[key].yesCount = r.measures.filter((m) => m.verdict === "Yes").length;
            perCompany[key].totalMeasures = r.measures.length;
          }
        }

        // Build per-measure verdict lookup.
        const scoresByCM: Record<string, Record<string, string>> = {};
        for (const r of results) {
          const key = String(r.companyId);
          scoresByCM[key] = {};
          for (const m of r.measures) scoresByCM[key][m.measureId] = m.verdict;
        }
        const measureIds = measureMetadata.map((m: any) => m.measureId);

        rootCauses = diagnoseRootCauses(Object.values(perCompany), measureIds, scoresByCM);
      } catch (e: any) {
        console.warn("[framework-builder v2 /test-drive/results] root-cause diagnostic failed:", e?.message);
      }

      // Snapshot this batch's outputs (per-company, per-measure, robustness,
      // root-causes) into the iteration history table. Idempotent — already-
      // snapshotted batches are skipped by the UNIQUE(batch_id) check inside
      // snapshotIteration(). Then top up the latest row with robustness+rootCauses
      // that snapshotIteration doesn't compute itself.
      try {
        const snap = await snapshotIteration(frameworkId, listId, ctx.workspaceId);
        if (snap?.iterationNumber) {
          await db.execute(sql`
            UPDATE framework_v2_iterations
            SET robustness = ${JSON.stringify(robustness)}::jsonb,
                rootCauses = ${JSON.stringify(rootCauses)}::jsonb
            WHERE framework_id = ${frameworkId} AND list_id = ${listId}
              AND iteration_number = ${snap.iterationNumber}
          `);
        }
      } catch (e: any) {
        console.warn("[framework-builder v2 /test-drive/results] iteration snapshot failed:", e?.message);
      }
    }

    return res.json({
      batch: batch
        ? {
            status: batch.status,
            totalJobs: batch.total_jobs,
            completedJobs: batch.completed_jobs,
            failedJobs: batch.failed_jobs,
            startedAt: batch.started_at,
            completedAt: batch.completed_at,
          }
        : null,
      scoringComplete,
      perCompany,
      report,
      robustness,
      edits,
      rootCauses,
      labelsInferred,
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /test-drive/results] error:", err);
    return res.status(500).json({ error: err?.message || "internal error", stack: err?.stack });
  }
});

// ─── POST /v2/test-drive/analyse — analyse scored test-drive results ─────
// Caller passes company-level results already produced by the existing pipeline.
// This endpoint applies flag rules and returns a fix plan.

// ─── GET /v2/test-drive/measure-drill ── per-company evidence for one measure ─
// Given ?frameworkId=&listId=&measureId=, returns quotes/verdicts/nuance for
// every company in the list. Used by the Improvement Analysis panel to let the
// user audit surprising results in-place (Layer 1 audit).
router.get("/v2/test-drive/measure-drill", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });
    const frameworkId = Number(req.query.frameworkId);
    const listId = Number(req.query.listId);
    const measureId = String(req.query.measureId || "");
    if (!frameworkId || !listId || !measureId) {
      return res.status(400).json({ error: "frameworkId, listId, measureId query params required" });
    }
    const rowsQ = await db.execute(sql`
      SELECT c.name AS company_name, ms.verdict, ms.confidence, ms.quotes, ms.verdict_nuance
      FROM measure_scores ms
      JOIN companies c ON c.id = ms.company_id
      JOIN company_list_members clm ON clm.company_id = c.id AND clm.list_id = ${listId}
      WHERE ms.framework_id = ${frameworkId} AND ms.measure_id = ${measureId}
      ORDER BY ms.verdict, c.name
    `);
    const rows = ((rowsQ as any).rows || []).map((r: any) => ({
      companyName: r.company_name,
      verdict: r.verdict || "No",
      confidence: r.confidence || "Medium",
      quotes: Array.isArray(r.quotes) ? r.quotes : [],
      nuance: r.verdict_nuance || "",
    }));
    return res.json({ measureId, rows });
  } catch (err: any) {
    console.error("[framework-builder v2 /test-drive/measure-drill] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── Helper: snapshot the CURRENT test-drive results into iteration history ──
// Called when the user hits "Re-score now" (before creating a fresh batch) and
// when a batch completes for the first time (via /v2/test-drive/results if no
// snapshot exists for that batch yet). Idempotent — UNIQUE constraint on
// (framework_id, list_id, iteration_number) prevents duplicate rows.
async function snapshotIteration(
  frameworkId: number,
  listId: number,
  workspaceId: number,
): Promise<{ iterationNumber: number; created: boolean } | null> {
  // Pull the most recent COMPLETED batch for this framework+list. Running/failed
  // batches are skipped — their measure_scores are either absent or stale. This
  // guarantees the snapshot reflects data actually written by that batch.
  const batchRow = await db.execute(sql`
    SELECT id FROM batch_runs
    WHERE framework_id = ${frameworkId} AND list_id = ${listId} AND workspace_id = ${workspaceId}
      AND status = 'completed'
    ORDER BY completed_at DESC NULLS LAST, started_at DESC LIMIT 1
  `);
  const batchId = (batchRow as any).rows?.[0]?.id;
  if (!batchId) return null;

  // Get current iteration count (0 if none)
  const countRow = await db.execute(sql`
    SELECT COALESCE(MAX(iteration_number), 0) AS maxn FROM framework_v2_iterations
    WHERE framework_id = ${frameworkId} AND list_id = ${listId}
  `);
  const nextIter = Number((countRow as any).rows?.[0]?.maxn || 0) + 1;

  // Check whether this batch has already been snapshotted (idempotent)
  const existingRow = await db.execute(sql`
    SELECT iteration_number FROM framework_v2_iterations
    WHERE framework_id = ${frameworkId} AND list_id = ${listId} AND batch_id = ${batchId}
  `);
  if (((existingRow as any).rows || []).length > 0) {
    return { iterationNumber: Number((existingRow as any).rows[0].iteration_number), created: false };
  }

  // Compute per-company and per-measure summaries from measure_scores.
  const scoresQ = await db.execute(sql`
    SELECT ms.company_id, c.name AS company_name, ms.measure_id, ms.verdict
    FROM measure_scores ms JOIN companies c ON c.id = ms.company_id
    JOIN company_list_members clm ON clm.company_id = c.id AND clm.list_id = ${listId}
    WHERE ms.framework_id = ${frameworkId}
  `);
  const scoreRows = ((scoresQ as any).rows || []) as any[];

  const byCompany: Record<string, any> = {};
  const byMeasure: Record<string, { yesCount: number; totalCount: number; verdictsByCompany: Record<string, string> }> = {};
  for (const r of scoreRows) {
    const cid = String(r.company_id);
    if (!byCompany[cid]) byCompany[cid] = { companyId: r.company_id, companyName: r.company_name, yesCount: 0, noCount: 0, partialCount: 0, total: 0 };
    byCompany[cid].total++;
    if (r.verdict === "Yes") byCompany[cid].yesCount++;
    else if (r.verdict === "Partial") byCompany[cid].partialCount++;
    else byCompany[cid].noCount++;

    if (!byMeasure[r.measure_id]) byMeasure[r.measure_id] = { yesCount: 0, totalCount: 0, verdictsByCompany: {} };
    byMeasure[r.measure_id].totalCount++;
    if (r.verdict === "Yes") byMeasure[r.measure_id].yesCount++;
    byMeasure[r.measure_id].verdictsByCompany[cid] = r.verdict || "No";
  }
  const perCompany = Object.values(byCompany).map((c: any) => ({
    ...c,
    yesRate: c.total > 0 ? c.yesCount / c.total : 0,
  }));

  await db.execute(sql`
    INSERT INTO framework_v2_iterations
      (framework_id, list_id, batch_id, iteration_number, per_company, per_measure)
    VALUES
      (${frameworkId}, ${listId}, ${batchId}, ${nextIter},
       ${JSON.stringify(perCompany)}::jsonb, ${JSON.stringify(byMeasure)}::jsonb)
    ON CONFLICT (framework_id, list_id, iteration_number) DO NOTHING
  `);
  return { iterationNumber: nextIter, created: true };
}

// ─── GET /v2/iterations?frameworkId=&listId= ── iteration history ──
router.get("/v2/iterations", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });
    const frameworkId = Number(req.query.frameworkId);
    const listId = Number(req.query.listId);
    if (!frameworkId || !listId) return res.status(400).json({ error: "frameworkId + listId required" });

    // Best-effort: also snapshot the CURRENT batch if not already snapshotted.
    // This backfills iteration 1 automatically the first time the user views
    // the panel after scoring completed.
    try { await snapshotIteration(frameworkId, listId, ctx.workspaceId); } catch { /* non-fatal */ }

    const rows = await db.execute(sql`
      SELECT id, iteration_number, batch_id, scored_at, per_company, per_measure, robustness, rootCauses
      FROM framework_v2_iterations
      WHERE framework_id = ${frameworkId} AND list_id = ${listId}
      ORDER BY iteration_number ASC
    `);
    return res.json({
      iterations: ((rows as any).rows || []).map((r: any) => ({
        id: r.id,
        iterationNumber: r.iteration_number,
        batchId: r.batch_id,
        scoredAt: r.scored_at,
        perCompany: r.per_company,
        perMeasure: r.per_measure,
        robustness: r.robustness,
        rootCauses: r.rootcauses,
      })),
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /iterations] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/rescore ── fire fresh batch against the same list ──
// Iteration snapshots are created by /v2/test-drive/results the FIRST time it
// observes a completed batch — not here. Snapshotting at rescore-start would
// either duplicate the previous batch's row or create a stale row pointing to
// the new empty batch.
router.post("/v2/rescore", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });
    const { frameworkId, listId } = req.body as { frameworkId: number; listId: number };
    if (!frameworkId || !listId) return res.status(400).json({ error: "frameworkId + listId required" });

    // Ensure the current batch (about to be replaced in measure_scores) is
    // snapshotted first, if it hasn't been already. Idempotent — no-op if the
    // most-recent completed batch is already recorded as an iteration.
    const snap = await snapshotIteration(frameworkId, listId, ctx.workspaceId);

    // Fire a fresh analyze batch by calling the existing /api/analyze route
    //    server-side, forwarding session cookies so it authenticates as this user.
    //    This keeps the batch-creation logic in one place rather than duplicating it.
    const cookieHeader = req.headers.cookie || "";
    const port = process.env.PORT || "3000";
    const analyzeResp = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ frameworkId, listId }),
    });
    const analyzeJson = await analyzeResp.json().catch(() => ({}));
    if (!analyzeResp.ok) {
      return res.status(analyzeResp.status).json({ error: analyzeJson?.error || "analyze route rejected rescore" });
    }

    return res.json({
      snapshotted: snap,
      newBatchId: analyzeJson?.batchId,
      totalJobs: analyzeJson?.totalJobs,
      nextIterationNumberWhenComplete: (snap?.iterationNumber || 0) + 1,
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /rescore] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/state/save ── persist client state to the framework row ──
// Body: { frameworkId, stage, testDriveListId?, testDriveListName? }
// Writes to frameworks.v2_state as a JSONB blob. Enables cross-session /
// cross-browser resume via /v2/state/load and the frameworks list.
router.post("/v2/state/save", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });
    const { frameworkId, stage, testDriveListId, testDriveListName } = req.body as {
      frameworkId: number; stage: string; testDriveListId?: number; testDriveListName?: string;
    };
    if (!frameworkId || !stage) return res.status(400).json({ error: "frameworkId and stage required" });

    // MONOTONIC GUARD: never regress a framework's stage backwards. Stages
    // conceptually go intake -> drafting -> review -> saved. Once a framework
    // reaches 'saved', we do not accept writes that push it back to 'intake'
    // or earlier stages — those are almost always races on client mount where
    // a resuming tab's default state briefly is 'intake' before the load
    // response arrives. This protects the DB from stale-default clobbers.
    const STAGE_RANK: Record<string, number> = { intake: 0, drafting: 1, review: 2, saved: 3 };
    const existingRow = await db.execute(sql`
      SELECT v2_state FROM frameworks WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}
    `);
    const existing = (existingRow as any).rows?.[0]?.v2_state || null;
    const existingStage = existing?.stage || "intake";
    if ((STAGE_RANK[stage] ?? 0) < (STAGE_RANK[existingStage] ?? 0)) {
      // Regression request. Keep existing state; only update lastUpdated timestamp
      // and lists if the caller has better information for them.
      const merged = {
        stage: existingStage,
        testDriveListId: testDriveListId ?? existing?.testDriveListId ?? null,
        testDriveListName: testDriveListName ?? existing?.testDriveListName ?? null,
        lastUpdated: new Date().toISOString(),
      };
      await db.execute(sql`
        UPDATE frameworks SET v2_state = ${JSON.stringify(merged)}::jsonb
        WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}
      `);
      return res.json({ ok: true, state: merged, note: "stage regression rejected; existing stage preserved" });
    }

    const state = { stage, testDriveListId: testDriveListId ?? existing?.testDriveListId ?? null, testDriveListName: testDriveListName ?? existing?.testDriveListName ?? null, lastUpdated: new Date().toISOString() };
    await db.execute(sql`
      UPDATE frameworks SET v2_state = ${JSON.stringify(state)}::jsonb
      WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}
    `);
    return res.json({ ok: true, state });
  } catch (err: any) {
    console.error("[framework-builder v2 /state/save] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── GET /v2/state/load?frameworkId= ── restore a v2 draft's client state ──
router.get("/v2/state/load", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });
    const frameworkId = Number(req.query.frameworkId);
    if (!frameworkId) return res.status(400).json({ error: "frameworkId required" });
    const row = await db.execute(sql`
      SELECT id, name, builder_version, v2_state FROM frameworks
      WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}
    `);
    const r = ((row as any).rows || [])[0];
    if (!r) return res.status(404).json({ error: "framework not found" });
    return res.json({
      frameworkId: r.id,
      frameworkName: r.name,
      builderVersion: r.builder_version,
      state: r.v2_state || null,
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /state/load] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── GET /v2/state/list ── list v2 frameworks + their most-recent state ──
// Used by the Framework page to show a 'Continue in v2 builder' entry for
// any framework that has resumable state.
router.get("/v2/state/list", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });
    const rows = await db.execute(sql`
      SELECT id, name, v2_state, updated_at, created_at FROM frameworks
      WHERE workspace_id = ${ctx.workspaceId} AND builder_version = 'v2'
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
    `);
    return res.json({
      frameworks: ((rows as any).rows || []).map((r: any) => ({
        frameworkId: r.id,
        frameworkName: r.name,
        state: r.v2_state || null,
        updatedAt: r.updated_at || r.created_at,
      })),
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /state/list] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/improvement/chat ── Stage 2 chat with LLM about improvements ──
interface ImprovementChatBody {
  frameworkId: number;
  listId: number;
  messages: ImprovementChatMessage[];
  providerName?: string;
}
router.post("/v2/improvement/chat", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });
    const { frameworkId, listId, messages, providerName } = req.body as ImprovementChatBody;
    if (!frameworkId || !listId || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "frameworkId, listId, messages[] required" });
    }

    // Rebuild the same analysis the results endpoint produced, so the LLM
    // sees the identical data the user is looking at on the panel.
    const resultsUrl = new URL(`http://internal/api/framework-builder/v2/test-drive/results?frameworkId=${frameworkId}&listId=${listId}`);
    // Rather than round-trip, call the shared computation inline. Simplest
    // path: fetch the pieces here (some duplication of the results endpoint
    // is acceptable; this keeps the chat endpoint self-contained).
    const fwRow = await db.execute(sql`SELECT name, topic_term FROM frameworks WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}`);
    const fwMeta = ((fwRow as any).rows || [])[0] || {};

    const scoresQuery = await db.execute(sql`
      SELECT ms.company_id, c.name AS company_name, ms.measure_id, ms.verdict
      FROM measure_scores ms
      JOIN companies c ON c.id = ms.company_id
      JOIN company_list_members clm ON clm.company_id = c.id AND clm.list_id = ${listId}
      WHERE ms.framework_id = ${frameworkId}
    `);
    const scoreRows = ((scoresQuery as any).rows || []) as any[];
    const byCompany: Record<string, { companyId: number; companyName: string; measures: any[] }> = {};
    for (const r of scoreRows) {
      const k = String(r.company_id);
      if (!byCompany[k]) byCompany[k] = { companyId: r.company_id, companyName: r.company_name, measures: [] };
      byCompany[k].measures.push({ measureId: r.measure_id, verdict: r.verdict || "No" });
    }
    const results = Object.values(byCompany);
    const perCompanySummary = results.map((r) => {
      const yes = r.measures.filter((m: any) => m.verdict === "Yes").length;
      return { companyName: r.companyName, yesCount: yes, yesRate: r.measures.length ? yes / r.measures.length : 0 };
    });

    // Reload measure metadata for edit proposals.
    const measureMetaQuery = await db.execute(sql`
      SELECT measure_id, expected_yes_rate, title, substantive_definition, fallback_yes_criterion,
             positive_examples, negative_examples, min_quote_context_chars
      FROM framework_measures WHERE framework_id = ${frameworkId}
    `);
    const measureRows = ((measureMetaQuery as any).rows || []) as any[];
    const measureMetadata = measureRows.map((m: any) => ({
      measureId: m.measure_id,
      expected_yes_rate: typeof m.expected_yes_rate === "number" ? m.expected_yes_rate : 0.35,
    }));
    const measuresById: Record<string, any> = {};
    for (const m of measureRows) measuresById[m.measure_id] = m;

    // Recompute flag report + edit proposals.
    const report = analyseTestDrive(results as any, measureMetadata);
    const editsBundle = proposeEditsForFlags(report.flags || [], measuresById);

    // Recompute root causes.
    const batchRow = await db.execute(sql`
      SELECT id FROM batch_runs WHERE framework_id = ${frameworkId} AND list_id = ${listId} AND workspace_id = ${ctx.workspaceId}
      ORDER BY started_at DESC LIMIT 1
    `);
    const batchId = (batchRow as any).rows?.[0]?.id;
    let rootCauses;
    if (batchId) {
      const topicRow = await db.execute(sql`SELECT topic_synonyms FROM frameworks WHERE id = ${frameworkId}`);
      const topicSynonyms = ((topicRow as any).rows?.[0]?.topic_synonyms) || [];
      const termsLc = [String(fwMeta.topic_term || "").toLowerCase(), ...topicSynonyms.map((s: string) => s.toLowerCase())].filter(Boolean);
      const corpusRows = await db.execute(sql`
        SELECT bc.company_id, c.name AS company_name, d.type, d.title,
               LENGTH(COALESCE(d.content, dc.content, '')) AS len,
               COALESCE(d.content, dc.content, '') AS text
        FROM batch_corpus bc JOIN companies c ON c.id = bc.company_id
        JOIN documents d ON d.id = bc.document_id
        LEFT JOIN document_content dc ON dc.id = d.content_id
        WHERE bc.batch_id = ${batchId}
      `);
      const perCompStats: Record<string, CompanyCorpusStats> = {};
      for (const r of ((corpusRows as any).rows || [])) {
        const cid = Number(r.company_id); const k = String(cid);
        if (!perCompStats[k]) perCompStats[k] = { companyId: cid, companyName: r.company_name, docCount: 0, totalChars: 0, pdfCount: 0, thematicReportCount: 0, topicTermMentions: 0, topicMentioningDocs: 0, yesCount: 0, totalMeasures: 0 };
        const s = perCompStats[k]; s.docCount++; s.totalChars += Number(r.len || 0);
        if (String(r.type || "").toLowerCase() === "pdf") s.pdfCount++;
        const titleLc = String(r.title || "").toLowerCase();
        if (titleLc.includes("sustainability") || titleLc.includes("tnfd") || titleLc.includes("tcfd") || titleLc.includes("esg report") || titleLc.includes("nature report")) s.thematicReportCount++;
        const textLc = String(r.text || "").toLowerCase(); let docMentions = 0;
        for (const t of termsLc) { let i = textLc.indexOf(t); while (i !== -1) { docMentions++; i = textLc.indexOf(t, i + t.length); } }
        s.topicTermMentions += docMentions; if (docMentions > 0) s.topicMentioningDocs++;
      }
      for (const r of results) {
        const k = String(r.companyId);
        if (perCompStats[k]) { perCompStats[k].yesCount = r.measures.filter((m: any) => m.verdict === "Yes").length; perCompStats[k].totalMeasures = r.measures.length; }
      }
      const scoresByCM: Record<string, Record<string, string>> = {};
      for (const r of results) { const k = String(r.companyId); scoresByCM[k] = {}; for (const m of r.measures) scoresByCM[k][m.measureId] = m.verdict; }
      rootCauses = diagnoseRootCauses(Object.values(perCompStats), measureMetadata.map((m: any) => m.measureId), scoresByCM);
    }

    if (!rootCauses) return res.status(500).json({ error: "could not build root-cause context" });

    const chatCtx: ImprovementChatContext = {
      frameworkName: fwMeta.name,
      topicTerm: fwMeta.topic_term,
      perCompanySummary,
      rootCauses,
      flags: report.flags || [],
      proposals: editsBundle.proposals,
      passedRobustnessCriteria: 0,
      totalRobustnessCriteria: 6,
    };

    const system = buildImprovementChatSystemPrompt(chatCtx);
    const history = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const { completeWithFallback } = await import("../lib/ai-providers.js");
    // Chat is a long-form consultation — use the widest allowable output window
    // (32K on Claude Sonnet). The provider clamps further if needed. The full
    // conversation is passed each turn so the LLM sees the entire back-and-forth,
    // not just a truncated window.
    const { text: reply } = await completeWithFallback(providerName || "claude", {
      system,
      prompt: history + "\n\nAssistant:",
      maxTokens: 32000,
      temperature: 0.2,
    });
    const { displayText, actions } = extractActionsFromReply(reply);
    return res.json({ reply: displayText, actions, proposalCount: editsBundle.proposals.length });
  } catch (err: any) {
    console.error("[framework-builder v2 /improvement/chat] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/improvement/apply ── apply structured actions to the framework ──
interface ImprovementApplyBody {
  frameworkId: number;
  listId: number;
  actions: Array<{ type: string; attrs: Record<string, string> }>;
}
router.post("/v2/improvement/apply", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });
    const { frameworkId, listId, actions } = req.body as ImprovementApplyBody;
    if (!frameworkId || !Array.isArray(actions)) {
      return res.status(400).json({ error: "frameworkId and actions[] required" });
    }

    // Re-derive proposals (same data the chat endpoint saw) so we can resolve
    // P1/P2/P3 references to actual EditProposal objects.
    const scoresQuery = await db.execute(sql`
      SELECT ms.company_id, c.name AS company_name, ms.measure_id, ms.verdict
      FROM measure_scores ms JOIN companies c ON c.id = ms.company_id
      JOIN company_list_members clm ON clm.company_id = c.id AND clm.list_id = ${listId}
      WHERE ms.framework_id = ${frameworkId}
    `);
    const scoreRows = ((scoresQuery as any).rows || []) as any[];
    const byCompany: Record<string, any> = {};
    for (const r of scoreRows) {
      const k = String(r.company_id);
      if (!byCompany[k]) byCompany[k] = { companyId: r.company_id, companyName: r.company_name, measures: [] };
      byCompany[k].measures.push({ measureId: r.measure_id, verdict: r.verdict || "No" });
    }
    const results = Object.values(byCompany) as any[];
    const measureMetaQuery = await db.execute(sql`
      SELECT measure_id, expected_yes_rate, substantive_definition, fallback_yes_criterion,
             positive_examples, negative_examples, min_quote_context_chars
      FROM framework_measures WHERE framework_id = ${frameworkId}
    `);
    const measureRows = ((measureMetaQuery as any).rows || []) as any[];
    const measureMetadata = measureRows.map((m: any) => ({ measureId: m.measure_id, expected_yes_rate: typeof m.expected_yes_rate === "number" ? m.expected_yes_rate : 0.35 }));
    const measuresById: Record<string, any> = {};
    for (const m of measureRows) measuresById[m.measure_id] = m;
    const report = analyseTestDrive(results as any, measureMetadata);
    const editsBundle = proposeEditsForFlags(report.flags || [], measuresById);

    // Collect proposals we need LLM regeneration for, then run one batched
    // regeneration call per (op, path) group. This preserves consistency
    // across measures AND keeps latency O(1) rather than O(N).
    async function applyProposal(prop: any, applied: any[], skipped: any[]) {
      if (prop.patch?.op === "replace") {
        const col = prop.patch.path === "fallback_yes_criterion" ? sql`fallback_yes_criterion` :
                    prop.patch.path === "min_quote_context_chars" ? sql`min_quote_context_chars` : null;
        if (!col) { skipped.push({ measureId: prop.measureId, reason: `unsupported patch path ${prop.patch.path}` }); return; }
        await db.execute(sql`
          UPDATE framework_measures SET ${col} = ${prop.patch.value}
          WHERE framework_id = ${frameworkId} AND measure_id = ${prop.measureId}
        `);
        applied.push({ measureId: prop.measureId, action: prop.action, patch: prop.patch });
      } else {
        // LLM regeneration paths get grouped into batches; caller processes them.
      }
    }

    async function runBatchedRegenerations(proposals: any[], applied: any[], skipped: any[]) {
      if (!proposals.length) return;
      const groups = groupProposalsByPatch(proposals);
      // Load framework topic context for the LLM.
      const fwRow = await db.execute(sql`
        SELECT name, topic_term, topic_synonyms, adjacent_topics FROM frameworks
        WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}
      `);
      const fw = ((fwRow as any).rows || [])[0] || {};
      const fctx: FrameworkContext = {
        topicTerm: fw.topic_term || "",
        topicSynonyms: Array.isArray(fw.topic_synonyms) ? fw.topic_synonyms : [],
        adjacentTopics: Array.isArray(fw.adjacent_topics) ? fw.adjacent_topics : [],
        frameworkName: fw.name || "",
      };
      for (const [groupKey, groupProps] of Object.entries(groups)) {
        const measureIds = groupProps.map((p: any) => p.measureId);
        // Fetch current measures for the LLM context. Drizzle's sql`` template
        // treats JS arrays as records unless we serialise to a Postgres-array
        // literal or unroll. Simplest: fetch all measures and filter in JS.
        const measureIdSet = new Set(measureIds);
        const allMeasuresQ = await db.execute(sql`
          SELECT measure_id, title, substantive_definition, fallback_yes_criterion,
                 positive_examples, negative_examples
          FROM framework_measures
          WHERE framework_id = ${frameworkId}
        `);
        const measureRowsQ = { rows: ((allMeasuresQ as any).rows || []).filter((m: any) => measureIdSet.has(m.measure_id)) };
        const measuresForLLM: MeasureBefore[] = ((measureRowsQ as any).rows || []).map((m: any) => ({
          measureId: m.measure_id,
          title: m.title,
          substantive_definition: m.substantive_definition || "",
          fallback_yes_criterion: m.fallback_yes_criterion || "",
          positive_examples: Array.isArray(m.positive_examples) ? m.positive_examples : [],
          negative_examples: Array.isArray(m.negative_examples) ? m.negative_examples : [],
        }));

        let result: { updates: any[]; provider: string } | null = null;
        try {
          if (groupKey === "tighten_definition::substantive_definition") {
            result = await batchTightenDefinitions(measuresForLLM, fctx);
          } else if (groupKey === "append_exclusion::substantive_definition") {
            result = await batchAppendExclusions(measuresForLLM, fctx);
          } else if (groupKey === "regenerate_examples::positive_examples") {
            result = await batchRegenerateExamples(measuresForLLM, fctx, "positive");
          } else if (groupKey === "regenerate_examples::negative_examples") {
            result = await batchRegenerateExamples(measuresForLLM, fctx, "negative");
          } else {
            for (const p of groupProps) skipped.push({ measureId: p.measureId, reason: `no regenerator for group '${groupKey}'` });
            continue;
          }
        } catch (e: any) {
          for (const p of groupProps) skipped.push({ measureId: p.measureId, reason: `LLM regeneration failed: ${e?.message || e}` });
          continue;
        }

        if (!result || !result.updates || !result.updates.length) {
          for (const p of groupProps) skipped.push({ measureId: p.measureId, reason: "LLM returned no updates" });
          continue;
        }
        for (const u of result.updates) {
          // Persist each field the LLM produced
          if (u.substantive_definition) {
            await db.execute(sql`
              UPDATE framework_measures SET substantive_definition = ${u.substantive_definition}
              WHERE framework_id = ${frameworkId} AND measure_id = ${u.measureId}
            `);
          }
          if (Array.isArray(u.positive_examples) && u.positive_examples.length) {
            await db.execute(sql`
              UPDATE framework_measures SET positive_examples = ${JSON.stringify(u.positive_examples)}::jsonb
              WHERE framework_id = ${frameworkId} AND measure_id = ${u.measureId}
            `);
          }
          if (Array.isArray(u.negative_examples) && u.negative_examples.length) {
            await db.execute(sql`
              UPDATE framework_measures SET negative_examples = ${JSON.stringify(u.negative_examples)}::jsonb
              WHERE framework_id = ${frameworkId} AND measure_id = ${u.measureId}
            `);
          }
          applied.push({ measureId: u.measureId, action: `regenerated:${groupKey}`, source: "llm" });
        }
        // Any group proposal without a returned update:
        const returnedIds = new Set(result.updates.map((u: any) => u.measureId));
        for (const p of groupProps) {
          if (!returnedIds.has(p.measureId)) skipped.push({ measureId: p.measureId, reason: "LLM did not return update for this measureId" });
        }
      }
    }

    // Walk actions and apply.
    const applied: any[] = [];
    const skipped: any[] = [];
    const deferredForLLM: any[] = [];
    for (const action of actions) {
      if (action.type === "apply_edit") {
        const idx = parseInt(String(action.attrs.proposal || "").replace(/^P/, ""), 10) - 1;
        const prop = editsBundle.proposals[idx];
        if (!prop) { skipped.push({ action, reason: "proposal not found" }); continue; }
        if (prop.patch?.op === "replace") {
          await applyProposal(prop, applied, skipped);
        } else {
          deferredForLLM.push(prop);
        }
      } else if (action.type === "ignore_measure") {
        // No-op on framework; record for audit only.
        applied.push({ measureId: action.attrs.measure, action: "ignore", reason: action.attrs.reason });
      } else if (action.type === "rescore_now") {
        // Trigger fresh scoring via the existing /analyze route contract.
        // Client will re-navigate; server just acknowledges.
        applied.push({ action: "rescore" });
      } else if (action.type === "escalate_to_corpus") {
        applied.push({ company: action.attrs.company, action: "corpus-escalated", note: "marked for retrieval fix, not framework edit" });
      } else if (action.type === "apply_all_by_cause") {
        const cause = action.attrs.cause;
        const matching = editsBundle.proposals.filter((p) => p.cause === cause);
        for (const prop of matching) {
          if (prop.patch?.op === "replace") await applyProposal(prop, applied, skipped);
          else deferredForLLM.push(prop);
        }
      } else {
        skipped.push({ action, reason: `unknown action type '${action.type}'` });
      }
    }

    // Run batched LLM regeneration for any deferred proposals.
    await runBatchedRegenerations(deferredForLLM, applied, skipped);

    return res.json({ applied, skipped, appliedCount: applied.length, skippedCount: skipped.length });
  } catch (err: any) {
    console.error("[framework-builder v2 /improvement/apply] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

router.post("/v2/test-drive/analyse", async (req: Request, res: Response) => {
  try {
    const { results, measureMetadata } = req.body as {
      results: TestDriveCompanyResult[];
      measureMetadata: Array<{ measureId: string; expected_yes_rate?: number }>;
    };
    if (!Array.isArray(results) || !Array.isArray(measureMetadata)) {
      return res.status(400).json({ error: "results and measureMetadata arrays required" });
    }
    const report = analyseTestDrive(results, measureMetadata);
    return res.json({ report });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/export-seed — export an existing framework as build seed ───

router.post("/v2/export-seed", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const { frameworkId } = req.body as { frameworkId: number };
    if (!frameworkId) return res.status(400).json({ error: "frameworkId required" });

    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });

    const fw = await storage.getFrameworkById(frameworkId, ctx.workspaceId);
    if (!fw) {
      return res.status(404).json({ error: "framework not found" });
    }
    const measures = await storage.getFrameworkMeasures(frameworkId);
    const input: ExistingFrameworkForExport = {
      framework: fw as any,
      measures: measures as any,
    };
    const template = exportFrameworkAsSeedTemplate(input);
    return res.json({ template });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────

function flattenMeasures(draft: any): any[] {
  const out: any[] = [];
  const cats = Array.isArray(draft?.categories) ? draft.categories : [];
  for (const c of cats) {
    const ms = Array.isArray(c?.measures) ? c.measures : [];
    for (const m of ms) out.push(m);
  }
  return out;
}

export default router;
