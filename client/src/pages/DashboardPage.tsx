import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState, useMemo } from "react";
import { Search, Play, XCircle, RefreshCw, Upload, Download, Plus, BarChart3 } from "lucide-react";

interface DashboardPageProps {
  onViewCompany: (id: number) => void;
}

export default function DashboardPage({ onViewCompany }: DashboardPageProps) {
  const [search, setSearch] = useState("");
  const [selectedList, setSelectedList] = useState<number | null>(null);
  const [selectedFramework, setSelectedFramework] = useState<number | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newCompanyIsin, setNewCompanyIsin] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const queryClient = useQueryClient();

  const { data: companiesData, refetch: refetchCompanies } = useQuery({
    queryKey: ["companies"],
    queryFn: api.getCompanies,
    refetchInterval: 10000,
  });

  const { data: batchStatus } = useQuery({
    queryKey: ["batchStatus"],
    queryFn: api.getBatchStatus,
    refetchInterval: 5000,
  });

  const { data: lists } = useQuery({
    queryKey: ["lists"],
    queryFn: api.getLists,
  });

  const { data: frameworks } = useQuery({
    queryKey: ["frameworks"],
    queryFn: api.getFrameworks,
  });

  const companies = companiesData?.companies || [];
  const stats = companiesData?.stats || { total: 0, completed: 0, avgScore: 0 };

  const filteredCompanies = companies.filter((c: any) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  // Score distribution calculation
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

  const handleAnalyze = async () => {
    const frameworkId = selectedFramework || frameworks?.[0]?.id;
    if (!frameworkId) return alert("No framework selected");

    try {
      await api.analyze({
        frameworkId,
        listId: selectedList || undefined,
      });
      refetchCompanies();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCancel = async () => {
    await api.cancelBatch();
  };

  const handleAddCompany = async () => {
    if (!newCompanyName.trim()) return;
    try {
      await api.request("/companies", {
        method: "POST",
        body: JSON.stringify({ name: newCompanyName, isin: newCompanyIsin || undefined }),
      });
      setNewCompanyName("");
      setNewCompanyIsin("");
      setShowAddModal(false);
      queryClient.invalidateQueries({ queryKey: ["companies"] });
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleImport = async () => {
    if (!importFile) return;
    const text = await importFile.text();
    const lines = text.split("\n").filter((l) => l.trim());
    const header = lines[0].toLowerCase();
    const hasHeader = header.includes("name") || header.includes("isin");
    const dataLines = hasHeader ? lines.slice(1) : lines;

    try {
      await api.request("/companies/import", {
        method: "POST",
        body: JSON.stringify({
          companies: dataLines.map((line) => {
            const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
            return { name: parts[0], isin: parts[1] || undefined, sector: parts[2] || undefined };
          }),
        }),
      });
      setImportFile(null);
      queryClient.invalidateQueries({ queryKey: ["companies"] });
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleExport = () => {
    const csv = [
      "Name,ISIN,Sector,Score,Status",
      ...companies.map((c: any) =>
        `"${c.name}","${c.isin || ""}","${c.sector || ""}",${c.totalScore ?? ""},${c.analysisStatus}`
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

  const getScoreColor = (score: number | null) => {
    if (score === null) return "text-gray-400";
    if (score >= 70) return "text-green-600";
    if (score >= 40) return "text-yellow-600";
    return "text-red-600";
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      idle: "bg-gray-100 text-gray-600",
      fetching: "bg-blue-100 text-blue-700",
      fetched: "bg-indigo-100 text-indigo-700",
      analyzing: "bg-purple-100 text-purple-700",
      completed: "bg-green-100 text-green-700",
      failed: "bg-red-100 text-red-700",
    };
    return colors[status] || "bg-gray-100 text-gray-600";
  };

  const selectedListObj = lists?.find((l: any) => l.id === selectedList);
  const listCompanyCount = selectedListObj?.memberCount || stats.total;

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm text-gray-500">Total Companies</div>
          <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm text-gray-500">Analyzed</div>
          <div className="text-2xl font-bold text-green-600">{stats.completed}</div>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm text-gray-500">Average Score</div>
          <div className="text-2xl font-bold text-blue-600">{stats.avgScore}%</div>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm text-gray-500">Batch Status</div>
          <div className="text-2xl font-bold text-gray-900">
            {batchStatus?.running
              ? `${batchStatus.completed}/${batchStatus.total}`
              : "Idle"}
          </div>
        </div>
      </div>

      {/* Batch Progress */}
      {batchStatus?.running && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <RefreshCw className="w-5 h-5 text-blue-600 animate-spin" />
            <span className="text-blue-800 font-medium">
              Batch Analysis Running: {batchStatus.completed}/{batchStatus.total} completed
              {batchStatus.failed > 0 && ` (${batchStatus.failed} failed)`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-48 bg-blue-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{ width: `${((batchStatus.completed + batchStatus.failed) / batchStatus.total) * 100}%` }}
              />
            </div>
            <button onClick={handleCancel} className="text-red-600 hover:text-red-800 flex items-center gap-1 text-sm border border-red-200 px-2 py-1 rounded">
              <XCircle className="w-4 h-4" /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* Analysis Configuration */}
      <div className="bg-white rounded-lg border p-4">
        <h3 className="text-sm font-semibold text-gray-500 uppercase mb-3">Analysis Configuration</h3>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <label className="text-xs text-gray-500">Company List</label>
            <select
              value={selectedList || ""}
              onChange={(e) => setSelectedList(e.target.value ? parseInt(e.target.value) : null)}
              className="w-full mt-1 px-3 py-2 border rounded-lg text-sm"
            >
              <option value="">All Companies ({stats.total})</option>
              {lists?.map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.memberCount || 0})
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="text-xs text-gray-500">Framework Template</label>
            <select
              value={selectedFramework || ""}
              onChange={(e) => setSelectedFramework(e.target.value ? parseInt(e.target.value) : null)}
              className="w-full mt-1 px-3 py-2 border rounded-lg text-sm"
            >
              {frameworks?.map((f: any) => (
                <option key={f.id} value={f.id}>
                  {f.name} {f.isActive ? "(active)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="pt-5 flex gap-2">
            <button
              onClick={handleAnalyze}
              disabled={batchStatus?.running}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
            >
              <Play className="w-4 h-4" /> Analyze
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Will analyze {selectedList ? `companies in selected list` : `all ${stats.total} companies`} using{" "}
          <strong>{frameworks?.find((f: any) => f.id === (selectedFramework || frameworks?.[0]?.id))?.name || "selected framework"}</strong>
        </p>
      </div>

      {/* Score Distribution Chart */}
      {scoreDistribution.total > 0 && (
        <div className="bg-white rounded-lg border p-4">
          <div className="flex items-center justify-between mb-1">
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase">Score Distribution</div>
              <h3 className="text-sm font-semibold text-gray-900">How risk scores are spread across the portfolio</h3>
            </div>
            <BarChart3 className="w-5 h-5 text-gray-400" />
          </div>
          <p className="text-xs text-gray-400 mb-4">
            {scoreDistribution.total} of {stats.total} companies scored
          </p>
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
              <div key={bucket.label} className="flex-1 text-center text-[10px] text-gray-400">
                {bucket.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Company Table */}
      <div className="bg-white rounded-lg border">
        <div className="p-4 border-b flex items-center justify-between">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search companies..."
              className="pl-9 pr-4 py-2 border rounded-lg text-sm w-64"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1 px-3 py-2 border rounded-lg text-sm hover:bg-gray-50"
            >
              <Plus className="w-4 h-4" /> Add
            </button>
            <label className="flex items-center gap-1 px-3 py-2 border rounded-lg text-sm hover:bg-gray-50 cursor-pointer">
              <Upload className="w-4 h-4" /> Import
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  setImportFile(e.target.files?.[0] || null);
                  if (e.target.files?.[0]) {
                    // Auto-import on file select
                    const file = e.target.files[0];
                    file.text().then((text) => {
                      const lines = text.split("\n").filter((l) => l.trim());
                      const header = lines[0].toLowerCase();
                      const hasHeader = header.includes("name") || header.includes("isin");
                      const dataLines = hasHeader ? lines.slice(1) : lines;
                      api.request("/companies/import", {
                        method: "POST",
                        body: JSON.stringify({
                          companies: dataLines.map((line) => {
                            const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
                            return { name: parts[0], isin: parts[1] || undefined, sector: parts[2] || undefined };
                          }),
                        }),
                      }).then(() => {
                        queryClient.invalidateQueries({ queryKey: ["companies"] });
                      });
                    });
                  }
                }}
              />
            </label>
            <button
              onClick={handleExport}
              className="flex items-center gap-1 px-3 py-2 border rounded-lg text-sm hover:bg-gray-50"
            >
              <Download className="w-4 h-4" /> Export
            </button>
          </div>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Company</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">ISIN</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Sector</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Score</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Measures Met</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
            </tr>
          </thead>
          <tbody>
            {filteredCompanies.slice(0, 100).map((company: any) => (
              <tr
                key={company.id}
                className="border-b hover:bg-gray-50 cursor-pointer"
                onClick={() => onViewCompany(company.id)}
              >
                <td className="px-4 py-3 font-medium text-gray-900">{company.name}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{company.isin || "-"}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{company.sector || "-"}</td>
                <td className={`px-4 py-3 text-center font-semibold ${getScoreColor(company.totalScore)}`}>
                  {company.totalScore !== null ? `${company.totalScore}%` : "-"}
                </td>
                <td className="px-4 py-3 text-center text-sm text-gray-600">
                  {company.measuresMetCount !== null && company.measuresTotalCount
                    ? `${company.measuresMetCount}/${company.measuresTotalCount}`
                    : "-"}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusBadge(company.analysisStatus)}`}>
                    {company.analysisStatus}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredCompanies.length > 100 && (
          <div className="p-3 text-center text-sm text-gray-500">
            Showing 100 of {filteredCompanies.length} companies
          </div>
        )}
        {filteredCompanies.length === 0 && (
          <div className="p-8 text-center text-gray-400">
            {companies.length === 0 ? "No companies added yet. Use Import or Add to get started." : "No companies match your search."}
          </div>
        )}
      </div>

      {/* Add Company Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96 shadow-xl">
            <h3 className="text-lg font-semibold mb-4">Add Company</h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm text-gray-600">Company Name *</label>
                <input
                  type="text"
                  value={newCompanyName}
                  onChange={(e) => setNewCompanyName(e.target.value)}
                  className="w-full mt-1 px-3 py-2 border rounded-lg text-sm"
                  placeholder="e.g., Apple Inc."
                  autoFocus
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">ISIN (optional)</label>
                <input
                  type="text"
                  value={newCompanyIsin}
                  onChange={(e) => setNewCompanyIsin(e.target.value)}
                  className="w-full mt-1 px-3 py-2 border rounded-lg text-sm"
                  placeholder="e.g., US0378331005"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleAddCompany}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Add Company
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
