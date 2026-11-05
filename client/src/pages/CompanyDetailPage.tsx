import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { realQuotes } from "../lib/quotes";
import { useState } from "react";
import { ArrowLeft, Play, Camera, Upload, ExternalLink, FileText, CheckCircle2, XCircle } from "lucide-react";
import { isMet } from "@shared/verdict";
// WP02/A1 (additive): render explicit research status so the UI shows the SAME
// status as CSV/export/API (CV07) and never claims "comprehensive" when there is
// an unresolved essential gap. Display-only — no score/verdict effect.
import { summarizeResearchStatus, isLowScoreCompany, LOW_SCORE_ESSENTIAL_THRESHOLD } from "@shared/research-state";

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

  const { company, scores, documents, researchStatus, evidenceFunnel } = data as any;

  // Evidence funnel (§3, display-only): per-stage counts + provenance-health
  // signal from the API. Flags issuer-domain docs sitting in the third-party
  // bucket (the 3M signature) so a classification problem is not mistaken for a
  // genuinely low score. Never affects scoring.
  const funnel = (evidenceFunnel as any) || null;
  const provHealth = funnel?.provenanceHealth || null;
  const showProvenanceWarning = !!provHealth?.warning;
  const sameDomainThirdPartyCount: number = provHealth?.sameDomainThirdPartyCount ?? 0;

  // Issue 5 (part 2): for low-scoring companies (<= 2/36 met), surface the
  // essential-document checklist next to the score so a reviewer can tell
  // "looked and found nothing" apart from "never obtained the key documents".
  const metCount: number = Array.isArray(scores)
    ? scores.filter((s: any) => isMet(s.verdict, s.score)).length
    : 0;
  const essentialChecklist: Array<{ label: string; status: string; detail: string }> =
    (researchStatus?.essentialChecklist as any[]) || [];
  const showEssentialChecklist =
    isLowScoreCompany(metCount) && essentialChecklist.length > 0;

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
            {scores ? `${scores.filter((s: any) => isMet(s.verdict, s.score)).length} / ${scores.length}` : "-"}
          </div>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm text-gray-500">Scored evidence</div>
          <div className="text-3xl font-bold text-gray-900">
            {funnel ? funnel.scoredEvidence : (documents?.length || company.documentsFound || 0)}
          </div>
          {funnel && (
            <div className="text-xs text-gray-400 mt-0.5">
              first-party, gate-accepted · {funnel.discovered} discovered
            </div>
          )}
        </div>
      </div>

      {/* Evidence funnel (§3, display-only). Replaces the misleading bare
          "Documents: N" total with every stage from discovery to scored
          evidence, so the first-party/third-party split (what actually drives
          the score) is explicit. Additive — same pattern as Research Status. */}
      {funnel && (
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm font-semibold uppercase text-gray-500 mb-3">Evidence funnel</div>
          <div className="space-y-0.5">
            {([
              { label: "Discovered", value: funnel.discovered, hint: "surfaced by discovery", indent: false, strong: false },
              { label: "Fetched", value: funnel.fetched, hint: "downloaded + extracted", indent: false, strong: false },
              { label: "Dead / unreachable", value: funnel.dead, hint: "failed fetch (true dead links)", indent: false, strong: false },
              { label: "Gate-accepted", value: funnel.gateAccepted, hint: "passed relevance/quality gate", indent: false, strong: false },
              { label: "— First-party (issuer)", value: funnel.firstParty, hint: "company's own documents → scoring-eligible", indent: true, strong: false },
              { label: "— Third-party", value: funnel.thirdParty, hint: "Third-party documents are about the company but not authored/filed by it, so they are not counted as the company's own disclosure.", indent: true, strong: false },
              { label: "Scored evidence", value: funnel.scoredEvidence, hint: "what the score is actually based on (first-party, gate-accepted)", indent: false, strong: true },
            ] as const).map((row, i) => (
              <div
                key={i}
                title={row.hint}
                className={`flex items-center justify-between py-1.5 ${
                  row.strong ? "border-t mt-1 pt-2 font-semibold text-gray-900" : "text-gray-700"
                }`}
              >
                <span className={`text-sm ${row.indent ? "pl-4 text-gray-600" : ""}`}>{row.label}</span>
                <span className={`text-sm tabular-nums ${row.strong ? "text-gray-900" : "text-gray-800"}`}>{row.value}</span>
              </div>
            ))}
          </div>
          {/* Rule 4: budget-noted is informational, NOT dead. */}
          {funnel.budgetNoted > 0 && (
            <div className="text-xs text-gray-500 mt-2">
              {funnel.budgetNoted} document{funnel.budgetNoted === 1 ? "" : "s"} fetched OK with an
              informational budget note (not counted as dead).
            </div>
          )}
        </div>
      )}

      {/* Rule 3: provenance-health warning — first-party is low AND issuer-domain
          documents are sitting in the third-party bucket (the 3M signature). This
          flags a classification problem rather than a genuinely low score. */}
      {showProvenanceWarning && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="text-sm font-semibold uppercase text-red-600">Provenance health warning</div>
          <div className="text-sm text-red-800 mt-1">
            First-party evidence is low ({funnel.firstParty}), but {sameDomainThirdPartyCount} document
            {sameDomainThirdPartyCount === 1 ? " on the issuer's own domain is" : "s on the issuer's own domain are"} currently
            classified <strong>third-party</strong>
            {provHealth?.issuerDomain ? ` (${provHealth.issuerDomain})` : ""}. The low score may reflect a
            provenance-classification problem rather than absent disclosure.
          </div>
        </div>
      )}

      {/* WP02/A1: Research status banner. Additive, display-only — never claims
          "comprehensive" when there is an unresolved essential gap. */}
      {researchStatus && (
        <div
          className={`rounded-lg border p-4 ${
            researchStatus.comprehensive
              ? "bg-green-50 border-green-200"
              : "bg-amber-50 border-amber-200"
          }`}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold uppercase text-gray-500">Research Status</div>
              <div
                className={`text-sm font-medium ${
                  researchStatus.comprehensive ? "text-green-700" : "text-amber-700"
                }`}
              >
                {summarizeResearchStatus(researchStatus)}
              </div>
            </div>
            <div className="text-xs text-gray-500 text-right">
              <div>
                Eligible retrieved: {researchStatus.coverage?.retrieved ?? 0} /{" "}
                {researchStatus.coverage?.denominator ?? 0}
              </div>
              <div>{researchStatus.discoveryRecall?.label}</div>
            </div>
          </div>
          {!researchStatus.comprehensive &&
            Array.isArray(researchStatus.reasons) &&
            researchStatus.reasons.length > 0 && (
              <ul className="mt-2 list-disc list-inside text-xs text-amber-800">
                {researchStatus.reasons.map((r: string, i: number) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
        </div>
      )}

      {/* Issue 5 (part 2): essential-document checklist for low-score companies
          (<= 2/36 met). Names each framework-required document as found / partial
          / not found so a zero/near-zero score is never mistaken for a confident
          "nothing to disclose". Display-only; derived automatically from research
          state (no manual labelling). */}
      {showEssentialChecklist && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="text-sm font-semibold uppercase text-gray-500">
            Essential-document checklist
          </div>
          <div className="text-xs text-amber-800 mb-2">
            This company met only {metCount}/{scores?.length ?? 0} measures
            (≤ {LOW_SCORE_ESSENTIAL_THRESHOLD}). Essential documents for this framework:
          </div>
          <ul className="space-y-1">
            {essentialChecklist.map((item, i) => {
              const color =
                item.status === "found"
                  ? "text-green-700"
                  : item.status === "partial"
                  ? "text-amber-700"
                  : "text-red-700";
              // Rule 5: when an item is "Not found" but same-domain documents are
              // classified third-party, state the basis — the gap may be
              // attribution, not absence.
              const notFoundAttributed =
                item.status !== "found" &&
                item.status !== "partial" &&
                sameDomainThirdPartyCount > 0;
              const label =
                item.status === "found"
                  ? "Found"
                  : item.status === "partial"
                  ? "Partial"
                  : notFoundAttributed
                  ? "Not found*"
                  : "Not found";
              const detail = notFoundAttributed
                ? `Not found in first-party evidence (${sameDomainThirdPartyCount} same-domain document${
                    sameDomainThirdPartyCount === 1 ? "" : "s"
                  } are currently classified third-party)`
                : item.detail;
              return (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className={`font-semibold ${color} w-20 shrink-0`}>{label}</span>
                  <span className="text-gray-800">
                    {item.label}
                    <span className="text-gray-500"> — {detail}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

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
                          {/* Slim per-measure detail: exactly 6 fields in order —
                              (i) Conclusion (tick/cross), (ii) Measure name,
                              (iii) Requirements to score Yes, (iv) Rationale,
                              (v) Evidence quote, (vi) Source (hyperlinked). */}
                          <div className="flex-1">
                            {/* (i) Conclusion + (ii) Measure name */}
                            <div className="flex items-center gap-2">
                              {isMet(m.verdict, m.score) ? (
                                <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                              ) : (
                                <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                              )}
                              <span className="text-sm font-medium text-gray-900">{m.title}</span>
                            </div>
                            {/* (iii) Requirements to score Yes */}
                            {m.requirementsToScoreYes && (
                              <div className="mt-2 ml-6">
                                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                                  Requirements to score Yes
                                </div>
                                <p className="text-xs text-gray-600 mt-0.5">{m.requirementsToScoreYes}</p>
                              </div>
                            )}
                            {/* (iv) Rationale */}
                            {m.evidenceSummary && (
                              <div className="mt-2 ml-6">
                                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                                  Rationale
                                </div>
                                <p className="text-xs text-gray-600 mt-0.5 bg-gray-50 p-2 rounded">
                                  {m.evidenceSummary}
                                </p>
                              </div>
                            )}
                            {/* (v) Evidence quote + (vi) Source (hyperlinked where a URL exists).
                                Diagnostic trace blobs (diag:// / retrieval-diagnostic / evidence-gate)
                                are filtered out here so only human-readable verbatim quotes show. */}
                            {realQuotes(m.quotes).length > 0 && (
                              <div className="ml-6 mt-2 space-y-1">
                                {realQuotes(m.quotes).map((q: any, idx: number) => (
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
