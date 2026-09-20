/**
 * Framework Creation v2 — REST endpoints
 *
 * Mounted at /api/framework-builder/v2/* alongside the existing v1 route.
 * v1 is left completely untouched during rollout.
 */

import { Router, Request, Response } from "express";
import { requireWorkspace, getSessionContext } from "../middleware/auth.js";
import { validateAll, summariseViolations, toStructuredIssues, renderStructuredIssues, evaluateAcceptanceGate, type FrameworkDraft, type StructuredIssue } from "../lib/framework-v2/rules.js";
import { analyzeEvidenceKeywordDistinctiveness } from "../lib/framework-v2/evidence-keyword-distinctiveness.js";
import { evaluateRobustness, type IntakeArtefact } from "../lib/framework-v2/robustness-gate.js";
import { INTAKE_SYSTEM_PROMPT, DRAFTING_SYSTEM_PROMPT_HEAD, CHUNKED_SKELETON_SYSTEM_PROMPT, CHUNKED_MEASURES_SYSTEM_PROMPT } from "../lib/framework-v2/intake-prompt.js";
import { resolveTargetCount } from "../lib/framework-v2/target-count.js";
import { sanitizeSearchTemplates } from "../lib/framework-v2/query-template-hygiene.js";
import { exportFrameworkAsSeedTemplate, type ExistingFrameworkForExport } from "../lib/framework-v2/export-as-seed.js";
import { exportFrameworkAsFullDetail } from "../lib/framework-v2/export-as-full.js";
import { analyseTestDrive, buildSampleSelectionPrompt, computeFlipStats, buildSparseCorpusFlag, type TestDriveCompanyResult, type TestDriveSampleRequest, type MultiRunIteration, type SparseCompanySignal } from "../lib/framework-v2/test-drive.js";
import { computeRobustnessCriteria, type CompanyLabel } from "../lib/framework-v2/robustness-criteria.js";
import { proposeEditsForFlags, proposeMergeForNearDuplicate, FRAMEWORK_LEVEL_OPS, DIRECT_MEASURE_OPS, FRAMEWORK_SENTINEL } from "../lib/framework-v2/edit-proposer.js";
import { computeQualityMetrics, coherenceGateMetrics, type MeasureSpecFields, type QualityMetricsReport } from "../lib/framework-v2/quality-metrics.js";
import { diagnoseRootCauses, type CompanyCorpusStats, type RootCauseReport } from "../lib/framework-v2/root-cause-diagnostic.js";
import { buildImprovementChatSystemPrompt, extractActionsFromReply, type ImprovementChatContext, type ImprovementChatMessage } from "../lib/framework-v2/improvement-chat.js";
import { groupProposalsByPatch, BATCH_REGENERATORS, differentiateMeasureDefinition, regenerateMeasureField, CUSTOM_EDIT_FIELDS, type CustomEditField, type CustomEditMeasure, type FrameworkContext, type MeasureBefore } from "../lib/framework-v2/edit-applier.js";
import { mergeStructuredIntoScoringGuidance } from "../lib/framework-v2/structured-guidance.js";
import { mergeCorrectedMeasure } from "../lib/framework-v2/merge-corrected-measure.js";
import { runTruthCheck, type TruthCheckResult } from "../lib/framework-v2/truth-check.js";
import { recordMeasureEdit } from "../lib/framework-v2/measure-audit.js";
import { resolveProposalByIdentity } from "../lib/framework-v2/proposal-identity.js";
import { pickEffectiveBatch } from "../lib/framework-v2/effective-batch.js";
import { deriveProposalBundle } from "../lib/framework-v2/derive-proposal-bundle.js";
import { buildDiagnosticReport, type DiagnosticMeasure, type StoredCell, type DiagnosticReport } from "../lib/measure-design-diagnostic.js";
import * as storage from "../storage.js";
import { db } from "../db.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { jsonrepair } from "jsonrepair";

const router = Router();

// ─── POST /v2/chat — intake conversation ─────────────────────────────────
// Runs one turn of the v2 intake conversation. The client passes the
// conversation history so far; the server returns the next assistant message
// plus the current robustness-gate state.

// ─── POST /v2/extract-pdf — extract text from an attached PDF ──────────────
// The FB v2 chat box lets the user attach reference files. Text-like files
// (csv/txt/md/json) are read client-side; PDFs are sent here as base64 and
// parsed server-side with pdf-parse (already a dependency), returning plain
// text the client folds into its chat message. Extraction only — no LLM call.
router.post("/v2/extract-pdf", async (req: Request, res: Response) => {
  try {
    const { base64, filename } = req.body as { base64?: string; filename?: string };
    if (!base64 || typeof base64 !== "string") {
      return res.status(400).json({ error: "base64 PDF content required" });
    }
    const buffer = Buffer.from(base64, "base64");
    // pdf-parse ships no type declarations (same as processor.ts / framework-builder.ts v1)
    // @ts-ignore
    const { default: pdfParse } = await import("pdf-parse");
    const data = await pdfParse(buffer);
    const text = (data?.text || "").trim();
    return res.json({ text, pages: data?.numpages ?? null, filename: filename || null });
  } catch (err: any) {
    console.error("[framework-builder v2 /extract-pdf] error:", err);
    return res.status(500).json({ error: `Could not extract PDF text: ${err?.message || String(err)}` });
  }
});

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

    // Route onto Claude's streaming path (>20000 => streaming) which handles large
    // conversational outputs; the final intake turn for a seeded framework can be
    // large. allowTruncated makes truncation on this CONVERSATIONAL path degrade
    // gracefully (return partial text) instead of throwing and cascading through
    // every fallback provider until the client aborts. Drafting/scoring stay fail-loud.
    const intakeCallStart = Date.now();
    const intakeResp = await completeWithFallback(providerName || "claude", {
      system: INTAKE_SYSTEM_PROMPT + gateContext,
      prompt: history,
      maxTokens: 32000,
      temperature: 0.2,
      allowTruncated: true,
    });
    const { text: response } = intakeResp;
    // [fb2-telemetry] Lightweight intake-path record. Log-only (not persisted):
    // this is the CONVERSATIONAL path where a truncation degrades gracefully, so
    // one compact line per turn is enough to spot provider/token/latency issues
    // without changing any behaviour.
    try {
      const m = (intakeResp as any).meta ?? null;
      console.log("[fb2-telemetry] intake", JSON.stringify({
        provider: (intakeResp as any).provider ?? null,
        elapsedMs: Date.now() - intakeCallStart,
        inputTokens: m?.inputTokens ?? null,
        outputTokens: m?.outputTokens ?? null,
        finishReason: m?.finishReason ?? null,
        truncated: m ? Boolean(m.truncated) : null,
        semaphoreWaitMs: m?.semaphoreWaitMs ?? null,
        messages: Array.isArray(messages) ? messages.length : null,
      }));
    } catch { /* telemetry must never break intake */ }

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
    negativeKeywords: (Array.isArray(draft.framework?.negativeKeywords) ? draft.framework.negativeKeywords : null) || intake.negativeKeywords,
    antiInferenceRules: (Array.isArray(draft.framework?.antiInferenceRules) ? draft.framework.antiInferenceRules : null) || intake.antiInferenceRules,
    measures,
  };
}

// Threshold above which we switch to chunked drafting to avoid Claude's
// per-call output-token ceiling. Configurable via env for tuning.
// Chunk-drafting threshold. Set conservatively: single-shot drafting at 24K
// output tokens truncates around ~16 rich (C1–C11) measures, so single-shot
// must be reserved for genuinely SMALL frameworks. Anything above this — OR any
// framework whose target size can't be resolved — is routed to the robust
// chunked path. Env-overridable for tuning.
const CHUNKED_DRAFT_THRESHOLD = Number(process.env.FRAMEWORK_V2_CHUNK_THRESHOLD || 12);
// Max measures expanded per chunked sub-call. Large categories are split into
// batches of this size so no single expansion call approaches the token cap.
const CHUNK_MEASURES_PER_CALL = Number(process.env.FRAMEWORK_V2_MEASURES_PER_CALL || 8);

// C11 repair instruction, mirrored from CHUNKED_MEASURES_SYSTEM_PROMPT so repair
// passes target the degree-word class of error that the initial-draft prompts
// already forbid. Kept here (not imported) so the two prompt families can drift
// independently if needed.
const C11_REPAIR_CLAUSE =
  `C11 (decidability): Every Yes-condition in fallback_yes_criterion (and any decision text in ` +
  `scoringGuidance / substantive_definition) must be DECIDABLE from a verbatim quote. A degree/holistic ` +
  `word (substantive, substantially, systematic, integrated, integration, sufficient, robust, meaningful, ` +
  `adequate, appropriate, comprehensive, holistic, effective, strong, well-developed) may NOT be the deciding ` +
  `test — it is not decidable from a quote and causes run-to-run verdict flips. Where a violation flags such a ` +
  `word, rewrite the offending condition/field as an explicit N-of-M test over NAMED, quote-verifiable ` +
  `artefacts: "Yes if at least N of the following NAMED artefacts are present in a verbatim quote: (a) ..., ` +
  `(b) ..., (c) ...", where each artefact is individually checkable from the quote.`;

// Robust JSON extractor + parser used across all drafting phases. Handles
// fenced ```json blocks, bare JSON, and truncation-recovery.
// Recovers a JSON OBJECT from a candidate string, tolerating fallback providers
// (e.g. openrouter/DeepSeek) that return DOUBLE-ESCAPED / stringified JSON —
// text literally starting with backslash-n / backslash-quote, or a JSON string
// literal that wraps the real object. Returns the parsed object, or null if none
// of the strategies yield an object.
function tryParseDraftObject(candidate: string): any | null {
  // Strategy 1: direct parse. If it yields a string (the payload was a JSON
  // string literal), parse that string once more to reach the object.
  try {
    const v = JSON.parse(candidate);
    if (v && typeof v === "object") return v;
    if (typeof v === "string") {
      try {
        const v2 = JSON.parse(v);
        if (v2 && typeof v2 === "object") return v2;
      } catch { /* fall through */ }
    }
  } catch { /* fall through */ }
  // Strategy 2: the candidate is escaped one level (literal \n, \" etc.) but was
  // NOT wrapped in quotes. Wrap it in quotes and parse to unescape one level,
  // then parse the unescaped string into the object.
  try {
    const unescaped = JSON.parse('"' + candidate.trim() + '"');
    if (typeof unescaped === "string") {
      const v = JSON.parse(unescaped);
      if (v && typeof v === "object") return v;
    }
  } catch { /* fall through */ }
  return null;
}

function parseDraftJson(response: string): { ok: true; draft: any } | { ok: false; error: string; recovered?: boolean; raw?: string } {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) || response.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : response;
  try {
    return { ok: true, draft: JSON.parse(candidate) };
  } catch (e: any) {
    // Defense-in-depth: recover double-escaped / stringified JSON returned by
    // fallback providers before treating this as an unrecoverable parse failure.
    const recoveredObj = tryParseDraftObject(candidate);
    if (recoveredObj) {
      return { ok: true, draft: recoveredObj };
    }
    const salvaged = trySalvageTruncatedFramework(candidate);
    if (salvaged) {
      (salvaged as any).__truncationRecovered = true;
      return { ok: true, draft: salvaged };
    }
    // LAST-RESORT safety net: structurally repair malformed JSON via jsonrepair.
    // Only reached after standard JSON.parse, escaped-JSON recovery, and truncation
    // salvage have all failed. Fail-LOUD: a successful repair is logged as a WARNING
    // so it is visible in Railway logs — the raw LLM output was malformed/truncated
    // and the recovered measures may be incomplete.
    try {
      const repaired = JSON.parse(jsonrepair(candidate));
      if (repaired && typeof repaired === "object") {
        console.warn("[framework-builder v2] WARNING: recovered draft JSON via jsonrepair — the raw LLM output was malformed/truncated; this category's measures may be incomplete. Investigate provider truncation.");
        return { ok: true, draft: repaired };
      }
    } catch { /* jsonrepair could not recover — fall through to the failure path */ }
    const looksTruncated = response.trim().length > 20000 && !response.trim().endsWith("}") && !response.trim().endsWith("```");
    const err = looksTruncated
      ? `The framework was too large for the model's output limit and got cut off (${response.length} chars generated). Try a smaller target measure count.`
      : `Could not parse framework JSON from LLM response: ${e?.message || e}`;
    return { ok: false, error: err, raw: response };
  }
}

// ─── Chunked drafting: skeleton + per-category batches in parallel ───────

// [fb2-telemetry] Build the compact run summary from the per-category results.
// Pure reduction over data already collected — no control-flow impact. Kept
// defensive (never throws) because it runs inside a tRec() swallow-wrapper.
function buildTelemetrySummary(categoryResults: any[], outcome: string): any {
  const cats = Array.isArray(categoryResults) ? categoryResults : [];
  const failedCategoryNames = cats.filter((r: any) => r?.failed).map((r: any) => r?.categoryName);
  const skippedCategoryNames = cats.filter((r: any) => r?.skipped).map((r: any) => r?.categoryName);
  const emptyCategoryNames = cats
    .filter((r: any) => !r?.failed && !r?.skipped && (!Array.isArray(r?.measures) || r.measures.length === 0))
    .map((r: any) => r?.categoryName);
  const totalMeasures = cats.reduce((s: number, r: any) => s + (Array.isArray(r?.measures) ? r.measures.length : 0), 0);
  return {
    outcome,
    totalCategories: cats.length,
    totalMeasures,
    failedCategoryCount: failedCategoryNames.length,
    skippedCategoryCount: skippedCategoryNames.length,
    emptyCategoryCount: emptyCategoryNames.length,
    failedCategoryNames,
    skippedCategoryNames,
    emptyCategoryNames,
  };
}

async function callChunkedDraftingLLM(intake: IntakeArtefact, providerName?: string, resolvedTarget?: number): Promise<{ draft: any; truncationRecovered: boolean; provider?: string; telemetry?: any } | { error: string; raw?: string; telemetry?: any }> {
  const { completeWithFallback } = await import("../lib/ai-providers.js");

  // [fb2-telemetry] Diagnostic-first sidecar accumulator. Instrumentation ONLY:
  // it records what each LLM call did; it never changes control flow, retry
  // counts, thresholds, parallelism, or the failed/skipped decision logic. Every
  // write is wrapped so a telemetry error is swallowed and never breaks the draft.
  const runStart = Date.now();
  const telemetry: any = {
    version: 1,
    startedAt: new Date(runStart).toISOString(),
    resolvedTarget: resolvedTarget ?? null,
    skeleton: null as any,
    categories: [] as any[],
    summary: null as any,
  };
  const tRec = (fn: () => void) => { try { fn(); } catch { /* telemetry must never break the draft */ } };

  // Wire the RESOLVED (normalised integer) target into the intake copy the
  // skeleton sees, so the skeleton distributes the right number of measures
  // across categories even when the raw intake field was a range/label string.
  const skeletonIntake =
    typeof resolvedTarget === "number"
      ? { ...(intake as any), targetMeasureCount: resolvedTarget }
      : intake;

  // Phase 1: skeleton (framework metadata + category outlines).
  const skeletonPrompt = `Intake artefact (JSON):\n${JSON.stringify(skeletonIntake, null, 2)}\n\nProduce the framework skeleton now.`;
  const skeletonStart = Date.now();
  const skeletonResp = await completeWithFallback(providerName || "claude", {
    system: CHUNKED_SKELETON_SYSTEM_PROMPT,
    prompt: skeletonPrompt,
    maxTokens: 6000,
    temperature: 0.2,
    json: true,
  });
  const skeletonElapsedMs = Date.now() - skeletonStart;
  const skeletonParsed = parseDraftJson(skeletonResp.text);
  if (!skeletonParsed.ok) {
    tRec(() => {
      telemetry.skeleton = {
        provider: (skeletonResp as any).provider ?? null,
        elapsedMs: skeletonElapsedMs,
        meta: (skeletonResp as any).meta ?? null,
        parsed: false,
        parseError: skeletonParsed.error,
        categoriesProduced: 0,
      };
      telemetry.summary = { failedPhase: "skeleton", elapsedMs: Date.now() - runStart };
    });
    return { error: `Skeleton phase failed: ${skeletonParsed.error}`, raw: skeletonParsed.raw, telemetry };
  }
  const skeleton = skeletonParsed.draft;
  if (!Array.isArray(skeleton?.categories) || skeleton.categories.length === 0) {
    tRec(() => {
      telemetry.skeleton = {
        provider: (skeletonResp as any).provider ?? null,
        elapsedMs: skeletonElapsedMs,
        meta: (skeletonResp as any).meta ?? null,
        parsed: true,
        categoriesProduced: 0,
      };
      telemetry.summary = { failedPhase: "skeleton-empty", elapsedMs: Date.now() - runStart };
    });
    return { error: `Skeleton phase produced no categories.`, raw: skeletonResp.text, telemetry };
  }
  tRec(() => {
    const sMeta = (skeletonResp as any).meta ?? null;
    telemetry.skeleton = {
      provider: (skeletonResp as any).provider ?? null,
      elapsedMs: skeletonElapsedMs,
      meta: sMeta,
      parsed: true,
      truncated: sMeta ? Boolean(sMeta.truncated) : null,
      categoriesProduced: skeleton.categories.length,
      // Per-category outline distribution: distinguishes "skeleton under-
      // distributed outlines" (0 outlines here) from "expansion failed" (outlines
      // present but measures came back empty).
      outlineDistribution: skeleton.categories.map((c: any) => ({
        name: c?.name ?? null,
        outlineCount: Array.isArray(c?.measureOutlines) ? c.measureOutlines.length : 0,
      })),
    };
  });

  // Phase 2: for each category, expand outlines into full measures. Run in
  // parallel. A category with many measures is split into sub-batches of
  // CHUNK_MEASURES_PER_CALL outlines so no single expansion call approaches the
  // token cap regardless of framework size — this is what lets Comprehensive
  // (35–50) frameworks draft without truncating a category.
  const expandBatch = async (
    cat: any,
    idx: number,
    batchIndex: number,
    batchOutlines: any[],
  ): Promise<{ measures: any[]; failed?: boolean; error?: string; rawSample?: string; provider?: string; truncationRecovered?: boolean; attempts?: any[] }> => {
    // [fb2-telemetry] per-attempt records for this batch. Recording only.
    const attempts: any[] = [];
    // Slim skeleton reference so the LLM has enough context but not too much.
    const skeletonRef = {
      framework: skeleton.framework,
      currentCategory: { name: cat.name, purpose: cat.purpose, index: idx + 1, measureOutlines: batchOutlines },
      otherCategories: skeleton.categories.filter((_: any, i: number) => i !== idx).map((c: any) => ({ name: c.name, purpose: c.purpose })),
    };
    const categoryPrompt = `Intake artefact (JSON):\n${JSON.stringify(intake, null, 2)}\n\nSkeleton reference (JSON):\n${JSON.stringify(skeletonRef, null, 2)}\n\nDraft the full measures for the ${batchOutlines.length} outline(s) listed under the category "${cat.name}" only. Return the JSON object described in the system prompt.`;
    // FIX D: count-based fail-loud + bounded retry. A batch is asked to produce
    // batchOutlines.length measures. A response that parses but returns FEWER
    // measures than requested is a masked mid-stream truncation (the salvage /
    // jsonrepair net "succeeds" on a cut payload, yielding e.g. 1 of 8 measures)
    // — historically accepted silently. We now retry the SAME batch up to 3
    // attempts total, keep the best (most-measures, successfully-parsed) attempt,
    // and accept as soon as an attempt is complete. If every attempt is short or
    // unparseable, we return the batch as FAILED (with the best partial measures)
    // so the shortfall flows into failedCategories / the dashboard Retry path
    // instead of quietly under-producing the framework.
    const EXPAND_MAX_ATTEMPTS = 3;
    let best: { measures: any[]; parsed: boolean; truncationRecovered: boolean } = {
      measures: [],
      parsed: false,
      truncationRecovered: false,
    };
    let lastText = "";
    let lastProvider: string | undefined;
    let lastParseError: string | undefined;
    for (let attempt = 1; attempt <= EXPAND_MAX_ATTEMPTS; attempt++) {
      const attemptStart = Date.now();
      const catResp = await completeWithFallback(providerName || "claude", {
        system: CHUNKED_MEASURES_SYSTEM_PROMPT,
        prompt: categoryPrompt,
        maxTokens: 24000,
        temperature: 0.2,
        json: true,
      });
      const attemptElapsedMs = Date.now() - attemptStart;
      lastText = typeof catResp.text === "string" ? catResp.text : "";
      lastProvider = catResp.provider;
      const catParsed = parseDraftJson(catResp.text);
      if (!catParsed.ok) {
        lastParseError = catParsed.error;
        tRec(() => {
          const m = (catResp as any).meta ?? null;
          attempts.push({
            attempt, batchIndex, provider: catResp.provider ?? null, elapsedMs: attemptElapsedMs,
            measuresRequested: batchOutlines.length, measuresReturned: 0,
            parsed: false, parseError: catParsed.error,
            inputTokens: m?.inputTokens ?? null, outputTokens: m?.outputTokens ?? null,
            finishReason: m?.finishReason ?? null, truncated: m ? Boolean(m.truncated) : null,
            semaphoreWaitMs: m?.semaphoreWaitMs ?? null,
          });
        });
        console.warn(`[framework-builder v2] Chunked-drafting category "${cat.name}" batch attempt ${attempt}/${EXPAND_MAX_ATTEMPTS} failed to parse: ${catParsed.error}`);
        continue; // retry
      }
      const measures = Array.isArray(catParsed.draft?.measures) ? catParsed.draft.measures : [];
      const truncationRecovered = Boolean((catParsed.draft as any)?.__truncationRecovered);
      tRec(() => {
        const m = (catResp as any).meta ?? null;
        attempts.push({
          attempt, batchIndex, provider: catResp.provider ?? null, elapsedMs: attemptElapsedMs,
          measuresRequested: batchOutlines.length, measuresReturned: measures.length,
          parsed: true, truncationRecovered,
          inputTokens: m?.inputTokens ?? null, outputTokens: m?.outputTokens ?? null,
          finishReason: m?.finishReason ?? null, truncated: m ? Boolean(m.truncated) : null,
          semaphoreWaitMs: m?.semaphoreWaitMs ?? null,
        });
      });
      if (measures.length > best.measures.length) {
        best = { measures, parsed: true, truncationRecovered };
      }
      if (measures.length >= batchOutlines.length) {
        // Complete generation — accept immediately (preserves the original
        // success return shape: measures + truncationRecovered, no `failed`).
        return { measures, truncationRecovered, provider: catResp.provider, attempts };
      }
      console.warn(`[framework-builder v2] Chunked-drafting category "${cat.name}" batch attempt ${attempt}/${EXPAND_MAX_ATTEMPTS} under-produced: got ${measures.length} of ${batchOutlines.length} measures; retrying.`);
    }
    // Every attempt was short or unparseable — fail LOUD, keeping best partial.
    const error = best.parsed
      ? `Under-produced batch: got ${best.measures.length} of ${batchOutlines.length} measures after ${EXPAND_MAX_ATTEMPTS} attempts (likely mid-stream truncation)`
      : (lastParseError || `Batch failed to parse after ${EXPAND_MAX_ATTEMPTS} attempts`);
    console.warn(`[framework-builder v2] Chunked-drafting category "${cat.name}" batch FAILED: ${error}`);
    return {
      measures: best.measures,
      failed: true,
      error,
      rawSample: lastText ? lastText.slice(0, 500) : undefined,
      provider: lastProvider,
      truncationRecovered: best.truncationRecovered,
      attempts,
    };
  };

  const perCategoryPromises = skeleton.categories.map(async (cat: any, idx: number) => {
    const outlines = Array.isArray(cat.measureOutlines) ? cat.measureOutlines : [];
    if (outlines.length === 0) {
      // Skeleton produced this category but gave it NO outlines to expand — the
      // measures will be empty through no fault of expansion. Recording this
      // separately (skipped vs failed) is what tells the "skeleton under-
      // distributed" story apart from the "expansion failed" story.
      tRec(() => {
        telemetry.categories.push({
          categoryName: cat.name, outlineCount: 0, batchCount: 0,
          measuresReturned: 0, skipped: true, failed: false, attempts: [],
        });
      });
      return { categoryName: cat.name, measures: [], skipped: true };
    }

    // Split into batches of CHUNK_MEASURES_PER_CALL; expand batches in parallel.
    const batches: any[][] = [];
    for (let i = 0; i < outlines.length; i += CHUNK_MEASURES_PER_CALL) {
      batches.push(outlines.slice(i, i + CHUNK_MEASURES_PER_CALL));
    }
    const batchResults = await Promise.all(batches.map((b, bi) => expandBatch(cat, idx, bi, b)));

    // Concatenate measures in outline order; a whole category counts as failed
    // only if EVERY one of its batches failed (partial success still returns
    // the measures that completed).
    const measures = batchResults.flatMap((r) => r.measures);
    const allFailed = batchResults.length > 0 && batchResults.every((r) => r.failed);
    const anyTrunc = batchResults.some((r) => r.truncationRecovered);
    tRec(() => {
      telemetry.categories.push({
        categoryName: cat.name,
        outlineCount: outlines.length,
        batchCount: batches.length,
        measuresReturned: measures.length,
        skipped: false,
        failed: allFailed,
        failedBatchCount: batchResults.filter((r) => r.failed).length,
        attempts: batchResults.flatMap((r) => r.attempts ?? []),
      });
    });
    if (allFailed) {
      const firstFailed = batchResults.find((r) => r.failed) ?? batchResults[0];
      return { categoryName: cat.name, measures: [], failed: true, error: firstFailed?.error, rawSample: firstFailed?.rawSample, provider: firstFailed?.provider };
    }
    const catProvider = batchResults.find((r) => r.provider)?.provider;
    return { categoryName: cat.name, measures, truncationRecovered: anyTrunc, provider: catProvider };
  });

  const categoryResults = await Promise.all(perCategoryPromises);
  const anyTruncationRecovered = categoryResults.some((r: any) => r.truncationRecovered);
  const failedCategories = categoryResults.filter((r: any) => r.failed);
  if (failedCategories.length === categoryResults.length) {
    // FIX 3: Surface the underlying per-category causes instead of a bare summary.
    // `raw` is persisted into error_stack (via result.raw) for full diagnostics,
    // and the first concrete cause is folded into the human-readable error_message
    // that the dashboard renders, so a failure is actionable at a glance.
    const details = failedCategories.map((r: any) => ({
      category: r.categoryName,
      provider: r.provider,
      error: r.error,
      payloadSample: r.rawSample,
    }));
    const firstCause = failedCategories.find((r: any) => r.error)?.error;
    const summary = firstCause
      ? `All ${failedCategories.length} category-drafting sub-calls failed. Last underlying error: ${String(firstCause).slice(0, 300)}`
      : `All ${failedCategories.length} category-drafting sub-calls failed.`;
    tRec(() => {
      telemetry.summary = buildTelemetrySummary(categoryResults, "all-categories-failed");
      console.log("[fb2-telemetry]", JSON.stringify(telemetry.summary));
    });
    return { error: summary, raw: JSON.stringify(details, null, 2), telemetry };
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
    searchTemplates: (() => {
      // Deterministic query-template hygiene (definition-of-good dim 4):
      // parameterise stale hardcoded years and drop junk-verb-only templates
      // before assembly. Auto-fix only — logged, never a violation, so the
      // repair loop is not touched.
      const h = sanitizeSearchTemplates(skeleton.searchTemplates || []);
      if (h.dropped.length > 0) console.log(`[framework-builder v2] query-template hygiene dropped ${h.dropped.length} junk template(s): ${h.dropped.slice(0, 10).join(" | ")}`);
      if (h.rewritten.length > 0) console.log(`[framework-builder v2] query-template hygiene parameterised ${h.rewritten.length} stale-year template(s): ${h.rewritten.slice(0, 10).join(" | ")}`);
      return h.cleaned;
    })(),
    evidenceKeywords: skeleton.evidenceKeywords || [],
  };
  if (anyTruncationRecovered) assembled.__truncationRecovered = true;
  // Record how many category batches failed outright so the caller can report a
  // shortfall accurately (and offer Retry) instead of blaming the user's size.
  if (failedCategories.length > 0) {
    assembled.__failedCategories = failedCategories.length;
    assembled.__failedCategoryNames = failedCategories.map((r: any) => r.categoryName);
  }

  const totalMeasures = assembled.categories.reduce((s: number, c: any) => s + (c.measures?.length || 0), 0);
  console.log(`[framework-builder v2] Chunked drafting complete: ${assembled.categories.length} categories, ${totalMeasures} measures, ${failedCategories.length} failed categories.`);

  // FIX F: report the ACTUAL provider that produced the draft (prefer a category
  // provider, else the skeleton's) so the job runner can persist provider_name
  // on success too — previously only recorded for failed batches.
  const draftProvider = categoryResults.find((r: any) => r.provider)?.provider || skeletonResp.provider;
  tRec(() => {
    telemetry.summary = {
      ...buildTelemetrySummary(categoryResults, failedCategories.length > 0 ? "partial-success" : "success"),
      wallClockMs: Date.now() - runStart,
      resolvedTarget: resolvedTarget ?? null,
    };
    console.log("[fb2-telemetry]", JSON.stringify(telemetry.summary));
  });
  return { draft: assembled, truncationRecovered: anyTruncationRecovered, provider: draftProvider, telemetry };
}

async function callDraftingLLM(intake: IntakeArtefact, providerName?: string, priorAttempt?: { draft: any; violations: any[] }): Promise<{ draft: any; truncationRecovered?: boolean; provider?: string; telemetry?: any } | { error: string; raw?: string; telemetry?: any }> {
  // Route to chunked drafting for fresh attempts unless the target is KNOWN to
  // be small. Repair passes always use single-shot with the prior draft as
  // context. Crucially, an UNKNOWN target (undefined — e.g. the intake LLM wrote
  // a label/range the old numeric gate couldn't parse) now routes to chunked,
  // not single-shot: single-shot truncates for any realistic framework, so it is
  // reserved only for a genuinely small, explicitly-resolved target.
  const target = resolveTargetCount(intake);
  if (!priorAttempt && (target === undefined || target > CHUNKED_DRAFT_THRESHOLD)) {
    console.log(`[framework-builder v2] Chunked drafting activated (target=${target ?? "unknown"}, threshold=${CHUNKED_DRAFT_THRESHOLD}).`);
    return callChunkedDraftingLLM(intake, providerName, target);
  }
  return callSingleShotDraftingLLM(intake, providerName, priorAttempt);
}

async function callSingleShotDraftingLLM(intake: IntakeArtefact, providerName?: string, priorAttempt?: { draft: any; violations: any[] }): Promise<{ draft: any; provider?: string } | { error: string; raw?: string }> {
  const { completeWithFallback } = await import("../lib/ai-providers.js");

  let userPrompt: string;
  if (priorAttempt) {
    // Repair prompt: give the LLM the exact violations to fix.
    const violationSummary = priorAttempt.violations
      .map((v: any) => `- [${v.rule}][${v.severity}] ${v.measureId ? `${v.measureId}: ` : ""}${v.message}${v.suggestion ? ` — SUGGESTION: ${v.suggestion}` : ""}`)
      .join("\n");
    userPrompt = `Intake artefact (JSON):\n${JSON.stringify(intake, null, 2)}\n\nPrior attempt draft (JSON, has validation errors):\n${JSON.stringify(priorAttempt.draft, null, 2)}\n\nViolations to fix (do NOT change measures that are already valid — only edit the fields that trigger these violations):\n${violationSummary}\n\n${C11_REPAIR_CLAUSE}\n\nReturn a corrected framework JSON. Preserve measureId values from the prior attempt. Every construction rule C1–C11 must pass this time.`;
  } else {
    const tgt = resolveTargetCount(intake);
    const countClause = typeof tgt === "number" && tgt > 0
      ? `The user requested approximately ${tgt} measures in total across all categories. Distribute measures roughly evenly across the sub-areas from the intake, weighting more heavily toward higher-priority sub-areas if the user's purpose emphasises them. Do not fall short by more than 15% or exceed by more than 15%.`
      : `Produce approximately 20–30 measures in total across all categories — enough to give balanced coverage but not so many as to become fatiguing to review.`;
    userPrompt = `Intake artefact (JSON):\n${JSON.stringify(intake, null, 2)}\n\nDraft the framework now, following construction rules C1–C11 exactly. ${countClause} Every measure must comply with C1–C11 — in particular: every measure's substantive_definition MUST include an explicit adjacent-topic exclusion clause naming at least one adjacent topic from the intake list; every measure's fallback_yes_criterion MUST have at least 3 numbered conditions each referencing the topic term or a synonym; every measure MUST have whatConstitutesEvidence AND whatDoesNotConstituteEvidence AND positive_examples (>=2) AND negative_examples (>=2).`;
  }

  const { text: response, provider: singleShotProvider } = await completeWithFallback(providerName || "claude", {
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
  return { draft, provider: singleShotProvider };
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

/**
 * Append evidenceKeyword-distinctiveness warnings to a validation result.
 *
 * evidenceKeywords are fed to BM25 as a bag of tokens; a list can read as
 * measure-specific to a human yet tokenise almost entirely into generic topic
 * vocabulary shared by every measure (observed on the Nature framework's 2.4
 * nature-opportunities). Such a measure is retrieved by topic density, not by
 * what makes it distinct — the root cause behind the 2.4 recall miss. This is a
 * NON-BLOCKING (severity "warning") signal so the operator can sharpen the list;
 * it never rewrites or drops the LLM's keywords. Kept in the route (not rules.ts)
 * because the analyzer imports the retrieval tokenizer, which rules.test.ts must
 * not pull in.
 */
function appendEvidenceKeywordWarnings(validation: any, fwDraft: FrameworkDraft): any {
  try {
    const ek = analyzeEvidenceKeywordDistinctiveness(
      (fwDraft.measures as any[]) || [],
      fwDraft.topicSynonyms || [],
    );
    for (const d of ek.perMeasure) {
      if (!d.warning) continue;
      validation.violations.push({
        measureId: d.measureId,
        rule: "evidence-keyword-distinctiveness",
        severity: "warning" as const,
        message: d.warning,
        suggestion:
          `Distinctive tokens so far: [${d.distinctiveTokens.join(", ") || "none"}]. ` +
          `Replace generic topic words with measure-specific single-token terms ` +
          `(mechanisms, instruments, named methods) that do NOT appear in the topic ` +
          `lexicon or in other measures.`,
      });
    }
  } catch (e: any) {
    console.error("[framework-builder v2] evidenceKeyword distinctiveness check failed:", e);
  }
  return validation;
}

// ITEM 1 — Build the machine-readable + human-readable design-issue payload
// attached to every draft/validate/save response. `issues` is the structured
// list the client renders as an accept-or-fix gate; `issuesReadable` is the
// four-part prose rendering; `errorCount`/`warningCount` let the client decide
// whether the gate blocks. The SAME issue ids are what the client passes back
// in acceptedIssueIds once the user explicitly accepts an outstanding issue.
function buildIssuePayload(validation: any): {
  issues: StructuredIssue[];
  issuesReadable: string;
  errorCount: number;
  warningCount: number;
} {
  const violations = (validation?.violations || []) as any[];
  const issues = toStructuredIssues(violations);
  return {
    issues,
    issuesReadable: renderStructuredIssues(issues),
    errorCount: issues.filter((i) => i.severity === "error").length,
    warningCount: issues.filter((i) => i.severity === "warning").length,
  };
}

/**
 * Targeted, per-measure repair — the auto-repair primitive used for ALL drafts,
 * chunked or not.
 *
 * Rather than re-sending the whole assembled draft to the LLM (which for a
 * chunked/25-measure framework blows Claude's 10-min non-streaming limit and
 * risks re-truncation), this builds a COMPACT prompt containing ONLY the
 * measures that carry a violation, plus their exact violation messages and the
 * explicit C11 rewrite instruction. It asks the model to return ONLY the
 * corrected measures (a JSON array keyed by measureId), then splices those back
 * into the full draft in place — valid measures are never touched.
 *
 * Returns the patched draft on success, or null when nothing could be repaired
 * (no addressable violations, LLM/parse failure) so the caller can keep the
 * prior draft and stop the loop.
 */
async function repairMeasuresTargeted(
  intake: IntakeArtefact,
  draft: any,
  violations: any[],
  providerName?: string,
  // ISSUE 2: which violation severities this pass should target per-measure.
  // Defaults to errors-only so the auto-repair path (executeDraft) is unchanged.
  // The user-initiated refine passes ["error","warning"] to genuinely address
  // per-measure warnings on explicit request.
  targetSeverities: Array<"error" | "warning"> = ["error"],
): Promise<{ patched: any | null; telem: any }> {
  const { completeWithFallback } = await import("../lib/ai-providers.js");

  // [fb2-telemetry] Per-pass diagnostic record. Instrumentation ONLY — it never
  // changes the repair control flow, thresholds, or what is returned to the
  // caller (the patched draft, or null). The caller reads `.patched` for the
  // exact same `if (!patched)` semantics as before and stashes `.telem` on the
  // telemetry sidecar so it lands in framework_v2_jobs.telemetry.
  const telem: any = {
    targetedMeasureCount: 0,
    violationsInCount: 0,
    promptChars: 0,
    llmElapsedMs: null as number | null,
    provider: providerName || "claude",
    providerRequested: providerName || "claude",
    parseOk: false,
    measuresReplaced: 0,
    batchCount: 0,
    batches: [] as any[],
    outcome: "unknown",
  };

  // FIX (b) / ISSUE 2: Group violations by measureId, keeping only the severities
  // this pass targets (errors-only by default; refine adds warnings). Info-level
  // advisories are never targeted. Violations without a measureId (framework/
  // set-level) can't be targeted per-measure, so they're skipped — they surface
  // to the review pane as before.
  const byMeasure = new Map<string, any[]>();
  for (const v of violations) {
    if (!targetSeverities.includes(v.severity)) continue;
    const id = v.measureId;
    if (!id) continue;
    if (!byMeasure.has(id)) byMeasure.set(id, []);
    byMeasure.get(id)!.push(v);
  }
  telem.targetedMeasureCount = byMeasure.size;
  telem.violationsInCount = Array.from(byMeasure.values()).reduce((s, vs) => s + vs.length, 0);
  if (byMeasure.size === 0) { telem.outcome = "nothing-addressable"; return { patched: null, telem }; }

  // Locate each offending measure in the draft by measureId, so we send only
  // those measures (not the whole framework) to the LLM.
  const cats = Array.isArray(draft?.categories) ? draft.categories : [];
  const targetMeasures: any[] = [];
  for (const c of cats) {
    const ms = Array.isArray(c?.measures) ? c.measures : [];
    for (const m of ms) {
      if (m && byMeasure.has(m.measureId)) targetMeasures.push(m);
    }
  }
  if (targetMeasures.length === 0) { telem.outcome = "no-target-measures"; return { patched: null, telem }; }

  // FIX (c): Split the offending measures into batches of
  // CHUNK_MEASURES_PER_CALL and repair them IN PARALLEL. A single giant call
  // carrying every offending measure can exceed Claude's non-streaming output
  // window and fall through to the slow OpenAI fallback — see telemetry job
  // 316678be, where one 340k-char repair call dominated a 30-min build.
  // Batching keeps each payload small; Promise.all issues the batch calls
  // concurrently. Cross-call concurrency is already bounded globally by the
  // single semaphore inside completeWithFallback, so no extra semaphore is
  // needed here (this mirrors expandBatch).
  const batches: any[][] = [];
  for (let i = 0; i < targetMeasures.length; i += CHUNK_MEASURES_PER_CALL) {
    batches.push(targetMeasures.slice(i, i + CHUNK_MEASURES_PER_CALL));
  }
  telem.batchCount = batches.length;

  const repairBatch = async (batchMeasures: any[], batchIndex: number) => {
    const rec: any = {
      batchIndex,
      measuresRequested: batchMeasures.length,
      promptChars: 0,
      provider: providerName || "claude",
      parseOk: false,
      measuresReturned: 0,
      llmElapsedMs: null as number | null,
      outcome: "unknown",
    };
    const violationBlock = batchMeasures
      .map((m: any) => {
        const vs = byMeasure.get(m.measureId) || [];
        const lines = vs
          .map((v: any) => `  - [${v.rule}][${v.severity}] ${v.message}${v.suggestion ? ` — SUGGESTION: ${v.suggestion}` : ""}`)
          .join("\n");
        return `${m.measureId}:\n${lines}`;
      })
      .join("\n\n");

    const userPrompt =
      `Intake artefact (JSON, for context — topic term, synonyms, adjacent topics):\n${JSON.stringify(intake, null, 2)}\n\n` +
      `The following measures FAILED validation. Each is given in full, followed by the exact violations to fix:\n\n` +
      `Measures to repair (JSON array):\n${JSON.stringify(batchMeasures, null, 2)}\n\n` +
      `Violations, grouped by measureId:\n${violationBlock}\n\n` +
      `${C11_REPAIR_CLAUSE}\n\n` +
      `Rewrite ONLY the fields that trigger these violations; leave every other field of each measure unchanged. ` +
      `Do NOT invent new measures and do NOT drop any. Preserve every measureId EXACTLY. ` +
      `Return a JSON object of the form {"measures": [ ...corrected measure objects... ]} containing ONLY the ` +
      `measures listed above (one corrected object per measureId), and nothing else.`;
    rec.promptChars = userPrompt.length;

    let resp: { text: string; provider?: string };
    const llmStart = Date.now();
    try {
      resp = await completeWithFallback(providerName || "claude", {
        system: DRAFTING_SYSTEM_PROMPT_HEAD,
        prompt: userPrompt,
        maxTokens: 16000,
        temperature: 0.2,
        json: true,
      });
    } catch (e: any) {
      rec.llmElapsedMs = Date.now() - llmStart;
      rec.outcome = "llm-failed";
      console.warn(`[framework-builder v2] Targeted repair batch ${batchIndex} LLM call failed: ${e?.message || e}`);
      return { corrected: [] as any[], rec };
    }
    rec.llmElapsedMs = Date.now() - llmStart;
    // Actual provider that produced this batch's response, when
    // completeWithFallback exposes it (else the requested provider).
    if ((resp as any).provider) rec.provider = (resp as any).provider;

    const parsed = parseDraftJson(resp.text);
    if (!parsed.ok) {
      rec.outcome = "parse-failed";
      console.warn(`[framework-builder v2] Targeted repair batch ${batchIndex} failed to parse: ${(parsed as { error: string }).error}`);
      return { corrected: [] as any[], rec };
    }
    rec.parseOk = true;
    const correctedBatch = Array.isArray(parsed.draft?.measures)
      ? parsed.draft.measures
      : Array.isArray(parsed.draft)
        ? parsed.draft
        : [];
    rec.measuresReturned = correctedBatch.length;
    rec.outcome = correctedBatch.length > 0 ? "parsed" : "no-measures-returned";
    return { corrected: correctedBatch as any[], rec };
  };

  // Issue all batch repairs concurrently; the global LLM semaphore inside
  // completeWithFallback bounds real parallelism. llmElapsedMs is the wall-clock
  // of the whole parallel phase (per-batch timings live in telem.batches).
  const batchStart = Date.now();
  const results = await Promise.all(batches.map((b, i) => repairBatch(b, i)));
  telem.llmElapsedMs = Date.now() - batchStart;
  telem.batches = results.map((r) => r.rec);
  telem.promptChars = results.reduce((s, r) => s + (r.rec.promptChars || 0), 0);
  telem.parseOk = results.some((r) => r.rec.parseOk);
  const providersUsed = Array.from(new Set(results.map((r) => r.rec.provider).filter(Boolean)));
  if (providersUsed.length > 0) telem.provider = providersUsed.join(",");

  // Merge corrected measures from every batch, keyed by measureId.
  const correctedById = new Map<string, any>();
  for (const r of results) {
    for (const m of r.corrected) {
      if (m && typeof m.measureId === "string") correctedById.set(m.measureId, m);
    }
  }
  if (correctedById.size === 0) {
    telem.outcome = "no-measures-returned";
    console.warn(`[framework-builder v2] Targeted repair returned no measures across ${batches.length} batch(es).`);
    return { patched: null, telem };
  }

  // Splice corrected measures back into the full draft by measureId, in place.
  // FIX: PRUNE-MERGE the model's (often partial) correction onto the ORIGINAL
  // measure via mergeCorrectedMeasure — a correction can only add/improve fields,
  // never delete one the model omitted or blanked. This stops complete measures
  // being turned into stubs. See mergeCorrectedMeasure for the root cause.
  let replaced = 0;
  let fieldsPreservedByMerge = 0;
  let regressionsPrevented = 0;
  const patched = {
    ...draft,
    categories: cats.map((c: any) => ({
      ...c,
      measures: (Array.isArray(c?.measures) ? c.measures : []).map((m: any) => {
        if (m && correctedById.has(m.measureId)) {
          replaced++;
          const { merged, fieldsPreserved, regressionPrevented } = mergeCorrectedMeasure(
            m,
            correctedById.get(m.measureId),
          );
          fieldsPreservedByMerge += fieldsPreserved;
          if (regressionPrevented) regressionsPrevented++;
          return merged;
        }
        return m;
      }),
    })),
  };
  telem.measuresReplaced = replaced;
  telem.fieldsPreservedByMerge = fieldsPreservedByMerge;
  telem.regressionsPrevented = regressionsPrevented;
  if (replaced === 0) {
    telem.outcome = "no-matches";
    console.warn(`[framework-builder v2] Targeted repair produced no measureId matches; keeping prior draft.`);
    return { patched: null, telem };
  }
  telem.outcome = "repaired";
  console.log(`[framework-builder v2] Targeted repair replaced ${replaced} measure(s).`);
  return { patched, telem };
}

async function executeDraft(intake: IntakeArtefact, providerName?: string): Promise<{ draft: any; measures: any[]; validation: any; summary: string; repairAttempts: number; truncationRecovered?: boolean; targetMeasureCount?: number; measureCount: number; failedCategories: number; failedCategoryNames?: string[]; provider?: string; issues: StructuredIssue[]; issuesReadable: string; errorCount: number; warningCount: number; designDiagnostic: DiagnosticReport; telemetry?: any } | { error: string; raw?: string; telemetry?: any }> {
  // Attempt 1: initial draft.
  const first = await callDraftingLLM(intake, providerName);
  if ("error" in first) return first;
  let draft = first.draft;
  // FIX F: actual provider that produced this draft, for persistence on success.
  const draftProvider = (first as any).provider as string | undefined;
  // [fb2-telemetry] Sidecar from the drafting call, propagated verbatim to the
  // job runner so it can be persisted to the framework_v2_jobs.telemetry column.
  const draftTelemetry = (first as any).telemetry;

  const validate = (d: any) => {
    const fwDraft = buildFrameworkDraft(d, intake);
    try {
      return appendEvidenceKeywordWarnings(validateAll(fwDraft), fwDraft);
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

  // [fb2-telemetry] Count error/warning/total violations off a validation
  // result. Pure read — never throws, never touches control flow.
  const countSeverity = (val: any) => {
    const vs = Array.isArray(val?.violations) ? val.violations : [];
    return {
      errorCount: vs.filter((v: any) => v.severity === "error").length,
      warningCount: vs.filter((v: any) => v.severity === "warning").length,
      violationCount: vs.length,
    };
  };

  // Initial (pre-repair) validation, timed so the sidecar can prove the
  // synchronous validator is not the ~35-min sink.
  const initialValidateStart = Date.now();
  let validation: any = validate(draft);
  const initialValidateMs = Date.now() - initialValidateStart;

  // Up to MAX_REPAIRS targeted repair passes for hard errors. Warnings don't
  // trigger a repair.
  //
  // This runs for ALL drafts, chunked or not. Previously the loop was DISABLED
  // for chunked drafts (>15 measures) because the old single-shot repair
  // re-sent the whole assembled draft, blowing Claude's 10-min non-streaming
  // limit — which meant a 25-measure framework's C11 errors flowed straight to
  // the user's review pane as an unrepaired dead end. repairMeasuresTargeted
  // sends only the offending measures, so the payload stays small and safe for
  // chunked drafts too.
  //
  // [fb2-telemetry] The repairPhase sidecar records, per executed pass, how long
  // the LLM call took, the payload size, the provider that answered, the parse
  // outcome, how many measures were replaced, and the validation error/warning
  // counts after each pass — so an over-long draft can be attributed to the
  // repair LLM calls rather than guessed at.
  //
  // FIX (a) KEEP-BEST / NON-REGRESSION GUARD: after each pass we RE-VALIDATE the
  // patched draft and compare its error count to the count that went INTO the
  // pass. A pass is only ACCEPTED if it STRICTLY reduces errors; otherwise the
  // patched draft is DISCARDED, the pre-pass draft is kept, and the loop stops.
  // The phase returns the fewest-error draft observed across the initial draft
  // and all accepted passes. This prevents the destructive-pass pathology (see
  // telemetry job 316678be, 14→100 errors) where a repair pass made the draft
  // strictly worse and that worse draft was carried forward. MAX_REPAIRS (2) and
  // the repair trigger condition are unchanged.
  const repairPhaseStart = Date.now();
  const repairPasses: any[] = [];
  const initialCounts = countSeverity(validation);
  let repairAttempts = 0;
  const MAX_REPAIRS = Number(process.env.FRAMEWORK_V2_MAX_REPAIRS || 2);
  // Best (fewest-error) draft observed so far, seeded with the initial draft.
  let bestDraft = draft;
  let bestValidation = validation;
  let bestErrorCount = initialCounts.errorCount;
  while (
    repairAttempts < MAX_REPAIRS &&
    validation.violations.some((v: any) => v.severity === "error")
  ) {
    repairAttempts++;
    const passStart = Date.now();
    const violationsInCounts = countSeverity(validation);
    const errorsIn = violationsInCounts.errorCount;
    const { patched, telem } = await repairMeasuresTargeted(intake, draft, validation.violations, providerName);
    if (!patched) {
      // Nothing addressable, or the repair failed to parse — keep prior draft, stop.
      try {
        repairPasses.push({
          pass: repairAttempts,
          targetedMeasureCount: telem?.targetedMeasureCount ?? null,
          violationsInCount: telem?.violationsInCount ?? violationsInCounts.violationCount,
          batchCount: telem?.batchCount ?? null,
          batches: telem?.batches ?? null,
          errorsIn,
          warningsIn: violationsInCounts.warningCount,
          errorCountBefore: errorsIn,
          promptChars: telem?.promptChars ?? null,
          llmElapsedMs: telem?.llmElapsedMs ?? null,
          provider: telem?.provider ?? (providerName || "claude"),
          parseOk: telem?.parseOk ?? false,
          measuresReplaced: telem?.measuresReplaced ?? 0,
          elapsedMs: Date.now() - passStart,
          errorCountAfter: errorsIn,
          warningCountAfter: violationsInCounts.warningCount,
          accepted: false,
          outcome: telem?.outcome ?? "no-usable-draft",
        });
      } catch { /* telemetry must never break the draft */ }
      console.warn(`[framework-builder v2] Repair attempt ${repairAttempts} produced no usable draft; keeping prior draft.`);
      break;
    }
    // FIX (a): validate the patched draft WITHOUT committing to it yet, so a
    // regressive pass can be discarded.
    const postValidateStart = Date.now();
    const patchedValidation = validate(patched);
    const postValidateMs = Date.now() - postValidateStart;
    const afterCounts = countSeverity(patchedValidation);
    // Accept only if this pass STRICTLY reduced the error count.
    const accepted = afterCounts.errorCount < errorsIn;
    try {
      repairPasses.push({
        pass: repairAttempts,
        targetedMeasureCount: telem?.targetedMeasureCount ?? null,
        violationsInCount: telem?.violationsInCount ?? violationsInCounts.violationCount,
        batchCount: telem?.batchCount ?? null,
        batches: telem?.batches ?? null,
        errorsIn,
        warningsIn: violationsInCounts.warningCount,
        errorCountBefore: errorsIn,
        promptChars: telem?.promptChars ?? null,
        llmElapsedMs: telem?.llmElapsedMs ?? null,
        provider: telem?.provider ?? (providerName || "claude"),
        parseOk: telem?.parseOk ?? false,
        measuresReplaced: telem?.measuresReplaced ?? 0,
        postValidateMs,
        elapsedMs: Date.now() - passStart,
        errorCountAfter: afterCounts.errorCount,
        warningCountAfter: afterCounts.warningCount,
        accepted,
        outcome: accepted ? (telem?.outcome ?? "repaired") : "discarded-regression",
      });
    } catch { /* telemetry must never break the draft */ }
    if (!accepted) {
      // FIX (a): pass did not strictly reduce errors — DISCARD the patched
      // draft, keep the pre-pass draft (already the best-so-far), and stop.
      console.warn(
        `[framework-builder v2] Repair attempt ${repairAttempts} did not reduce errors ` +
        `(${errorsIn} → ${afterCounts.errorCount}); discarding patched draft and stopping.`,
      );
      break;
    }
    // Accepted: commit the patched draft and update best-so-far.
    draft = patched;
    validation = patchedValidation;
    if (afterCounts.errorCount < bestErrorCount) {
      bestDraft = draft;
      bestValidation = validation;
      bestErrorCount = afterCounts.errorCount;
    }
  }
  // FIX (a): return the fewest-error draft observed (keep-best).
  draft = bestDraft;
  validation = bestValidation;
  const repairPhaseMs = Date.now() - repairPhaseStart;

  // [fb2-telemetry] Attach the repair + validation phase section onto the
  // existing drafting telemetry sidecar so it is persisted to the
  // framework_v2_jobs.telemetry JSONB column alongside skeleton/expansion data.
  try {
    if (draftTelemetry && typeof draftTelemetry === "object") {
      draftTelemetry.repairPhase = {
        wallClockMs: repairPhaseMs,
        maxRepairs: MAX_REPAIRS,
        repairAttempts,
        initialValidation: {
          errorCount: initialCounts.errorCount,
          warningCount: initialCounts.warningCount,
          violationCount: initialCounts.violationCount,
        },
        // FIX (a): fewest-error count of the draft actually returned (keep-best).
        finalErrorCount: bestErrorCount,
        passes: repairPasses,
      };
      draftTelemetry.validationPhase = {
        initialValidateMs,
      };
      console.log(
        `[fb2-telemetry] repairPhase wallClockMs=${repairPhaseMs} attempts=${repairAttempts}/${MAX_REPAIRS} ` +
        `initialErrors=${initialCounts.errorCount} initialWarnings=${initialCounts.warningCount} ` +
        `finalErrors=${countSeverity(validation).errorCount} passes=${repairPasses.length} ` +
        `initialValidateMs=${initialValidateMs}`,
      );
    }
  } catch { /* telemetry must never break the draft */ }

  const measures = flattenMeasures(draft);
  const truncationRecovered = Boolean((draft as any).__truncationRecovered);
  const failedCategories = Number((draft as any).__failedCategories || 0);
  const failedCategoryNames = ((draft as any).__failedCategoryNames as string[] | undefined) || undefined;
  const issuePayload = buildIssuePayload(validation);
  // [fb2-telemetry] Time the (synchronous) design-diagnostic build so the sidecar
  // can prove it is not the phase consuming the wall clock. Behaviour unchanged:
  // the same report is passed to the return object below.
  const designDiagStart = Date.now();
  const designDiagnosticReport = buildDraftDesignDiagnostic(draft, intake);
  try {
    if (draftTelemetry && typeof draftTelemetry === "object") {
      draftTelemetry.validationPhase = {
        ...(draftTelemetry.validationPhase || {}),
        designDiagnosticMs: Date.now() - designDiagStart,
      };
    }
  } catch { /* telemetry must never break the draft */ }
  return {
    draft,
    measures,
    validation,
    summary: summariseViolations(validation.violations),
    repairAttempts,
    truncationRecovered,
    // Honest reporting so the client can explain any shortfall accurately
    // instead of blindly telling the user to pick a smaller size.
    targetMeasureCount: resolveTargetCount(intake),
    measureCount: measures.length,
    failedCategories,
    failedCategoryNames,
    provider: draftProvider,
    // STATIC design diagnostic over the just-drafted measures (LLM-free). The
    // builder surfaces these as REVIEW items so design defects are tackled
    // BEFORE the draft is proposed as ready. Advisory only — never auto-applied.
    designDiagnostic: designDiagnosticReport,
    telemetry: draftTelemetry,
    ...issuePayload,
  };
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
        // Iterative targeted repair on the incoming draft. We re-validate, then
        // repair only the offending measures (compact payload — safe for large
        // chunked drafts, unlike the old full-draft single-shot re-send), up to
        // MAX_REPAIRS passes. Warnings are surfaced but do not, on their own,
        // block; error-severity violations drive the loop.
        const MAX_REPAIRS = Number(process.env.FRAMEWORK_V2_MAX_REPAIRS || 2);
        let currentDraft = draft;
        let currentFwDraft = buildFrameworkDraft(currentDraft, intake);
        const revalidate = (fw: FrameworkDraft) => {
          try { return appendEvidenceKeywordWarnings(validateAll(fw), fw); }
          catch (e: any) { return { passed: false, violations: [{ rule: "internal", severity: "error", message: e?.message }] }; }
        };
        let currentValidation: any = revalidate(currentFwDraft);
        // ISSUE 2: snapshot the pre-refine warning/error counts so we can report,
        // honestly, how many warnings this user-initiated refine actually resolved.
        const countWarn = (val: any) => (val.violations || []).filter((v: any) => v.severity === "warning").length;
        const countErr = (val: any) => (val.violations || []).filter((v: any) => v.severity === "error").length;
        const initialWarningCount = countWarn(currentValidation);
        const initialErrorCount = countErr(currentValidation);
        const hasActionable = (val: any) =>
          (val.violations || []).some((v: any) => v.severity === "error" || v.severity === "warning");
        if (!hasActionable(currentValidation)) {
          // Nothing to refine — just return the current draft.
          await db.execute(sql`
            UPDATE framework_v2_jobs
            SET status = 'succeeded', result = ${JSON.stringify({ draft: currentDraft, measures: currentFwDraft.measures, validation: currentValidation, summary: "No violations to refine.", repairAttempts: 0, designDiagnostic: buildDraftDesignDiagnostic(currentDraft, intake) })}::jsonb, updated_at = NOW()
            WHERE id = ${jobId}
          `);
          return;
        }

        let repairAttempts = 0;
        while (repairAttempts < MAX_REPAIRS && hasActionable(currentValidation)) {
          repairAttempts++;
          // ISSUE 2: user-initiated refine targets BOTH errors AND warnings that
          // carry a measureId (per-measure repairable). This is the explicit
          // "address the warnings" request — distinct from the errors-only
          // auto-repair during initial drafting.
          const { patched } = await repairMeasuresTargeted(
            intake,
            currentDraft,
            currentValidation.violations,
            providerName,
            ["error", "warning"],
          );
          if (!patched) {
            console.warn(`[framework-builder v2 /draft/refine] repair attempt ${repairAttempts} produced no usable draft; keeping prior draft.`);
            break;
          }
          currentDraft = patched;
          currentFwDraft = buildFrameworkDraft(currentDraft, intake);
          currentValidation = revalidate(currentFwDraft);
        }

        if (repairAttempts === 0) {
          // Should not happen (hasActionable was true) — but if no pass ran, fail cleanly.
          await db.execute(sql`
            UPDATE framework_v2_jobs
            SET status = 'failed', error_message = ${"Refine could not run a repair pass."}, updated_at = NOW()
            WHERE id = ${jobId}
          `);
          return;
        }

        // ISSUE 2: build an HONEST outcome distinguishing warnings we resolved from
        // those that remain, and WHY the remainder could not be auto-fixed. Set-level
        // advisories (no measureId) cannot be patched per-measure by repairMeasuresTargeted,
        // so they will persist across passes; per-measure warnings that survive MAX_REPAIRS
        // are genuinely unresolved-after-passes. This drives an accurate client message
        // instead of implying "re-draft ran but nothing changed".
        const finalViolations: any[] = currentValidation.violations || [];
        const finalWarnings = finalViolations.filter((v: any) => v.severity === "warning");
        const finalErrorCount = countErr(currentValidation);
        const setLevelWarnings = finalWarnings.filter((v: any) => !v.measureId);
        const perMeasureRemaining = finalWarnings.filter((v: any) => !!v.measureId);
        const warningsResolved = Math.max(0, initialWarningCount - finalWarnings.length);
        const setLevelRuleNames = [...new Set(setLevelWarnings.map((v: any) => v.rule).filter(Boolean))];
        const errorsResolved = Math.max(0, initialErrorCount - finalErrorCount);
        const refineOutcome = {
          initialWarningCount,
          initialErrorCount,
          warningsResolved,
          errorsResolved,
          warningsRemaining: finalWarnings.length,
          errorsRemaining: finalErrorCount,
          setLevelWarningCount: setLevelWarnings.length,
          setLevelRuleNames,
          perMeasureRemainingCount: perMeasureRemaining.length,
          repairAttempts,
          maxRepairs: MAX_REPAIRS,
        };
        // Human-readable honest summary (client also renders a structured version).
        let refineMessage: string;
        if (finalWarnings.length === 0 && finalErrorCount === 0) {
          refineMessage = `Re-draft resolved all ${initialWarningCount} warning${initialWarningCount === 1 ? "" : "s"}${initialErrorCount ? ` and ${initialErrorCount} error${initialErrorCount === 1 ? "" : "s"}` : ""}. The draft is now clean.`;
        } else {
          const parts: string[] = [];
          parts.push(
            `Re-draft addressed ${warningsResolved} of ${initialWarningCount} warning${initialWarningCount === 1 ? "" : "s"}. ${finalWarnings.length} remain`,
          );
          const reasons: string[] = [];
          if (setLevelWarnings.length > 0) {
            reasons.push(
              `${setLevelWarnings.length} set-level advisor${setLevelWarnings.length === 1 ? "y" : "ies"} (${setLevelRuleNames.join(", ")}) that cannot be auto-fixed per-measure`,
            );
          }
          if (perMeasureRemaining.length > 0) {
            reasons.push(
              `${perMeasureRemaining.length} still unresolved after ${repairAttempts} repair pass${repairAttempts === 1 ? "" : "es"} (max ${MAX_REPAIRS})`,
            );
          }
          if (reasons.length) parts.push(`: ${reasons.join("; ")}`);
          parts.push(". These are advisory — you can save as a draft and edit manually, or re-draft again.");
          refineMessage = parts.join("");
        }

        const result = {
          draft: currentDraft,
          measures: currentFwDraft.measures,
          validation: currentValidation,
          summary: summariseViolations(currentValidation.violations),
          refineOutcome,
          refineMessage,
          repairAttempts,
          designDiagnostic: buildDraftDesignDiagnostic(currentDraft, intake),
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
        // [fb2-telemetry] Persist the diagnostic sidecar to the dedicated JSONB
        // column on BOTH outcomes so a failed/under-produced run survives beyond
        // Railway's short log-retention window and is queryable after the fact.
        const telemetryJson = (result as any).telemetry ? JSON.stringify((result as any).telemetry) : null;
        if ("error" in result) {
          await db.execute(sql`
            UPDATE framework_v2_jobs
            SET status = 'failed', error_message = ${result.error}, error_stack = ${result.raw || null}, telemetry = ${telemetryJson}::jsonb, updated_at = NOW()
            WHERE id = ${jobId}
          `);
          return;
        }
        // FIX F: persist the ACTUAL provider that produced the draft (not just the
        // requested one recorded at INSERT) so a succeeded-but-under-produced job
        // still has provider_name for diagnostics.
        await db.execute(sql`
          UPDATE framework_v2_jobs
          SET status = 'succeeded', result = ${JSON.stringify(result)}::jsonb, provider_name = COALESCE(${(result as any).provider || null}, provider_name), telemetry = ${telemetryJson}::jsonb, updated_at = NOW()
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
    const validation = appendEvidenceKeywordWarnings(validateAll(fwDraft), fwDraft);
    return res.json({
      validation,
      summary: summariseViolations(validation.violations),
      ...buildIssuePayload(validation),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/save — persist a validated v2 framework ────────────────────
// Called by the client after the user has drafted + validated + (optionally)
// test-driven the framework. Writes framework + measures with builder_version="v2"
// and all C1-C11 fields populated.
//
// ITEM 1 — Acceptance gate: the save is BLOCKED while any error-severity design
// issue is outstanding. The client must resolve the issue (re-draft) OR pass
// its id in `acceptedIssueIds` (explicit per-issue acceptance) OR pass
// `proceedWithWarnings: true` (accept the whole current error set knowingly).
// Warning-severity issues never block; they are returned for surfacing. This
// enforcement applies to EVERY save (both save-as-draft and production-ready) so
// an ambiguous framework can no longer be persisted silently.

router.post("/v2/save", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const { draft, intake, testDriveSummary, testDriveWarnings, productionReady, acceptedIssueIds, proceedWithWarnings } = req.body as {
      draft: any;
      intake: IntakeArtefact;
      testDriveSummary?: any;
      testDriveWarnings?: any[];
      productionReady?: boolean;
      acceptedIssueIds?: string[];
      proceedWithWarnings?: boolean;
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
      validation = appendEvidenceKeywordWarnings(validateAll(fwDraft), fwDraft);
    } catch (e: any) {
      validation = { passed: false, violations: [{ rule: "internal", severity: "error", message: `Validator threw: ${e?.message || e}` }] };
    }

    // ITEM 1 — Acceptance gate. Transform violations into structured issues and
    // block the save while any error-severity issue is unaccepted. This replaces
    // the old "only block production-ready" behaviour: an ambiguous framework can
    // no longer be silently saved-as-draft either — the user must explicitly
    // accept each outstanding error (acceptedIssueIds) or proceedWithWarnings.
    const issuePayload = buildIssuePayload(validation);
    const gate = evaluateAcceptanceGate(issuePayload.issues, { acceptedIssueIds, proceedWithWarnings });
    if (!gate.allowed) {
      return res.status(400).json({
        error:
          `Framework has ${gate.blockingIssues.length} outstanding error-severity design issue(s) that must be resolved or explicitly accepted before saving. ` +
          `Re-draft to fix them, or re-submit with acceptedIssueIds (the id of each issue you accept) or proceedWithWarnings: true.`,
        blocked: true,
        validation,
        summary: summariseViolations(validation.violations),
        ...issuePayload,
        blockingIssueIds: gate.blockingIssues.map((i) => i.id),
      });
    }
    // Production-ready additionally requires a clean pass (no accepted-away
    // errors): a framework promoted to production must not ship known flip risks.
    if (productionReady && !validation.passed) {
      return res.status(400).json({
        error: "Framework fails C1-C11 validation and cannot be saved as production-ready. Save as draft instead.",
        validation,
        summary: summariseViolations(validation.violations),
        ...issuePayload,
      });
    }

    // ─── Approach 2a: generate + DF-validate the corpus-selection query vocab ──
    // Runs automatically at framework creation (server-side, no CLI). The cleaned
    // set is persisted to retrievalQueryTerms and later fed (weighted) into
    // summarizeDocuments' corpus selection. Non-fatal: any failure degrades to []
    // so creation proceeds exactly as before (backward-compatible).
    let retrievalQueryTerms: string[] = [];
    try {
      const { completeWithFallback } = await import("../lib/ai-providers.js");
      const { generateRetrievalQueryTerms } = await import("../lib/framework-v2/retrieval-query-terms.js");
      const gen = await generateRetrievalQueryTerms(
        {
          topicTerm: fwDraft.topicTerm,
          topicSynonyms: fwDraft.topicSynonyms || [],
          topicDescription: draft.framework.topicDescription || intake.topic || "",
          frameworkName: fwDraft.name,
        },
        completeWithFallback as any,
      );
      retrievalQueryTerms = gen.terms;
      console.log(
        `[v2/save] retrievalQueryTerms generated: ${gen.terms.length} kept, ${gen.validation.dropped.length} dropped (of ${gen.raw.length} candidates)`,
      );
    } catch (e: any) {
      console.warn(`[v2/save] retrievalQueryTerms generation failed (non-fatal): ${e?.message ?? e}`);
      retrievalQueryTerms = [];
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
      retrievalQueryTerms,
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
        C6: true, C7: true, C8: true, C9: true, C10: true, C11: true,
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
      // Surface the accepted-issue trail so the client can show what was saved
      // with known warnings/accepted errors.
      acceptedErrorCount: gate.acceptedCount,
      warningCount: issuePayload.warningCount,
      issues: issuePayload.issues,
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /save] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

// ─── POST /v2/test-drive/select — propose test-drive sample ──────────────

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
      // Sized for a TEST_DRIVE_SAMPLE_SIZE (50) company JSON array; 3000 was
      // enough only for the old 10-company sample and would truncate at 50.
      maxTokens: 12000,
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
// /v2/test-drive/select (which returned the candidate companies).
// The endpoint:
//   1. Ensures each proposed company exists in the workspace (create if missing)
//   2. Creates a new company list "Test-drive: <framework name>"
//   3. Adds the companies to the list
//   4. Returns { listId, companyIds } so the client can POST /api/analyze itself
// We do not call /analyze internally because it depends on session context and
// req.body shape that varies with the caller.

router.post("/v2/test-drive/run", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const { frameworkId, companies, frameworkName, runs } = req.body as {
      frameworkId: number;
      frameworkName?: string;
      companies: Array<{ name: string; ticker?: string; sector?: string; country?: string; isKnownDiscloser?: boolean }>;
      runs?: number; // ITEM 2: how many times to score the SAME sample (flip detection)
    };
    if (!frameworkId || !Array.isArray(companies) || companies.length === 0) {
      return res.status(400).json({ error: "frameworkId and companies[] required" });
    }

    // ITEM 2: bounded number of scoring runs for run-to-run flip detection.
    // Each completed batch becomes one framework_v2_iterations row; the flip
    // detector compares verdicts per company across these iterations. This is a
    // DESIGN-time diagnostic — live scoring stays single-shot. k is clamped to
    // [1, TEST_DRIVE_MAX_RUNS] and defaults to TEST_DRIVE_RUNS.
    const defaultRuns = Math.max(1, parseInt(process.env.TEST_DRIVE_RUNS || "3", 10) || 3);
    const maxRuns = Math.max(1, parseInt(process.env.TEST_DRIVE_MAX_RUNS || "5", 10) || 5);
    const requestedRuns = Number.isFinite(runs as number) ? Math.floor(runs as number) : defaultRuns;
    const scoringRuns = Math.min(maxRuns, Math.max(1, requestedRuns));
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
      scoringRuns, // ITEM 2: score the sample this many times for flip detection
      maxRuns,
      hint:
        scoringRuns > 1
          ? `POST /api/analyze with { frameworkId, listId } ${scoringRuns} times to score the same sample repeatedly; each completed batch is one iteration, and /v2/test-drive/results reports per-measure run-to-run flip rates.`
          : "POST /api/analyze with { frameworkId, listId } to kick off scoring, or navigate to Results with these IDs.",
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
    // progressBatch = the newest batch of ANY status — used for live-progress
    // display (a running/cancelled/failed run still reports its true progress).
    const batchRow = await db.execute(sql`
      SELECT id, status, total_jobs, completed_jobs, failed_jobs, started_at, completed_at
      FROM batch_runs
      WHERE framework_id = ${frameworkId} AND list_id = ${listId} AND workspace_id = ${ctx.workspaceId}
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const progressBatch = (batchRow as any).rows?.[0] || null;

    // latestCompletedBatch = the most recent COMPLETED batch — used for the
    // scoringComplete gate and proposal/robustness computation so the dashboard
    // keeps showing the last good results even when the newest run was
    // cancelled/failed/still running. Generic: prefers latest completed for every
    // framework, no hardcoding.
    const completedBatchRow = await db.execute(sql`
      SELECT id, status, total_jobs, completed_jobs, failed_jobs, started_at, completed_at
      FROM batch_runs
      WHERE framework_id = ${frameworkId} AND list_id = ${listId} AND workspace_id = ${ctx.workspaceId}
        AND status = 'completed'
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const latestCompletedBatch = (completedBatchRow as any).rows?.[0] || null;

    // When the newest batch is itself completed, effectiveBatch === progressBatch
    // (no behavior change for the normal case).
    const effectiveBatch = pickEffectiveBatch(progressBatch, latestCompletedBatch);
    // Keep the historic `batch` name pointing at the live-progress batch so the
    // response's existing progress fields are unchanged.
    const batch = progressBatch;

    // 2. Fetch measure_scores for the list's companies + framework.
    const scoresQuery = await db.execute(sql`
      SELECT ms.company_id, c.name AS company_name, ms.measure_id, ms.verdict,
             ms.confidence, ms.quotes, ms.verdict_nuance, ms.score,
             ms.rationale_score_inconsistent
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

    // 4. Measure metadata (expected_yes_rate, definitions, spec fields) is loaded
    //    inside deriveProposalBundle() below alongside the flag analysis + edit
    //    proposals, so the READ path here and the WRITE path in
    //    /v2/improvement/apply share one derivation and never diverge.

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
    // Gate on the EFFECTIVE (latest completed) batch, not the newest one, so a
    // cancelled/failed/running newest batch does not suppress the last good
    // proposals. Snapshots below therefore never fire off a non-completed batch.
    const scoringComplete = effectiveBatch?.status === "completed" && results.length > 0;
    let report: any = null;
    let robustness: any = null;
    let edits: any = null;
    let rootCauses: any = null;
    let flipStats: any[] = [];
    let qualityMetrics: QualityMetricsReport | null = null;
    let nearDuplicateEdits: any[] = [];
    let designDiagnostic: DiagnosticReport | null = null;
    if (scoringComplete) {
      // Snapshot this batch FIRST so its verdicts are persisted as an iteration
      // row before we build the multi-run flip input — otherwise the current
      // batch would be missing from the run-to-run comparison. Idempotent:
      // already-snapshotted batches are skipped inside snapshotIteration().
      let snapIterationNumber: number | undefined;
      try {
        const snap = await snapshotIteration(frameworkId, listId, ctx.workspaceId);
        snapIterationNumber = snap?.iterationNumber;
      } catch (e: any) {
        console.warn("[framework-builder v2 /test-drive/results] iteration snapshot failed:", e?.message);
      }

      // Derive the FULL proposal bundle from the single shared function so the
      // READ path here and the WRITE path in /v2/improvement/apply can never
      // diverge (multi-run flip analysis, sparse-corpus flag, edit proposals,
      // quality metrics and near-duplicate merges are all produced there). Called
      // AFTER snapshotIteration() above so the fresh iteration is included in the
      // multi-run flip comparison.
      const bundle = await deriveProposalBundle(db, frameworkId, listId, ctx.workspaceId);
      flipStats = bundle.flipStats;
      report = bundle.report;
      robustness = bundle.robustness;
      edits = bundle.edits;
      qualityMetrics = bundle.qualityMetrics;
      nearDuplicateEdits = bundle.nearDuplicateEdits;

      // Top up the snapshot row with robustness (+ rootCauses, still null here;
      // filled lazily by /v2/improvement/chat) that snapshotIteration() itself
      // does not compute.
      try {
        if (snapIterationNumber) {
          await db.execute(sql`
            UPDATE framework_v2_iterations
            SET robustness = ${JSON.stringify(robustness)}::jsonb,
                rootCauses = ${JSON.stringify(rootCauses)}::jsonb
            WHERE framework_id = ${frameworkId} AND list_id = ${listId}
              AND iteration_number = ${snapIterationNumber}
          `);
        }
      } catch (e: any) {
        console.warn("[framework-builder v2 /test-drive/results] iteration top-up failed:", e?.message);
      }

      // POST-TEST design diagnostic — read-only over stored results (the
      // measure_scores rows already fetched + the snapshotted iterations). NO
      // re-scoring, NO worker call, NO LLM. Surfaced for REVIEW alongside the
      // proposals; advisory only, never auto-applied. Multi-run flip rate
      // auto-populates once a re-test produces a second iteration.
      try {
        designDiagnostic = await buildTestDriveDesignDiagnostic(
          frameworkId,
          listId,
          (report as any)?.frameworkName ?? null,
          rows,
          snapIterationNumber,
        );
      } catch (e: any) {
        console.warn("[framework-builder v2 /test-drive/results] design diagnostic failed (non-fatal):", e?.message);
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
      // Additive, backward-compatible fields describing which batch the proposals
      // were computed from vs. the newest batch shown in live progress.
      proposalsFromBatchId: effectiveBatch?.id ?? null,
      latestBatchStatus: progressBatch?.status ?? null,
      perCompany,
      report,
      robustness,
      edits,
      rootCauses,
      flipStats, // ITEM 2: per-measure run-to-run flip stats across iterations
      iterationsCompared: flipStats.length > 0 ? Math.max(...flipStats.map((s: any) => s.runs || 0)) : 0,
      labelsInferred,
      qualityMetrics, // Tier-1 design-time quality gate (MAXIMISE + GATE metrics, Q composite)
      nearDuplicateEdits, // selectable merge/differentiate proposals for near-duplicate pairs
      designDiagnostic, // POST-TEST measure-design diagnostic (read-only, advisory) — null until scoring completes
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /test-drive/results] error:", err);
    return res.status(500).json({ error: err?.message || "internal error", stack: err?.stack });
  }
});

// ─── POST /v2/test-drive/analyse — analyse scored test-drive results ─────
// Caller passes company-level results already produced by the existing pipeline.
// This endpoint applies flag rules and returns a fix plan.

// ─── POST /v2/truth-check ── independent Perplexity verification of one cell ──
// Body: { frameworkId, companyId, measureId, force? }
// Runs a fresh Perplexity Sonar search for the specific measure-company
// combination, using the SAME measure definition the app uses to score.
// Caches the result in framework_v2_truth_findings so re-opening the drill
// doesn't re-hit the API. Pass force=true to bust the cache.
router.post("/v2/truth-check", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });
    const { frameworkId, companyId, measureId, force } = req.body as {
      frameworkId: number; companyId: number; measureId: string; force?: boolean;
    };
    if (!frameworkId || !companyId || !measureId) {
      return res.status(400).json({ error: "frameworkId, companyId, measureId required" });
    }

    // Return cached finding unless the caller asked for a fresh run.
    if (!force) {
      const cached = await db.execute(sql`
        SELECT verdict, confidence, reasoning, quotes, sources, provider, model_id, checked_at
        FROM framework_v2_truth_findings
        WHERE framework_id = ${frameworkId} AND company_id = ${companyId} AND measure_id = ${measureId}
      `);
      const r = (cached as any).rows?.[0];
      if (r) {
        return res.json({
          cached: true,
          verdict: r.verdict, confidence: r.confidence, reasoning: r.reasoning,
          quotes: r.quotes || [], sources: r.sources || [],
          provider: r.provider, modelId: r.model_id, checkedAt: r.checked_at,
        });
      }
    }

    // Load the measure definition + framework topic context.
    const fwRow = await db.execute(sql`
      SELECT topic_term, topic_synonyms, adjacent_topics FROM frameworks
      WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}
    `);
    const fw = ((fwRow as any).rows || [])[0];
    if (!fw) return res.status(404).json({ error: "framework not found" });

    const measureRow = await db.execute(sql`
      SELECT measure_id, title, substantive_definition, fallback_yes_criterion,
             positive_examples, negative_examples
      FROM framework_measures
      WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}
    `);
    const m = ((measureRow as any).rows || [])[0];
    if (!m) return res.status(404).json({ error: "measure not found" });

    const companyRow = await db.execute(sql`
      SELECT name, COALESCE(domain, fmp_website) AS company_domain FROM companies
      WHERE id = ${companyId} AND workspace_id = ${ctx.workspaceId}
    `);
    const company = ((companyRow as any).rows || [])[0];
    if (!company) return res.status(404).json({ error: "company not found" });

    let result: TruthCheckResult;
    try {
      result = await runTruthCheck({
        companyName: company.name,
        companyDomain: company.company_domain || undefined,
        measureId: m.measure_id,
        measureTitle: m.title || m.measure_id,
        measureSubstantiveDefinition: m.substantive_definition || "",
        measureFallbackYesCriterion: m.fallback_yes_criterion || "",
        measurePositiveExamples: Array.isArray(m.positive_examples) ? m.positive_examples : [],
        measureNegativeExamples: Array.isArray(m.negative_examples) ? m.negative_examples : [],
        topicTerm: fw.topic_term || "",
        adjacentTopics: Array.isArray(fw.adjacent_topics) ? fw.adjacent_topics : [],
      });
    } catch (e: any) {
      return res.status(502).json({ error: `truth-check provider error: ${e?.message || e}` });
    }

    // Persist (upsert)
    await db.execute(sql`
      INSERT INTO framework_v2_truth_findings
        (framework_id, company_id, measure_id, verdict, confidence, reasoning, quotes, sources, provider, model_id)
      VALUES (${frameworkId}, ${companyId}, ${measureId}, ${result.verdict}, ${result.confidence},
              ${result.reasoning}, ${JSON.stringify(result.quotes)}::jsonb, ${JSON.stringify(result.sources)}::jsonb,
              ${result.provider}, ${result.modelId})
      ON CONFLICT (framework_id, company_id, measure_id) DO UPDATE SET
        verdict = EXCLUDED.verdict, confidence = EXCLUDED.confidence, reasoning = EXCLUDED.reasoning,
        quotes = EXCLUDED.quotes, sources = EXCLUDED.sources, provider = EXCLUDED.provider,
        model_id = EXCLUDED.model_id, checked_at = NOW()
    `);

    return res.json({
      cached: false,
      verdict: result.verdict, confidence: result.confidence, reasoning: result.reasoning,
      quotes: result.quotes, sources: result.sources,
      provider: result.provider, modelId: result.modelId,
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /truth-check] error:", err);
    return res.status(500).json({ error: err?.message || "internal error" });
  }
});

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
      SELECT c.id AS company_id, c.name AS company_name,
             ms.verdict, ms.confidence, ms.quotes, ms.verdict_nuance,
             tf.verdict AS truth_verdict, tf.confidence AS truth_confidence,
             tf.reasoning AS truth_reasoning, tf.quotes AS truth_quotes,
             tf.sources AS truth_sources, tf.checked_at AS truth_checked_at
      FROM measure_scores ms
      JOIN companies c ON c.id = ms.company_id
      JOIN company_list_members clm ON clm.company_id = c.id AND clm.list_id = ${listId}
      LEFT JOIN framework_v2_truth_findings tf ON tf.framework_id = ms.framework_id
           AND tf.company_id = ms.company_id AND tf.measure_id = ms.measure_id
      WHERE ms.framework_id = ${frameworkId} AND ms.measure_id = ${measureId}
      ORDER BY ms.verdict, c.name
    `);
    const rows = ((rowsQ as any).rows || []).map((r: any) => ({
      companyId: r.company_id,
      companyName: r.company_name,
      verdict: r.verdict || "No",
      confidence: r.confidence || "Medium",
      quotes: Array.isArray(r.quotes) ? r.quotes : [],
      nuance: r.verdict_nuance || "",
      truth: r.truth_verdict ? {
        verdict: r.truth_verdict,
        confidence: r.truth_confidence,
        reasoning: r.truth_reasoning,
        quotes: r.truth_quotes || [],
        sources: r.truth_sources || [],
        checkedAt: r.truth_checked_at,
      } : null,
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
  // Also persist per-cell confidence + evidence fingerprint so future runs can
  // compute retrieval-stability (Jaccard over fingerprints) and confidence-
  // conditioned stability across iterations (quality-metrics §4.7). Both are
  // OPTIONAL, backward-compatible additions to the per_measure jsonb.
  const scoresQ = await db.execute(sql`
    SELECT ms.company_id, c.name AS company_name, ms.measure_id, ms.verdict,
           ms.confidence, ms.evidence_fingerprint
    FROM measure_scores ms JOIN companies c ON c.id = ms.company_id
    JOIN company_list_members clm ON clm.company_id = c.id AND clm.list_id = ${listId}
    WHERE ms.framework_id = ${frameworkId}
  `);
  const scoreRows = ((scoresQ as any).rows || []) as any[];

  const byCompany: Record<string, any> = {};
  const byMeasure: Record<
    string,
    {
      yesCount: number;
      totalCount: number;
      verdictsByCompany: Record<string, string>;
      confidenceByCompany: Record<string, string>;
      fingerprintsByCompany: Record<string, string>;
    }
  > = {};
  for (const r of scoreRows) {
    const cid = String(r.company_id);
    if (!byCompany[cid]) byCompany[cid] = { companyId: r.company_id, companyName: r.company_name, yesCount: 0, noCount: 0, partialCount: 0, total: 0 };
    byCompany[cid].total++;
    if (r.verdict === "Yes") byCompany[cid].yesCount++;
    else if (r.verdict === "Partial") byCompany[cid].partialCount++;
    else byCompany[cid].noCount++;

    if (!byMeasure[r.measure_id]) byMeasure[r.measure_id] = { yesCount: 0, totalCount: 0, verdictsByCompany: {}, confidenceByCompany: {}, fingerprintsByCompany: {} };
    byMeasure[r.measure_id].totalCount++;
    if (r.verdict === "Yes") byMeasure[r.measure_id].yesCount++;
    byMeasure[r.measure_id].verdictsByCompany[cid] = r.verdict || "No";
    if (r.confidence) byMeasure[r.measure_id].confidenceByCompany[cid] = String(r.confidence);
    if (r.evidence_fingerprint) byMeasure[r.measure_id].fingerprintsByCompany[cid] = String(r.evidence_fingerprint);
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

// ─── GET /v2/measure-edits ── read the edit-audit log ──
// Returns the most recent measure-edit audit rows for a framework (optionally
// scoped to a list), newest first. `applied=false` rows carry a skip_reason so
// the UI can flag silently-skipped accepts. Defensive: if the audit table does
// not exist yet, returns an empty list rather than 500.
router.get("/v2/measure-edits", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });
    const frameworkId = Number(req.query.frameworkId);
    if (!frameworkId) return res.status(400).json({ error: "frameworkId required" });
    const listIdRaw = req.query.listId;
    const listId = listIdRaw !== undefined && listIdRaw !== "" ? Number(listIdRaw) : null;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;

    try {
      const rows = await db.execute(sql`
        SELECT id, workspace_id, framework_id, list_id, measure_id, field, op,
               before_value, after_value, source, applied, skip_reason, created_at
        FROM measure_edits
        WHERE framework_id = ${frameworkId}
          ${listId !== null ? sql`AND list_id = ${listId}` : sql``}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `);
      return res.json({
        edits: ((rows as any).rows || []).map((r: any) => ({
          id: Number(r.id),
          workspaceId: r.workspace_id,
          frameworkId: r.framework_id,
          listId: r.list_id,
          measureId: r.measure_id,
          field: r.field,
          op: r.op,
          beforeValue: r.before_value,
          afterValue: r.after_value,
          source: r.source,
          applied: r.applied,
          skipReason: r.skip_reason,
          createdAt: r.created_at,
        })),
      });
    } catch (inner: any) {
      // Table missing / transient error — audit is observability-only, so never
      // surface a 500 for the read path.
      console.warn("[framework-builder v2 /measure-edits] read failed (returning empty):", inner?.message || inner);
      return res.json({ edits: [] });
    }
  } catch (err: any) {
    console.error("[framework-builder v2 /measure-edits] error:", err);
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
    const { frameworkId, stage, testDriveListId, testDriveListName, draft, validation } = req.body as {
      frameworkId: number; stage: string; testDriveListId?: number; testDriveListName?: string;
      draft?: any; validation?: any;
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
        // Persist draft + validation for resumability. If not provided in this
        // call, preserve any existing stored value.
        ...(draft !== undefined ? { draft } : existing?.draft !== undefined ? { draft: existing.draft } : {}),
        ...(validation !== undefined ? { validation } : existing?.validation !== undefined ? { validation: existing.validation } : {}),
        lastUpdated: new Date().toISOString(),
      };
      await db.execute(sql`
        UPDATE frameworks SET v2_state = ${JSON.stringify(merged)}::jsonb
        WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}
      `);
      return res.json({ ok: true, state: merged, note: "stage regression rejected; existing stage preserved" });
    }

    const state = {
      stage,
      testDriveListId: testDriveListId ?? existing?.testDriveListId ?? null,
      testDriveListName: testDriveListName ?? existing?.testDriveListName ?? null,
      // Persist draft + validation for resumability. draft can be ~100KB; stored once
      // at save time. If not provided in this call, preserve any existing stored value.
      ...(draft !== undefined ? { draft } : existing?.draft !== undefined ? { draft: existing.draft } : {}),
      ...(validation !== undefined ? { validation } : existing?.validation !== undefined ? { validation: existing.validation } : {}),
      lastUpdated: new Date().toISOString(),
    };
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
             positive_examples, negative_examples, min_quote_context_chars, disclosure_vehicles
      FROM framework_measures WHERE framework_id = ${frameworkId}
    `);
    const measureRows = ((measureMetaQuery as any).rows || []) as any[];
    const measureMetadata = measureRows.map((m: any) => ({
      measureId: m.measure_id,
      expected_yes_rate: typeof m.expected_yes_rate === "number" ? m.expected_yes_rate : 0.35,
    }));
    const measuresById: Record<string, any> = {};
    for (const m of measureRows) measuresById[m.measure_id] = m;

    // ITEM 2: load iteration snapshots so the chat's flag report includes the
    // same run-to-run flip detection the results panel shows. Flipping measures
    // therefore reach the improvement LLM with the C11 countable-rewrite advice.
    let multiRunForChat: MultiRunIteration[] = [];
    try {
      const iterRows = await db.execute(sql`
        SELECT iteration_number, per_measure FROM framework_v2_iterations
        WHERE framework_id = ${frameworkId} AND list_id = ${listId}
        ORDER BY iteration_number ASC
      `);
      multiRunForChat = ((iterRows as any).rows || []).map((r: any) => ({
        iterationNumber: Number(r.iteration_number),
        perMeasure: (r.per_measure && typeof r.per_measure === "object") ? r.per_measure : {},
      }));
    } catch (e: any) {
      console.warn("[improvement/chat] multi-run load failed (non-fatal):", e?.message);
    }

    // Recompute flag report + edit proposals.
    const report = analyseTestDrive(results as any, measureMetadata, multiRunForChat);
    const editsBundle = proposeEditsForFlags(report.flags || [], measuresById);

    // Recompute root causes.
    const batchRow = await db.execute(sql`
      SELECT id FROM batch_runs WHERE framework_id = ${frameworkId} AND list_id = ${listId} AND workspace_id = ${ctx.workspaceId}
      ORDER BY started_at DESC LIMIT 1
    `);
    const batchId = (batchRow as any).rows?.[0]?.id;
    let rootCauses: RootCauseReport | null = null;
    // Corpus text per company (lowercased), captured while computing root causes
    // so terminology-gap mining below can reuse it without a second heavy query.
    const corpusTexts = new Map<string, string>();
    let topicSynonymsForGap: string[] = [];
    if (batchId) {
      const topicRow = await db.execute(sql`SELECT topic_synonyms FROM frameworks WHERE id = ${frameworkId}`);
      const topicSynonyms = ((topicRow as any).rows?.[0]?.topic_synonyms) || [];
      topicSynonymsForGap = Array.isArray(topicSynonyms) ? topicSynonyms : [];
      const termsLc = [String(fwMeta.topic_term || "").toLowerCase(), ...topicSynonyms.map((s: string) => s.toLowerCase())].filter(Boolean);
      // IMPORTANT: do NOT select LENGTH(full_content) — on large corpora (e.g. 564MB)
      // Postgres must fully decompress every TOAST value to compute LENGTH, making this
      // query take 10–30s even with a LEFT() limit applied.  We use LEFT(..., 50000)
      // to sample each doc (enough for topic-mention detection and terminology gap
      // mining) and derive char-count from the sample length, which is cheap.
      const corpusRows = await db.execute(sql`
        SELECT bc.company_id, c.name AS company_name, d.type, d.title,
               LEFT(COALESCE(d.content, dc.content, ''), 50000) AS text
        FROM batch_corpus bc JOIN companies c ON c.id = bc.company_id
        JOIN documents d ON d.id = bc.document_id
        LEFT JOIN document_content dc ON dc.id = d.content_id
        WHERE bc.batch_id = ${batchId}
      `);
      const perCompStats: Record<string, CompanyCorpusStats> = {};
      for (const r of ((corpusRows as any).rows || [])) {
        const cid = Number(r.company_id); const k = String(cid);
        if (!perCompStats[k]) perCompStats[k] = { companyId: cid, companyName: r.company_name, docCount: 0, totalChars: 0, pdfCount: 0, thematicReportCount: 0, topicTermMentions: 0, topicMentioningDocs: 0, yesCount: 0, totalMeasures: 0 };
        const s = perCompStats[k]; s.docCount++;
        // totalChars is an undercount (sample-based) but acceptable for root-cause thresholds.
        s.totalChars += String(r.text || "").length;
        if (String(r.type || "").toLowerCase() === "pdf") s.pdfCount++;
        const titleLc = String(r.title || "").toLowerCase();
        if (titleLc.includes("sustainability") || titleLc.includes("tnfd") || titleLc.includes("tcfd") || titleLc.includes("esg report") || titleLc.includes("nature report")) s.thematicReportCount++;
        const textLc = String(r.text || "").toLowerCase(); let docMentions = 0;
        for (const t of termsLc) { let i = textLc.indexOf(t); while (i !== -1) { docMentions++; i = textLc.indexOf(t, i + t.length); } }
        s.topicTermMentions += docMentions; if (docMentions > 0) s.topicMentioningDocs++;
        // Accumulate corpus text per company for terminology gap mining. Cap BOTH
        // the per-doc slice AND the per-company total — detectTerminologyGaps only
        // scans the first ~200K chars per company, so holding more just wastes heap.
        const CORPUS_TEXT_CAP_PER_COMPANY = 200_000;
        const existing = corpusTexts.get(r.company_name) ?? "";
        if (existing.length < CORPUS_TEXT_CAP_PER_COMPANY) {
          corpusTexts.set(r.company_name, existing + " " + textLc.slice(0, 50000));
        }
      }
      for (const r of results) {
        const k = String(r.companyId);
        if (perCompStats[k]) { perCompStats[k].yesCount = r.measures.filter((m: any) => m.verdict === "Yes").length; perCompStats[k].totalMeasures = r.measures.length; }
      }
      const scoresByCM: Record<string, Record<string, string>> = {};
      for (const r of results) { const k = String(r.companyId); scoresByCM[k] = {}; for (const m of r.measures) scoresByCM[k][m.measureId] = m.verdict; }
      rootCauses = diagnoseRootCauses(Object.values(perCompStats), measureMetadata.map((m: any) => m.measureId), scoresByCM);
    }

    // The chat can work without corpus-based root-cause data — flags, proposals,
    // and per-company yes counts still give the LLM plenty to reason about. If the
    // corpus lookup produced nothing (e.g. batchId null), fall back to a stub so
    // the route returns 200 with useful context rather than a hard 500.
    if (!rootCauses) {
      rootCauses = {
        companies: [],
        measures: [],
        summary: { docCollectionFailures: 0, frameworkIssues: 0, healthy: 0, ambiguous: 0, deadMeasuresLikelyFrameworkFault: 0, deadMeasuresLikelyCorpusFault: 0 },
        headline: "Root-cause corpus analysis unavailable — discuss flags and proposals below.",
      };
    }

    // ITEM 3: surface data-sparse companies (root-cause "doc-collection-failure")
    // as an explicit, actionable prompt in the improvement flow, so the designer
    // fixes corpus collection before rewording measures that look broken only
    // because their evidence was never collected.
    try {
      const sparseSignals: SparseCompanySignal[] = (rootCauses?.companies || [])
        .filter((c: any) => c.classification === "doc-collection-failure")
        .map((c: any) => ({ companyId: c.companyId, companyName: c.companyName, classification: c.classification }));
      const sparseFlag = buildSparseCorpusFlag(sparseSignals);
      if (sparseFlag) report.flags = [sparseFlag, ...(report.flags || [])];
    } catch (e: any) {
      console.warn("[improvement/chat] sparse-corpus surfacing failed (non-fatal):", e?.message);
    }

    // ── Terminology gap detection ──────────────────────────────────────────
    // Mine the corpus for terms companies actually use near the topic that
    // aren't already in topicSynonyms. Pass the top candidates to the LLM.
    let terminologyGapResult: import("../lib/framework-v2/test-drive.js").TerminologyGapResult | null = null;
    try {
      const { detectTerminologyGaps } = await import("../lib/framework-v2/test-drive.js");
      if (corpusTexts.size > 0) {
        terminologyGapResult = detectTerminologyGaps(corpusTexts, topicSynonymsForGap, String(fwMeta.topic_term || ""));
      }
    } catch (tgErr) {
      console.warn("[improvement/chat] terminology gap detection failed (non-fatal):", tgErr);
    }

    // ── Disclosure vehicle mismatch detection ─────────────────────────────
    const vehicleMismatches: Array<{ measureId: string; expectedVehicles: string[]; observedTypes: string[]; companyName: string }> = [];
    try {
      // For each measure that has disclosure_vehicles defined, check if any
      // corpus documents are of types not in the expected list — especially
      // for companies that scored zero on that measure.
      const measuresWithVehicles = measureRows.filter((m: any) =>
        Array.isArray(m.disclosure_vehicles) && m.disclosure_vehicles.length > 0
      );
      if (measuresWithVehicles.length > 0 && batchId) {
        // Get doc types present in the corpus per company
        const docTypeRows = await db.execute(sql`
          SELECT c.name AS company_name, d.type AS doc_type, COUNT(*) AS cnt
          FROM batch_corpus bc
          JOIN companies c ON c.id = bc.company_id
          JOIN documents d ON d.id = bc.document_id
          WHERE bc.batch_id = ${batchId}
          GROUP BY c.name, d.type
        `);
        const docTypesByCompany: Record<string, Set<string>> = {};
        for (const r of ((docTypeRows as any).rows || [])) {
          if (!docTypesByCompany[r.company_name]) docTypesByCompany[r.company_name] = new Set();
          if (r.doc_type) docTypesByCompany[r.company_name].add(String(r.doc_type).toLowerCase());
        }
        // For each company that scored zero on a measure with disclosure_vehicles,
        // check if observed doc types differ from expected
        for (const m of measuresWithVehicles) {
          const expectedVehicles = (m.disclosure_vehicles as string[]).map((v: string) => v.toLowerCase());
          for (const r of results) {
            const zeroOnMeasure = r.measures.find((mm: any) => mm.measureId === m.measure_id && mm.verdict === "No");
            if (!zeroOnMeasure) continue;
            const observedTypes = Array.from(docTypesByCompany[r.companyName] ?? []);
            const unexpectedTypes = observedTypes.filter((t) => !expectedVehicles.some((ev) => t.includes(ev) || ev.includes(t)));
            if (unexpectedTypes.length > 0) {
              vehicleMismatches.push({
                measureId: m.measure_id,
                expectedVehicles,
                observedTypes: unexpectedTypes.slice(0, 3),
                companyName: r.companyName,
              });
            }
          }
        }
      }
    } catch (vmErr) {
      console.warn("[improvement/chat] vehicle mismatch detection failed (non-fatal):", vmErr);
    }

    const chatCtx: ImprovementChatContext = {
      frameworkName: fwMeta.name,
      topicTerm: fwMeta.topic_term,
      perCompanySummary,
      rootCauses,
      flags: report.flags || [],
      proposals: editsBundle.proposals,
      passedRobustnessCriteria: 0,
      totalRobustnessCriteria: 6,
      terminologyGaps: terminologyGapResult?.missingTerms,
      vehicleMismatches: vehicleMismatches.length > 0 ? vehicleMismatches : undefined,
    };

    const system = buildImprovementChatSystemPrompt(chatCtx);
    const history = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const { completeWithFallback } = await import("../lib/ai-providers.js");
    // Conversational replies are short. 4000 output tokens is plenty and stays
    // within the limits of every fallback provider (some cap far below Claude's
    // 32K), avoiding a provider-side rejection that surfaced as "Error: Error".
    // The full conversation is passed each turn so the LLM sees the entire
    // back-and-forth, not just a truncated window.
    const { text: reply } = await completeWithFallback(providerName || "claude", {
      system,
      prompt: history + "\n\nAssistant:",
      maxTokens: 4000,
      temperature: 0.2,
      // Conversational path: on the rare turn that hits the cap, return the partial
      // reply instead of throwing and cascading through fallbacks until the client aborts.
      allowTruncated: true,
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

    // Re-derive proposals through the SAME shared function the results view uses
    // so the apply path resolves accepted proposals against the IDENTICAL set.
    // Before this, the apply path re-derived with a leaner query and NO multi-run
    // history, so multi-run-only proposals (residual-instability), the
    // sparse-corpus proposal and near-duplicate merges were absent here and every
    // accepted one was skipped as "proposal no longer present". deriveProposalBundle
    // reproduces the full derivation (multi-run flip analysis + sparse flag + edit
    // proposals + near-duplicate merges), closing that divergence.
    const bundle = await deriveProposalBundle(db, frameworkId, listId, ctx.workspaceId);
    const measuresById = bundle.measuresById;
    const editsBundle = bundle.edits;
    // The COMPLETE proposal set: edit proposals first (positional P<idx> indices
    // stay stable), near-duplicate merges appended. apply_edit resolves against
    // this; apply_all_by_cause stays scoped to the edit proposals only.
    const allProposals = bundle.allProposals;

    // Collect proposals we need LLM regeneration for, then run one batched
    // regeneration call per (op, path) group. This preserves consistency
    // across measures AND keeps latency O(1) rather than O(N).
    async function applyProposal(prop: any, applied: any[], skipped: any[]) {
      const op = prop.patch?.op;
      // Direct per-measure column writes (no LLM regeneration): the legacy
      // "replace" ops plus the calibration/annotation ops set_expected_yes_rate
      // (Feature 1) and flag_non_discriminating (Feature 2). Each op maps to an
      // explicit column and coerces its value; anything else falls through to the
      // batched LLM regeneration path handled by the caller.
      if (DIRECT_MEASURE_OPS.includes(op)) {
        const path = prop.patch.path;
        let col: any = null;
        let value: any = prop.patch.value;
        if (op === "replace") {
          col = path === "fallback_yes_criterion" ? sql`fallback_yes_criterion` :
                path === "min_quote_context_chars" ? sql`min_quote_context_chars` : null;
        } else if (op === "set_expected_yes_rate") {
          col = sql`expected_yes_rate`;
          // Clamp to a valid probability defensively (builder already clamps).
          const n = typeof value === "number" ? value : parseFloat(String(value));
          value = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
        } else if (op === "flag_non_discriminating") {
          // SOFT, non-destructive annotation — never deletes/disables the measure.
          col = sql`flagged_non_discriminating`;
          value = true;
        }
        if (!col || value === null) {
          const reason = !col ? `unsupported patch path ${path}` : `invalid value for ${op}`;
          skipped.push({ measureId: prop.measureId, reason });
          await recordMeasureEdit(db, {
            workspaceId: ctx.workspaceId, frameworkId, listId, measureId: prop.measureId,
            field: path || "(unknown)", op: op || null,
            source: `proposal:${prop.flagRule}`, applied: false, skipReason: reason,
          });
          return;
        }
        // Read the before-value so the audit row carries the prior state.
        let beforeValue: any = null;
        try {
          const beforeQ = await db.execute(sql`
            SELECT ${col} AS v FROM framework_measures
            WHERE framework_id = ${frameworkId} AND measure_id = ${prop.measureId} LIMIT 1
          `);
          beforeValue = ((beforeQ as any).rows || [])[0]?.v ?? null;
        } catch { /* audit before-value is best-effort */ }
        await db.execute(sql`
          UPDATE framework_measures SET ${col} = ${value}, updated_at = NOW()
          WHERE framework_id = ${frameworkId} AND measure_id = ${prop.measureId}
        `);
        applied.push({ measureId: prop.measureId, action: prop.action, patch: { ...prop.patch, value } });
        await recordMeasureEdit(db, {
          workspaceId: ctx.workspaceId, frameworkId, listId, measureId: prop.measureId,
          field: path, op, beforeValue, afterValue: value,
          source: `proposal:${prop.flagRule}`, applied: true,
        });
      } else {
        // LLM regeneration paths get grouped into batches; caller processes them.
      }
    }

    // Apply a FRAMEWORK-LEVEL proposal (terminology-gap synonyms, adjacent-topic
    // registration, anchor-framework coverage). These target a jsonb column on
    // `frameworks` — never a per-measure field — so they are additive DISTINCT
    // appends, not column replaces. The whitelist maps each proposer patch.op to
    // its exact column (a column name cannot be parameterised in SQL, so each op
    // uses an explicit template). measureId is the framework sentinel and the
    // audit records the before/after jsonb. Mirrors the existing chat
    // add_synonyms handler but resolves the values from the proposal's patch and
    // covers all three framework-level ops generically.
    async function applyFrameworkLevelProposal(prop: any, applied: any[], skipped: any[]) {
      const op = prop.patch?.op;
      const path = prop.patch?.path;
      const values = Array.isArray(prop.patch?.value)
        ? prop.patch.value.map((v: any) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
        : [];
      // op → column, kept in lock-step with FRAMEWORK_LEVEL_OPS / the jsonb
      // columns on `frameworks`. Any op not listed here is rejected (defensive).
      const columnForOp: Record<string, { col: any; field: string }> = {
        add_synonyms: { col: sql`topic_synonyms`, field: "topic_synonyms" },
        add_adjacent_topics: { col: sql`adjacent_topics`, field: "adjacent_topics" },
        add_anchor_frameworks: { col: sql`anchor_frameworks`, field: "anchor_frameworks" },
      };
      const target = columnForOp[op];
      if (!target) {
        const reason = `unsupported framework-level op ${op}`;
        skipped.push({ measureId: FRAMEWORK_SENTINEL, reason });
        await recordMeasureEdit(db, {
          workspaceId: ctx.workspaceId, frameworkId, listId, measureId: FRAMEWORK_SENTINEL,
          field: path || "(unknown)", op: op || null,
          source: `proposal:${prop.flagRule}`, applied: false, skipReason: reason,
        });
        return;
      }
      if (values.length === 0) {
        const reason = "no values supplied";
        skipped.push({ measureId: FRAMEWORK_SENTINEL, reason });
        await recordMeasureEdit(db, {
          workspaceId: ctx.workspaceId, frameworkId, listId, measureId: FRAMEWORK_SENTINEL,
          field: target.field, op, source: `proposal:${prop.flagRule}`, applied: false, skipReason: reason,
        });
        return;
      }
      // Read the before-value so the audit row carries the prior list state.
      let beforeVal: any = null;
      try {
        const beforeQ = await db.execute(sql`
          SELECT ${target.col} AS v FROM frameworks
          WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId} LIMIT 1
        `);
        beforeVal = ((beforeQ as any).rows || [])[0]?.v ?? null;
      } catch { /* audit before-value is best-effort */ }
      // Additive DISTINCT jsonb append: keep every existing entry and add the new
      // values, de-duplicated. Never removes or overwrites an existing entry.
      await db.execute(sql`
        UPDATE frameworks
        SET ${target.col} = (
          SELECT jsonb_agg(DISTINCT term)
          FROM (
            SELECT jsonb_array_elements_text(COALESCE(${target.col}, '[]'::jsonb)) AS term
            UNION
            SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb) AS term
          ) sub
        )
        WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}
      `);
      applied.push({ measureId: FRAMEWORK_SENTINEL, action: prop.action, patch: { op, path: target.field, value: values } });
      await recordMeasureEdit(db, {
        workspaceId: ctx.workspaceId, frameworkId, listId, measureId: FRAMEWORK_SENTINEL,
        field: target.field, op, beforeValue: beforeVal, afterValue: values,
        source: `proposal:${prop.flagRule}`, applied: true,
      });
    }

    // Load framework topic context for the LLM (memoised for this request).
    let _fctxCache: FrameworkContext | null = null;
    async function loadFrameworkContext(): Promise<FrameworkContext> {
      if (_fctxCache) return _fctxCache;
      const fwRow = await db.execute(sql`
        SELECT name, topic_term, topic_synonyms, adjacent_topics FROM frameworks
        WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}
      `);
      const fw = ((fwRow as any).rows || [])[0] || {};
      _fctxCache = {
        topicTerm: fw.topic_term || "",
        topicSynonyms: Array.isArray(fw.topic_synonyms) ? fw.topic_synonyms : [],
        adjacentTopics: Array.isArray(fw.adjacent_topics) ? fw.adjacent_topics : [],
        frameworkName: fw.name || "",
      };
      return _fctxCache;
    }

    // Fetch a single measure's editable fields, or null if it does not exist.
    async function loadMeasure(measureId: string): Promise<CustomEditMeasure | null> {
      const q = await db.execute(sql`
        SELECT measure_id, title, substantive_definition, fallback_yes_criterion,
               positive_examples, negative_examples, expected_yes_rate, min_quote_context_chars,
               scoring_guidance
        FROM framework_measures
        WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}
        LIMIT 1
      `);
      const row = ((q as any).rows || [])[0];
      if (!row) return null;
      return {
        measureId: row.measure_id,
        title: row.title,
        substantive_definition: row.substantive_definition || "",
        fallback_yes_criterion: row.fallback_yes_criterion || "",
        positive_examples: Array.isArray(row.positive_examples) ? row.positive_examples : [],
        negative_examples: Array.isArray(row.negative_examples) ? row.negative_examples : [],
        expected_yes_rate: typeof row.expected_yes_rate === "number" ? row.expected_yes_rate : undefined,
        min_quote_context_chars: typeof row.min_quote_context_chars === "number" ? row.min_quote_context_chars : undefined,
        scoring_guidance: typeof row.scoring_guidance === "string" ? row.scoring_guidance : (row.scoring_guidance == null ? "" : String(row.scoring_guidance)),
      };
    }

    // Persist ONE custom-edit field value to the correct column. Arrays go to
    // jsonb; scalars to their typed columns. Returns false if the field is
    // unknown (defensive — the caller validates against CUSTOM_EDIT_FIELDS).
    async function persistMeasureField(measureId: string, field: CustomEditField, value: any): Promise<boolean> {
      switch (field) {
        case "substantive_definition":
          await db.execute(sql`UPDATE framework_measures SET substantive_definition = ${value}, updated_at = NOW() WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}`); return true;
        case "fallback_yes_criterion":
          await db.execute(sql`UPDATE framework_measures SET fallback_yes_criterion = ${value}, updated_at = NOW() WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}`); return true;
        case "positive_examples":
          await db.execute(sql`UPDATE framework_measures SET positive_examples = ${JSON.stringify(value)}::jsonb, updated_at = NOW() WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}`); return true;
        case "negative_examples":
          await db.execute(sql`UPDATE framework_measures SET negative_examples = ${JSON.stringify(value)}::jsonb, updated_at = NOW() WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}`); return true;
        case "expected_yes_rate":
          await db.execute(sql`UPDATE framework_measures SET expected_yes_rate = ${value}, updated_at = NOW() WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}`); return true;
        case "min_quote_context_chars":
          await db.execute(sql`UPDATE framework_measures SET min_quote_context_chars = ${value}, updated_at = NOW() WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}`); return true;
        default:
          return false;
      }
    }

    function fieldValueOf(m: CustomEditMeasure, field: CustomEditField): any {
      switch (field) {
        case "positive_examples": return m.positive_examples;
        case "negative_examples": return m.negative_examples;
        case "fallback_yes_criterion": return m.fallback_yes_criterion;
        case "expected_yes_rate": return m.expected_yes_rate;
        case "min_quote_context_chars": return m.min_quote_context_chars;
        default: return m.substantive_definition;
      }
    }

    async function runBatchedRegenerations(proposals: any[], applied: any[], skipped: any[]) {
      if (!proposals.length) return;
      const groups = groupProposalsByPatch(proposals);
      const fctx = await loadFrameworkContext();
      for (const [groupKey, groupProps] of Object.entries(groups)) {
        const measureIds = groupProps.map((p: any) => p.measureId);
        // Fetch current measures for the LLM context. Drizzle's sql`` template
        // treats JS arrays as records unless we serialise to a Postgres-array
        // literal or unroll. Simplest: fetch all measures and filter in JS.
        const measureIdSet = new Set(measureIds);
        const allMeasuresQ = await db.execute(sql`
          SELECT measure_id, title, substantive_definition, fallback_yes_criterion,
                 positive_examples, negative_examples, scoring_guidance
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
          scoring_guidance: typeof m.scoring_guidance === "string" ? m.scoring_guidance : (m.scoring_guidance == null ? "" : String(m.scoring_guidance)),
        }));

        // Derive the audited field/op generically from the group key
        // ("<op>::<path>") and the before-state + provenance from the group's
        // own proposals — no framework/measure-specific branching.
        const [groupOp, groupField] = groupKey.split("::");
        const beforeById: Record<string, MeasureBefore> = {};
        for (const m of measuresForLLM) beforeById[m.measureId] = m;
        const flagRuleById: Record<string, string> = {};
        for (const p of groupProps) flagRuleById[p.measureId] = p.flagRule;
        const auditSource = (measureId: string) => `proposal:${flagRuleById[measureId] || groupOp}`;
        const beforeFieldValue = (measureId: string): any => {
          const b = beforeById[measureId];
          if (!b) return null;
          if (groupField === "positive_examples") return b.positive_examples;
          if (groupField === "negative_examples") return b.negative_examples;
          if (groupField === "fallback_yes_criterion") return b.fallback_yes_criterion;
          return b.substantive_definition;
        };

        let result: { updates: any[]; provider: string } | null = null;
        const regenerator = BATCH_REGENERATORS[groupKey];
        if (!regenerator) {
          for (const p of groupProps) {
            const reason = `not applied: no regenerator wired for group '${groupKey}'`;
            skipped.push({ measureId: p.measureId, reason });
            await recordMeasureEdit(db, {
              workspaceId: ctx.workspaceId, frameworkId, listId, measureId: p.measureId,
              field: groupField || "(unknown)", op: groupOp || null,
              beforeValue: beforeFieldValue(p.measureId),
              source: auditSource(p.measureId), applied: false, skipReason: reason,
            });
          }
          continue;
        }
        try {
          result = await regenerator(measuresForLLM, fctx);
        } catch (e: any) {
          const reason = `LLM regeneration failed: ${e?.message || e}`;
          for (const p of groupProps) {
            skipped.push({ measureId: p.measureId, reason });
            await recordMeasureEdit(db, {
              workspaceId: ctx.workspaceId, frameworkId, listId, measureId: p.measureId,
              field: groupField || "(unknown)", op: groupOp || null,
              beforeValue: beforeFieldValue(p.measureId),
              source: auditSource(p.measureId), applied: false, skipReason: reason,
            });
          }
          continue;
        }

        if (!result || !result.updates || !result.updates.length) {
          // CRITICAL: an LLM batch returning zero updates is exactly the silent
          // skip we are auditing. One row per measure so all affected measures
          // leave a durable trace, not just an in-memory count.
          const reason = "LLM returned no updates";
          for (const p of groupProps) {
            skipped.push({ measureId: p.measureId, reason });
            await recordMeasureEdit(db, {
              workspaceId: ctx.workspaceId, frameworkId, listId, measureId: p.measureId,
              field: groupField || "(unknown)", op: groupOp || null,
              beforeValue: beforeFieldValue(p.measureId),
              source: auditSource(p.measureId), applied: false, skipReason: reason,
            });
          }
          continue;
        }
        for (const u of result.updates) {
          // Persist each field the LLM produced, auditing before/after per field.
          const before = beforeById[u.measureId];
          if (u.substantive_definition) {
            await db.execute(sql`
              UPDATE framework_measures SET substantive_definition = ${u.substantive_definition}, updated_at = NOW()
              WHERE framework_id = ${frameworkId} AND measure_id = ${u.measureId}
            `);
            await recordMeasureEdit(db, {
              workspaceId: ctx.workspaceId, frameworkId, listId, measureId: u.measureId,
              field: "substantive_definition", op: groupOp || null,
              beforeValue: before?.substantive_definition ?? null, afterValue: u.substantive_definition,
              source: auditSource(u.measureId), applied: true,
            });
          }
          if (Array.isArray(u.positive_examples) && u.positive_examples.length) {
            await db.execute(sql`
              UPDATE framework_measures SET positive_examples = ${JSON.stringify(u.positive_examples)}::jsonb, updated_at = NOW()
              WHERE framework_id = ${frameworkId} AND measure_id = ${u.measureId}
            `);
            await recordMeasureEdit(db, {
              workspaceId: ctx.workspaceId, frameworkId, listId, measureId: u.measureId,
              field: "positive_examples", op: groupOp || null,
              beforeValue: before?.positive_examples ?? null, afterValue: u.positive_examples,
              source: auditSource(u.measureId), applied: true,
            });
          }
          if (Array.isArray(u.negative_examples) && u.negative_examples.length) {
            await db.execute(sql`
              UPDATE framework_measures SET negative_examples = ${JSON.stringify(u.negative_examples)}::jsonb, updated_at = NOW()
              WHERE framework_id = ${frameworkId} AND measure_id = ${u.measureId}
            `);
            await recordMeasureEdit(db, {
              workspaceId: ctx.workspaceId, frameworkId, listId, measureId: u.measureId,
              field: "negative_examples", op: groupOp || null,
              beforeValue: before?.negative_examples ?? null, afterValue: u.negative_examples,
              source: auditSource(u.measureId), applied: true,
            });
          }
          // Freshly authored structured scoring_guidance (the refine path now
          // authors the same qualifyingInstance/disqualifiers/anchors/yesRequiresQuote
          // fields the create/intake paths do). Merge additively onto the measure's
          // existing scoring_guidance so prior guidance is never blanked; only
          // persist when the merge actually changed something.
          if (u.scoring_guidance) {
            const beforeGuidance = before?.scoring_guidance ?? null;
            const mergedGuidance = mergeStructuredIntoScoringGuidance(beforeGuidance, u.scoring_guidance);
            if (mergedGuidance && mergedGuidance !== (beforeGuidance ?? "")) {
              await db.execute(sql`
                UPDATE framework_measures SET scoring_guidance = ${mergedGuidance}, updated_at = NOW()
                WHERE framework_id = ${frameworkId} AND measure_id = ${u.measureId}
              `);
              await recordMeasureEdit(db, {
                workspaceId: ctx.workspaceId, frameworkId, listId, measureId: u.measureId,
                field: "scoring_guidance", op: groupOp || null,
                beforeValue: beforeGuidance, afterValue: mergedGuidance,
                source: auditSource(u.measureId), applied: true,
              });
            }
          }
          applied.push({ measureId: u.measureId, action: `regenerated:${groupKey}`, source: "llm" });
        }
        // Any group proposal without a returned update:
        const returnedIds = new Set(result.updates.map((u: any) => u.measureId));
        for (const p of groupProps) {
          if (!returnedIds.has(p.measureId)) {
            const reason = "LLM did not return update for this measureId";
            skipped.push({ measureId: p.measureId, reason });
            await recordMeasureEdit(db, {
              workspaceId: ctx.workspaceId, frameworkId, listId, measureId: p.measureId,
              field: groupField || "(unknown)", op: groupOp || null,
              beforeValue: beforeFieldValue(p.measureId),
              source: auditSource(p.measureId), applied: false, skipReason: reason,
            });
          }
        }
      }
    }

    // Walk actions and apply.
    const applied: any[] = [];
    const skipped: any[] = [];
    const dismissed: any[] = [];
    const deferredForLLM: any[] = [];
    for (const action of actions) {
      if (action.type === "apply_edit") {
        // Resolve the accepted proposal against the FRESHLY re-derived bundle by
        // its stable identity (measureId + flagRule + patch.op + patch.path).
        // The legacy positional "P<n>" index no longer lines up because the
        // re-derived bundle may be shorter/reordered after rescore.
        const match = resolveProposalByIdentity(allProposals, action.attrs);
        const auditSource = `proposal:${action.attrs.flagRule || action.attrs.proposal || "?"}`;

        let prop: any = null;
        if (match.status === "matched") {
          prop = match.proposal;
        } else if (match.status === "absent") {
          // Identity was provided but no proposal in the re-derived bundle matches:
          // the flag no longer fires after rescore, so the proposal is genuinely gone.
          const reason = "proposal no longer present (flag no longer fires after rescore)";
          skipped.push({ action, reason });
          await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: String(action.attrs.measure || "(unknown)"), field: "(proposal)", op: "apply_edit", source: auditSource, applied: false, skipReason: reason });
          continue;
        } else if (match.status === "ambiguous") {
          const reason = "ambiguous proposal identity";
          skipped.push({ action, reason });
          await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: String(action.attrs.measure || "(unknown)"), field: "(proposal)", op: "apply_edit", source: auditSource, applied: false, skipReason: reason });
          continue;
        } else {
          // status === "no-identity": fully old client sent only positional P<idx>.
          const idx = parseInt(String(action.attrs.proposal || "").replace(/^P/, ""), 10) - 1;
          // Positional fallback reads from allProposals; its edit-proposal prefix
          // is identical to editsBundle.proposals, so legacy P<idx> stays correct.
          prop = allProposals[idx];
          if (!prop) {
            const reason = "proposal not found";
            skipped.push({ action, reason });
            await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: String(action.attrs.measure || "(unknown)"), field: "(proposal)", op: "apply_edit", source: `proposal:${action.attrs.proposal || "?"}`, applied: false, skipReason: reason });
            continue;
          }
        }
        if (DIRECT_MEASURE_OPS.includes(prop.patch?.op)) {
          // Direct per-measure column writes: "replace" + the calibration/
          // annotation ops (set_expected_yes_rate, flag_non_discriminating).
          await applyProposal(prop, applied, skipped);
        } else if (FRAMEWORK_LEVEL_OPS.includes(prop.patch?.op)) {
          // Framework-level additive ops (add_synonyms / add_adjacent_topics /
          // add_anchor_frameworks) are applied directly to a jsonb column on
          // `frameworks`; they never go through LLM regeneration.
          await applyFrameworkLevelProposal(prop, applied, skipped);
        } else {
          deferredForLLM.push(prop);
        }
      } else if (action.type === "dismiss") {
        // Explicitly DISMISS a proposal without changing the measure. This is a
        // pure audit/suppression write: it records a measure_edits row with
        // applied=false and skip_reason='dismissed' so deriveProposalBundle's
        // resolved-proposal suppression stops re-surfacing this proposal on
        // subsequent results loads. It must NOT mutate any measure and must NOT
        // push to `applied` (which would wrongly trigger the auto-rescore tail).
        // We resolve by identity so the persisted (measureId, field, op) key
        // matches proposalKeyFromProposal for the SAME proposal; if the proposal
        // is no longer present we still record from the client-supplied attrs so
        // the dismissal sticks.
        const match = resolveProposalByIdentity(allProposals, action.attrs);
        const prop: any = match.status === "matched" ? match.proposal : null;
        const measureId = String(prop?.measureId ?? action.attrs.measure ?? "(unknown)");
        const field = String(prop?.patch?.path ?? prop?.fieldPath ?? action.attrs.path ?? "(proposal)");
        const op = String(prop?.patch?.op ?? action.attrs.op ?? "dismiss");
        const flagRule = prop?.flagRule ?? action.attrs.flagRule;
        const auditSource = flagRule ? `proposal:${flagRule}` : "user_dismiss";
        await recordMeasureEdit(db, {
          workspaceId: ctx.workspaceId,
          frameworkId,
          listId,
          measureId,
          field,
          op,
          source: auditSource,
          applied: false,
          skipReason: "dismissed",
        });
        dismissed.push({ measureId, field, op, flagRule });
      } else if (action.type === "ignore_measure") {
        // No-op on framework; record for audit only.
        applied.push({ measureId: action.attrs.measure, action: "ignore", reason: action.attrs.reason });
      } else if (action.type === "add_synonyms") {
        // Append mined terminology-gap terms to the framework's topic_synonyms,
        // de-duplicated against existing entries (case preserved as supplied).
        const newTerms = String(action.attrs.terms || "").split(",").map((t: string) => t.trim()).filter(Boolean);
        if (newTerms.length > 0) {
          // Framework-level edit (topic_synonyms lives on frameworks, not
          // framework_measures) — audited under a generic sentinel measure id.
          let beforeSyn: any = null;
          try {
            const synQ = await db.execute(sql`SELECT topic_synonyms FROM frameworks WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId} LIMIT 1`);
            beforeSyn = ((synQ as any).rows || [])[0]?.topic_synonyms ?? null;
          } catch { /* best-effort */ }
          await db.execute(sql`
            UPDATE frameworks
            SET topic_synonyms = (
              SELECT jsonb_agg(DISTINCT term)
              FROM (
                SELECT jsonb_array_elements_text(COALESCE(topic_synonyms, '[]'::jsonb)) AS term
                UNION
                SELECT jsonb_array_elements_text(${JSON.stringify(newTerms)}::jsonb) AS term
              ) sub
            )
            WHERE id = ${frameworkId} AND workspace_id = ${ctx.workspaceId}
          `);
          applied.push({ action: "add_synonyms", terms: newTerms });
          await recordMeasureEdit(db, {
            workspaceId: ctx.workspaceId, frameworkId, listId, measureId: "(framework)",
            field: "topic_synonyms", op: "add_synonyms", beforeValue: beforeSyn, afterValue: newTerms,
            source: "add_synonyms", applied: true,
          });
        } else {
          skipped.push({ action, reason: "no terms supplied" });
          await recordMeasureEdit(db, {
            workspaceId: ctx.workspaceId, frameworkId, listId, measureId: "(framework)",
            field: "topic_synonyms", op: "add_synonyms", source: "add_synonyms",
            applied: false, skipReason: "no terms supplied",
          });
        }
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
          if (DIRECT_MEASURE_OPS.includes(prop.patch?.op)) await applyProposal(prop, applied, skipped);
          else if (FRAMEWORK_LEVEL_OPS.includes(prop.patch?.op)) await applyFrameworkLevelProposal(prop, applied, skipped);
          else deferredForLLM.push(prop);
        }
      } else if (action.type === "apply_custom_edit") {
        // Generic free-text edit: regenerate ONE field of ONE measure per the
        // user's described change. Guarantees a described edit always executes.
        const measureId = String(action.attrs.measure || "").trim();
        const field = String(action.attrs.field || "").trim() as CustomEditField;
        const instruction = String(action.attrs.instruction || "").trim();
        if (!measureId) {
          const reason = "not applied: missing 'measure' id";
          skipped.push({ action, reason });
          await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: "(unknown)", field: field || "(unknown)", op: "custom_edit", source: "custom_edit", applied: false, skipReason: reason });
          continue;
        }
        if (!(CUSTOM_EDIT_FIELDS as readonly string[]).includes(field)) {
          const reason = `not applied: field '${field}' is not editable (allowed: ${CUSTOM_EDIT_FIELDS.join(", ")})`;
          skipped.push({ action, reason });
          await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId, field: field || "(unknown)", op: "custom_edit", source: "custom_edit", applied: false, skipReason: reason });
          continue;
        }
        if (!instruction) {
          const reason = "not applied: missing 'instruction'";
          skipped.push({ action, reason });
          await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId, field, op: "custom_edit", source: "custom_edit", applied: false, skipReason: reason });
          continue;
        }
        const measure = await loadMeasure(measureId);
        if (!measure) {
          const reason = `not applied: measure '${measureId}' not found`;
          skipped.push({ action, reason });
          await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId, field, op: "custom_edit", source: "custom_edit", applied: false, skipReason: reason });
          continue;
        }
        try {
          const fctx = await loadFrameworkContext();
          const before = fieldValueOf(measure, field);
          const { value: after, scoringGuidance } = await regenerateMeasureField(measure, field, instruction, fctx);
          if (after == null || (Array.isArray(after) && after.length === 0)) {
            const reason = "not applied: LLM returned no usable value for this field";
            skipped.push({ measureId, action: "apply_custom_edit", field, reason });
            await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId, field, op: "custom_edit", beforeValue: before, source: "custom_edit", applied: false, skipReason: reason });
            continue;
          }
          await persistMeasureField(measureId, field, after);
          applied.push({ measureId, action: "custom_edit", field, instruction, before, after, source: "llm" });
          await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId, field, op: "custom_edit", beforeValue: before, afterValue: after, source: "custom_edit", applied: true });
          // When the deciding criteria were rewritten, the same call also re-authored
          // the structured scoring_guidance. Merge it additively onto the measure's
          // existing scoring_guidance (never blanking prior guidance) and persist.
          if (field === "substantive_definition" && scoringGuidance) {
            const beforeGuidance = measure.scoring_guidance ?? null;
            const mergedGuidance = mergeStructuredIntoScoringGuidance(beforeGuidance, scoringGuidance);
            if (mergedGuidance && mergedGuidance !== (beforeGuidance ?? "")) {
              await db.execute(sql`UPDATE framework_measures SET scoring_guidance = ${mergedGuidance}, updated_at = NOW() WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}`);
              await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId, field: "scoring_guidance", op: "custom_edit", beforeValue: beforeGuidance, afterValue: mergedGuidance, source: "custom_edit", applied: true });
            }
          }
        } catch (e: any) {
          const reason = `not applied: regeneration failed: ${e?.message || e}`;
          skipped.push({ measureId, action: "apply_custom_edit", field, reason });
          await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId, field, op: "custom_edit", source: "custom_edit", applied: false, skipReason: reason });
        }
      } else if (action.type === "merge_or_differentiate") {
        // Resolve a near-duplicate pair. mode="differentiate" (default) rewrites
        // measureA's substantive_definition to test a distinct artefact from
        // measureB; mode="merge" retires measureB (keeping measureA), deleting
        // its framework_measures row and its measure_scores rows so counts stay
        // consistent. Human-selected; neither branch auto-deletes without intent.
        const measureAId = String(action.attrs.measureA || action.attrs.measure || "").trim();
        const measureBId = String(action.attrs.measureB || "").trim();
        const mode = (String(action.attrs.mode || "differentiate").trim().toLowerCase() === "merge") ? "merge" : "differentiate";
        if (!measureAId || !measureBId) {
          const reason = "not applied: both 'measureA' and 'measureB' required";
          skipped.push({ action, reason });
          await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: measureAId || "(unknown)", field: "substantive_definition", op: mode, source: mode, applied: false, skipReason: reason });
          continue;
        }
        const mA = await loadMeasure(measureAId);
        const mB = await loadMeasure(measureBId);
        if (!mA || !mB) {
          const reason = `not applied: measure(s) not found (${!mA ? measureAId : ""}${!mA && !mB ? ", " : ""}${!mB ? measureBId : ""})`;
          skipped.push({ action, reason });
          await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: measureAId, field: "substantive_definition", op: mode, source: mode, applied: false, skipReason: reason });
          continue;
        }
        if (mode === "merge") {
          try {
            await db.execute(sql`DELETE FROM measure_scores WHERE framework_id = ${frameworkId} AND measure_id = ${measureBId}`);
            await db.execute(sql`DELETE FROM framework_measures WHERE framework_id = ${frameworkId} AND measure_id = ${measureBId}`);
            const cntQ = await db.execute(sql`SELECT COUNT(*)::int AS n FROM framework_measures WHERE framework_id = ${frameworkId}`);
            const remaining = ((cntQ as any).rows || [])[0]?.n ?? null;
            applied.push({ action: "merge", keptMeasureId: measureAId, retiredMeasureId: measureBId, remainingMeasureCount: remaining });
            // Audited against the retired measure — it is the row that changed
            // (deleted). before = its prior definition, after = null.
            await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: measureBId, field: "(measure)", op: "merge", beforeValue: mB.substantive_definition, afterValue: null, source: `merge:kept=${measureAId}`, applied: true });
          } catch (e: any) {
            const reason = `not applied: merge failed: ${e?.message || e}`;
            skipped.push({ action, reason });
            await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: measureBId, field: "(measure)", op: "merge", source: `merge:kept=${measureAId}`, applied: false, skipReason: reason });
          }
        } else {
          try {
            const fctx = await loadFrameworkContext();
            const before = mA.substantive_definition;
            const { value: after, scoringGuidance } = await differentiateMeasureDefinition(mA, mB, fctx);
            if (!after) {
              const reason = "not applied: LLM returned no differentiated definition";
              skipped.push({ action, reason });
              await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: measureAId, field: "substantive_definition", op: "differentiate", beforeValue: before, source: `differentiate:against=${measureBId}`, applied: false, skipReason: reason });
              continue;
            }
            await persistMeasureField(measureAId, "substantive_definition", after);
            applied.push({ measureId: measureAId, action: "differentiate", against: measureBId, before, after, source: "llm" });
            await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: measureAId, field: "substantive_definition", op: "differentiate", beforeValue: before, afterValue: after, source: `differentiate:against=${measureBId}`, applied: true });
            // Persist the co-authored structured scoring_guidance additively onto
            // measureA's existing guidance (never blanking prior guidance).
            if (scoringGuidance) {
              const beforeGuidance = mA.scoring_guidance ?? null;
              const mergedGuidance = mergeStructuredIntoScoringGuidance(beforeGuidance, scoringGuidance);
              if (mergedGuidance && mergedGuidance !== (beforeGuidance ?? "")) {
                await db.execute(sql`UPDATE framework_measures SET scoring_guidance = ${mergedGuidance}, updated_at = NOW() WHERE framework_id = ${frameworkId} AND measure_id = ${measureAId}`);
                await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: measureAId, field: "scoring_guidance", op: "differentiate", beforeValue: beforeGuidance, afterValue: mergedGuidance, source: `differentiate:against=${measureBId}`, applied: true });
              }
            }
          } catch (e: any) {
            const reason = `not applied: differentiate failed: ${e?.message || e}`;
            skipped.push({ action, reason });
            await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: measureAId, field: "substantive_definition", op: "differentiate", source: `differentiate:against=${measureBId}`, applied: false, skipReason: reason });
          }
        }
      } else {
        const reason = `not applied: unknown action type '${action.type}'`;
        skipped.push({ action, reason });
        await recordMeasureEdit(db, { workspaceId: ctx.workspaceId, frameworkId, listId, measureId: String(action?.attrs?.measure || "(unknown)"), field: "(action)", op: String(action?.type || "unknown"), source: "action", applied: false, skipReason: reason });
      }
    }

    // Run batched LLM regeneration for any deferred proposals.
    await runBatchedRegenerations(deferredForLLM, applied, skipped);

    // ── Auto-trigger the re-score server-side ──────────────────────────────
    // A large apply can run several minutes; Railway's edge proxy cuts any HTTP
    // connection at ~300s, so the browser frequently never receives this
    // response and therefore never fires the follow-up /v2/rescore. To make the
    // iteration reliable we trigger the re-score here, in-process, exactly the
    // way POST /v2/rescore does — independent of the browser surviving the
    // request. The client MUST NOT fire a second rescore (that would trip the
    // single-active-batch 409 / create a duplicate batch).
    let rescoreTriggered = false;
    let newBatchId: number | undefined;
    let rescoreTotalJobs: number | undefined;
    let rescoreSkippedReason: string | undefined;
    let rescoreError: string | undefined;
    if (applied.length > 0) {
      try {
        // Idempotent snapshot of the batch about to be replaced in measure_scores.
        await snapshotIteration(frameworkId, listId, ctx.workspaceId);
        const cookieHeader = req.headers.cookie || "";
        const port = process.env.PORT || "3000";
        const analyzeResp = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: cookieHeader },
          body: JSON.stringify({ frameworkId, listId }),
        });
        const analyzeJson: any = await analyzeResp.json().catch(() => ({}));
        if (analyzeResp.ok) {
          rescoreTriggered = true;
          newBatchId = analyzeJson?.batchId;
          rescoreTotalJobs = analyzeJson?.totalJobs;
        } else if (analyzeResp.status === 409) {
          // A batch is already running / pending review — non-fatal. The apply
          // itself fully succeeded; just report that a rescore wasn't started.
          rescoreSkippedReason =
            analyzeJson?.error || (analyzeJson?.pendingReview ? "pendingReview" : "alreadyRunning");
        } else {
          rescoreError = analyzeJson?.error || `analyze route returned ${analyzeResp.status}`;
        }
      } catch (e: any) {
        // A rescore-trigger failure must never turn a fully-successful apply into
        // a 500. Report it and let the client recover / offer a manual re-score.
        rescoreError = e?.message || "rescore trigger failed";
        console.error("[framework-builder v2 /improvement/apply] rescore trigger failed:", e);
      }
    } else {
      rescoreSkippedReason = "no edits applied";
    }

    return res.json({
      applied,
      skipped,
      dismissed,
      appliedCount: applied.length,
      skippedCount: skipped.length,
      dismissedCount: dismissed.length,
      rescoreTriggered,
      newBatchId,
      rescoreTotalJobs,
      rescoreSkippedReason,
      rescoreError,
    });
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

// ─── GET /v2/:frameworkId/export-full — full-detail markdown export ───────

router.get("/v2/:frameworkId/export-full", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const frameworkId = parseInt(String(req.params.frameworkId), 10);
    if (!Number.isFinite(frameworkId) || frameworkId <= 0) {
      return res.status(400).json({ error: "valid frameworkId required" });
    }

    const ctx = getSessionContext(req);
    if (!ctx?.workspaceId) return res.status(401).json({ error: "workspace required" });

    const fw = await storage.getFrameworkById(frameworkId, ctx.workspaceId);
    if (!fw) {
      return res.status(404).json({ error: "framework not found" });
    }
    const measures = await storage.getFrameworkMeasures(frameworkId);

    const markdown = exportFrameworkAsFullDetail({
      framework: fw as any,
      measures: (measures as any[]) || [],
    });

    const slug = String((fw as any).name || `framework-${frameworkId}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `framework-${frameworkId}`;

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}-full-export.md"`);
    return res.send(markdown);
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

// ─── Design-diagnostic mapping (in-memory draft → DiagnosticMeasure) ──────
// Draft measures arrive from the LLM with the same mixed snake_case/camelCase
// field names the /v2/save route reads (see createFrameworkMeasure mapping).
// This normalises them into the diagnostic's DiagnosticMeasure shape so the
// STATIC pre-test analyzer (LLM-free) can run before a draft is proposed.
export function draftMeasureToDiagnostic(m: any, fallbackId: string): DiagnosticMeasure {
  const asText = (v: any): string | null | undefined =>
    typeof v === "string" ? v : Array.isArray(v) ? v.join("\n") : v == null ? v : String(v);
  return {
    measureId: (typeof m?.measureId === "string" && m.measureId) || fallbackId,
    title: m?.title ?? null,
    definition: m?.definition ?? null,
    primaryAssessmentTarget: m?.primary_assessment_target ?? m?.primaryAssessmentTarget ?? null,
    substantiveDefinition: m?.substantive_definition ?? m?.substantiveDefinition ?? null,
    whatConstitutesEvidence: asText(m?.whatConstitutesEvidence ?? m?.what_constitutes_evidence),
    whatDoesNotConstituteEvidence: asText(m?.whatDoesNotConstituteEvidence ?? m?.what_does_not_constitute_evidence),
    fallbackYesCriterion: m?.fallback_yes_criterion ?? m?.fallbackYesCriterion ?? null,
    positiveExamples: m?.positive_examples ?? m?.positiveExamples ?? null,
    negativeExamples: m?.negative_examples ?? m?.negativeExamples ?? null,
    scoringGuidance:
      typeof m?.scoringGuidance === "string" ? m.scoringGuidance : m?.scoringGuidance ?? null,
  };
}

// Run the STATIC (pre-test only) design diagnostic over an in-memory draft.
// No DB, no LLM — purely lexical over the just-drafted measures. Returns the
// diagnostic report so the builder can surface design defects for REVIEW BEFORE
// proposing the draft as ready. Advisory only; never auto-applied.
export function buildDraftDesignDiagnostic(draft: any, intake: IntakeArtefact): DiagnosticReport {
  const raw = flattenMeasures(draft);
  const measures: DiagnosticMeasure[] = raw.map((m, i) =>
    draftMeasureToDiagnostic(m, `${i + 1}`),
  );
  return buildDiagnosticReport({
    frameworkId: 0, // no persisted framework id yet at draft time
    frameworkName: draft?.framework?.name || intake.topic || null,
    measures,
    runs: [], // pre-test only — no scoring has happened yet
  });
}

// Run the design diagnostic over a COMPLETED test-drive: static pre-test over
// the framework's measure definitions, post-test signals over the just-completed
// batch's stored cells (measure_scores — carrying the deterministic
// rationale-score inconsistency flag), and run-to-run flip rate across every
// snapshotted iteration for this framework+list. Read-only over stored results:
// NO re-scoring, NO worker call, NO LLM. `currentRows` are the measure_scores
// rows already fetched by the results route; `currentIterationNumber` is the
// snapshot just written for this batch (excluded from the reconstructed prior
// runs so it is not counted twice).
async function buildTestDriveDesignDiagnostic(
  frameworkId: number,
  listId: number,
  frameworkName: string | null,
  currentRows: any[],
  currentIterationNumber?: number,
): Promise<DiagnosticReport> {
  const asText = (v: any): string | null =>
    typeof v === "string" ? v : Array.isArray(v) ? v.join("\n") : v == null ? null : String(v);

  // 1. Measure definitions → DiagnosticMeasure[] (static pre-test inputs).
  const mq = await db.execute(sql`
    SELECT measure_id, title, definition, primary_assessment_target,
           substantive_definition, what_constitutes_evidence,
           what_does_not_constitute_evidence, fallback_yes_criterion,
           positive_examples, negative_examples, scoring_guidance
    FROM framework_measures WHERE framework_id = ${frameworkId}
    ORDER BY category_number, display_order
  `);
  const measures: DiagnosticMeasure[] = (((mq as any).rows || []) as any[]).map((m) => ({
    measureId: String(m.measure_id),
    title: m.title ?? null,
    definition: m.definition ?? null,
    primaryAssessmentTarget: m.primary_assessment_target ?? null,
    substantiveDefinition: m.substantive_definition ?? null,
    whatConstitutesEvidence: asText(m.what_constitutes_evidence),
    whatDoesNotConstituteEvidence: asText(m.what_does_not_constitute_evidence),
    fallbackYesCriterion: m.fallback_yes_criterion ?? null,
    positiveExamples: m.positive_examples ?? null,
    negativeExamples: m.negative_examples ?? null,
    scoringGuidance: asText(m.scoring_guidance),
  }));

  // 2. Just-completed batch cells (only these carry the inconsistency flag).
  const currentCells: StoredCell[] = (currentRows || []).map((r) => ({
    companyId: r.company_id,
    measureId: String(r.measure_id),
    verdict: r.verdict ?? null,
    confidence: r.confidence ?? null,
    score: typeof r.score === "number" ? r.score : null,
    rationaleScoreInconsistent: r.rationale_score_inconsistent === true,
  }));

  // 3. Prior iterations reconstructed from snapshots (exclude current batch's).
  const iterQ = await db.execute(sql`
    SELECT iteration_number, per_measure FROM framework_v2_iterations
    WHERE framework_id = ${frameworkId} AND list_id = ${listId}
    ORDER BY iteration_number ASC
  `);
  const priorRuns: StoredCell[][] = [];
  for (const it of (((iterQ as any).rows || []) as any[])) {
    if (currentIterationNumber && Number(it.iteration_number) === currentIterationNumber) continue;
    const perMeasure = (it.per_measure || {}) as Record<string, any>;
    const cells: StoredCell[] = [];
    for (const [measureId, agg] of Object.entries(perMeasure)) {
      const verdicts = (agg?.verdictsByCompany || {}) as Record<string, string>;
      const confs = (agg?.confidenceByCompany || {}) as Record<string, string>;
      for (const [cid, verdict] of Object.entries(verdicts)) {
        cells.push({ companyId: cid, measureId, verdict: verdict ?? null, confidence: confs[cid] ?? null });
      }
    }
    if (cells.length > 0) priorRuns.push(cells);
  }

  // Current run first, then priors. Post-test aggregates across runs; multi-run
  // flip rate needs ≥2 non-empty runs (auto-enabled once a re-test exists).
  const runs: StoredCell[][] = [currentCells, ...priorRuns];

  return buildDiagnosticReport({ frameworkId, frameworkName, measures, runs, batchIds: [] });
}

export default router;
