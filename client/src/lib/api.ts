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
  // Auth
  login: (email: string, password: string) =>
    request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  signup: (email: string, password: string, name: string) =>
    request("/auth/signup", { method: "POST", body: JSON.stringify({ email, password, name }) }),
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
  importCompanies: (data: any) => request("/companies/import", { method: "POST", body: JSON.stringify(data) }),

  // Lists
  getLists: () => request("/lists"),
  createList: (name: string, description?: string) => request("/lists", { method: "POST", body: JSON.stringify({ name, description }) }),
  getListCompanies: (id: number) => request(`/lists/${id}/companies`),
  addToList: (listId: number, companyId: number) => request(`/lists/${listId}/companies`, { method: "POST", body: JSON.stringify({ companyId }) }),

  // Frameworks
  getFrameworks: () => request("/frameworks"),
  getFramework: (id: number) => request(`/frameworks/${id}`),
  createFramework: (data: any) => request("/frameworks", { method: "POST", body: JSON.stringify(data) }),
  activateFramework: (id: number) => request(`/frameworks/${id}/activate`, { method: "POST" }),
  setMeasures: (frameworkId: number, measures: any[]) => request(`/frameworks/${frameworkId}/measures`, { method: "POST", body: JSON.stringify({ measures }) }),

  // Analysis
  analyze: (data: { frameworkId: number; listId?: number; companyIds?: number[] }) =>
    request("/analyze", { method: "POST", body: JSON.stringify(data) }),
  getBatchStatus: () => request("/batch/status"),
  cancelBatch: () => request("/batch/cancel", { method: "POST" }),

  // Results
  getResults: () => request("/results"),

  // Settings
  getSettings: () => request("/settings"),
  setSetting: (key: string, value: string) => request("/settings", { method: "POST", body: JSON.stringify({ key, value }) }),

  // Trusted Sources
  getTrustedSources: () => request("/trusted-sources"),
  addTrustedSource: (name: string, domain: string) => request("/trusted-sources", { method: "POST", body: JSON.stringify({ name, domain }) }),
  deleteTrustedSource: (id: number) => request(`/trusted-sources/${id}`, { method: "DELETE" }),

  // Queue
  getQueueStats: () => request("/queue/stats"),
};
