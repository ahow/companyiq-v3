import { Router, Request, Response } from "express";
import * as storage from "../storage.js";
import { requireAuth, getSessionContext } from "../middleware/auth.js";

export const authRouter = Router();

// ─── Sign Up ────────────────────────────────────────────────────────────────

authRouter.post("/signup", async (req: Request, res: Response) => {
  try {
    const { email, password, name, workspaceMode, workspaceId: joinWorkspaceId, workspaceName } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: "Email, password, and name are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    // Check if user already exists
    const existing = await storage.getUserByEmail(email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    // Create user
    const user = await storage.createUser(email.toLowerCase(), password, name);

    let workspace;
    if (workspaceMode === "join" && joinWorkspaceId) {
      // Join an existing workspace
      await storage.joinWorkspace(joinWorkspaceId, user.id);
      workspace = await storage.getWorkspaceById(joinWorkspaceId);
    } else {
      // Create a new workspace (default behavior)
      const wsName = workspaceName || `${name}'s Workspace`;
      workspace = await storage.createWorkspace(wsName, user.id);
    }

    // Set session
    req.session.userId = user.id;
    req.session.workspaceId = workspace!.id;
    req.session.email = user.email;

    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      workspace: { id: workspace!.id, name: workspace!.name, slug: workspace!.slug },
    });
  } catch (error: any) {
    console.error("[Auth] Signup error:", error.message);
    res.status(500).json({ error: "Failed to create account" });
  }
});

// ─── List Available Workspaces (for signup) ────────────────────────────────

authRouter.get("/workspaces", async (_req: Request, res: Response) => {
  try {
    const workspaces = await storage.getAllWorkspaces();
    res.json({ workspaces });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Log In ─────────────────────────────────────────────────────────────────

authRouter.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await storage.getUserByEmail(email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await storage.verifyPassword(user, password);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Get user's workspaces
    const workspaces = await storage.getUserWorkspaces(user.id);
    const defaultWorkspace = workspaces[0]?.workspace;

    if (!defaultWorkspace) {
      // Create a workspace if none exists (shouldn't happen normally)
      const workspace = await storage.createWorkspace(`${user.name}'s Workspace`, user.id);
      req.session.workspaceId = workspace.id;
    } else {
      req.session.workspaceId = defaultWorkspace.id;
    }

    req.session.userId = user.id;
    req.session.email = user.email;

    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      workspace: defaultWorkspace || { id: req.session.workspaceId },
      workspaces: workspaces.map((m) => ({ ...m.workspace, role: m.role })),
    });
  } catch (error: any) {
    console.error("[Auth] Login error:", error.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// ─── Log Out ────────────────────────────────────────────────────────────────

authRouter.post("/logout", (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Logout failed" });
    }
    res.json({ success: true });
  });
});

// ─── Session Check ──────────────────────────────────────────────────────────

authRouter.get("/me", async (req: Request, res: Response) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const user = await storage.getUserById(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: "User not found" });
  }

  const workspaces = await storage.getUserWorkspaces(user.id);
  const currentWorkspace = workspaces.find((m) => m.workspace.id === req.session.workspaceId)?.workspace;

  res.json({
    user: { id: user.id, email: user.email, name: user.name },
    workspace: currentWorkspace,
    workspaces: workspaces.map((m) => ({ ...m.workspace, role: m.role })),
  });
});

// ─── Switch Workspace ───────────────────────────────────────────────────────

authRouter.post("/switch-workspace", requireAuth, async (req: Request, res: Response) => {
  try {
    const { workspaceId } = req.body;
    const userId = req.session.userId!;

    const isMember = await storage.isWorkspaceMember(workspaceId, userId);
    if (!isMember) {
      return res.status(403).json({ error: "Not a member of this workspace" });
    }

    req.session.workspaceId = workspaceId;
    const workspace = await storage.getWorkspaceById(workspaceId);

    res.json({ workspace });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Create Workspace ───────────────────────────────────────────────────────

authRouter.post("/create-workspace", requireAuth, async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    const userId = req.session.userId!;

    if (!name) {
      return res.status(400).json({ error: "Workspace name is required" });
    }

    const workspace = await storage.createWorkspace(name, userId);
    req.session.workspaceId = workspace.id;

    res.json({ workspace });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Change Password ──────────────────────────────────────────────────────

authRouter.post("/change-password", requireAuth, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.session.userId!;

    const user = await storage.getUserById(userId);
    if (!user || !(await storage.verifyPassword(user, currentPassword))) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    if (!newPassword || String(newPassword).length < 12) {
      return res.status(400).json({ error: "New password must be at least 12 characters" });
    }

    await storage.updateUserPassword(user.id, String(newPassword));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
