const API_BASE = "/api";

async function request(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    credentials: "include",
  });

  if (res.status === 401) {
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || res.statusText);
  }

  return res.json();
}

export const api = {
  // Raw request helper
  request,

  // Auth
  login: (email: string, password: string) =>
    request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  signup: (email: string, password: string, name: string, opts?: { workspaceMode?: string; workspaceId?: number; workspaceName?: string }) =>
    request("/auth/signup", { method: "POST", body: JSON.stringify({ email, password, name, ...opts }) }),
  getWorkspaces: () => request("/auth/workspaces"),
  logout: () => request("/auth/logout", { method: "POST" }),
  getSession: async () => {
    try {
      return await request("/auth/me");
    } catch (e: any) {
      if (e.message === "Unauthorized") return null;
      throw e;
    }
  },

  // Companies
  getCompanies: () => request("/companies"),
  getCompany: (id: number) => request(`/companies/${id}`),
  createCompany: (data: any) => request("/companies", { method: "POST", body: JSON.stringify(data) }),
  updateCompany: (id: number, data: any) => request(`/companies/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteCompany: (id: number) => request(`/companies/${id}`, { method: "DELETE" }),
  resetCompany: (id: number) => request(`/companies/${id}/reset`, { method: "POST" }),
  fullResetCompany: (id: number) => request(`/companies/${id}/full-reset`, { method: "POST" }),
  resetList: (listId: number) => request(`/lists/${listId}/reset`, { method: "POST" }),
  fullResetList: (listId: number) => request(`/lists/${listId}/full-reset`, { method: "POST" }),
  resetAll: () => request("/companies/reset-all", { method: "POST" }),
  fullResetAll: () => request("/companies/full-reset-all", { method: "POST" }),
  importCompanies: (data: any) => request("/companies/import", { method: "POST", body: JSON.stringify(data) }),

  // Lists
  getLists: () => request("/lists"),
  createList: (name: string, description?: string) => request("/lists", { method: "POST", body: JSON.stringify({ name, description }) }),
  updateList: (id: number, data: any) => request(`/lists/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  getListCompanies: (id: number) => request(`/lists/${id}/companies`),
  addToList: (listId: number, companyId: number) => request(`/lists/${listId}/companies`, { method: "POST", body: JSON.stringify({ companyId }) }),

  // Frameworks
  getFrameworks: () => request("/frameworks"),
  getFramework: (id: number) => request(`/frameworks/${id}`),
  createFramework: (data: any) => request("/frameworks", { method: "POST", body: JSON.stringify(data) }),
  updateFramework: (id: number, data: any) => request(`/frameworks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteFramework: (id: number) => request(`/frameworks/${id}`, { method: "DELETE" }),
  activateFramework: (id: number) => request(`/frameworks/${id}/activate`, { method: "POST" }),
  setMeasures: (frameworkId: number, measures: any[]) => request(`/frameworks/${frameworkId}/measures`, { method: "POST", body: JSON.stringify({ measures }) }),

  // Analysis
  analyze: (data: { frameworkId: number; listId?: number; companyIds?: number[]; offPeakOnly?: boolean }) =>
    request("/analyze", { method: "POST", body: JSON.stringify(data) }),
  getBatchStatus: () => request("/batch/status"),
  cancelBatch: () => request("/batch/cancel", { method: "POST" }),
  getSystemAlerts: () => request("/system/alerts"),
  resumeSystem: (kind: string = "credit_exhaustion") =>
    request("/system/alerts/resume", { method: "POST", body: JSON.stringify({ kind }) }),
  getBatchReview: () => request("/batch/review"),
  reexamineFailures: () => request("/batch/review/reexamine", { method: "POST" }),
  finalizeBatchReview: () => request("/batch/review/finalize", { method: "POST" }),

  // Results
  getResults: () => request("/results"),
  getResultById: (id: number) => request(`/results/${id}`),
  bulkDeleteResults: (ids: number[]) =>
    request("/results/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) }),

  // Settings
  getSettings: () => request("/settings"),
  setSetting: (key: string, value: string) => request("/settings", { method: "POST", body: JSON.stringify({ key, value }) }),

  // User / workspace member management
  getUsers: () => request("/users"),
  addUser: (data: { email: string; name?: string; password?: string; role?: string }) =>
    request("/users", { method: "POST", body: JSON.stringify(data) }),
  updateUserRole: (userId: number, role: string) =>
    request(`/users/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  removeUser: (userId: number) => request(`/users/${userId}`, { method: "DELETE" }),

  // Trusted Sources
  getTrustedSources: () => request("/trusted-sources"),
  addTrustedSource: (name: string, domain: string, description?: string) => request("/trusted-sources", { method: "POST", body: JSON.stringify({ name, domain, description }) }),
  updateTrustedSource: (id: number, data: any) => request(`/trusted-sources/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTrustedSource: (id: number) => request(`/trusted-sources/${id}`, { method: "DELETE" }),

  // Excluded Sources
  getExcludedSources: () => request("/excluded-sources"),
  addExcludedSource: (domain: string, reason?: string) => request("/excluded-sources", { method: "POST", body: JSON.stringify({ domain, reason }) }),
  updateExcludedSource: (id: number, data: any) => request(`/excluded-sources/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteExcludedSource: (id: number) => request(`/excluded-sources/${id}`, { method: "DELETE" }),

  // Platform Sources (global shared multi-tenant hosts — always issuer-verified)
  getPlatformSources: () => request("/platform-sources"),
  addPlatformSource: (domain: string, reason?: string) => request("/platform-sources", { method: "POST", body: JSON.stringify({ domain, reason }) }),
  updatePlatformSource: (id: number, data: any) => request(`/platform-sources/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deletePlatformSource: (id: number) => request(`/platform-sources/${id}`, { method: "DELETE" }),
  suppressPlatformSource: (id: number) => request(`/platform-sources/${id}/suppress`, { method: "POST" }),
  unsuppressPlatformSource: (id: number) => request(`/platform-sources/${id}/unsuppress`, { method: "POST" }),
  detectPlatformSources: (minCompanies = 3) => request("/platform-sources/detect", { method: "POST", body: JSON.stringify({ minCompanies }) }),

  // Results (delete)
  deleteResult: (id: number) => request(`/results/${id}`, { method: "DELETE" }),

  // Queue
  getQueueStats: () => request("/queue/stats"),

  // Diagnostics
  getBatchRuns: () => request("/batch/runs"),
  getRecentErrors: () => request("/diagnostics/recent-errors"),

  // Score Anomalies
  getScoreAnomalies: (status: string = "pending") => request(`/score-anomalies?status=${status}`),
  getAnomalyCount: () => request("/score-anomalies/count"),
  dismissAnomaly: (id: number) => request(`/score-anomalies/${id}/dismiss`, { method: "POST" }),
  reexamineAnomaly: (id: number) => request(`/score-anomalies/${id}/reexamine`, { method: "POST" }),
  bulkDismissAnomalies: (ids: number[]) => request("/score-anomalies/bulk-dismiss", { method: "POST", body: JSON.stringify({ ids }) }),
  bulkReexamineAnomalies: (ids: number[]) => request("/score-anomalies/bulk-reexamine", { method: "POST", body: JSON.stringify({ ids }) }),
};
