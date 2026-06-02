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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || "3000");

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Server] CompanyIQ v3 running on port ${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || "development"}`);

  // Start the embedded worker
  const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
  startWorker(workerId);
});
