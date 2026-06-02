import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Download } from "lucide-react";
import { useState } from "react";

export default function ResultsPage() {
  const { data: resultsList } = useQuery({
    queryKey: ["results"],
    queryFn: api.getResults,
  });

  // resultsList is an array of snapshot rows, each with { id, frameworkName, resultsData, companiesCount, createdAt }
  const [selectedIdx, setSelectedIdx] = useState(0);
  const selected = resultsList?.[selectedIdx];
  const rows = selected?.resultsData || [];

  const handleExport = () => {
    if (!rows || rows.length === 0) return;

    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(","),
      ...rows.map((row: any) =>
        headers.map((h) => {
          const val = row[h] ?? "";
          return typeof val === "string" && val.includes(",") ? `"${val}"` : val;
        }).join(",")
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `companyiq-results-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Analysis Results</h1>
        <div className="flex items-center gap-3">
          {resultsList && resultsList.length > 1 && (
            <select
              value={selectedIdx}
              onChange={(e) => setSelectedIdx(Number(e.target.value))}
              className="text-sm border rounded px-2 py-1.5"
            >
              {resultsList.map((r: any, i: number) => (
                <option key={r.id} value={i}>
                  {r.frameworkName} ({r.companiesCount} companies) — {new Date(r.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={handleExport}
            disabled={!rows?.length}
            className="flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
          >
            <Download className="w-4 h-4" /> Export CSV
          </button>
        </div>
      </div>

      {rows.length > 0 ? (
        <div className="bg-white rounded-lg border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                {Object.keys(rows[0]).slice(0, 8).map((key) => (
                  <th key={key} className="text-left px-3 py-2 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">
                    {key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row: any, i: number) => (
                <tr key={i} className="border-b hover:bg-gray-50">
                  {Object.keys(row).slice(0, 8).map((key) => (
                    <td key={key} className="px-3 py-2 text-gray-700 whitespace-nowrap">
                      {row[key] ?? "-"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-3 text-sm text-gray-500 border-t">
            {rows.length} companies · {selected?.frameworkName || "Unknown framework"}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg border p-12 text-center">
          <p className="text-gray-500">No results yet. Run a batch analysis to generate results.</p>
        </div>
      )}
    </div>
  );
}
