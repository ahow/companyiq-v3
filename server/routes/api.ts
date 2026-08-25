import { Router, Request, Response } from "express";
import multer from "multer";
import * as storage from "../storage.js";
import { requireWorkspace, getSessionContext } from "../middleware/auth.js";
import { addBatchJobs, removeBatchJobs, getQueueStats } from "../queue.js";
import { cancelBatch, enqueueReliabilityFinalizer, finalizeBatchAndSave, saveBatchSnapshot } from "../worker.js";
import {
  getAllPausedProviders,
  buildOperationalStatus,
  resumeProvider,
  getConfiguredFallbackOrder,
} from "../lib/provider-resilience.js";
import { getAvailableProviders, getProviderStatus } from "../lib/ai-providers.js";
import { resetProvider as resetCreditBreaker, isProviderTripped, clearCreditAlert } from "../lib/credit-breaker.js";
import { detectScoreAnomalies } from "../lib/anomaly-detection.js";
import { db } from "../db.js";
import { sql } from "drizzle-orm";
import { assertProductionFingerprint, computeRecoveryLabels, deploymentFingerprintFromEnvironment, isTerminalLifecycleState, type DeploymentFingerprint } from "../lib/reliability.js";
import { analyzeCompanyMeasures } from "../lib/analyzer.js";
export const apiRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// All API routes require workspace context
apiRouter.use(requireWorkspace);

// ─── QA Worklist ────────────────────────────────────────────────────────────
// Residual companies that exhausted bounded auto-re-examination and are flagged
// for human review (discoveryDiagnostics.qaFlag.flagged = true). Read-only.
apiRouter.get("/qa/worklist", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const companies = await storage.getCompanies(workspaceId);
    const items = companies
      .filter((c: any) => {
        const d = c.discoveryDiagnostics;
        return d && typeof d === "object" && d.qaFlag && d.qaFlag.flagged === true;
      })
      .map((c: any) => {
        const d = c.discoveryDiagnostics || {};
        const fc = d.fetchCoverage || {};
        return {
          id: c.id,
          name: c.name,
          analysisStatus: c.analysisStatus,
          totalScore: c.totalScore,
          qaReason: d.qaFlag?.reason ?? null,
          flaggedAt: d.qaFlag?.flaggedAt ?? null,
          autoReexamAttempts: d.autoReexam?.count ?? 0,
          reconcileAttempts: d.reconcile?.count ?? 0,
          documentsDiscovered: fc.documentsDiscovered ?? null,
          documentsFetched: fc.documentsFetched ?? null,
          documentsDead: fc.documentsDead ?? null,
          fetchRatio: fc.fetchRatio ?? null,
          lowEvidence: fc.lowEvidence ?? null,
        };
      })
      .sort((a: any, b: any) => (a.documentsFetched ?? 0) - (b.documentsFetched ?? 0));
    res.json({ count: items.length, items });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Companies ──────────────────────────────────────────────────────────────

apiRouter.get("/companies", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const companies = await storage.getCompanies(workspaceId);

    const total = companies.length;
    const completed = companies.filter((c) => c.analysisStatus === "completed").length;
    const scores = companies.filter((c) => c.totalScore !== null).map((c) => c.totalScore!);
    const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

    res.json({
      companies,
      stats: { total, completed, avgScore },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.get("/companies/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const company = await storage.getCompanyById(parseInt(req.params.id), workspaceId);
    if (!company) return res.status(404).json({ error: "Company not found" });

    const scores = await storage.getMeasureScores(company.id);
    const documents = await storage.getAcceptedDocuments(company.id);

    res.json({ company, scores, documents });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/companies", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const company = await storage.createCompany({ ...req.body, workspaceId });
    res.json(company);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.patch("/companies/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const company = await storage.updateCompany(parseInt(req.params.id), workspaceId, req.body);
    res.json(company);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.delete("/companies/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    await storage.deleteCompany(parseInt(req.params.id), workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Reset a single company (clear scores, status, summary)
apiRouter.post("/companies/:id/reset", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const companyId = parseInt(req.params.id);
    await storage.clearMeasureScores(companyId);
    // Also clear dead documents so fresh discovery can find better sources
    await storage.clearDiscoveredDocuments(companyId);
    await storage.updateCompany(companyId, workspaceId, { analysisStatus: "idle", totalScore: null, summary: null });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Reset all companies in a list
apiRouter.post("/lists/:id/reset", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const listId = parseInt(req.params.id);
    const list = await storage.getListById(listId, workspaceId);
    if (!list) return res.status(404).json({ error: "List not found" });
    const resetCount = await storage.resetListCompanies(listId, workspaceId);
    res.json({ success: true, resetCount, listName: list.name });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Reset all companies in workspace (soft: keeps ok documents)
apiRouter.post("/companies/reset-all", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const resetCount = await storage.resetAllCompanies(workspaceId);
    res.json({ success: true, resetCount });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Full reset a single company (purge ALL documents including ok)
apiRouter.post("/companies/:id/full-reset", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const companyId = parseInt(req.params.id);
    await storage.clearMeasureScores(companyId);
    await storage.fullResetCompanyDocuments(companyId);
    await storage.updateCompany(companyId, workspaceId, {
      analysisStatus: "idle", totalScore: null, summary: null,
      measuresMetCount: null, measuresTotalCount: null, discoveryDiagnostics: null
    } as any);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Full reset all companies in a list (purge ALL documents)
apiRouter.post("/lists/:id/full-reset", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const listId = parseInt(req.params.id);
    const list = await storage.getListById(listId, workspaceId);
    if (!list) return res.status(404).json({ error: "List not found" });
    // Guard: reject reset if any batch is currently in-flight for this list
    const activeBatches = await storage.getActiveBatchesForList(listId, workspaceId);
    if (activeBatches.length > 0) {
      return res.status(409).json({
        error: "Cannot reset while a batch is in-flight",
        activeBatchIds: activeBatches.map((b: any) => b.id),
        hint: "Wait for the batch to complete or cancel it first."
      });
    }
    const resetCount = await storage.fullResetListCompanies(listId, workspaceId);
    res.json({ success: true, resetCount, listName: list.name });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Full reset all companies in workspace (purge ALL documents)
apiRouter.post("/companies/full-reset-all", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const resetCount = await storage.fullResetAllCompanies(workspaceId);
    res.json({ success: true, resetCount });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Company Lists ──────────────────────────────────────────────────────────

apiRouter.get("/lists", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const lists = await storage.getCompanyLists(workspaceId);
    res.json(lists);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/lists", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const list = await storage.createCompanyList(workspaceId, req.body.name, req.body.description);
    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.patch("/lists/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const listId = parseInt(req.params.id);
    const { isShared } = req.body;
    if (isShared !== undefined) {
      await storage.updateCompanyList(listId, workspaceId, { isShared });
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.get("/lists/:id/companies", async (req: Request, res: Response) => {
  try {
    const companies = await storage.getListCompanies(parseInt(req.params.id));
    res.json(companies.map((c) => c.company));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/lists/:id/companies", async (req: Request, res: Response) => {
  try {
    await storage.addCompanyToList(parseInt(req.params.id), req.body.companyId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Bulk Import Companies ──────────────────────────────────────────────────

apiRouter.post("/companies/import", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const listName = req.body.listName || "Imported List";
    const pastedText = req.body.pastedText;

    // Helper to find a value from multiple possible column names
    function findCol(row: any, ...keys: string[]): string | null {
      for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
          return String(row[key]).trim();
        }
      }
      // Also try case-insensitive partial match
      const rowKeys = Object.keys(row);
      for (const candidate of keys) {
        const found = rowKeys.find(k => k.toLowerCase().includes(candidate.toLowerCase()));
        if (found && row[found] !== undefined && row[found] !== null && String(row[found]).trim() !== "") {
          return String(row[found]).trim();
        }
      }
      return null;
    }

    let rows: any[] = [];

    if (req.file) {
      const mimeType = req.file.mimetype;
      const filename = req.file.originalname.toLowerCase();

      if (
        mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        mimeType === "application/vnd.ms-excel" ||
        filename.endsWith(".xlsx") || filename.endsWith(".xls")
      ) {
        // Parse Excel file
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(sheet);
      } else {
        // Parse CSV file
        const content = req.file.buffer.toString("utf-8");
        const lines = content.split("\n").filter((l: string) => l.trim());
        if (lines.length < 2) {
          return res.status(400).json({ error: "CSV file is empty or has no data rows" });
        }
        // Parse CSV with proper quote handling
        const parseCSVLine = (line: string): string[] => {
          const result: string[] = [];
          let current = "";
          let inQuotes = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
              inQuotes = !inQuotes;
            } else if (ch === ',' && !inQuotes) {
              result.push(current.trim());
              current = "";
            } else {
              current += ch;
            }
          }
          result.push(current.trim());
          return result;
        };
        const headers = parseCSVLine(lines[0]).map(h => h.replace(/^"|"$/g, "").trim());
        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          const obj: any = {};
          headers.forEach((h, idx) => { obj[h] = values[idx]?.replace(/^"|"$/g, "") || undefined; });
          rows.push(obj);
        }
      }
    } else if (pastedText) {
      // Handle pasted text - could be CSV-like or just company names (one per line)
      const lines = pastedText.trim().split("\n").filter((l: string) => l.trim());
      if (lines.length === 0) {
        return res.status(400).json({ error: "No data provided" });
      }

      // Detect if first line is a header
      const firstLine = lines[0].toLowerCase();
      const hasCommas = lines[0].includes(",");
      const looksLikeHeader = firstLine.includes("name") || firstLine.includes("isin") || firstLine.includes("company") || firstLine.includes("sector");

      if (hasCommas) {
        // CSV-like pasted data
        const startIdx = looksLikeHeader ? 1 : 0;
        const headers = looksLikeHeader
          ? lines[0].split(",").map((h: string) => h.trim().replace(/^"|"$/g, ""))
          : ["name", "isin", "sector", "country", "domain"];
        for (let i = startIdx; i < lines.length; i++) {
          const values = lines[i].split(",").map((v: string) => v.trim().replace(/^"|"$/g, ""));
          const obj: any = {};
          headers.forEach((h: string, idx: number) => { obj[h] = values[idx] || undefined; });
          rows.push(obj);
        }
      } else {
        // Plain list of company names (one per line)
        for (const line of lines) {
          if (line.trim()) {
            rows.push({ name: line.trim() });
          }
        }
      }
    } else if (req.body.companies) {
      rows = JSON.parse(req.body.companies);
    } else {
      return res.status(400).json({ error: "No data provided. Upload a CSV/XLSX file or paste company names." });
    }

    // Create companies with flexible column matching
    const created: any[] = [];
    const skipped: string[] = [];
    for (const row of rows) {
      const name = findCol(row, "NAME", "name", "Name", "company", "Company", "COMPANY", "Company Name", "company_name");
      if (!name) continue;

      const isin = findCol(row, "ISIN", "isin", "Type", "type", "Identifier", "ID");
      const sector = findCol(row, "LEVEL2 SECTOR NAME", "LEVEL3 SECTOR NAME", "sector", "Sector", "SECTOR", "Industry", "industry");
      const country = findCol(row, "GEOGRAPHIC DESCR.", "GEOGRAPHIC DESCR", "country", "Country", "COUNTRY", "Geography", "Region");
      const domain = findCol(row, "domain", "Domain", "DOMAIN", "website", "Website", "URL", "url");

      // Finding 1 fix: dedup on IDENTITY (normalized ISIN) first, then fall back to
      // exact-name match only when no ISIN is supplied. This prevents the same
      // security being re-inserted as a duplicate row under a different name casing
      // (e.g. "Citigroup Inc." vs "CITIGROUP INC"). When a match is found we UPDATE
      // the existing row's metadata (so re-uploads keep names/sectors fresh) rather
      // than creating a new row, and we never touch its analysis state.
      const normIsin = (isin || "").trim();
      let existing = normIsin ? await storage.getCompanyByIsin(normIsin, workspaceId) : null;
      if (!existing) existing = await storage.getCompanyByName(name, workspaceId);
      if (existing) {
        // Refresh metadata in place without disturbing analysis status/scores.
        const patch: any = {};
        if (name && name !== existing.name) patch.name = name;
        if (sector && sector !== existing.sector) patch.sector = sector;
        if (country && country !== existing.country) patch.country = country;
        if (domain && domain !== existing.domain) patch.domain = domain;
        if (normIsin && normIsin !== (existing.isin || "")) patch.isin = normIsin;
        if (Object.keys(patch).length > 0) {
          try { existing = await storage.updateCompany(existing.id, workspaceId, patch); } catch { /* keep existing on patch failure */ }
        }
        skipped.push(name);
        created.push(existing);
        continue;
      }

      const company = await storage.createCompany({
        name,
        isin: normIsin || null,
        sector: sector || null,
        country: country || null,
        domain: domain || null,
        workspaceId,
      });
      created.push(company);
    }

    // Create list and add all companies (including existing ones)
    if (listName && created.length > 0) {
      const list = await storage.createCompanyList(workspaceId, listName);
      for (const company of created) {
        await storage.addCompanyToList(list.id, company.id);
      }
    }

    res.json({
      imported: created.length - skipped.length,
      existing: skipped.length,
      total: rows.length,
      listName,
      companies: created,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Frameworks ─────────────────────────────────────────────────────────────

apiRouter.get("/frameworks", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const frameworks = await storage.getFrameworks(workspaceId);
    res.json(frameworks);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.get("/frameworks/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const framework = await storage.getFrameworkById(parseInt(req.params.id), workspaceId);
    if (!framework) return res.status(404).json({ error: "Framework not found" });

    const measures = await storage.getFrameworkMeasures(framework.id);
    res.json({ framework, measures });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/frameworks", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    // Fix D: Reject empty dataPatterns at framework creation time (Instruction 21c strictness)
    if (!req.body.dataPatterns || !Array.isArray(req.body.dataPatterns) || req.body.dataPatterns.length === 0) {
      return res.status(400).json({
        error: "dataPatterns is required — provide ≥2 regex patterns that identify topic-relevant content in fetched documents. See the framework-builder docs for examples.",
      });
    }
    if (req.body.dataPatterns.length < 2) {
      return res.status(400).json({
        error: "dataPatterns must contain at least 2 patterns (used for the ≥2-distinct-hits corpus-validity check).",
      });
    }
    const framework = await storage.createFramework({ ...req.body, workspaceId });
    res.json(framework);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/frameworks/:id/activate", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    await storage.setActiveFramework(parseInt(req.params.id), workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/frameworks/:id/measures", async (req: Request, res: Response) => {
  try {
    const frameworkId = parseInt(req.params.id);
    const { measures } = req.body;

    // Replace all measures
    await storage.deleteFrameworkMeasures(frameworkId);
    for (let i = 0; i < measures.length; i++) {
      const measure = measures[i];
      const measureId = measure.measureId || `m_${frameworkId}_${i + 1}`;
      const categoryNumber = measure.categoryNumber || 1;
      const displayOrder = measure.displayOrder || (i + 1);
      await storage.createFrameworkMeasure({
        ...measure,
        frameworkId,
        measureId,
        categoryNumber,
        displayOrder,
      });
    }

    res.json({ success: true, count: measures.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.patch("/frameworks/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const frameworkId = parseInt(req.params.id);
    const framework = await storage.getFrameworkById(frameworkId, workspaceId);
    if (!framework) return res.status(404).json({ error: "Framework not found" });

    const allowedFields = ["name", "topicDescription", "searchTemplates", "negativeKeywords", "negativeDomains", "knownDisclosureUrls", "trustedSourceIds", "isShared", "requiredDocTypes", "dataPatterns", "legacyQueryTemplates", "multiDocumentQueryTemplates", "authoritativeRegistries", "authoritativeFilingTypes", "scoringExamples", "antiInferenceRules"];
    const updates: Record<string, any> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length > 0) {
      await storage.updateFramework(frameworkId, updates as any);
    }

    const updated = await storage.getFrameworkById(frameworkId, workspaceId);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.delete("/frameworks/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const frameworkId = parseInt(req.params.id);
    await storage.deleteFramework(frameworkId, workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Batch Analysis ─────────────────────────────────────────────────────────

apiRouter.post("/analyze", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const { frameworkId, listId, companyIds, offPeakOnly, scoreOnly } = req.body;
    const testCycleId = typeof req.body.testCycleId === "string" ? req.body.testCycleId.trim() : "";
    const batteryLabel = typeof req.body.batteryLabel === "string" ? req.body.batteryLabel.trim() : "";
    const commitSha = typeof req.body.commitSha === "string" ? req.body.commitSha.trim() : "";
    const diagnosticRun = req.body.diagnosticRun === true;
    const requestedFingerprint = req.body.deploymentFingerprint as DeploymentFingerprint | undefined;
    const liveFingerprint = deploymentFingerprintFromEnvironment();

    // Reliability runs are explicit so ordinary interactive analysis remains
    // backward-compatible. Battery runs are never allowed to proceed on mixed
    // source/app/worker/static-analysis fingerprints unless diagnostic mode is on.
    if (testCycleId || batteryLabel || commitSha || requestedFingerprint) {
      if (!testCycleId || !batteryLabel || !commitSha) {
        return res.status(400).json({ error: "testCycleId, batteryLabel, and commitSha are required for reliability runs" });
      }
      try {
        if (requestedFingerprint && requestedFingerprint.sourceSha && requestedFingerprint.sourceSha !== commitSha && !diagnosticRun) {
          throw new Error("Production battery refused: commit SHA does not match fingerprint source SHA");
        }
        assertProductionFingerprint(requestedFingerprint ?? liveFingerprint, liveFingerprint, diagnosticRun);
      } catch (error: any) {
        return res.status(409).json({ error: error.message, diagnosticRunAllowed: true, fingerprint: liveFingerprint });
      }
    }

    const framework = await storage.getFrameworkById(frameworkId, workspaceId);
    if (!framework) return res.status(404).json({ error: "Framework not found" });

    let companies: any[];
    if (companyIds && companyIds.length > 0) {
      companies = [];
      for (const id of companyIds) {
        const c = await storage.getCompanyById(id, workspaceId);
        if (c) companies.push(c);
      }
    } else if (listId) {
      const listCompanies = await storage.getListCompanies(listId);
      companies = listCompanies.map((c) => c.company);
    } else {
      companies = await storage.getCompanies(workspaceId);
    }
    if (companies.length === 0) return res.status(400).json({ error: "No companies to analyze" });

    let reliability: Awaited<ReturnType<typeof storage.createOrAdoptReliabilityRun>> | null = null;
    let adopted = false;
    if (testCycleId) {
      reliability = await storage.createOrAdoptReliabilityRun({
        workspaceId,
        testCycleId,
        commitSha,
        frameworkId,
        listId: listId ?? null,
        batteryLabel,
        deploymentFingerprint: requestedFingerprint ?? liveFingerprint,
        diagnosticRun,
      });
      adopted = reliability.adopted;
      const existingBatch = await storage.getBatchRunByReliabilityRunId(reliability.run.id, workspaceId);
      if (isTerminalLifecycleState(reliability.run.lifecycleState)) {
        return res.status(409).json({ error: "run_key already has a terminal result", terminal: true, adopted: true, runKey: reliability.run.runKey, batchId: existingBatch?.id ?? null });
      }
      if (existingBatch) {
        const progress = await storage.getBatchProgress(existingBatch.id);
        const pendingJobs = (await storage.getJobsForBatch(existingBatch.id)).filter((j: any) => j.status === "pending");
        await addBatchJobs(pendingJobs.map((j: any) => ({ jobId: j.id, companyId: j.companyId, frameworkId: j.frameworkId, batchId: existingBatch.id, workspaceId, skipFetch: existingBatch.scoreOnly === true })), workspaceId, existingBatch.id);
        return res.json({ success: true, adopted: true, runKey: reliability.run.runKey, batchId: existingBatch.id, scoreOnly: existingBatch.scoreOnly === true, totalJobs: existingBatch.totalJobs, progress });
      }
    }

    if (!adopted) {
      for (const company of companies) {
        await storage.updateCompany(company.id, workspaceId, { analysisStatus: "idle", totalScore: null, summary: null });
      }
      storage.detectAndUpsertPlatformSources(3)
        .then((d) => console.log(`[PlatformSources] Auto-detect at batch start: ${d.filter(x => x.added).length} new, ${d.length} qualifying (>=3 companies)`))
        .catch((e) => console.warn(`[PlatformSources] Auto-detect failed (non-fatal): ${e?.message || e}`));
    }

    // Legacy interactive requests still use the existing workspace guard. The
    // reliability path relies on a database-unique run_key instead of stale reads.
    if (!testCycleId && process.env.SINGLE_ACTIVE_BATCH !== "false") {
      const existingActive = await storage.getActiveBatchRun(workspaceId);
      if (existingActive && existingActive.status === "running") {
        return res.status(409).json({ error: "A batch is already running for this workspace.", alreadyRunning: true, batchId: existingActive.id, completed: existingActive.completedJobs, total: existingActive.totalJobs });
      }
      const pendingReview = await storage.getLatestReviewableBatch(workspaceId);
      if (pendingReview) {
        return res.status(409).json({ error: "A previous batch is awaiting review. Resolve it before starting a new analysis.", pendingReview: true, batchId: pendingReview.id, failed: pendingReview.failedJobs, completed: pendingReview.completedJobs, total: pendingReview.totalJobs });
      }
    }

    const batch = await storage.createBatchRun(
      workspaceId,
      frameworkId,
      companies.length,
      listId,
      offPeakOnly === true,
      scoreOnly === true,
      reliability ? { runId: reliability.run.id, runKey: reliability.run.runKey, testCycleId, batteryLabel, deploymentFingerprint: requestedFingerprint ?? liveFingerprint } : undefined,
    );
    if (reliability) {
      await storage.updateReliabilityRunLifecycle(reliability.run.id, "running", { lastHeartbeatAt: new Date(), lastProgressAt: new Date() });
      await storage.recordReliabilityAuditEvent({ workspaceId, runId: reliability.run.id, batchId: batch.id, eventType: adopted ? "adoption" : "creation", fromState: reliability.run.lifecycleState, toState: "running", reason: adopted ? "concurrent request adopted the existing non-terminal run" : "reliability run created" });
    }

    const jobsData = companies.map((c) => ({ workspaceId, batchId: batch.id, companyId: c.id, companyName: c.name, frameworkId }));
    await storage.createAnalysisJobs(jobsData);
    const allJobs = await storage.getJobsForBatch(batch.id);
    const queueJobs = allJobs.filter((j: any) => j.status === "pending").map((j: any) => ({ jobId: j.id, companyId: j.companyId, frameworkId: j.frameworkId, batchId: batch.id, workspaceId, skipFetch: scoreOnly === true }));
    await addBatchJobs(queueJobs, workspaceId, batch.id);

    res.json({ success: true, adopted, runKey: reliability?.run.runKey ?? null, batchId: batch.id, scoreOnly: scoreOnly === true, totalJobs: companies.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Batch Status ───────────────────────────────────────────────────────────

apiRouter.get("/batch/status", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const batch = await storage.getActiveBatchRun(workspaceId);

    // Honest "is anything actually running" summary (in-flight work + ETA),
    // distinguishing a portfolio batch run from a 1-company re-examination.
    let activeRun: any = null;
    try { activeRun = await storage.getActiveRunSummary(workspaceId); } catch { /* non-fatal */ }

    // A batch awaiting review is reported via the `review` field so the
    // dashboard can show the review banner even though it is not "running".
    let review: any = null;
    try {
      const rb = await storage.getLatestReviewableBatch(workspaceId);
      if (rb) {
        const reviewAlert = await storage.getActiveSystemAlert("batch_review");
        let reviewableCount = 1;
        try { reviewableCount = await storage.countReviewableBatches(workspaceId); } catch { /* non-fatal */ }
        let failures: Array<{ companyId: number; name: string; error: string }> = [];
        try {
          const raw = await storage.getFailedJobsForBatch(rb.id);
          failures = raw.map(f => ({ companyId: f.companyId, name: f.companyName, error: f.error }));
        } catch { /* non-fatal */ }
        review = {
          batchId: rb.id,
          completed: rb.completedJobs,
          failed: rb.failedJobs,
          failedCount: rb.failedJobs ?? failures.length,
          total: rb.totalJobs,
          failures,
          reviewableCount,
          message: reviewAlert?.message,
          since: reviewAlert?.created_at,
        };
      }
    } catch { /* non-fatal */ }

    if (!batch) {
      // Even with no `running` batch row, there may be genuine in-flight work
      // (e.g. re-exam jobs). `activeRun` reflects that truthfully.
      return res.json({ running: !!activeRun, completed: 0, total: 0, failed: 0, review, activeRun });
    }

    let reliabilityStatus: any = null;
    try {
      const run = await storage.getReliabilityRunForBatch(batch.id);
      if (run) {
        const thresholdMs = Number(process.env.RELIABILITY_STALL_THRESHOLD_MS || 45 * 60 * 1000);
        const classified = await storage.classifyBatchStall(batch.id, thresholdMs);
        await storage.recordReliabilityStatusTrace(run.id, batch.id, classified.progress, classified.classification);
        reliabilityStatus = {
          runId: run.id,
          runKey: run.runKey,
          lifecycleState: run.lifecycleState,
          acceptanceState: run.acceptanceState,
          lastHeartbeatAt: run.lastHeartbeatAt,
          terminalAt: run.terminalAt,
          ...classified.progress,
          stalled: classified.stalled,
          classification: classified.classification,
        };
      }
    } catch (error: any) {
      console.warn(`[Reliability] status trace failed (non-fatal): ${error?.message || error}`);
    }

    // Surface any active system alert (e.g. API credit exhaustion) so the
    // dashboard can render a banner without an extra request.
    let alert: any = null;
    try {
      const a = await storage.getActiveSystemAlert("credit_exhaustion");
      if (a) alert = { kind: a.kind, provider: a.provider, message: a.message, since: a.created_at };
    } catch { /* non-fatal */ }

    res.json({
      // Only report running when there is genuinely in-flight work, not merely
      // a stale `running` batch row.
      running: !!activeRun,
      batchId: batch.id,
      completed: batch.completedJobs,
      failed: batch.failedJobs,
      total: batch.totalJobs,
      paused: !!alert,
      alert,
      review,
      activeRun,
      reliabilityStatus,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Dedicated alerts endpoint (all active alerts) for the dashboard banner.
apiRouter.get("/system/alerts", async (_req: Request, res: Response) => {
  try {
    const alerts = await storage.getActiveSystemAlerts();
    res.json({ alerts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Manually clear a credit-exhaustion alert (e.g. after confirming a top-up).
// This resumes paused processing on the next worker tick.
apiRouter.post("/system/alerts/resume", async (req: Request, res: Response) => {
  try {
    const { kind } = req.body || {};
    await storage.clearSystemAlert(kind || "credit_exhaustion");
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Provider Operational Status Endpoint ───────────────────────────────────
// Safe read-only endpoint exposing provider health, failure class, pause state,
// retry_after, affected jobs/batches, and resumable batch IDs.
apiRouter.get("/providers/status", async (_req: Request, res: Response) => {
  try {
    const providerNames = getAvailableProviders().map(p => p.name);
    const trippedSet = new Set<string>();
    for (const name of providerNames) {
      if (isProviderTripped(name)) trippedSet.add(name);
    }
    const status = buildOperationalStatus(providerNames, trippedSet);
    const fallbackOrder = getConfiguredFallbackOrder();
    const pausedProviders = getAllPausedProviders();

    // Find resumable batches: running batches with jobs in pending/claimed state
    let resumableBatchIds: number[] = [];
    try {
      const r = await db.execute(sql`
        SELECT DISTINCT b.id FROM batch_runs b
        JOIN analysis_jobs j ON j.batch_id = b.id
        WHERE b.status = 'running'
          AND j.status IN ('pending', 'claimed')
        ORDER BY b.id DESC
        LIMIT 20
      `);
      resumableBatchIds = (r.rows as any[]).map(row => Number(row.id));
    } catch { /* non-fatal */ }

    // Recent failure events from durable storage (last 24h, max 50)
    let recentFailures: any[] = [];
    try {
      recentFailures = await storage.getRecentProviderFailures({ limit: 50 });
    } catch { /* non-fatal */ }

    res.json({
      providers: status,
      fallbackOrder,
      pausedProviders: pausedProviders.map(p => ({
        provider: p.provider,
        failureClass: p.failureClass,
        pausedAt: new Date(p.pausedAt).toISOString(),
        retryAfter: new Date(p.retryAfter).toISOString(),
        backoffMs: p.backoffMs,
        affectedJobIds: p.affectedJobIds,
        affectedBatchIds: p.affectedBatchIds,
        resumeCount: p.resumeCount,
        lastResumedAt: p.lastResumedAt ? new Date(p.lastResumedAt).toISOString() : null,
        lastResumedBy: p.lastResumedBy,
      })),
      resumableBatchIds,
      recentFailures,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Provider Resume Endpoint ───────────────────────────────────────────────
// Idempotent and auditable: resumes a paused provider, clears the credit
// breaker and system alert, and returns the affected batch IDs for the caller
// to verify. Safe to call multiple times.
apiRouter.post("/providers/resume", async (req: Request, res: Response) => {
  try {
    const { provider } = req.body || {};
    if (!provider || typeof provider !== "string") {
      return res.status(400).json({ error: "provider name is required" });
    }
    // Idempotent resume: clear process-local pause state
    const wasResumed = resumeProvider(provider, "manual");
    // Clear the credit breaker (process-local rolling window)
    resetCreditBreaker(provider);
    // Clear the persisted system alert so worker picks up the change
    await clearCreditAlert(provider);
    // Also clear the generic credit_exhaustion alert if it matches
    await storage.clearSystemAlert("credit_exhaustion", provider);

    // Record an audit event
    try {
      const { workspaceId } = getSessionContext(req);
      await storage.recordReliabilityAuditEvent({
        workspaceId,
        eventType: "provider_resume",
        reason: `Manual provider resume: ${provider} (wasActuallyPaused=${wasResumed})`,
        metadata: { provider, wasResumed, resumedAt: new Date().toISOString(), by: "manual" },
      });
    } catch { /* non-fatal audit */ }

    res.json({
      success: true,
      provider,
      wasActuallyPaused: wasResumed,
      message: wasResumed
        ? `Provider ${provider} resumed. Paused jobs will auto-retry on next worker tick.`
        : `Provider ${provider} was not paused (idempotent, no-op).`,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Reliability Run and Gate Report API ─────────────────────────────────────

apiRouter.get("/reliability/run/:runKey", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const run = await storage.getReliabilityRunByKey(String(req.params.runKey), workspaceId);
    if (!run) return res.status(404).json({ error: "Reliability run not found" });
    const batch = await storage.getBatchRunByReliabilityRunId(run.id, workspaceId);
    const progress = batch ? await storage.getBatchProgress(batch.id) : null;
    res.json({ run, batch, progress });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/reliability/recovery-plan", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const testCycleId = String(req.body.testCycleId || "").trim();
    const expectedLabels = Array.isArray(req.body.expectedLabels) ? req.body.expectedLabels.map((label: unknown) => String(label)) : [];
    if (!testCycleId || expectedLabels.length === 0) return res.status(400).json({ error: "testCycleId and expectedLabels are required" });
    const runs = await storage.getReliabilityRunsForCycle(testCycleId, workspaceId);
    res.json({ testCycleId, ...computeRecoveryLabels(expectedLabels, runs) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.get("/reliability/gate-report/:testCycleId", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const report = await storage.getGateReport(String(req.params.testCycleId), workspaceId);
    if (!report) return res.status(404).json({ error: "Gate Report not found", complete: false });
    res.json({ complete: true, report });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/reliability/finalize", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const testCycleId = String(req.body.testCycleId || "").trim();
    if (!testCycleId) return res.status(400).json({ error: "testCycleId is required" });
    const snapshots = await storage.getAcceptedEvidenceSnapshots(testCycleId, workspaceId);
    const expectedCompanyCount = Number(req.body.expectedCompanyCount || snapshots[0]?.companiesCount || 0);
    const deploymentFingerprint = (req.body.deploymentFingerprint || snapshots[0]?.deploymentFingerprint || deploymentFingerprintFromEnvironment()) as DeploymentFingerprint;
    await enqueueReliabilityFinalizer({ kind: "reliability_finalizer", testCycleId, workspaceId, expectedCompanyCount, deploymentFingerprint });
    res.status(202).json({ queued: true, testCycleId, expectedCompanyCount });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Corpus Replay (G4 stability fix) ─────────────────────────────────────────
// Enqueue a score-only batch that replays the exact corpus from a source batch,
// eliminating corpus-selection instability in A/B reliability comparisons.
apiRouter.post("/analyze/replay", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const { sourceBatchId, testCycleId, batteryLabel, commitSha, diagnosticRun } = req.body;
    const requestedFingerprint = req.body.deploymentFingerprint as DeploymentFingerprint | undefined;
    const liveFingerprint = deploymentFingerprintFromEnvironment();

    if (!sourceBatchId || !testCycleId || !batteryLabel || !commitSha) {
      return res.status(400).json({ error: "sourceBatchId, testCycleId, batteryLabel, and commitSha are required for corpus replay" });
    }

    // Validate source batch exists, is in this workspace, and is accepted/terminal-success
    const sourceBatch = await storage.getBatchRunById(Number(sourceBatchId), workspaceId);
    if (!sourceBatch) {
      return res.status(404).json({ error: "Source batch not found in this workspace" });
    }
    const sourceRun = sourceBatch.reliabilityRunId ? await storage.getReliabilityRunForBatch(sourceBatch.id) : null;
    if (sourceRun && sourceRun.acceptanceState !== "accepted") {
      return res.status(409).json({ error: "Source batch is not accepted (terminal-success)", acceptanceState: sourceRun.acceptanceState });
    }
    if (!sourceBatch.frameworkId) {
      return res.status(409).json({ error: "Source batch has no framework" });
    }

    // Validate deployment fingerprint
    if (requestedFingerprint) {
      try {
        assertProductionFingerprint(requestedFingerprint, liveFingerprint, diagnosticRun === true);
      } catch (fpErr: any) {
        return res.status(409).json({ error: fpErr.message, fingerprint: liveFingerprint });
      }
    }

    // Compute source corpus fingerprint from batch_corpus
    const { db: dbLocal } = await import("../db.js");
    const { sql: sqlLocal } = await import("drizzle-orm");
    const corpusRows = await dbLocal.execute(sqlLocal`
      SELECT DISTINCT company_id, document_id FROM batch_corpus
      WHERE batch_id = ${sourceBatch.id}
      ORDER BY company_id, document_id
    `);
    if (corpusRows.rows.length === 0) {
      return res.status(409).json({ error: "Source batch has no corpus snapshot (batch_corpus is empty)" });
    }
    const { createHash } = await import("crypto");
    const sourceCorpusFingerprint = createHash("sha256")
      .update(corpusRows.rows.map((r: any) => `${r.company_id}:${r.document_id}`).join(","))
      .digest("hex");

    // Validate same workspace/framework/list/ordered company IDs
    const sourceJobs = await storage.getJobsForBatch(sourceBatch.id);
    const sourceCompanyIds = sourceJobs.map((j: any) => j.companyId);
    if (sourceBatch.listId) {
      const listCompanies = await storage.getListCompanies(sourceBatch.listId);
      const listCompanyIds = listCompanies.map((c: any) => c.company.id);
      const sourceIdStr = sourceCompanyIds.join(",");
      const listIdStr = listCompanyIds.join(",");
      if (sourceIdStr !== listIdStr) {
        return res.status(409).json({ error: "Source batch company set/order does not match current list membership" });
      }
    }

    // Create reliability run
    const reliability = await storage.createOrAdoptReliabilityRun({
      workspaceId,
      testCycleId,
      commitSha,
      frameworkId: sourceBatch.frameworkId,
      listId: sourceBatch.listId ?? null,
      batteryLabel,
      deploymentFingerprint: requestedFingerprint ?? liveFingerprint,
      diagnosticRun: diagnosticRun === true,
    });

    // Create batch with replay provenance
    const batch = await storage.createBatchRun(
      workspaceId,
      sourceBatch.frameworkId,
      sourceCompanyIds.length,
      sourceBatch.listId ?? undefined,
      false, // offPeakOnly
      true,  // scoreOnly (replay is always score-only)
      { runId: reliability.run.id, runKey: reliability.run.runKey, testCycleId, batteryLabel, deploymentFingerprint: requestedFingerprint ?? liveFingerprint },
      { sourceBatchId: sourceBatch.id, sourceRunKey: sourceRun?.runKey ?? `batch-${sourceBatch.id}`, sourceCorpusFingerprint },
    );

    await storage.updateReliabilityRunLifecycle(reliability.run.id, "running", { lastHeartbeatAt: new Date(), lastProgressAt: new Date() });
    await storage.recordReliabilityAuditEvent({ workspaceId, runId: reliability.run.id, batchId: batch.id, eventType: "corpus_replay", reason: `corpus replay from source batch ${sourceBatch.id}`, metadata: { sourceBatchId: sourceBatch.id, sourceCorpusFingerprint } });

    // Create jobs and enqueue
    const companies: any[] = [];
    for (const cid of sourceCompanyIds) {
      const c = await storage.getCompanyById(cid, workspaceId);
      if (c) companies.push(c);
    }
    const jobsData = companies.map((c) => ({ workspaceId, batchId: batch.id, companyId: c.id, companyName: c.name, frameworkId: sourceBatch.frameworkId }));
    await storage.createAnalysisJobs(jobsData);
    const allJobs = await storage.getJobsForBatch(batch.id);
    const { addBatchJobs: addJobs } = await import("../queue.js");
    const queueJobs = allJobs.filter((j: any) => j.status === "pending").map((j: any) => ({
      jobId: j.id,
      companyId: j.companyId,
      frameworkId: j.frameworkId,
      batchId: batch.id,
      workspaceId,
      skipFetch: true,
      sourceBatchId: sourceBatch.id,
    }));
    await addJobs(queueJobs, workspaceId, batch.id);

    res.json({
      success: true,
      replay: true,
      runKey: reliability.run.runKey,
      batchId: batch.id,
      sourceBatchId: sourceBatch.id,
      sourceCorpusFingerprint,
      totalJobs: companies.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Batch Completion Review Gate ─────────────────────────────────────────────
// When a batch finishes with terminal failures it enters `pending_review` and
// nothing is saved to the Results page until the user resolves it here.

// GET the batch awaiting review (with the full failed-company list + errors).
apiRouter.get("/batch/review", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const batch = await storage.getLatestReviewableBatch(workspaceId);
    if (!batch) return res.json({ pendingReview: false });
    const failures = await storage.getFailedJobsForBatch(batch.id);
    res.json({
      pendingReview: true,
      batchId: batch.id,
      completed: batch.completedJobs,
      failed: batch.failedJobs,
      total: batch.totalJobs,
      failures,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Re-examine the failed companies: reset their jobs to pending, re-enqueue into
// the SAME batch, flip the batch back to `running`, clear the review alert.
apiRouter.post("/batch/review/reexamine", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const batch = await storage.getLatestReviewableBatch(workspaceId);
    if (!batch) return res.status(404).json({ error: "No batch awaiting review." });

    // Reset failed jobs -> pending (also resets companies + decrements counter).
    const jobs = await storage.requeueFailedJobsForBatch(batch.id);
    if (jobs.length === 0) {
      // Nothing actually failed (race) — just finalise.
      await finalizeBatchAndSave(batch.id, batch.frameworkId, workspaceId, batch.listId ?? undefined);
      return res.json({ success: true, reexamined: 0, finalised: true });
    }

    // Clear any stale BullMQ keys for this batch, then re-enqueue the failures.
    try { await removeBatchJobs(batch.id); } catch { /* non-fatal */ }
    const queueJobs = jobs.map((j) => ({
      jobId: j.id,
      companyId: j.companyId,
      frameworkId: j.frameworkId,
      batchId: batch.id,
      workspaceId,
    }));
    await addBatchJobs(queueJobs, workspaceId, batch.id);

    // Flip batch back to running and clear the review alert.
    await storage.setBatchRunStatus(batch.id, "running");
    try { await storage.clearSystemAlert("batch_review", String(batch.id)); } catch { /* non-fatal */ }

    res.json({ success: true, reexamined: jobs.length, batchId: batch.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Discard the failures and finalise: save results (completed companies only) to
// the Results page and clear the review alert.
apiRouter.post("/batch/review/finalize", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const batch = await storage.getLatestReviewableBatch(workspaceId);
    if (!batch) return res.status(404).json({ error: "No batch awaiting review." });

    await finalizeBatchAndSave(batch.id, batch.frameworkId, workspaceId, batch.listId ?? undefined);
    res.json({ success: true, finalised: true, batchId: batch.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin recovery: force-save the analysis_results snapshot for a specific batch
// that completed work but was never finalised (e.g. cancelled large batches).
// Rebuilds the snapshot from the intact company + measure_scores data using the
// same save path as a normal finalisation, so the Results page shows it.
apiRouter.post("/batch/:batchId/recover-results", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const batchId = parseInt(String(req.params.batchId), 10);
    if (!Number.isFinite(batchId)) return res.status(400).json({ error: "Invalid batchId." });
    const batch = await storage.getBatchRunById(batchId, workspaceId);
    if (!batch) return res.status(404).json({ error: "Batch not found in this workspace." });
    await finalizeBatchAndSave(batch.id, batch.frameworkId, workspaceId, batch.listId ?? undefined);
    // Look up the snapshot by batchId (the durable upsert ensures batchId is current)
    const saved = await storage.getAnalysisResults(workspaceId);
    const row = saved.find((r: any) => r.batchId === batchId);
    // Also check batch_runs for artifact and acceptance state
    const batchAfter = await storage.getBatchRunById(batchId, workspaceId);
    res.json({
      success: true,
      batchId,
      saved: !!row,
      companiesCount: row?.companiesCount ?? null,
      averageScore: row?.averageScore ?? null,
      acceptanceState: batchAfter?.acceptanceState ?? null,
      artifactId: batchAfter?.artifactId ?? null,
      snapshotSaved: !!(batchAfter as any)?.snapshotSaved,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/batch/cancel", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const batch = await storage.getActiveBatchRun(workspaceId);
    let snapshotSaved = false;
    if (batch) {
      cancelBatch(batch.id);
      await removeBatchJobs(batch.id);
      // Safeguard: preserve any completed companies on the Results page before
      // cancelling, so cancellation never silently discards finished work.
      try {
        snapshotSaved = await saveBatchSnapshot(batch.id, batch.frameworkId, workspaceId, batch.listId ?? undefined);
      } catch { /* non-fatal */ }
      await storage.cancelBatchRun(batch.id);
    }
    res.json({ success: true, snapshotSaved });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.get("/queue/stats", async (req: Request, res: Response) => {
  try {
    const stats = await getQueueStats();
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Environment Check (for debugging) ─────────────────────────────────────

apiRouter.get("/env-check", async (req: Request, res: Response) => {
  res.json({
    SERPER_API_KEY: process.env.SERPER_API_KEY ? `set (${process.env.SERPER_API_KEY.slice(0, 8)}...)` : "NOT SET",
    SERP_API_KEY: process.env.SERP_API_KEY ? `set (${process.env.SERP_API_KEY.slice(0, 8)}...)` : "NOT SET",
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ? "set" : "NOT SET",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "set" : "NOT SET",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ? "set" : "NOT SET",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? "set" : "NOT SET",
    REDIS_URL: process.env.REDIS_URL ? "set" : "NOT SET",
    DATABASE_URL: process.env.DATABASE_URL ? "set" : "NOT SET",
  });
});

// ─── Results ────────────────────────────────────────────────────────────────

apiRouter.get("/results", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    // Metadata only — excludes the large results_data blob so the list always
    // loads quickly regardless of snapshot size. Full data via GET /results/:id.
    const results = await storage.getAnalysisResultsMeta(workspaceId);
    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Full single result (includes results_data). Used on demand for CSV export.
apiRouter.get("/results/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id." });
    const row = await storage.getAnalysisResultById(id, workspaceId);
    if (!row) return res.status(404).json({ error: "Result not found." });
    res.json(row);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk-delete multiple saved results in one request. Scoped to the workspace so
// a user can only ever delete their own results. Defined BEFORE "/results/:id"
// so the literal path takes precedence over the param route.
apiRouter.post("/results/bulk-delete", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const rawIds = (req.body && req.body.ids) || [];
    const ids: number[] = Array.isArray(rawIds)
      ? rawIds.map((n: any) => parseInt(String(n), 10)).filter((n: number) => Number.isFinite(n))
      : [];
    if (ids.length === 0) return res.status(400).json({ error: "No valid result ids provided." });
    const deleted = await storage.deleteAnalysisResults(ids, workspaceId);
    res.json({ success: true, deleted });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.delete("/results/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const id = parseInt(req.params.id);
    await storage.deleteAnalysisResult(id, workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Share Management ─────────────────────────────────────────────────────
// Toggle public sharing on/off for a result (opt-in)
apiRouter.post("/results/:id/share/toggle", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const id = parseInt(req.params.id);
    const { isPublic, expiresInDays } = req.body || {};
    const { db } = await import("../db.js");
    const { sql } = await import("drizzle-orm");
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null;
    await db.execute(sql`
      UPDATE analysis_results
      SET is_public = ${isPublic !== false}, share_expires_at = ${expiresAt}
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `);
    res.json({ success: true, isPublic: isPublic !== false, shareExpiresAt: expiresAt });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Rotate (revoke old + generate new) share token
apiRouter.post("/results/:id/share/rotate", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const id = parseInt(req.params.id);
    const { db } = await import("../db.js");
    const { sql } = await import("drizzle-orm");
    const { randomUUID } = await import("crypto");
    const newToken = randomUUID();
    await db.execute(sql`
      UPDATE analysis_results
      SET share_token = ${newToken}
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `);
    res.json({ success: true, shareToken: newToken });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.get("/results/:id/share", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid result id." });

    // ?format=summary (default) -> lightweight per-company scores, browser-friendly.
    // ?format=full            -> complete dataset incl. measures/quotes/sources, streamed.
    const format = String(req.query.format || "summary").toLowerCase();
    const wantFull = format === "full";

    // Public share endpoint - returns the results data as JSON
    const { db } = await import("./db.js");
    const { sql } = await import("drizzle-orm");

    // Cache for 5 min at the edge; payload is immutable per id+format.
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (!wantFull) {
      // Default summary view. Project ONLY the light per-company fields *inside Postgres*
      // via jsonb_array_elements + jsonb_build_object, so the ~100MB results_data blob is
      // never loaded into the app. For 2,440 companies this is ~0.5MB instead of ~100MB.
      const r = await db.execute(sql`
        SELECT
          ar.id, ar.framework_name, ar.list_name, ar.companies_count,
          ar.average_score, ar.created_at,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'companyName', e->>'companyName',
              'isin',        e->>'isin',
              'sector',      e->>'sector',
              'country',     e->>'country',
              'totalScore',  e->'totalScore',
              'measuresMetCount',   e->'measuresMetCount',
              'measuresTotalCount', e->'measuresTotalCount',
              'coverageLevel',      e->>'coverageLevel',
              'corpusValidityWarning', e->>'corpusValidityWarning',
              'hasRequiredDataDoc',    e->'hasRequiredDataDoc',
              'corpusHash',            e->>'corpusHash'
            ))
            FROM jsonb_array_elements(ar.results_data) e
          ), '[]'::jsonb) AS summary
        FROM analysis_results ar WHERE ar.id = ${id}
      `).then((x: any) => x.rows) as any[];
      const row = r[0];
      if (!row) return res.status(404).json({ error: "Result not found" });
      return res.json({
        id: row.id,
        frameworkName: row.framework_name,
        listName: row.list_name,
        companiesCount: row.companies_count,
        averageScore: row.average_score,
        createdAt: row.created_at,
        format: "summary",
        note: "Summary view. Append ?format=full for the complete dataset (measures, quotes, sources).",
        results: row.summary || [],
      });
    }

    // Full export. Load the blob once, then stream the JSON so we never re-buffer a second
    // ~100MB copy. Compression middleware gzips this on the wire (~100MB -> a few MB).
    const [result] = await db.execute(sql`SELECT * FROM analysis_results WHERE id = ${id}`).then((x: any) => x.rows) as any[];
    if (!result) return res.status(404).json({ error: "Result not found" });
    const rows: any[] = Array.isArray(result.results_data) ? result.results_data : [];
    const meta = {
      id: result.id,
      frameworkName: result.framework_name,
      listName: result.list_name,
      companiesCount: result.companies_count,
      averageScore: result.average_score,
      createdAt: result.created_at,
      format: "full",
    };
    res.write('{');
    for (const [k, v] of Object.entries(meta)) {
      res.write(JSON.stringify(k) + ':' + JSON.stringify(v) + ',');
    }
    res.write('"results":[');
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) res.write(',');
      res.write(JSON.stringify(rows[i]));
    }
    res.write(']}');
    return res.end();
  } catch (error: any) {
    if (!res.headersSent) return res.status(500).json({ error: error.message });
    try { res.end(); } catch {}
  }
});

// ─── Settings ───────────────────────────────────────────────────────────────

apiRouter.get("/settings", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const settings = await storage.getSettings(workspaceId);
    res.json(settings);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/settings", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const { key, value } = req.body;
    await storage.setSetting(workspaceId, key, value);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── User / Workspace Member Management ──────────────────────────────────────

// Only owners and admins may manage members.
async function requireAdmin(req: Request, res: Response): Promise<{ workspaceId: number; userId: number; role: string } | null> {
  const { workspaceId, userId } = getSessionContext(req);
  const role = await storage.getMemberRole(workspaceId, userId);
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "You do not have permission to manage users in this workspace" });
    return null;
  }
  return { workspaceId, userId, role };
}

const VALID_ROLES = ["owner", "admin", "member"];

// List members of the current workspace.
apiRouter.get("/users", async (req: Request, res: Response) => {
  try {
    const { workspaceId, userId } = getSessionContext(req);
    const myRole = await storage.getMemberRole(workspaceId, userId);
    const members = await storage.getWorkspaceMembers(workspaceId);
    res.json({ members, currentUserId: userId, currentUserRole: myRole });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Add a member: either an existing user by email, or create a new user.
apiRouter.post("/users", async (req: Request, res: Response) => {
  try {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { workspaceId } = ctx;
    const { email, name, password, role } = req.body;

    if (!email) return res.status(400).json({ error: "Email is required" });
    const memberRole = VALID_ROLES.includes(role) ? role : "member";
    const normalizedEmail = String(email).toLowerCase().trim();

    const existing = await storage.getUserByEmail(normalizedEmail);
    if (existing) {
      const alreadyRole = await storage.getMemberRole(workspaceId, existing.id);
      if (alreadyRole) {
        return res.status(409).json({ error: "This user is already a member of the workspace" });
      }
      await storage.addWorkspaceMember(workspaceId, existing.id, memberRole);
      return res.json({ success: true, userId: existing.id, created: false });
    }

    // New user — name and password required.
    if (!name || !password) {
      return res.status(400).json({ error: "Name and an initial password are required to create a new user" });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    const user = await storage.createUserAndAddToWorkspace(normalizedEmail, password, name, workspaceId, memberRole);
    res.json({ success: true, userId: user.id, created: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update a member's role.
apiRouter.patch("/users/:userId", async (req: Request, res: Response) => {
  try {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { workspaceId } = ctx;
    const targetUserId = parseInt(req.params.userId);
    const { role } = req.body;

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    const currentRole = await storage.getMemberRole(workspaceId, targetUserId);
    if (!currentRole) return res.status(404).json({ error: "User is not a member of this workspace" });

    // Prevent demoting the last remaining owner.
    if (currentRole === "owner" && role !== "owner") {
      const ownerCount = await storage.countWorkspaceOwners(workspaceId);
      if (ownerCount <= 1) {
        return res.status(400).json({ error: "Cannot demote the last owner of the workspace" });
      }
    }
    await storage.updateMemberRole(workspaceId, targetUserId, role);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Remove a member from the workspace.
apiRouter.delete("/users/:userId", async (req: Request, res: Response) => {
  try {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { workspaceId, userId } = ctx;
    const targetUserId = parseInt(req.params.userId);

    const currentRole = await storage.getMemberRole(workspaceId, targetUserId);
    if (!currentRole) return res.status(404).json({ error: "User is not a member of this workspace" });

    // Prevent removing the last remaining owner.
    if (currentRole === "owner") {
      const ownerCount = await storage.countWorkspaceOwners(workspaceId);
      if (ownerCount <= 1) {
        return res.status(400).json({ error: "Cannot remove the last owner of the workspace" });
      }
    }
    if (targetUserId === userId) {
      return res.status(400).json({ error: "You cannot remove yourself" });
    }
    await storage.removeWorkspaceMember(workspaceId, targetUserId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Trusted Sources ────────────────────────────────────────────────────────

apiRouter.get("/trusted-sources", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const sources = await storage.getTrustedSources(workspaceId);
    res.json(sources);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/trusted-sources", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const source = await storage.addTrustedSource(workspaceId, req.body.name, req.body.domain);
    res.json(source);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.patch("/trusted-sources/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    await storage.updateTrustedSource(parseInt(req.params.id), workspaceId, req.body);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.delete("/trusted-sources/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    await storage.deleteTrustedSource(parseInt(req.params.id), workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Excluded Sources ───────────────────────────────────────────────────────────

apiRouter.get("/excluded-sources", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const sources = await storage.getExcludedSources(workspaceId);
    res.json(sources);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/excluded-sources", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const source = await storage.addExcludedSource(workspaceId, req.body.domain, req.body.reason);
    res.json(source);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.patch("/excluded-sources/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    await storage.updateExcludedSource(parseInt(req.params.id), workspaceId, req.body);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.delete("/excluded-sources/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    await storage.deleteExcludedSource(parseInt(req.params.id), workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Platform Sources (GLOBAL — shared multi-tenant hosts) ──────────────────────
// Documents on these hosts are ALWAYS issuer-verified (override own-domain
// fast-path). The list is global across all workspaces.

apiRouter.get("/platform-sources", async (_req: Request, res: Response) => {
  try {
    const sources = await storage.getPlatformSources();
    res.json(sources);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/platform-sources", async (req: Request, res: Response) => {
  try {
    const source = await storage.addPlatformSource(req.body.domain, req.body.reason, false);
    res.json(source);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.patch("/platform-sources/:id", async (req: Request, res: Response) => {
  try {
    await storage.updatePlatformSource(parseInt(req.params.id), req.body);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.delete("/platform-sources/:id", async (req: Request, res: Response) => {
  try {
    await storage.deletePlatformSource(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete-and-suppress: keep a tombstone so the >=3-companies auto-detection
// will NOT re-add this domain even if it keeps qualifying.
apiRouter.post("/platform-sources/:id/suppress", async (req: Request, res: Response) => {
  try {
    const domain = await storage.suppressPlatformSource(parseInt(req.params.id));
    res.json({ success: true, domain });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Lift suppression so the domain can be auto-detected / re-activated again.
apiRouter.post("/platform-sources/:id/unsuppress", async (req: Request, res: Response) => {
  try {
    await storage.unsuppressPlatformSource(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Run the >=3-companies auto-detection now and upsert any qualifying hosts.
apiRouter.post("/platform-sources/detect", async (req: Request, res: Response) => {
  try {
    const min = parseInt(req.body?.minCompanies ?? "3", 10) || 3;
    const detected = await storage.detectAndUpsertPlatformSources(min);
    res.json({ detected, added: detected.filter(d => d.added).length, total: detected.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Single Company Analyze ─────────────────────────────────────────────────
apiRouter.post("/companies/:id/analyze", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const companyId = parseInt(req.params.id);
    const { scoreOnly, frameworkId: bodyFrameworkId } = req.body || {};
    const company = await storage.getCompanyById(companyId, workspaceId);
    if (!company) return res.status(404).json({ error: "Company not found" });

    // Resolve framework: explicit body param > company's most-recent framework > active (fallback).
    // NEVER silently score on the active framework when the company was last scored on another.
    let framework;
    const frameworks = await storage.getFrameworks(workspaceId);
    if (bodyFrameworkId) {
      framework = frameworks.find((f: any) => f.id === bodyFrameworkId);
    } else {
      const lastFwId = await storage.getMostRecentFrameworkIdForCompany(companyId, workspaceId);
      framework = frameworks.find((f: any) => f.id === lastFwId)
               ?? frameworks.find((f: any) => f.isActive);
    }
    if (!framework) {
      return res.status(400).json({ error: "No framework resolved. Pass frameworkId." });
    }

    // Reset company status
    await storage.updateCompany(company.id, workspaceId, { analysisStatus: "idle", totalScore: null, summary: null });

    // Create a batch for single company
    // FIX: listId must be undefined (not false); put flags in their correct slots.
    const batch = await storage.createBatchRun(
      workspaceId, framework.id, 1, undefined /*listId*/, false /*offPeakOnly*/, !!scoreOnly /*scoreOnly*/
    );

    // Create jobs in DB (same pattern as batch analyze)
    const jobsData = [{
      workspaceId,
      batchId: batch.id,
      companyId: company.id,
      companyName: company.name,
      frameworkId: framework.id,
    }];
    const dbJobs = await storage.createAnalysisJobs(jobsData);

    // Add to BullMQ queue
    const queueJobs = dbJobs.map((j) => ({
      jobId: j.id,
      companyId: j.companyId,
      frameworkId: j.frameworkId,
      batchId: batch.id,
      workspaceId,
      ...(scoreOnly ? { skipFetch: true } : {}),
    }));
    await addBatchJobs(queueJobs, workspaceId, batch.id);

    res.json({ success: true, batchId: batch.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Update Measure (PATCH) ─────────────────────────────────────────────────
apiRouter.patch("/frameworks/:frameworkId/measures/:measureId", async (req: Request, res: Response) => {
  // I76: PATCH by measureId (string) so callers can update scoringGuidance and
  // other fields without knowing the numeric row id. Accepts an object for
  // scoringGuidance and stringifies before storing.
  try {
    const { workspaceId } = getSessionContext(req);
    const frameworkId = parseInt(req.params.frameworkId);
    const measureId = req.params.measureId;
    const framework = await storage.getFrameworkById(frameworkId, workspaceId);
    if (!framework) return res.status(404).json({ error: "Framework not found" });

    const allowed = ["title", "definition", "scoringGuidance", "evidenceKeywords", "category", "requiredSourceTypes"];
    const updates: Record<string, any> = {};
    for (const f of allowed) {
      if (req.body[f] !== undefined) {
        if (f === "scoringGuidance" && typeof req.body[f] !== "string") {
          updates[f] = JSON.stringify(req.body[f]);
        } else {
          updates[f] = req.body[f];
        }
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }
    await storage.updateMeasure(frameworkId, measureId, updates as any);
    res.json({ success: true, updated: Object.keys(updates) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Delete Measure ─────────────────────────────────────────────────────────
apiRouter.delete("/frameworks/:frameworkId/measures/:measureId", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const measureId = parseInt(req.params.measureId);
    await storage.deleteFrameworkMeasure(measureId, workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Delete Framework ───────────────────────────────────────────────────────
apiRouter.delete("/frameworks/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const id = parseInt(req.params.id);
    await storage.deleteFramework(id, workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get Single List ────────────────────────────────────────────────────────
apiRouter.get("/lists/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const id = parseInt(req.params.id);
    const list = await storage.getListById(id, workspaceId);
    if (!list) return res.status(404).json({ error: "List not found" });
    const members = await storage.getListMembers(id, workspaceId);
    res.json({ ...list, members });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Delete List ────────────────────────────────────────────────────────────
apiRouter.delete("/lists/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const id = parseInt(req.params.id);
    await storage.deleteList(id, workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── List Members ───────────────────────────────────────────────────────────
apiRouter.post("/lists/:id/members", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const listId = parseInt(req.params.id);
    const { companyId } = req.body;
    await storage.addListMember(listId, companyId, workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.delete("/lists/:id/members/:companyId", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const listId = parseInt(req.params.id);
    const companyId = parseInt(req.params.companyId);
    await storage.removeListMember(listId, companyId, workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Diagnostics ───────────────────────────────────────────────────────────
apiRouter.get("/batch/runs", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const runs = await storage.getBatchRuns(workspaceId);
    res.json(runs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.get("/diagnostics/recent-errors", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const errors = await storage.getRecentErrors(workspaceId);
    res.json(errors);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Score Anomalies (Expected-Score Outlier Detection) ───────────────────

apiRouter.get("/score-anomalies", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const status = (req.query.status as string) || "pending";
    const anomalies = await storage.getScoreAnomalies(workspaceId, status);
    res.json(anomalies);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.get("/score-anomalies/count", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const count = await storage.countPendingAnomalies(workspaceId);
    res.json({ count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/score-anomalies/:id/dismiss", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const id = parseInt(req.params.id);
    await storage.dismissAnomaly(id, workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/score-anomalies/:id/reexamine", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const id = parseInt(req.params.id);
    // Get the anomaly to find the company
    const anomaly = await storage.getAnomalyById(id, workspaceId);
    if (!anomaly) return res.status(404).json({ error: "Anomaly not found" });
    // Enqueue re-examination using the typed storage contract.
    const result = await storage.enqueueReexamination({
      companyId: anomaly.companyId,
      companyName: anomaly.companyName,
      frameworkId: anomaly.frameworkId,
      workspaceId,
    });
    if (!result) return res.status(503).json({ error: "Could not enqueue re-examination" });
    // Mark anomaly as re_examined
    await storage.markAnomalyReexamined(id, workspaceId);
    res.json({ success: true, batchId: result.batchId, jobId: result.jobId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/score-anomalies/bulk-dismiss", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids required" });
    await storage.bulkDismissAnomalies(ids, workspaceId);
    res.json({ success: true, dismissed: ids.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/score-anomalies/bulk-reexamine", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids required" });
    const anomalies = await storage.getAnomaliesByIds(ids, workspaceId);
    const results: Array<{ companyId: number; batchId: number; jobId: number }> = [];
    const reexaminedIds: number[] = [];
    for (const a of anomalies) {
      const r = await storage.enqueueReexamination({
        companyId: a.companyId,
        companyName: a.companyName,
        frameworkId: a.frameworkId,
        workspaceId,
      });
      if (r) {
        results.push({ companyId: a.companyId, batchId: r.batchId, jobId: r.jobId });
        reexaminedIds.push(a.id);
      }
    }
    if (reexaminedIds.length > 0) {
      await storage.bulkMarkAnomaliesReexamined(reexaminedIds, workspaceId);
    }
    res.json({ success: true, reexamined: results.length, results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Seed anomaly detection for all completed companies in a framework
apiRouter.post("/score-anomalies/seed", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const { frameworkId } = req.body;
    if (!frameworkId) return res.status(400).json({ error: "frameworkId required" });

    // Get all completed company IDs for this workspace
    const allCompanies = await storage.getCompletedCompanyIds(workspaceId);
    if (allCompanies.length === 0) return res.json({ flagged: 0, message: "No completed companies" });

    // Find the latest completed batch for this framework to use as the batch reference
    const latestBatch = await storage.getLatestCompletedBatch(workspaceId, Number(frameworkId));
    if (!latestBatch) return res.json({ flagged: 0, message: "No completed batch found for this framework" });

    const flagged = await detectScoreAnomalies({
      batchId: latestBatch.id,
      workspaceId,
      frameworkId: Number(frameworkId),
      companyIds: allCompanies,
    });

    res.json({ success: true, flagged, totalCompanies: allCompanies.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 41-F / 42-E: Manual override for related_domains_manual (standardised auth pattern)
apiRouter.post("/companies/:id/related-domains-manual", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const cid = parseInt(req.params.id, 10);
    const { domains } = req.body as { domains: string[] };
    if (!Array.isArray(domains) || domains.some(d => typeof d !== "string")) {
      return res.status(400).json({ error: "domains must be string[]" });
    }
    const cleaned = domains
      .map(d => d.trim().toLowerCase())
      .filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
    await db.execute(sql`
      UPDATE companies SET related_domains_manual = ${JSON.stringify(cleaned)}::jsonb, updated_at = NOW()
      WHERE id = ${cid} AND workspace_id = ${workspaceId}
    `);
    res.json({ success: true, related_domains_manual: cleaned });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 42-C: Reset discovery cache (FIGI + related domains) for a single company
apiRouter.post("/companies/:id/reset-discovery-cache", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    await storage.resetCompanyDiscoveryCache(parseInt(req.params.id, 10), workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 42-C: Reset discovery cache for all companies in a list
apiRouter.post("/lists/:id/reset-discovery-cache", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const listId = parseInt(req.params.id, 10);
    const activeBatches = await storage.getActiveBatchesForList(listId, workspaceId);
    if (activeBatches.length > 0) {
      return res.status(409).json({
        error: "Cannot reset while a batch is in-flight",
        activeBatchIds: activeBatches.map((b: any) => b.id),
      });
    }
    const resetCount = await storage.resetListDiscoveryCache(listId, workspaceId);
    res.json({ success: true, resetCount });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── I59d DIAGNOSTIC: controlled single-corpus probe ─────────────────────────
// Run `analyzeCompanyMeasures` for a company/framework with a hand-filtered
// subset of that company's docs. Purpose: disambiguate retrieval vs scoring
// as the ceiling on any measure. Read-only — never writes to measure_scores
// or any other persistent store.
//
// POST /api/diagnostic/analyze-subset
// Body: { companyId, frameworkId, docFilter: { includeSubstrings?: string[], excludeSubstrings?: string[] } }
// Response: verdicts + evidenceSummary + first 3 quotes per measure.
apiRouter.post("/diagnostic/analyze-subset", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const { companyId, frameworkId, docFilter } = req.body as any;
    if (!companyId || !frameworkId) {
      return res.status(400).json({ error: "companyId and frameworkId are required" });
    }
    const company = await storage.getCompanyById(companyId, workspaceId);
    if (!company) return res.status(404).json({ error: "company not found" });
    const framework = await storage.getFrameworkById(frameworkId, workspaceId);
    if (!framework) return res.status(404).json({ error: "framework not found" });
    const measures = await storage.getFrameworkMeasures(frameworkId);

    // Build a URL/title filter over this company's fetched-ok docs, reading
    // content directly from documents + document_content (bypasses any content
    // stripping that API summary paths apply).
    const inc = ((docFilter?.includeSubstrings || []) as string[]).map((s) => s.toLowerCase()).filter(Boolean);
    const exc = ((docFilter?.excludeSubstrings || []) as string[]).map((s) => s.toLowerCase()).filter(Boolean);
    const rows = await db.execute(sql`
      SELECT d.id, d.url, d.title,
             COALESCE(dc.content, d.content) AS content
      FROM documents d
      LEFT JOIN document_content dc ON dc.id = d.content_id
      WHERE d.company_id = ${companyId}
        AND d.fetch_status = 'ok'
        AND COALESCE(dc.content_length, length(d.content)) > 50
      ORDER BY d.id
    `);
    const allDocs: any[] = (rows.rows as any[]).filter((r) => r.content && r.content.length > 50);
    const filtered = allDocs.filter((d) => {
      const hay = `${(d.title || "").toLowerCase()} ${(d.url || "").toLowerCase()}`;
      if (inc.length > 0 && !inc.some((s) => hay.includes(s))) return false;
      if (exc.length > 0 && exc.some((s) => hay.includes(s))) return false;
      return true;
    });

    if (filtered.length === 0) {
      return res.json({
        error: "no docs match filter",
        totalDocs: allDocs.length,
        sample: allDocs.slice(0, 5).map((d) => ({ id: d.id, title: d.title, url: d.url })),
      });
    }

    const documentTexts = filtered.map((d) => d.content as string);
    const documentUrls = filtered.map((d) => d.url as string);
    const documentTitles = filtered.map((d) => d.title as string);
    const totalChars = documentTexts.reduce((s, t) => s + t.length, 0);

    const analysis = await analyzeCompanyMeasures({
      workspaceId,
      companyName: company.name,
      companyId,
      documentTexts,
      documentUrls,
      documentTitles,
      framework: framework as any,
      measures: measures as any,
      freshScoring: true,
    });

    const allM = analysis.categories.flatMap((c: any) => c.measures);
    const report = allM.map((m: any) => ({
      measureId: m.measureId,
      title: m.title,
      verdict: m.verdict,
      score: m.score,
      confidence: m.confidence,
      abstained: (m as any).abstained === true,
      evidenceSummary: (m.evidenceSummary || "").slice(0, 600),
      quotes: (m.quotes || [])
        .filter((q: any) => q.sourceUrl !== "diag://retrieval-v1")
        .slice(0, 3)
        .map((q: any) => ({
          text: (q.text || "").slice(0, 300),
          source: q.source,
          sourceUrl: q.sourceUrl,
        })),
    }));
    res.json({
      company: company.name,
      framework: framework.name,
      inputDocs: filtered.map((d) => ({ id: d.id, title: d.title, url: d.url, chars: d.content.length })),
      totalChars,
      totalScore: analysis.scorePercentage,
      measures: report,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message, stack: (error.stack || "").split("\n").slice(0, 5) });
  }
});
