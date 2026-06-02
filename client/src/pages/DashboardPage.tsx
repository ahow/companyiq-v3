import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Search, Play, XCircle, RefreshCw } from "lucide-react";

interface DashboardPageProps {
  onViewCompany: (id: number) => void;
}

export default function DashboardPage({ onViewCompany }: DashboardPageProps) {
  const [search, setSearch] = useState("");
  const [selectedList, setSelectedList] = useState<number | null>(null);
  const [selectedFramework, setSelectedFramework] = useState<number | null>(null);

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
                style={{ width: `${(batchStatus.completed / batchStatus.total) * 100}%` }}
              />
            </div>
            <button onClick={handleCancel} className="text-red-600 hover:text-red-800 flex items-center gap-1 text-sm">
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
                <option key={l.id} value={l.id}>{l.name}</option>
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
          <div className="pt-5">
            <button
              onClick={handleAnalyze}
              disabled={batchStatus?.running}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
            >
              <Play className="w-4 h-4" /> Analyze
            </button>
          </div>
        </div>
      </div>

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
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Company</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">ISIN</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Sector</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Score</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
            </tr>
          </thead>
          <tbody>
            {filteredCompanies.slice(0, 50).map((company: any) => (
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
                <td className="px-4 py-3 text-center">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusBadge(company.analysisStatus)}`}>
                    {company.analysisStatus}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredCompanies.length > 50 && (
          <div className="p-3 text-center text-sm text-gray-500">
            Showing 50 of {filteredCompanies.length} companies
          </div>
        )}
      </div>
    </div>
  );
}
