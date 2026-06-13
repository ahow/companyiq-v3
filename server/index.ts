import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { sessionMiddleware } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { apiRouter } from "./routes/api.js";
import frameworkBuilderRouter from "./routes/framework-builder.js";
import { startWorker } from "./worker.js";
import { initializeDatabase } from "./db.js";
import { cleanupOnStartup } from "./startup-cleanup.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || "3000");

// ─── Log Noise Filter ───────────────────────────────────────────────────────
// PDF.js (via pdf-parse) emits a high volume of benign warnings while parsing
// malformed PDFs ("Unknown command", "Badly formatted number", "Ignoring
// invalid character", flate-stream errors, etc.). Under batch load these can
// exceed Railway's 500 logs/sec limit and drop genuinely useful log lines.
// Filter only this known-benign noise; everything else passes through.
(() => {
  const NOISE_PATTERNS = [
    "Unknown command",
    "Badly formatted number",
    "Ignoring invalid character",
    "Unterminated string",
    "FormatError: Bad encoding in flate stream",
    "FormatError: Unknown charset format",
    "getTextContent - ignoring",
    "Skipping command",
    "fontRef not available",
    "Setting up fake worker",
    "Indexing all PDF objects",
  ];
  const isNoise = (args: any[]) =>
    typeof args[0] === "string" && NOISE_PATTERNS.some((p) => args[0].includes(p));
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  console.log = (...args: any[]) => { if (!isNoise(args)) origLog(...args); };
  console.warn = (...args: any[]) => { if (!isNoise(args)) origWarn(...args); };
})();

// ─── Global Safety-Net Handlers ─────────────────────────────────────────────
// The BullMQ worker runs in this same process. Without these handlers, a single
// unhandled rejection from the document-fetch pipeline (e.g. a Chromium launch
// failure under resource pressure) would terminate the entire web server and
// take the app down. Log and survive instead of crashing.

process.on("unhandledRejection", (reason: any) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  console.error(`[FATAL-GUARD] Unhandled promise rejection (suppressed, process kept alive): ${msg}`);
});

process.on("uncaughtException", (err: any) => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  console.error(`[FATAL-GUARD] Uncaught exception (suppressed, process kept alive): ${msg}`);
});

// Graceful shutdown so in-flight work and the worker close cleanly on deploys.
async function gracefulShutdown(signal: string) {
  console.log(`[Server] Received ${signal} — shutting down gracefully...`);
  try {
    const { stopWorker } = await import("./worker.js");
    await stopWorker();
  } catch (e: any) {
    console.warn(`[Server] Worker shutdown error (non-fatal): ${e?.message}`);
  }
  process.exit(0);
}
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });

// ─── Middleware ─────────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.NODE_ENV === "production" ? undefined : "http://localhost:5173",
  credentials: true,
}));
app.use(express.json({ limit: "50mb" }));
app.use(sessionMiddleware);

// Trust proxy for Railway/Heroku
app.set("trust proxy", 1);

// ─── API Routes ─────────────────────────────────────────────────────────────

// ─── Health Check (before auth) ────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: "3.0.0", timestamp: new Date().toISOString() });
});

// ─── Public Share Endpoint (no auth required) ──────────────────────────────
app.get("/api/results/:id/share", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { db } = await import("./db.js");
    const { sql } = await import("drizzle-orm");
    const result = await db.execute(sql`SELECT * FROM analysis_results WHERE id = ${id}`);
    const row = (result.rows as any[])?.[0];
    if (!row) return res.status(404).json({ error: "Result not found" });
    res.json({
      frameworkName: row.framework_name,
      listName: row.list_name,
      companiesCount: row.companies_count,
      averageScore: row.average_score,
      createdAt: row.created_at,
      results: row.results_data,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Admin: Resume/Enqueue Analysis (token-protected, no session) ───────────
// Used to resume an interrupted batch for a specific set of companies without a
// dashboard session. Protected by ADMIN_TOKEN. Runs the exact same enqueue path
// the /analyze route uses (createBatchRun -> createAnalysisJobs -> addBatchJobs).
app.post("/api/admin/resume-analysis", async (req, res) => {
  try {
    const token = req.header("x-admin-token");
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { workspaceId, frameworkId, companyIds } = req.body || {};
    if (!workspaceId || !frameworkId || !Array.isArray(companyIds) || companyIds.length === 0) {
      return res.status(400).json({ error: "workspaceId, frameworkId and non-empty companyIds[] required" });
    }
    const storage = await import("./storage.js");
    const { addBatchJobs } = await import("./queue.js");

    // Resolve companies within the given workspace
    const companies: any[] = [];
    for (const id of companyIds) {
      const c = await storage.getCompanyById(Number(id), Number(workspaceId));
      if (c) companies.push(c);
    }
    if (companies.length === 0) {
      return res.status(400).json({ error: "No valid companies found in workspace" });
    }

    // Reset their status so they re-run cleanly
    for (const company of companies) {
      await storage.updateCompany(company.id, Number(workspaceId), { analysisStatus: "idle", totalScore: null, summary: null });
    }

    const batch = await storage.createBatchRun(Number(workspaceId), Number(frameworkId), companies.length);
    const jobsData = companies.map((c) => ({
      workspaceId: Number(workspaceId),
      batchId: batch.id,
      companyId: c.id,
      companyName: c.name,
      frameworkId: Number(frameworkId),
    }));
    const dbJobs = await storage.createAnalysisJobs(jobsData);
    const queueJobs = dbJobs.map((j: any) => ({
      jobId: j.id,
      companyId: j.companyId,
      frameworkId: j.frameworkId,
      batchId: batch.id,
      workspaceId: Number(workspaceId),
    }));
    await addBatchJobs(queueJobs, Number(workspaceId), batch.id);

    console.log(`[Admin] Resume enqueued batch ${batch.id} with ${companies.length} companies (workspace ${workspaceId}, framework ${frameworkId})`);
    res.json({ success: true, batchId: batch.id, enqueued: companies.length, requested: companyIds.length });
  } catch (error: any) {
    console.error(`[Admin] resume-analysis error: ${error?.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.use("/api/auth", authRouter);
app.use("/api", apiRouter);
app.use("/api/framework-builder", frameworkBuilderRouter);

// ─── Static Files (SPA) ─────────────────────────────────────────────────────

const clientDist = path.join(process.cwd(), "dist/client");
app.use(express.static(clientDist));
app.get("*", (req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// ─── Start Server & Worker ──────────────────────────────────────────────────

// Initialize database then start server
initializeDatabase().then(async () => {
  // Clean up stale jobs from previous server sessions
  // This ensures analysis only runs when explicitly triggered by the user
  await cleanupOnStartup();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] CompanyIQ v3 running on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || "development"}`);

    // Start the embedded worker
    const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
    startWorker(workerId);
  });
}).catch((err) => {
  console.error("[Server] Failed to initialize database:", err);
  process.exit(1);
});
