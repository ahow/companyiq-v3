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
import { INTAKE_SYSTEM_PROMPT, DRAFTING_SYSTEM_PROMPT_HEAD } from "../lib/framework-v2/intake-prompt.js";
import { exportFrameworkAsSeedTemplate, type ExistingFrameworkForExport } from "../lib/framework-v2/export-as-seed.js";
import { analyseTestDrive, buildSampleSelectionPrompt, type TestDriveCompanyResult, type TestDriveSampleRequest } from "../lib/framework-v2/test-drive.js";
import * as storage from "../storage.js";

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

// ─── POST /v2/draft — draft the framework from a confirmed intake ────────

router.post("/v2/draft", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const { intake, providerName } = req.body as {
      intake: IntakeArtefact;
      providerName?: string;
    };
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

    const { completeWithFallback } = await import("../lib/ai-providers.js");

    const draftPrompt = `Intake artefact (JSON):
${JSON.stringify(intake, null, 2)}

Draft the framework now, following construction rules C1–C10 exactly.`;

    const { text: response } = await completeWithFallback(providerName || "claude", {
      system: DRAFTING_SYSTEM_PROMPT_HEAD,
      prompt: draftPrompt,
      maxTokens: 16000,
      temperature: 0.2,
      json: true,
    });

    let draft: any = null;
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) || response.match(/\{[\s\S]*\}/);
      draft = jsonMatch ? JSON.parse(jsonMatch[1] ?? jsonMatch[0]) : JSON.parse(response);
    } catch (e) {
      return res.status(500).json({ error: "Could not parse framework JSON from LLM response", raw: response });
    }

    // Flatten categories into a FrameworkDraft for validation
    const measures = flattenMeasures(draft);
    const fwDraft: FrameworkDraft = {
      name: draft.framework?.name || intake.topic || "unnamed",
      topicTerm: draft.framework?.topicTerm || intake.topicTerm,
      topicSynonyms: draft.framework?.topicSynonyms || intake.topicSynonyms || [],
      adjacentTopics: draft.framework?.adjacentTopics || intake.adjacentTopics,
      anchorFrameworks: draft.framework?.anchorFrameworks || intake.anchorFrameworks,
      sensitivityPreference: draft.framework?.sensitivityPreference || intake.sensitivityPreference,
      measures,
    };
    const validation = validateAll(fwDraft);

    return res.json({
      draft,
      measures,
      validation,
      summary: summariseViolations(validation.violations),
    });
  } catch (err: any) {
    console.error("[framework-builder v2 /draft] error:", err);
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
    const measures = flattenMeasures(draft);
    const fwDraft: FrameworkDraft = {
      name: draft.framework.name || intake.topic || "unnamed",
      topicTerm: draft.framework.topicTerm || intake.topicTerm,
      topicSynonyms: draft.framework.topicSynonyms || intake.topicSynonyms || [],
      adjacentTopics: draft.framework.adjacentTopics || intake.adjacentTopics,
      anchorFrameworks: draft.framework.anchorFrameworks || intake.anchorFrameworks,
      sensitivityPreference: draft.framework.sensitivityPreference || intake.sensitivityPreference,
      measures,
    };
    const validation = validateAll(fwDraft);
    if (!validation.passed) {
      return res.status(400).json({
        error: "Framework fails C1-C10 validation and cannot be saved",
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

// ─── POST /v2/test-drive/analyse — analyse scored test-drive results ─────
// Caller passes company-level results already produced by the existing pipeline.
// This endpoint applies flag rules and returns a fix plan.

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
