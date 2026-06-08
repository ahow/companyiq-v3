import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Download, Share2, Trash2 } from "lucide-react";

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

  const deleteResultMutation = useMutation({
    mutationFn: (id: number) => api.request(`/results/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["results"] }),
  });

  const handleExportCSV = (result: any) => {
    const rows = result.resultsData || [];
    if (rows.length === 0) return;

    // Get all unique measure titles from the first row that has measureScores
    const measureTitles: string[] = [];
    for (const row of rows) {
      if (row.measureScores && Array.isArray(row.measureScores) && row.measureScores.length > 0) {
        row.measureScores.forEach((ms: any) => {
          if (ms.title && !measureTitles.includes(ms.title)) {
            measureTitles.push(ms.title);
          }
        });
        break;
      }
    }

    // Build headers: company info + each measure (verdict + rationale + sources) + source documents
    const baseHeaders = ["Company", "ISIN", "Sector", "Country", "Total Score (%)", "Measures Met", "Measures Total"];
    // For each measure, add three columns: Verdict, Rationale, Sources
    const measureHeaders: string[] = [];
    for (const title of measureTitles) {
      measureHeaders.push(`${title} - Verdict`);
      measureHeaders.push(`${title} - Rationale`);
      measureHeaders.push(`${title} - Sources`);
    }
    const headers = [...baseHeaders, ...measureHeaders, "Source Documents"];

    // Build rows
    const csvRows = rows.map((row: any) => {
      const baseValues = [
        row.companyName || "",
        row.isin || "",
        row.sector || "",
        row.country || "",
        row.totalScore ?? 0,
        row.measuresMetCount ?? "",
        row.measuresTotalCount ?? "",
      ];

      // Map each measure title to verdict + rationale + sources
      const measureValues: string[] = [];
      for (const title of measureTitles) {
        const ms = (row.measureScores || []).find((m: any) => m.title === title);
        if (ms) {
          // Verdict
          measureValues.push(ms.verdict || (ms.score > 0 ? "Yes" : "No"));
          // Rationale: combine evidenceSummary and quotes
          const quotes = (ms.quotes || []).map((q: any) => q.text).filter(Boolean);
          const rationale = quotes.length > 0 
            ? quotes.join(" | ") 
            : (ms.evidenceSummary || "");
          measureValues.push(rationale);
          // Sources: URLs from quotes
          const sources = (ms.quotes || [])
            .map((q: any) => q.source)
            .filter((s: string) => s && s.startsWith("http"));
          const uniqueSources = [...new Set(sources)];
          measureValues.push(uniqueSources.join(" ; "));
        } else {
          measureValues.push("", "", "");
        }
      }

      // Source documents used for this company
      const sourceDocs = (row.sourceDocuments || [])
        .map((d: any) => d.url || d.title || "")
        .filter(Boolean)
        .join(" ; ");

      return [...baseValues, ...measureValues, sourceDocs];
    });

    // Escape and format CSV
    const escapeCSV = (val: any) => {
      const str = String(val ?? "");
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    };

    const csv = [
      headers.map(escapeCSV).join(","),
      ...csvRows.map((row: any[]) => row.map(escapeCSV).join(",")),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.frameworkName}-${formatDate(result.createdAt)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleShare = async (result: any) => {
    const shareUrl = `${window.location.origin}/api/results/${result.id}/share`;
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
    // Try to find the list name from the results data or batch info
    if (result.listName) return result.listName;
    // Fallback: check if we can derive from the list of known lists
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Saved Results</h1>
        <p className="text-sm text-gray-500 mt-1">
          Completed analyses are automatically saved here. Download as a spreadsheet or share as a JSON link.
        </p>
      </div>

      {resultsList.length > 0 ? (
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
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
                return (
                  <tr key={result.id} className="hover:bg-gray-50">
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
