import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { ArrowLeft, Play, Camera, Upload, ExternalLink, FileText, CheckCircle2, XCircle, AlertCircle } from "lucide-react";

interface CompanyDetailPageProps {
  companyId: number;
  onBack: () => void;
}

export default function CompanyDetailPage({ companyId, onBack }: CompanyDetailPageProps) {
  const [activeTab, setActiveTab] = useState<"analysis" | "documents" | "diagnostics">("analysis");
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["company", companyId],
    queryFn: () => api.getCompany(companyId),
    refetchInterval: 5000,
  });

  if (!data) return <div className="text-center py-8 text-gray-400">Loading...</div>;

  const { company, scores, documents } = data;

  const handleAnalyze = async () => {
    try {
      await api.request(`/companies/${companyId}/analyze`, { method: "POST" });
      queryClient.invalidateQueries({ queryKey: ["company", companyId] });
    } catch (err: any) {
      alert(err.message);
    }
  };

  const getScoreColor = (score: number | null) => {
    if (score === null) return "text-gray-400";
    if (score >= 70) return "text-green-600";
    if (score >= 40) return "text-yellow-600";
    return "text-red-600";
  };

  // No longer needed - using tick/cross icons instead

  // Group scores by category
  const categories: Record<string, any[]> = {};
  for (const score of scores || []) {
    const cat = score.category || "Uncategorized";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(score);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <button onClick={onBack} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-2">
            <ArrowLeft className="w-4 h-4" /> Back to Dashboard
          </button>
          <h1 className="text-2xl font-bold text-gray-900 uppercase">{company.name}</h1>
          <p className="text-sm text-gray-500">
            {company.isin && `ISIN: ${company.isin}`}
            {company.sector && ` · ${company.sector}`}
            {company.country && ` · ${company.country}`}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="flex items-center gap-2 px-3 py-2 border rounded-lg text-sm hover:bg-gray-50">
            <Camera className="w-4 h-4" /> Snapshot
          </button>
          <button className="flex items-center gap-2 px-3 py-2 border rounded-lg text-sm hover:bg-gray-50">
            <Upload className="w-4 h-4" /> Upload PDF
          </button>
          <button
            onClick={handleAnalyze}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium"
          >
            <Play className="w-4 h-4" /> Analyze
          </button>
        </div>
      </div>

      {/* Score Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm text-gray-500">Total Score</div>
          <div className={`text-3xl font-bold ${getScoreColor(company.totalScore)}`}>
            {company.totalScore !== null ? `${company.totalScore}%` : "-"}
          </div>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm text-gray-500">Measures Met</div>
          <div className="text-3xl font-bold text-gray-900">
            {scores ? `${scores.filter((s: any) => s.score > 0).length} / ${scores.length}` : "-"}
          </div>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm text-gray-500">Documents</div>
          <div className="text-3xl font-bold text-gray-900">{documents?.length || company.documentsFound || 0}</div>
        </div>
      </div>

      {/* Executive Summary */}
      {company.summary && (
        <div className="bg-white rounded-lg border p-4">
          <h3 className="text-sm font-semibold text-gray-500 uppercase mb-2">Executive Summary</h3>
          <p className="text-sm text-gray-700 leading-relaxed">{company.summary}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="bg-white rounded-lg border">
        <div className="border-b flex">
          {(["analysis", "documents", "diagnostics"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab === "analysis" ? "Detailed Analysis" : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        <div className="p-4">
          {/* Analysis Tab */}
          {activeTab === "analysis" && (
            <div className="space-y-6">
              {Object.keys(categories).length === 0 ? (
                <p className="text-gray-400 text-center py-8">No analysis results yet. Click Analyze to start.</p>
              ) : (
                Object.entries(categories).map(([category, measures]) => (
                  <div key={category}>
                    <h4 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide border-b pb-2">{category}</h4>
                    <div className="space-y-2">
                      {measures.sort((a: any, b: any) => (a.displayOrder || 0) - (b.displayOrder || 0)).map((m: any) => (
                        <div key={m.id} className="px-4 py-3 border-b last:border-b-0">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                {m.score > 0 ? (
                                  <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                                ) : m.verdict === "Partial" ? (
                                  <AlertCircle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                                ) : (
                                  <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                                )}
                                <span className="text-sm font-medium text-gray-900">{m.title}</span>
                              </div>
                              {m.evidenceSummary && (
                                <p className="text-xs text-gray-600 mt-2 ml-6 bg-gray-50 p-2 rounded">
                                  {m.evidenceSummary}
                                </p>
                              )}
                              {m.verdict && m.verdict !== "Yes" && m.verdict !== "No" && (
                                <p className="text-xs text-gray-500 mt-1 ml-6 italic">{m.verdict}</p>
                              )}
                              {m.quotes && m.quotes.length > 0 && (
                                <div className="ml-6 mt-2 space-y-1">
                                  {m.quotes.map((q: any, idx: number) => (
                                    <blockquote key={idx} className="text-xs text-gray-500 border-l-2 border-blue-200 pl-2 italic">
                                      "{q.text}"
                                      {q.source && (
                                        q.sourceUrl ? (
                                          <a
                                            href={q.sourceUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-blue-500 hover:text-blue-700 underline ml-1"
                                            title={q.sourceUrl}
                                          >
                                            — {q.source}
                                          </a>
                                        ) : (
                                          <span className="text-gray-400 ml-1">— {q.source}</span>
                                        )
                                      )}
                                    </blockquote>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2 ml-4">
                              <span className={`text-xs px-2 py-0.5 rounded-full ${
                                m.confidence === "High" ? "bg-green-100 text-green-700" :
                                m.confidence === "Medium" ? "bg-yellow-100 text-yellow-700" :
                                "bg-gray-100 text-gray-600"
                              }`}>
                                {m.confidence}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Documents Tab */}
          {activeTab === "documents" && (
            <div>
              {(!documents || documents.length === 0) ? (
                <p className="text-gray-400 text-center py-8">No documents discovered yet.</p>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 uppercase">Document</th>
                      <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 uppercase">Type</th>
                      <th className="text-center px-3 py-2 text-xs font-medium text-gray-500 uppercase">Gate</th>
                      <th className="text-center px-3 py-2 text-xs font-medium text-gray-500 uppercase">Fetch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documents.map((doc: any) => (
                      <tr key={doc.id} className="border-b hover:bg-gray-50">
                        <td className="px-3 py-2">
                          <a
                            href={doc.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                          >
                            <FileText className="w-3.5 h-3.5 flex-shrink-0" />
                            {doc.title || doc.url?.slice(0, 60) || "Untitled"}
                          </a>
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-500">{doc.type || "html"}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            doc.gateVerdict === "accept" ? "bg-green-100 text-green-700" :
                            doc.gateVerdict === "reject" ? "bg-red-100 text-red-700" :
                            "bg-gray-100 text-gray-600"
                          }`}>
                            {doc.gateVerdict || "pending"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            doc.fetchStatus === "ok" ? "bg-green-100 text-green-700" :
                            doc.fetchStatus === "dead" ? "bg-red-100 text-red-700" :
                            "bg-yellow-100 text-yellow-700"
                          }`}>
                            {doc.fetchStatus || "pending"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Diagnostics Tab */}
          {activeTab === "diagnostics" && (
            <div className="space-y-4">
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Analysis Status</h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="text-gray-500">Status:</span> <span className="font-medium">{company.analysisStatus}</span></div>
                  <div><span className="text-gray-500">Last Updated:</span> <span className="font-medium">{company.updatedAt ? new Date(company.updatedAt).toLocaleString() : "-"}</span></div>
                  <div><span className="text-gray-500">Documents Found:</span> <span className="font-medium">{company.documentsFound || 0}</span></div>
                  <div><span className="text-gray-500">Domain:</span> <span className="font-medium">{company.domain || "auto-detect"}</span></div>
                  <div><span className="text-gray-500">Total Score:</span> <span className="font-medium">{company.totalScore !== null ? `${company.totalScore}%` : "Not scored"}</span></div>
                  <div><span className="text-gray-500">Sector:</span> <span className="font-medium">{company.sector || "Not set"}</span></div>
                </div>
              </div>
              {company.discoveryDiagnostics && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">Discovery Diagnostics</h4>
                  <pre className="text-xs text-gray-600 font-mono whitespace-pre-wrap">{JSON.stringify(company.discoveryDiagnostics, null, 2)}</pre>
                </div>
              )}
              {company.analysisStatus === "failed" && (
                <div className="bg-red-50 rounded-lg p-4">
                  <p className="text-sm text-red-700">Analysis failed. Try re-running.</p>
                </div>
              )}
              {company.analysisStatus !== "failed" && (
                <div className="bg-green-50 rounded-lg p-4">
                  <p className="text-sm text-green-700">No processing errors recorded.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
