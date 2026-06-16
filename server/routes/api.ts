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
      measuresMet: null, measuresTotal: null, discoveryDiagnostics: null
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

    const allowedFields = ["name", "topicDescription", "searchTemplates", "negativeKeywords", "negativeDomains", "knownDisclosureUrls", "trustedSourceIds", "isShared"];
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
    const results = await storage.getAnalysisResults(workspaceId);
    res.json(results);
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

apiRouter.get("/results/:id/share", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    // Public share endpoint - returns the results data as JSON
    const { db } = await import("./db.js");
    const { sql } = await import("drizzle-orm");
    const [result] = await db.execute(sql`SELECT * FROM analysis_results WHERE id = ${id}`).then(r => r.rows) as any[];
    if (!result) return res.status(404).json({ error: "Result not found" });
    res.json({
      frameworkName: result.framework_name,
      listName: result.list_name,
      companiesCount: result.companies_count,
      createdAt: result.created_at,
      results: result.results_data,
    });
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

    // Reset company status
    await storage.updateCompany(company.id, workspaceId, { analysisStatus: "idle", totalScore: null, summary: null });

    // Create a batch for single company
    const batch = await storage.createBatchRun(workspaceId, activeFramework.id, 1);

    // Create jobs in DB (same pattern as batch analyze)
    const jobsData = [{
      workspaceId,
      batchId: batch.id,
      companyId: company.id,
      companyName: company.name,
      frameworkId: activeFramework.id,
    }];
    const dbJobs = await storage.createAnalysisJobs(jobsData);

    // Add to BullMQ queue
    const queueJobs = dbJobs.map((j) => ({
      jobId: j.id,
      companyId: j.companyId,
      frameworkId: j.frameworkId,
      batchId: batch.id,
      workspaceId,
    }));
    await addBatchJobs(queueJobs, workspaceId, batch.id);

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
