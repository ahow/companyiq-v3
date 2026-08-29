import express from "express";
import cors from "cors";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { sessionMiddleware } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { apiRouter } from "./routes/api.js";
import frameworkBuilderRouter from "./routes/framework-builder.js";
import frameworkBuilderV2Router from "./routes/framework-builder-v2.js";
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
// gzip/deflate responses. Large JSON payloads (e.g. consolidated share
// snapshots of 2000+ companies) are highly repetitive text and compress ~10-20x,
// turning a ~100MB response into a few MB so it transfers within proxy limits.
app.use(compression());
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
// Security: uses unguessable UUID share tokens (not sequential IDs) to prevent
// Share endpoint: Token-only access. Numeric IDs are REMOVED (returns 410 Gone).
// Public access requires the result to have is_public=true AND be accessed by token.
// Authenticated users can access any result in their workspace by token.
app.get("/api/results/:idOrToken/share", async (req, res) => {
  try {
    const param = req.params.idOrToken;
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);
    const isNumeric = /^\d+$/.test(param);

    // SECURITY: Numeric path is permanently removed. No enumeration possible.
    if (isNumeric) {
      return res.status(410).json({ error: "Numeric share links have been permanently removed. Use the share token URL." });
    }
    if (!isUUID) {
      return res.status(400).json({ error: "Invalid share link." });
    }

    const { db } = await import("./db.js");
    const { sql } = await import("drizzle-orm");

    // Token-only lookup
    const whereClause = sql`ar.share_token = ${param}`;

    // Check is_public + expiry. Unauthenticated access requires is_public=true.
    // Authenticated users in the same workspace can always access their own results.
    const authCheck = await db.execute(sql`
      SELECT ar.id, ar.is_public, ar.share_expires_at, ar.workspace_id
      FROM analysis_results ar WHERE ar.share_token = ${param}
    `);
    const authRow = (authCheck.rows as any[])?.[0];
    if (!authRow) return res.status(404).json({ error: "Result not found" });

    // Check if caller is authenticated and owns this result.
    // express-session (sessionMiddleware) has already populated req.session.
    // The cookie is "connect.sid" (not "session_id"), and the session store is
    // connect-pg-simple which stores a JSON blob — no workspace_id column.
    // So we read workspaceId directly from the deserialized session object.
    const sessWorkspaceId = (req.session as any)?.workspaceId;
    const isOwner = sessWorkspaceId != null && String(sessWorkspaceId) === String(authRow.workspace_id);

    // Enforce access control
    if (!isOwner) {
      if (!authRow.is_public) {
        return res.status(403).json({ error: "This result has not been shared publicly. The owner must enable sharing first." });
      }
      if (authRow.share_expires_at && new Date(authRow.share_expires_at) < new Date()) {
        return res.status(410).json({ error: "This share link has expired." });
      }
    }

    // ?format=summary (default) -> lightweight per-company scores, browser-friendly.
    // ?format=full            -> complete dataset incl. measures/quotes/sources, streamed.
    // format=full requires authentication (even with a valid token) to prevent
    // full evidence dumps from leaking via a shared link.
    const wantFull = String(req.query.format || "summary").toLowerCase() === "full";
    if (wantFull && !isOwner) {
      return res.status(403).json({ error: "Full export requires authentication. Use the summary format for public share links." });
    }

    // Cache for 5 min at the edge; payload is immutable per id+format.
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (!wantFull) {
      // Default summary view. Project ONLY the light per-company fields *inside Postgres*
      // via jsonb_array_elements + jsonb_build_object, so the (potentially ~100MB)
      // results_data blob is never loaded into the app.
      const r = await db.execute(sql`
        SELECT
          ar.id, ar.share_token, ar.framework_name, ar.list_name, ar.companies_count,
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
              'coverageLevel',      e->>'coverageLevel'
            ))
            FROM jsonb_array_elements(ar.results_data) e
          ), '[]'::jsonb) AS summary
        FROM analysis_results ar WHERE ${whereClause}
      `);
      const row = (r.rows as any[])?.[0];
      if (!row) return res.status(404).json({ error: "Result not found" });
      return res.json({
        id: row.id,
        shareToken: row.share_token,
        shareUrl: `/api/results/${row.share_token}/share`,
        frameworkName: row.framework_name,
        listName: row.list_name,
        companiesCount: row.companies_count,
        averageScore: row.average_score,
        createdAt: row.created_at,
        format: "summary",
        note: "Summary view. Append ?format=full for the complete dataset.",
        results: row.summary || [],
      });
    }

    // Full export. Stream results_data as raw text from Postgres — avoids parsing
    // the ~100MB JSONB blob into a JS object (which causes OOM/timeout on large results).
    // We select metadata + results_data::text separately, then write the JSON envelope
    // around the raw text without ever parsing it.
    const metaResult = await db.execute(sql`
      SELECT ar.id, ar.share_token, ar.framework_name, ar.list_name, ar.companies_count,
             ar.average_score, ar.created_at
      FROM analysis_results ar WHERE ${whereClause}
    `);
    const metaRow = (metaResult.rows as any[])?.[0];
    if (!metaRow) return res.status(404).json({ error: "Result not found" });

    // Fetch results_data as raw text (no JSON parse by pg driver)
    const dataResult = await db.execute(sql`
      SELECT ar.results_data::text AS raw_data
      FROM analysis_results ar WHERE ${whereClause}
    `);
    const rawData = (dataResult.rows as any[])?.[0]?.raw_data || "[]";

    const meta: any = {
      id: metaRow.id,
      shareToken: metaRow.share_token,
      shareUrl: `/api/results/${metaRow.share_token}/share`,
      frameworkName: metaRow.framework_name,
      listName: metaRow.list_name,
      companiesCount: metaRow.companies_count,
      averageScore: metaRow.average_score,
      createdAt: metaRow.created_at,
      format: "full",
    };
    res.write('{');
    for (const [k, v] of Object.entries(meta)) {
      res.write(JSON.stringify(k) + ':' + JSON.stringify(v) + ',');
    }
    // Write results_data directly as raw JSON text (already a valid JSON array)
    res.write('"results":');
    res.write(rawData);
    res.write('}');
    return res.end();
  } catch (error: any) {
    if (!res.headersSent) return res.status(500).json({ error: error.message });
    try { res.end(); } catch {}
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
app.use("/api/framework-builder", frameworkBuilderV2Router);

// ─── Static Files (SPA) ─────────────────────────────────────────────────────

const clientDist = path.join(process.cwd(), "dist/client");
app.use(express.static(clientDist));
app.get("*", (req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// ─── Start Server & Worker ──────────────────────────────────────────────────

// Initialize database then start server
initializeDatabase().then(async () => {
  // Clean up stale jobs from previous server sessions.
  // IMPORTANT: when a dedicated worker service owns the queue (RUN_WORKER=false),
  // the web service must NOT run cleanup — otherwise a web redeploy would cancel
  // batches the worker is actively processing (web/worker startup race).
  // The dedicated worker performs cleanup instead (gated by WORKER_RUN_CLEANUP).
  if (process.env.RUN_WORKER === "false") {
    console.log("[Server] RUN_WORKER=false — skipping startup cleanup (owned by dedicated worker service)");
  } else {
    await cleanupOnStartup();
  }

  // Self-heal: recover any completed batches that lost their snapshot
  // (e.g. due to a redeploy/crash during the old setTimeout window).
  try {
    const storage = await import("./storage.js");
    const { saveBatchSnapshot } = await import("./worker.js");
    const missing = await storage.getCompletedBatchesMissingSnapshot();
    for (const b of missing) {
      console.warn("[Recovery] Batch " + b.id + " completed without a snapshot — saving now");
      try {
        const saved = await saveBatchSnapshot(b.id, b.framework_id, b.workspace_id, b.list_id ?? undefined);
        if (saved) {
          await storage.markBatchSnapshotSaved(b.id);
          console.log("[Recovery] Snapshot recovered for batch " + b.id);
        } else {
          // Check if the snapshot actually exists in analysis_results before marking saved.
          // Do NOT blindly mark snapshot_saved=TRUE when no row was persisted — that
          // permanently hides the batch from future recovery attempts.
          const existingResults = await storage.getAnalysisResults(b.workspace_id);
          const hasRow = existingResults.some((r: any) => r.batchId === b.id);
          if (hasRow) {
            await storage.markBatchSnapshotSaved(b.id);
            console.log("[Recovery] Batch " + b.id + " already has a snapshot row — marking saved");
          } else {
            console.warn("[Recovery] Batch " + b.id + " has NO snapshot row — leaving snapshot_saved=FALSE for future retry");
          }
        }
      } catch (e: any) {
        console.error("[Recovery] Failed to recover snapshot for batch " + b.id + ": " + e.message);
      }
    }
    if (missing.length > 0) console.log(`[Recovery] Processed ${missing.length} missing snapshots`);
  } catch (e: any) {
    console.warn("[Recovery] Snapshot self-heal failed (non-fatal): " + e.message);
  }

  // B7: Validate framework regex patterns on startup
  try {
    const storage = await import("./storage.js");
    // Get all frameworks across all workspaces for validation
    const { db } = await import("./db.js");
    const { frameworks: frameworksTable } = await import("../shared/schema.js");
    const allFw = await db.select().from(frameworksTable);
    const frameworks = allFw;
    for (const fw of frameworks) {
      const patterns = ((fw as any).authoritativeFilingTypes as Array<{pattern: string}> | null) || [];
      for (const {pattern} of patterns) {
        if (/[\x00-\x1f]/.test(pattern)) {
          console.error(`[startup] Framework ${fw.id} has corrupted authoritativeFilingTypes pattern (contains control chars): ${JSON.stringify(pattern)}`);
        }
        try { new RegExp(pattern, "i"); }
        catch (e) {
          console.error(`[startup] Framework ${fw.id} has invalid authoritativeFilingTypes regex "${pattern}": ${e}`);
        }
      }
    }
  } catch (e: any) {
    console.warn("[startup] Framework regex validation failed (non-fatal):", e.message);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] CompanyIQ v3 running on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || "development"}`);

    // Start the embedded worker — unless a dedicated worker service is used.
    // Set RUN_WORKER=false on the web service once the standalone worker
    // (server/worker-main.ts) is deployed, so the web process stays lean and
    // heavy Chromium fetching can never affect web availability.
    if (process.env.RUN_WORKER === "false") {
      console.log("[Server] RUN_WORKER=false — embedded worker disabled (using dedicated worker service)");
    } else {
      const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
      startWorker(workerId);
    }
  });
}).catch((err) => {
  console.error("[Server] Failed to initialize database:", err);
  process.exit(1);
});
