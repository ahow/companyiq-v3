import { Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "../db.js";

const PgSession = connectPgSimple(session);

export const sessionMiddleware = session({
  store: new PgSession({
    pool: pool as any,
    tableName: "user_sessions",
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || "companyiq-v3-secret-change-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: "lax",
  },
});

// Extend Express Request type
declare module "express-session" {
  interface SessionData {
    userId: number;
    workspaceId: number;
    email: string;
  }
}

// Require authentication middleware
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

// Require workspace selection middleware
export function requireWorkspace(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  if (!req.session.workspaceId) {
    return res.status(400).json({ error: "No workspace selected" });
  }
  next();
}

// Helper to get current user/workspace from session
export function getSessionContext(req: Request) {
  return {
    userId: req.session.userId!,
    workspaceId: req.session.workspaceId!,
    email: req.session.email!,
  };
}
