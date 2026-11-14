import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Download, Share2, Trash2, X, CheckSquare } from "lucide-react";
// NOTE: CSV column/scoring logic now lives server-side in the streaming endpoint
// GET /api/results/:id/csv (see server/routes/api.ts). The in-browser CSV builder
// — which imported realQuotes / normalizeVerdict / isMet / researchStatusCsvColumns
// — was removed because it failed for large snapshots (V8 "Invalid string length").

export default function ResultsPage() {
  const queryClient = useQueryClient();

  const { data: resultsList = [] } = useQuery({
    queryKey: ["results"],
    queryFn: api.getResults,
  });

  const { data: lists = [] } = useQuery({
    queryKey: ["lists"],
    queryFn: api.getLists,
  });

  // ── Multi-select state ──────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Issue 5 (part 3): optional opt-in to EXCLUDE non-comprehensive companies
  // from the ranking/portfolio CSV export, rather than presenting their scores
  // alongside fully-researched ones. Default OFF — by default every row is kept
  // AND flagged via the research-status columns (constraint: relevant rows/text
  // are never silently dropped). When ON, rows whose research is explicitly
  // not comprehensive (researchStatus.comprehensive === false) are omitted;
  // legacy snapshots without a research status are always kept.
  const [excludeNonComprehensive, setExcludeNonComprehensive] = useState(false);

  const allIds: number[] = useMemo(
    () => (resultsList as any[]).map((r: any) => r.id),
    [resultsList]
  );
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0 && !allSelected;

  const toggleOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds((prev) => {
      if (allIds.length > 0 && allIds.every((id) => prev.has(id))) return new Set();
      return new Set(allIds);
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const selectSingleCompany = () => {
    const ids = (resultsList as any[])
      .filter((r: any) => (r.companiesCount ?? 0) === 1)
      .map((r: any) => r.id);
    setSelectedIds(new Set(ids));
  };

  const deleteResultMutation = useMutation({
    mutationFn: (id: number) => api.request(`/results/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["results"] }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: number[]) => api.bulkDeleteResults(ids),
    onSuccess: () => {
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ["results"] });
    },
  });

  const handleBulkDelete = () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (
      confirm(
        `Delete ${ids.length} selected result${ids.length === 1 ? "" : "s"}? This cannot be undone.`
      )
    ) {
      bulkDeleteMutation.mutate(ids);
    }
  };

  const handleExportCSV = (result: any) => {
    // CSV is now built and STREAMED by the server at GET /api/results/:id/csv.
    // The old path fetched the entire snapshot as one JSON and assembled the CSV
    // in the browser; for large snapshots (>~850 companies) that single giant
    // string exceeded V8's max string length and failed with HTTP 500 "Invalid
    // string length". The server streams one row at a time, so the download now
    // works for snapshots of ANY size. Auth is the same-origin httpOnly session
    // cookie, sent automatically with a plain navigation/anchor download; the
    // server's Content-Disposition sets the filename, and the
    // `excludeNonComprehensive` filter is applied server-side via the query param.
    const params = excludeNonComprehensive ? "?excludeNonComprehensive=1" : "";
    const href = `/api/results/${result.id}/csv${params}`;
    const a = document.createElement("a");
    a.href = href;
    // download is advisory; the server's Content-Disposition is authoritative.
    a.download = `${result.frameworkName}-${formatDate(result.createdAt)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleShare = async (result: any) => {
    // Use the unguessable share token (not numeric ID) for public share links
    const shareUrl = `${window.location.origin}/api/results/${result.shareToken}/share`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      alert("Share link copied to clipboard!");
    } catch {
      prompt("Copy this share link:", shareUrl);
    }
  };

  const handleDelete = (result: any) => {
    if (confirm(`Delete this result set? (${result.frameworkName} — ${formatDate(result.createdAt)})`)) {
      deleteResultMutation.mutate(result.id);
    }
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  const getScoreColor = (score: number) => {
    if (score >= 70) return "text-green-600";
    if (score >= 40) return "text-yellow-600";
    return "text-red-600";
  };

  // Derive list name from the result's batch if available
  const getListName = (result: any) => {
    if (result.listName) return result.listName;
    return "—";
  };

  const getAvgScore = (result: any) => {
    // Prefer the stored averageScore from the database
    if (result.averageScore !== null && result.averageScore !== undefined) return result.averageScore;
    // Fallback: calculate from results data
    const rows = result.resultsData || [];
    if (rows.length === 0) return 0;
    const scores = rows
      .map((r: any) => r.totalScore ?? r.TotalScore ?? r.TOTALSCORE)
      .filter((s: any) => s !== null && s !== undefined && s > 0);
    if (scores.length === 0) return 0;
    return Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length);
  };

  const singleCompanyCount = useMemo(
    () => (resultsList as any[]).filter((r: any) => (r.companiesCount ?? 0) === 1).length,
    [resultsList]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Saved Results</h1>
          <p className="text-sm text-gray-500 mt-1">
            Completed analyses are automatically saved here. Download as a spreadsheet or share as a JSON link.
          </p>
        </div>
        {resultsList.length > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            <label
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-gray-50 text-gray-700 border border-gray-200 rounded cursor-pointer select-none"
              title="When ticked, CSV exports omit companies flagged as non-comprehensive (research not complete) so their scores aren't ranked alongside fully-researched ones. Off by default — all rows are exported and flagged."
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                checked={excludeNonComprehensive}
                onChange={(e) => setExcludeNonComprehensive(e.target.checked)}
              />
              Exclude non-comprehensive
            </label>
            {singleCompanyCount > 0 && (
              <button
                onClick={selectSingleCompany}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-gray-50 text-gray-700 border border-gray-200 rounded hover:bg-gray-100"
                title="Select all results that contain only one company"
              >
                <CheckSquare className="w-3.5 h-3.5" />
                Select single-company ({singleCompanyCount})
              </button>
            )}
          </div>
        )}
      </div>

      {/* Selection action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between gap-4 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-blue-900">
              {selectedIds.size} selected
            </span>
            <button
              onClick={clearSelection}
              className="inline-flex items-center gap-1 text-xs text-blue-700 hover:text-blue-900"
            >
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          </div>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleteMutation.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-60"
          >
            <Trash2 className="w-4 h-4" />
            {bulkDeleteMutation.isPending ? "Deleting…" : `Delete selected (${selectedIds.size})`}
          </button>
        </div>
      )}

      {resultsList.length > 0 ? (
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="w-10 px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                    title={allSelected ? "Deselect all" : "Select all"}
                  />
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Framework Template</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Company List</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Companies</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Avg Score</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Time</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {resultsList.map((result: any) => {
                const avgScore = getAvgScore(result);
                const isSelected = selectedIds.has(result.id);
                return (
                  <tr key={result.id} className={isSelected ? "bg-blue-50" : "hover:bg-gray-50"}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                        checked={isSelected}
                        onChange={() => toggleOne(result.id)}
                      />
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {result.frameworkName}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {result.listName || getListName(result)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-center">
                      {result.companiesCount}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-sm font-bold ${getScoreColor(avgScore)}`}>
                        {avgScore > 0 ? `${avgScore}%` : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-center">
                      {formatDate(result.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-center">
                      {formatTime(result.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleExportCSV(result)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-green-50 text-green-700 border border-green-200 rounded hover:bg-green-100"
                          title="Download as CSV"
                        >
                          <Download className="w-3.5 h-3.5" /> CSV
                        </button>
                        <button
                          onClick={() => handleShare(result)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-gray-50 text-gray-700 border border-gray-200 rounded hover:bg-gray-100"
                          title="Copy share link"
                        >
                          <Share2 className="w-3.5 h-3.5" /> Share
                        </button>
                        <button
                          onClick={() => handleDelete(result)}
                          className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                          title="Delete result"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white rounded-lg border p-12 text-center">
          <p className="text-gray-500">No saved results yet. Run a batch analysis to generate results.</p>
        </div>
      )}
    </div>
  );
}
