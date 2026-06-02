import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { ArrowLeft, FileText, ExternalLink } from "lucide-react";

interface CompanyDetailPageProps {
  companyId: number;
  onBack: () => void;
}

export default function CompanyDetailPage({ companyId, onBack }: CompanyDetailPageProps) {
  const { data } = useQuery({
    queryKey: ["company", companyId],
    queryFn: () => api.getCompany(companyId),
  });

  if (!data) return <div className="text-center py-8">Loading...</div>;

  const { company, scores, documents } = data;

  const getScoreColor = (score: number) => {
    if (score >= 2) return "bg-green-100 text-green-800";
    if (score >= 1) return "bg-yellow-100 text-yellow-800";
    return "bg-red-100 text-red-800";
  };

  // Group scores by category
  const categories: Record<string, any[]> = {};
  for (const score of scores || []) {
    if (!categories[score.category]) categories[score.category] = [];
    categories[score.category].push(score);
  }

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="flex items-center gap-1 text-gray-600 hover:text-gray-900 text-sm">
        <ArrowLeft className="w-4 h-4" /> Back to Dashboard
      </button>

      {/* Header */}
      <div className="bg-white rounded-lg border p-6">
        <h1 className="text-2xl font-bold text-gray-900">{company.name}</h1>
        <p className="text-gray-500 text-sm mt-1">
          {company.isin && `ISIN: ${company.isin}`}
          {company.sector && ` · ${company.sector}`}
          {company.country && ` · ${company.country}`}
        </p>

        <div className="grid grid-cols-3 gap-4 mt-6">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm text-gray-500">Total Score</div>
            <div className={`text-3xl font-bold ${company.totalScore !== null ? (company.totalScore >= 50 ? "text-green-600" : "text-red-600") : "text-gray-400"}`}>
              {company.totalScore !== null ? `${company.totalScore}%` : "-"}
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm text-gray-500">Measures Met</div>
            <div className="text-3xl font-bold text-gray-900">
              {scores ? `${scores.filter((s: any) => s.score >= 2).length} / ${scores.length}` : "-"}
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm text-gray-500">Documents</div>
            <div className="text-3xl font-bold text-gray-900">{documents?.length || 0}</div>
          </div>
        </div>

        {company.summary && (
          <div className="mt-4 p-4 bg-blue-50 rounded-lg">
            <h3 className="text-sm font-semibold text-blue-800 mb-1">Executive Summary</h3>
            <p className="text-sm text-blue-900">{company.summary}</p>
          </div>
        )}
      </div>

      {/* Detailed Analysis */}
      <div className="bg-white rounded-lg border">
        <div className="p-4 border-b">
          <h2 className="font-semibold text-gray-900">Detailed Analysis</h2>
        </div>
        <div className="divide-y">
          {Object.entries(categories).map(([category, measures]) => (
            <div key={category} className="p-4">
              <h3 className="font-medium text-gray-800 mb-3">{category}</h3>
              <div className="space-y-2">
                {measures.sort((a, b) => a.displayOrder - b.displayOrder).map((m: any) => (
                  <div key={m.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${getScoreColor(m.score)}`}>
                      {m.score}/2
                    </span>
                    <div className="flex-1">
                      <div className="font-medium text-sm text-gray-900">{m.title}</div>
                      {m.evidenceSummary && (
                        <p className="text-xs text-gray-600 mt-1">{m.evidenceSummary}</p>
                      )}
                      {m.verdict && (
                        <p className="text-xs text-gray-500 mt-1 italic">{m.verdict}</p>
                      )}
                    </div>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      m.confidence === "High" ? "bg-green-50 text-green-700" :
                      m.confidence === "Medium" ? "bg-yellow-50 text-yellow-700" :
                      "bg-red-50 text-red-700"
                    }`}>
                      {m.confidence}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Documents */}
      <div className="bg-white rounded-lg border">
        <div className="p-4 border-b">
          <h2 className="font-semibold text-gray-900">Documents ({documents?.length || 0})</h2>
        </div>
        <div className="divide-y">
          {documents?.map((doc: any) => (
            <div key={doc.id} className="px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-gray-400" />
                <span className="text-sm text-gray-900">{doc.title || doc.url}</span>
                <span className="text-xs text-gray-400">{doc.type}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded ${
                  doc.fetchStatus === "ok" ? "bg-green-100 text-green-700" :
                  doc.fetchStatus === "dead" ? "bg-red-100 text-red-700" :
                  "bg-gray-100 text-gray-600"
                }`}>
                  {doc.fetchStatus}
                </span>
                <a href={doc.url} target="_blank" rel="noopener" className="text-blue-600 hover:text-blue-800">
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
