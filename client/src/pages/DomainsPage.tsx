import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState, useMemo } from "react";
import { Globe, Search, Check, X, Pencil, Download, AlertCircle, CheckCircle2 } from "lucide-react";

type Filter = "all" | "with" | "without";

interface Company {
  id: number;
  name: string;
  ticker?: string | null;
  isin?: string | null;
  sector?: string | null;
  country?: string | null;
  domain?: string | null;
  analysis_status?: string | null;
  analysisStatus?: string | null;
}

// Normalize a user-entered domain: strip protocol, path, leading "www.", whitespace, lowercase.
function normalizeDomain(raw: string): string {
  let d = (raw || "").trim().toLowerCase();
  if (!d) return "";
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split("/")[0];
  d = d.split("?")[0];
  d = d.replace(/\s+/g, "");
  return d;
}

export default function DomainsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);

  const { data: companies = [], isLoading } = useQuery<Company[]>({
    queryKey: ["companies"],
    queryFn: api.getCompanies,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, domain }: { id: number; domain: string }) =>
      api.updateCompany(id, { domain: domain || null }),
    onMutate: ({ id }) => setSavingId(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["companies"] });
    },
    onSettled: () => {
      setSavingId(null);
      setEditingId(null);
    },
  });

  const stats = useMemo(() => {
    const total = companies.length;
    const withDomain = companies.filter((c) => c.domain && c.domain.trim()).length;
    return { total, withDomain, without: total - withDomain };
  }, [companies]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return companies
      .filter((c) => {
        const has = !!(c.domain && c.domain.trim());
        if (filter === "with" && !has) return false;
        if (filter === "without" && has) return false;
        return true;
      })
      .filter((c) => {
        if (!q) return true;
        return (
          c.name?.toLowerCase().includes(q) ||
          (c.ticker || "").toLowerCase().includes(q) ||
          (c.isin || "").toLowerCase().includes(q) ||
          (c.domain || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [companies, search, filter]);

  const startEdit = (c: Company) => {
    setEditingId(c.id);
    setEditValue(c.domain || "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  const saveEdit = (c: Company) => {
    const normalized = normalizeDomain(editValue);
    if (normalized === (c.domain || "")) {
      cancelEdit();
      return;
    }
    updateMutation.mutate({ id: c.id, domain: normalized });
  };

  const handleExport = () => {
    const rows = [
      "Name,Ticker,ISIN,Sector,Country,Domain",
      ...companies
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (c) =>
            `"${(c.name || "").replace(/"/g, '""')}","${c.ticker || ""}","${c.isin || ""}","${c.sector || ""}","${c.country || ""}","${c.domain || ""}"`
        ),
    ].join("\n");
    const blob = new Blob([rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "company_domains.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Globe className="w-6 h-6 text-blue-600" />
            Domains
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Review and correct the official website domain used to anchor each company's documents.
          </p>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-2 px-3 py-2 text-sm border rounded-lg hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200"
        >
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button
          onClick={() => setFilter("all")}
          className={`text-left bg-white dark:bg-gray-900 border rounded-xl p-4 transition-colors ${
            filter === "all" ? "border-blue-500 ring-1 ring-blue-500" : "border-gray-200 dark:border-gray-700"
          }`}
        >
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Total Companies</p>
          <p className="text-2xl font-semibold text-gray-900 dark:text-white mt-1">{stats.total}</p>
        </button>
        <button
          onClick={() => setFilter("with")}
          className={`text-left bg-white dark:bg-gray-900 border rounded-xl p-4 transition-colors ${
            filter === "with" ? "border-green-500 ring-1 ring-green-500" : "border-gray-200 dark:border-gray-700"
          }`}
        >
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> With Domain
          </p>
          <p className="text-2xl font-semibold text-green-600 mt-1">{stats.withDomain}</p>
        </button>
        <button
          onClick={() => setFilter("without")}
          className={`text-left bg-white dark:bg-gray-900 border rounded-xl p-4 transition-colors ${
            filter === "without" ? "border-amber-500 ring-1 ring-amber-500" : "border-gray-200 dark:border-gray-700"
          }`}
        >
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5 text-amber-500" /> Missing Domain
          </p>
          <p className="text-2xl font-semibold text-amber-500 mt-1">{stats.without}</p>
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, ticker, ISIN, or domain..."
          className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm dark:bg-gray-900 dark:border-gray-700 dark:text-white"
        />
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading companies...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No companies match the current filter.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-gray-50 dark:bg-gray-800 dark:border-gray-700">
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Company</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Ticker</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Sector</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Country</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase w-[320px]">Domain</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const has = !!(c.domain && c.domain.trim());
                  const isEditing = editingId === c.id;
                  const isSaving = savingId === c.id;
                  return (
                    <tr key={c.id} className="border-b dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-4 py-2 text-sm font-medium text-gray-900 dark:text-white">{c.name}</td>
                      <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">{c.ticker || "-"}</td>
                      <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">{c.sector || "-"}</td>
                      <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">{c.country || "-"}</td>
                      <td className="px-4 py-2 text-sm">
                        {isEditing ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              autoFocus
                              type="text"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveEdit(c);
                                if (e.key === "Escape") cancelEdit();
                              }}
                              placeholder="example.com"
                              className="flex-1 px-2 py-1 border rounded text-sm font-mono dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                            />
                            <button
                              onClick={() => saveEdit(c)}
                              disabled={isSaving}
                              className="p-1.5 rounded text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30 disabled:opacity-50"
                              title="Save"
                            >
                              {isSaving ? (
                                <div className="w-4 h-4 border-2 border-green-600 border-t-transparent rounded-full animate-spin" />
                              ) : (
                                <Check className="w-4 h-4" />
                              )}
                            </button>
                            <button
                              onClick={cancelEdit}
                              className="p-1.5 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                              title="Cancel"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 group">
                            {has ? (
                              <>
                                <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                                <a
                                  href={`https://${c.domain}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-mono text-blue-600 dark:text-blue-400 hover:underline truncate"
                                >
                                  {c.domain}
                                </a>
                              </>
                            ) : (
                              <span className="flex items-center gap-1.5 text-amber-500">
                                <AlertCircle className="w-4 h-4 shrink-0" />
                                <span className="italic text-gray-400">no domain</span>
                              </span>
                            )}
                            <button
                              onClick={() => startEdit(c)}
                              className="p-1 rounded text-gray-400 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Edit domain"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Showing {filtered.length} of {stats.total} companies. Click the pencil to edit a domain, then press Enter to save.
        Domains are normalized automatically (protocol, "www." and paths are stripped).
      </p>
    </div>
  );
}
