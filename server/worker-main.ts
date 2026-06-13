/**
 * Standalone Worker Entrypoint for CompanyIQ v3
 *
 * Runs the BullMQ analysis worker in its OWN process / Railway service,
 * decoupled from the web server. This isolates heavy document fetching
 * (including Chromium browser-fallback) from web availability and lets the
 * worker service be sized with a Chromium-friendly memory budget independently.
 *
 * Start command (worker service): node --import tsx server/worker-main.ts
 *
 * Notes:
 * - No Express server is started here; this process only consumes the queue.
 * - Startup cleanup is intentionally NOT run here by default. Cleanup that
 *   cancels stale batches / drains the queue is owned by the web service
 *   (single owner) to avoid two services racing to wipe each other's jobs.
 *   Set WORKER_RUN_CLEANUP=true only if this worker should own cleanup instead.
 */

import crypto from "crypto";
import { initializeDatabase } from "./db.js";
import { startWorker, stopWorker } from "./worker.js";

// ─── Log Noise Filter ───────────────────────────────────────────────────────
// Mirror the web server's PDF.js noise filter so the worker (which does the
// actual PDF parsing) does not flood Railway's log-rate limit.
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
// Keep the worker process alive on an unhandled rejection (e.g. a transient
// Chromium launch failure). The restartPolicy will still recover a true crash.
process.on("unhandledRejection", (reason: any) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  console.error(`[FATAL-GUARD] Unhandled promise rejection (suppressed, worker kept alive): ${msg}`);
});
process.on("uncaughtException", (err: any) => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  console.error(`[FATAL-GUARD] Uncaught exception (suppressed, worker kept alive): ${msg}`);
});

async function gracefulShutdown(signal: string) {
  console.log(`[Worker-Main] Received ${signal} — shutting down worker gracefully...`);
  try {
    await stopWorker();
  } catch (e: any) {
    console.warn(`[Worker-Main] Worker shutdown error (non-fatal): ${e?.message}`);
  }
  process.exit(0);
}
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });

// ─── Boot ─────────────────────────────────────────────────────────────────
initializeDatabase().then(async () => {
  if (process.env.WORKER_RUN_CLEANUP === "true") {
    try {
      const { cleanupOnStartup } = await import("./startup-cleanup.js");
      await cleanupOnStartup();
    } catch (e: any) {
      console.warn(`[Worker-Main] Startup cleanup error (non-fatal): ${e?.message}`);
    }
  }

  const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`[Worker-Main] Starting standalone worker ${workerId} (concurrency=${process.env.WORKER_CONCURRENCY || "10"}, maxBrowsers=${process.env.MAX_CONCURRENT_BROWSER || "2"})`);
  startWorker(workerId);

  // Lightweight heartbeat so the service shows liveness in logs.
  setInterval(() => {
    console.log(`[Worker-Main] alive @ ${new Date().toISOString()} (rss=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB)`);
  }, 120_000);
}).catch((err) => {
  console.error("[Worker-Main] Failed to initialize database:", err);
  process.exit(1);
});
