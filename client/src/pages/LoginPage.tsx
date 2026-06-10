import { useState, useEffect } from "react";
import { api } from "../lib/api";

interface LoginPageProps {
  onSuccess: () => void;
}

export default function LoginPage({ onSuccess }: LoginPageProps) {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Workspace selection state
  const [workspaceMode, setWorkspaceMode] = useState<"create" | "join">("create");
  const [workspaceName, setWorkspaceName] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number | null>(null);
  const [availableWorkspaces, setAvailableWorkspaces] = useState<Array<{ id: number; name: string }>>([]);

  // Load available workspaces when signup mode is active
  useEffect(() => {
    if (isSignup) {
      api.getWorkspaces().then((data: any) => {
        setAvailableWorkspaces(data.workspaces || []);
      }).catch(() => {});
    }
  }, [isSignup]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (isSignup) {
        const opts: any = { workspaceMode };
        if (workspaceMode === "join" && selectedWorkspaceId) {
          opts.workspaceId = selectedWorkspaceId;
        } else if (workspaceMode === "create" && workspaceName.trim()) {
          opts.workspaceName = workspaceName.trim();
        }
        await api.signup(email, password, name, opts);
      } else {
        await api.login(email, password);
      }
      onSuccess();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center mx-auto mb-3">
            <span className="text-white font-bold text-lg">IQ</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">CompanyIQ</h1>
          <p className="text-gray-500 text-sm mt-1">
            Multi-company ESG & governance assessment platform
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignup && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Your name"
                required
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="you@company.com"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="••••••••"
              required
              minLength={6}
            />
          </div>

          {/* Workspace selection — only shown during signup */}
          {isSignup && (
            <div className="border border-gray-200 rounded-lg p-4 space-y-3">
              <label className="block text-sm font-medium text-gray-700">Workspace</label>
              <p className="text-xs text-gray-500">
                <strong>Join an existing workspace</strong> to share company lists, frameworks, and results with other members.
                <strong> Create a new workspace</strong> for independent analysis that runs in parallel without competing for queue priority.
              </p>

              <div className="flex gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="workspaceMode"
                    value="create"
                    checked={workspaceMode === "create"}
                    onChange={() => setWorkspaceMode("create")}
                    className="text-blue-600"
                  />
                  <span className="text-sm text-gray-700">Create new</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="workspaceMode"
                    value="join"
                    checked={workspaceMode === "join"}
                    onChange={() => setWorkspaceMode("join")}
                    className="text-blue-600"
                  />
                  <span className="text-sm text-gray-700">Join existing</span>
                </label>
              </div>

              {workspaceMode === "create" && (
                <input
                  type="text"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  placeholder="Workspace name (optional)"
                />
              )}

              {workspaceMode === "join" && (
                <select
                  value={selectedWorkspaceId || ""}
                  onChange={(e) => setSelectedWorkspaceId(e.target.value ? Number(e.target.value) : null)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  required
                >
                  <option value="">Select a workspace...</option>
                  {availableWorkspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>{ws.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {error && (
            <div className="text-red-600 text-sm bg-red-50 p-3 rounded-lg">{error}</div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? "..." : isSignup ? "Create Account" : "Sign In"}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            onClick={() => { setIsSignup(!isSignup); setError(""); }}
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            {isSignup ? "Already have an account? Sign in" : "Need an account? Sign up"}
          </button>
        </div>
      </div>
    </div>
  );
}
