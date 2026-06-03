import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState, useMemo, useRef } from "react";
import {
  Search, Play, Square, Plus, Upload, Download, BarChart3,
  RotateCcw, ExternalLink, Trash2, Loader2, CheckCircle2, XCircle,
  Clock, AlertCircle
} from "lucide-react";

interface DashboardPageProps {
  onViewCompany: (id: number) => void;
}

export default function DashboardPage({ onViewCompany }: DashboardPageProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedList, setSelectedList] = useState<number | null>(null);
  const [selectedFramework, setSelectedFramework] = useState<number | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCompany, setNewCompany] = useState({ name: "", isin: "", sector: "", country: "", domain: "" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: companiesData, isLoading } = useQuery({
    queryKey: ["companies"],
    queryFn: api.getCompanies,
    refetchInterval: 10000,
  });

  const { data: batchStatus } = useQuery({
    queryKey: ["batchStatus"],
    queryFn: api.getBatchStatus,
    refetchInterval: 3000,
  });

  const { data: lists = [] } = useQuery({
    queryKey: ["lists"],
    queryFn: api.getLists,
  });

  const { data: frameworks = [] } = useQuery({
    queryKey: ["frameworks"],
    queryFn: api.getFrameworks,
  });

  const companies = companiesData?.companies || [];
  const stats = companiesData?.stats || { total: 0, completed: 0, avgScore: 0 };

  const filteredCompanies = companies.filter((c: any) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.sector || "").toLowerCase().includes(search.toLowerCase()) ||
    (c.country || "").toLowerCase().includes(search.toLowerCase())
  );

  // Score distribution
  const scoreDistribution = useMemo(() => {
    const completedCompanies = companies.filter((c: any) => c.analysisStatus === "completed" && c.totalScore !== null);
    const buckets = [
      { label: "0-10%", min: 0, max: 10, count: 0 },
      { label: "11-20%", min: 11, max: 20, count: 0 },
      { label: "21-30%", min: 21, max: 30, count: 0 },
      { label: "31-40%", min: 31, max: 40, count: 0 },
      { label: "41-50%", min: 41, max: 50, count: 0 },
      { label: "51-60%", min: 51, max: 60, count: 0 },
      { label: "61-70%", min: 61, max: 70, count: 0 },
      { label: "71-80%", min: 71, max: 80, count: 0 },
      { label: "81-90%", min: 81, max: 90, count: 0 },
      { label: "91-100%", min: 91, max: 100, count: 0 },
    ];
    completedCompanies.forEach((c: any) => {
      const score = c.totalScore;
      const bucket = buckets.find((b) => score >= b.min && score <= b.max);
      if (bucket) bucket.count++;
    });
    return { buckets, total: completedCompanies.length };
  }, [companies]);

  const maxBucketCount = Math.max(...scoreDistribution.buckets.map((b) => b.count), 1);

  // Mutations
  const analyzeMutation = useMutation({
    mutationFn: (opts: { frameworkId: number; listId?: number }) => api.analyze(opts),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["batchStatus"] });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
    },
    onError: (error: any) => alert(`Analysis failed to start: ${error.message}`),
  });

  const cancelBatchMutation = useMutation({
    mutationFn: api.cancelBatch,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["batchStatus"] }),
  });

  const resetCompanyMutation = useMutation({
    mutationFn: (id: number) => api.resetCompany(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["companies"] }),
  });

  const resetListMutation = useMutation({
    mutationFn: (listId: number) => api.resetList(listId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["companies"] }),
  });

  const resetAllMutation = useMutation({
    mutationFn: () => api.resetAll(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["companies"] }),
  });

  const createCompanyMutation = useMutation({
    mutationFn: (data: any) => api.createCompany(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      setShowAddModal(false);
      setNewCompany({ name: "", isin: "", sector: "", country: "", domain: "" });
    },
  });

  const deleteCompanyMutation = useMutation({
    mutationFn: (id: number) => api.deleteCompany(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["companies"] }),
  });

  const importMutation = useMutation({
    mutationFn: (file: File) => {
      return file.text().then((text) => {
        const lines = text.split("\n").filter((l) => l.trim());
        const header = lines[0].toLowerCase();
        const hasHeader = header.includes("name") || header.includes("isin") || header.includes("company");
        const dataLines = hasHeader ? lines.slice(1) : lines;
        return api.importCompanies({
          companies: dataLines.map((line) => {
            const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
            return { name: parts[0], isin: parts[1] || undefined, sector: parts[2] || undefined, country: parts[3] || undefined };
          }),
        });
      });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      queryClient.invalidateQueries({ queryKey: ["lists"] });
    },
  });

  // Determine active framework
  const activeFramework = frameworks.find((f: any) => f.isActive);
  const effectiveFrameworkId = selectedFramework || activeFramework?.id;
  const effectiveFrameworkName = selectedFramework
    ? frameworks.find((f: any) => f.id === selectedFramework)?.name
    : activeFramework?.name;

  const handleAnalyze = () => {
    if (!effectiveFrameworkId) return alert("No framework selected");
    analyzeMutation.mutate({
      frameworkId: effectiveFrameworkId,
      listId: selectedList || undefined,
    });
  };

  const handleReset = () => {
    if (selectedList) {
      const listName = lists.find((l: any) => l.id === selectedList)?.name || "this list";
      if (confirm(`Reset all companies in "${listName}"? This will clear their scores and analysis status.`)) {
        resetListMutation.mutate(selectedList);
      }
    } else {
      if (confirm(`Reset ALL ${companies.length} companies? This will clear all scores and analysis status.`)) {
        resetAllMutation.mutate();
      }
    }
  };

  const handleExport = () => {
    const csv = [
      "Name,ISIN,Sector,Country,Score,Status",
      ...companies.map((c: any) =>
        `"${c.name}","${c.isin || ""}","${c.sector || ""}","${c.country || ""}",${c.totalScore ?? ""},${c.analysisStatus}`
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "companies_export.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed": return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "failed": return <XCircle className="w-4 h-4 text-red-500" />;
      case "searching":
      case "fetching":
      case "fetched":
      case "analyzing": return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
      default: return <Clock className="w-4 h-4 text-gray-400" />;
    }
  };

  const getScoreColor = (score: number | null) => {
    if (score === null) return "text-gray-400";
    if (score >= 70) return "text-green-600";
    if (score >= 40) return "text-yellow-600";
    return "text-red-600";
  };

  return (
    <div className="space-y-6">
      {/* Stats Bar */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Total Companies</p>
          <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Analyzed</p>
          <p className="text-2xl font-bold text-green-600">{stats.completed}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Average Score</p>
          <p className="text-2xl font-bold text-blue-600">{stats.avgScore}%</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Batch Status</p>
          <p className="text-2xl font-bold text-gray-900">
            {batchStatus?.running ? `${batchStatus.completed}/${batchStatus.total}` : "Idle"}
          </p>
        </div>
      </div>

      {/* Batch Progress */}
      {batchStatus?.running && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
              <span className="text-sm font-medium text-blue-800">
                Batch Analysis Running: {batchStatus.completed}/{batchStatus.total} completed
                {batchStatus.failed > 0 && `, ${batchStatus.failed} failed`}
              </span>
            </div>
            <button
              onClick={() => cancelBatchMutation.mutate()}
              className="flex items-center gap-1 px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200"
            >
              <Square className="w-3 h-3" /> Cancel
            </button>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all"
              style={{ width: `${((batchStatus.completed + (batchStatus.failed || 0)) / batchStatus.total) * 100}%` }}
            />
          </div>
          {batchStatus.currentCompany && (
            <p className="text-xs text-blue-600 mt-1">Currently: {batchStatus.currentCompany}</p>
          )}
        </div>
      )}

      {/* Analysis Configuration */}
      <div className="bg-white rounded-lg border p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Analysis Configuration</h3>
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-end">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-500 mb-1">Company List</label>
            <select
              value={selectedList || ""}
              onChange={(e) => setSelectedList(e.target.value ? parseInt(e.target.value) : null)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white"
            >
              <option value="">All Companies ({stats.total})</option>
              {lists.map((list: any) => (
                <option key={list.id} value={list.id}>
                  {list.name} ({list.memberCount || 0})
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-500 mb-1">Framework Template</label>
            <select
              value={selectedFramework || ""}
              onChange={(e) => setSelectedFramework(e.target.value ? parseInt(e.target.value) : null)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white"
            >
              {activeFramework && <option value="">{activeFramework.name} (active)</option>}
              {frameworks.filter((f: any) => !f.isActive).map((f: any) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleAnalyze}
              disabled={batchStatus?.running || companies.length === 0}
              className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title={`Analyze ${selectedList ? "selected list" : "all companies"} with ${effectiveFrameworkName || "active framework"}`}
            >
              <Play className="w-4 h-4" /> Analyze
            </button>
            <button
              onClick={handleReset}
              disabled={batchStatus?.running || companies.length === 0}
              className="flex items-center gap-1 px-3 py-2 text-sm bg-amber-50 border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
              title={selectedList ? "Reset all companies in selected list (clear scores)" : "Reset all companies (clear scores)"}
            >
              <RotateCcw className="w-4 h-4" /> {selectedList ? "Reset List" : "Reset All"}
            </button>
          </div>
        </div>
        {effectiveFrameworkName && (
          <p className="text-xs text-gray-500 mt-2">
            Will analyze {selectedList ? "companies in selected list" : `all ${stats.total} companies`} using{" "}
            <strong>{effectiveFrameworkName}</strong>
          </p>
        )}
      </div>

      {/* Feedback Banners */}
      {resetListMutation.isSuccess && (
        <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <RotateCcw className="w-4 h-4 text-amber-600" />
          <span className="text-sm text-amber-700">
            List reset successfully. {(resetListMutation.data as any)?.resetCount} companies cleared.
          </span>
        </div>
      )}
      {resetAllMutation.isSuccess && (
        <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <RotateCcw className="w-4 h-4 text-amber-600" />
          <span className="text-sm text-amber-700">
            All companies reset successfully. {(resetAllMutation.data as any)?.resetCount} companies cleared.
          </span>
        </div>
      )}
      {importMutation.isSuccess && (
        <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg">
          <CheckCircle2 className="w-4 h-4 text-green-600" />
          <span className="text-sm text-green-700">
            Import successful! {(importMutation.data as any)?.imported || (importMutation.data as any)?.companies?.length || ""} companies added.
          </span>
        </div>
      )}
      {importMutation.isError && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle className="w-4 h-4 text-red-600" />
          <span className="text-sm text-red-700">
            Import failed: {(importMutation.error as any)?.message}
          </span>
        </div>
      )}

      {/* Score Distribution */}
      {scoreDistribution.total > 0 && (
        <div className="bg-white rounded-lg border p-4">
          <div className="flex items-center justify-between mb-1">
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase">Score Distribution</div>
              <h3 className="text-sm font-semibold text-gray-900">How risk scores are spread across the portfolio</h3>
            </div>
            <BarChart3 className="w-5 h-5 text-gray-400" />
          </div>
          <p className="text-xs text-gray-400 mb-4">{scoreDistribution.total} of {stats.total} companies scored</p>
          <div className="flex items-end gap-1 h-32">
            {scoreDistribution.buckets.map((bucket) => (
              <div key={bucket.label} className="flex-1 flex flex-col items-center">
                <span className="text-xs text-gray-600 mb-1">{bucket.count > 0 ? bucket.count : ""}</span>
                <div
                  className="w-full bg-blue-500 rounded-t transition-all"
                  style={{
                    height: `${bucket.count > 0 ? (bucket.count / maxBucketCount) * 100 : 0}%`,
                    minHeight: bucket.count > 0 ? "4px" : "0",
                  }}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-1 mt-1">
            {scoreDistribution.buckets.map((bucket) => (
              <div key={bucket.label} className="flex-1 text-center text-[10px] text-gray-400">{bucket.label}</div>
            ))}
          </div>
        </div>
      )}

      {/* Company Table Controls */}
      <div className="flex flex-col md:flex-row gap-3 items-start md:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search companies..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1 px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            <Plus className="w-4 h-4" /> Add
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            <Upload className="w-4 h-4" /> Import
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-1 px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            <Download className="w-4 h-4" /> Export
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) importMutation.mutate(file);
          }}
        />
      </div>

      {/* Company Table */}
      <div className="bg-white rounded-lg border overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Company</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase hidden md:table-cell">Sector</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase hidden md:table-cell">Country</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Score</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                  Loading companies...
                </td>
              </tr>
            ) : filteredCompanies.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  {companies.length === 0
                    ? "No companies yet. Add or import companies to get started."
                    : "No companies match your search."}
                </td>
              </tr>
            ) : (
              filteredCompanies.map((company: any) => (
                <tr key={company.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <button
                      onClick={() => onViewCompany(company.id)}
                      className="text-sm font-medium text-blue-600 hover:text-blue-800 text-left"
                    >
                      {company.name}
                    </button>
                    {company.isin && <p className="text-xs text-gray-400">{company.isin}</p>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 hidden md:table-cell">{company.sector || "\u2014"}</td>
                  <td className="px-4 py-3 text-sm text-gray-600 hidden md:table-cell">{company.country || "\u2014"}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-sm font-bold ${getScoreColor(company.totalScore)}`}>
                      {company.totalScore !== null ? `${company.totalScore}%` : "\u2014"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {getStatusIcon(company.analysisStatus)}
                      <span className="text-xs text-gray-500 capitalize">{company.analysisStatus}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Reset ${company.name}? This will clear scores and analysis status.`)) {
                            resetCompanyMutation.mutate(company.id);
                          }
                        }}
                        className="p-1 text-gray-400 hover:text-amber-600 rounded"
                        title="Reset analysis"
                      >
                        <RotateCcw className="w-4 h-4" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onViewCompany(company.id);
                        }}
                        className="p-1 text-gray-400 hover:text-blue-600 rounded"
                        title="View details"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete ${company.name}?`)) {
                            deleteCompanyMutation.mutate(company.id);
                          }
                        }}
                        className="p-1 text-gray-400 hover:text-red-600 rounded"
                        title="Delete company"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add Company Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
            <h3 className="text-lg font-semibold mb-4">Add Company</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createCompanyMutation.mutate(newCompany);
              }}
              className="space-y-3"
            >
              <input
                type="text"
                placeholder="Company Name *"
                value={newCompany.name}
                onChange={(e) => setNewCompany({ ...newCompany, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm"
                required
                autoFocus
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  placeholder="ISIN"
                  value={newCompany.isin}
                  onChange={(e) => setNewCompany({ ...newCompany, isin: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
                <input
                  type="text"
                  placeholder="Domain (e.g. apple.com)"
                  value={newCompany.domain}
                  onChange={(e) => setNewCompany({ ...newCompany, domain: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  placeholder="Sector"
                  value={newCompany.sector}
                  onChange={(e) => setNewCompany({ ...newCompany, sector: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
                <input
                  type="text"
                  placeholder="Country"
                  value={newCompany.country}
                  onChange={(e) => setNewCompany({ ...newCompany, country: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 px-4 py-2 border rounded-lg text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!newCompany.name || createCompanyMutation.isPending}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  Add Company
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
