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
    const { companies: companiesData, listName } = req.body;

    let parsed: Array<{ name: string; isin?: string; domain?: string; sector?: string; country?: string; ticker?: string }>;

    if (req.file) {
      // Parse CSV
      const content = req.file.buffer.toString("utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
      parsed = lines.slice(1).map((line) => {
        const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
        const obj: any = {};
        headers.forEach((h, i) => { obj[h] = values[i] || undefined; });
        return obj;
      });
    } else if (companiesData) {
      parsed = JSON.parse(companiesData);
    } else {
      return res.status(400).json({ error: "No data provided" });
    }

    // Create companies
    const created: any[] = [];
    for (const data of parsed) {
      if (!data.name) continue;
      const company = await storage.createCompany({ ...data, workspaceId });
      created.push(company);
    }

    // Create list if specified
    if (listName && created.length > 0) {
      const list = await storage.createCompanyList(workspaceId, listName);
      for (const company of created) {
        await storage.addCompanyToList(list.id, company.id);
      }
    }

    res.json({ imported: created.length, companies: created });
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
    for (const measure of measures) {
      await storage.createFrameworkMeasure({ ...measure, frameworkId });
    }

    res.json({ success: true, count: measures.length });
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
