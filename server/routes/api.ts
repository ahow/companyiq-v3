import { Router, Request, Response } from "express";
import multer from "multer";
import * as storage from "../storage.js";
import { requireWorkspace, getSessionContext } from "../middleware/auth.js";
import { addBatchJobs, removeBatchJobs, getQueueStats } from "../queue.js";
import { cancelBatch } from "../worker.js";

export const apiRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// All API routes require workspace context
apiRouter.use(requireWorkspace);

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

      // Check for existing company with same name in this workspace
      const existing = await storage.getCompanyByName(name, workspaceId);
      if (existing) {
        skipped.push(name);
        created.push(existing);
        continue;
      }

      const isin = findCol(row, "ISIN", "isin", "Type", "type", "Identifier", "ID");
      const sector = findCol(row, "LEVEL2 SECTOR NAME", "LEVEL3 SECTOR NAME", "sector", "Sector", "SECTOR", "Industry", "industry");
      const country = findCol(row, "GEOGRAPHIC DESCR.", "GEOGRAPHIC DESCR", "country", "Country", "COUNTRY", "Geography", "Region");
      const domain = findCol(row, "domain", "Domain", "DOMAIN", "website", "Website", "URL", "url");

      const company = await storage.createCompany({
        name,
        isin: isin || null,
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

    const allowedFields = ["name", "topicDescription", "searchTemplates", "negativeKeywords", "negativeDomains", "knownDisclosureUrls", "trustedSourceIds"];
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
    const { frameworkId, listId, companyIds } = req.body;

    // Get framework
    const framework = await storage.getFrameworkById(frameworkId, workspaceId);
    if (!framework) return res.status(404).json({ error: "Framework not found" });

    // Determine companies to analyze
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

    if (companies.length === 0) {
      return res.status(400).json({ error: "No companies to analyze" });
    }

    // Reset company statuses
    for (const company of companies) {
      await storage.updateCompany(company.id, workspaceId, { analysisStatus: "idle", totalScore: null, summary: null });
    }

    // Create batch run
    const batch = await storage.createBatchRun(workspaceId, frameworkId, companies.length, listId);

    // Create jobs in DB and add to BullMQ queue
    const jobsData = companies.map((c) => ({
      workspaceId,
      batchId: batch.id,
      companyId: c.id,
      companyName: c.name,
      frameworkId,
    }));
    const dbJobs = await storage.createAnalysisJobs(jobsData);

    // Add to BullMQ for processing
    const queueJobs = dbJobs.map((j) => ({
      jobId: j.id,
      companyId: j.companyId,
      frameworkId: j.frameworkId,
      batchId: batch.id,
      workspaceId,
    }));
    await addBatchJobs(queueJobs, workspaceId, batch.id);

    res.json({
      success: true,
      batchId: batch.id,
      totalJobs: companies.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Batch Status ───────────────────────────────────────────────────────────

apiRouter.get("/batch/status", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const batch = await storage.getActiveBatchRun(workspaceId);

    if (!batch) {
      return res.json({ running: false, completed: 0, total: 0, failed: 0 });
    }

    res.json({
      running: batch.status === "running",
      batchId: batch.id,
      completed: batch.completedJobs,
      failed: batch.failedJobs,
      total: batch.totalJobs,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post("/batch/cancel", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const batch = await storage.getActiveBatchRun(workspaceId);
    if (batch) {
      cancelBatch(batch.id);
      await removeBatchJobs(batch.id);
      await storage.cancelBatchRun(batch.id);
    }
    res.json({ success: true });
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

// ─── Results ────────────────────────────────────────────────────────────────

apiRouter.get("/results", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const results = await storage.getAnalysisResults(workspaceId);
    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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

apiRouter.delete("/trusted-sources/:id", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    await storage.deleteTrustedSource(parseInt(req.params.id), workspaceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Single Company Analyze ─────────────────────────────────────────────────
apiRouter.post("/companies/:id/analyze", async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const companyId = parseInt(req.params.id);
    const company = await storage.getCompanyById(companyId, workspaceId);
    if (!company) return res.status(404).json({ error: "Company not found" });

    const frameworks = await storage.getFrameworks(workspaceId);
    const activeFramework = frameworks.find((f: any) => f.isActive);
    if (!activeFramework) return res.status(400).json({ error: "No active framework" });

    // Create a batch for single company
    const batch = await storage.createBatchRun(workspaceId, activeFramework.id, 1);
    const jobs = await storage.createAnalysisJobs(batch.id, [companyId], workspaceId);
    await addBatchJobs(batch.id, jobs, workspaceId, activeFramework.id);

    res.json({ success: true, batchId: batch.id });
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
