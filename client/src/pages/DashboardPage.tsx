import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState, useMemo, useRef, useEffect } from "react";
import {
  Search, Play, Square, Plus, Upload, Download, BarChart3,
  RotateCcw, ExternalLink, Trash2, Loader2, CheckCircle2, XCircle,
  Clock, AlertCircle, MoreHorizontal, ChevronDown, ChevronRight
} from "lucide-react";

interface DashboardPageProps {
  onViewCompany: (id: number) => void;
}

// localStorage keys for the dashboard's persisted list/framework selection.
const DASH_SELECTED_LIST_KEY = "dash-selected-list-id";
const DASH_SELECTED_FRAMEWORK_KEY = "dash-selected-framework-id";

/** Read a persisted numeric id from localStorage, returning null if absent or
 * unparseable. Safe in non-browser/SSR contexts (no window). */
function readStoredId(key: string): number | null {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Render the coverage flags for a low-discovery/low-retrieval row as plain-English
 * badges with a hover explanation, instead of the raw internal flag names. */
function DiscoveryFlagCell({
  budgetExceeded,
  lowEvidence,
  critical,
}: {
  budgetExceeded?: boolean;
  lowEvidence?: boolean;
  critical?: boolean;
}) {
  const flags: Array<{ label: string; title: string; cls: string }> = [];
  if (critical) {
    flags.push({
      label: "critical",
      title:
        "Fewer than 3 documents were retrieved, or the fetch ratio is below the critical threshold — the score rests on very little evidence and is especially unreliable.",
      cls: "bg-red-100 text-red-700",
    });
  }
  if (budgetExceeded) {
    flags.push({
      label: "fetch-time budget hit",
      title:
        "The per-company document-download phase reached its time limit before all the discovered documents could be fetched. The remaining documents were skipped and the company was scored on those already retrieved. Re-running retries the un-fetched documents.",
      cls: "bg-gray-100 text-gray-700",
    });
  }
  if (lowEvidence) {
    flags.push({
      label: "thin evidence",
      title:
        "Very little usable text was retrieved, so the score rests on a weak evidence base.",
      cls: "bg-gray-100 text-gray-700",
    });
  }
  if (flags.length === 0) return <span className="text-gray-400">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span
          key={f.label}
          title={f.title}
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium cursor-help ${f.cls}`}
        >
          {f.label}
        </span>
      ))}
    </span>
  );
}

/** Persist (or clear when null) a numeric id in localStorage. Best-effort. */
function writeStoredId(key: string, id: number | null): void {
  try {
    if (typeof window === "undefined") return;
    if (id == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(id));
  } catch {
    /* ignore storage failures (private mode, quota) */
  }
}

// ── Status-indicator helpers ────────────────────────────────────────────────
/** Human-readable elapsed/started label, e.g. "started 12:04 (8m ago)". */
function formatStarted(startedAt?: string | null): string {
  if (!startedAt) return "";
  const start = new Date(startedAt);
  if (isNaN(start.getTime())) return "";
  const t = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const mins = Math.max(0, Math.round((Date.now() - start.getTime()) / 60000));
  const ago = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
  return `started ${t} (${ago})`;
}

/** Human-readable ETA from seconds, e.g. "~12 min remaining". */
function formatEta(etaSeconds?: number | null): string {
  if (etaSeconds == null || !isFinite(etaSeconds) || etaSeconds <= 0) return "";
  if (etaSeconds < 90) return "~1 min remaining";
  const mins = Math.round(etaSeconds / 60);
  if (mins < 60) return `~${mins} min remaining`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `~${h}h ${m}m remaining`;
}

export default function DashboardPage({ onViewCompany }: DashboardPageProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  // Persist the dashboard's list/framework selection across reloads. Purely
  // presentational — these ids only filter what the dashboard shows and pick the
  // framework for a run; they never touch query keys, mutations, or scoring. The
  // lazy initialiser rehydrates the last selection so the dropdowns survive a
  // refresh; a guard effect below discards any stored id that no longer exists.
  const [selectedList, setSelectedList] = useState<number | null>(() =>
    readStoredId(DASH_SELECTED_LIST_KEY),
  );
  const [selectedFramework, setSelectedFramework] = useState<number | null>(() =>
    readStoredId(DASH_SELECTED_FRAMEWORK_KEY),
  );
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCompany, setNewCompany] = useState({ name: "", isin: "", sector: "", country: "", domain: "" });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [anomalyExpanded, setAnomalyExpanded] = useState(false);
  const [selectedAnomalyIds, setSelectedAnomalyIds] = useState<Set<number>>(new Set());
  // Document-discovery coverage sections (low tier + critical tier).
  const [lowDiscExpanded, setLowDiscExpanded] = useState(false);
  const [criticalDiscExpanded, setCriticalDiscExpanded] = useState(false);
  const [selectedLowDiscIds, setSelectedLowDiscIds] = useState<Set<number>>(new Set());
  const [selectedCriticalDiscIds, setSelectedCriticalDiscIds] = useState<Set<number>>(new Set());
  // Understated — pending domain review (companies affected by approved Source Domains).
  const [affectedExpanded, setAffectedExpanded] = useState(false);
  const [selectedAffectedIds, setSelectedAffectedIds] = useState<Set<number>>(new Set());
  // Presentational: secondary run actions live behind a "More" menu; the company
  // table can be collapsed. Neither affects scoring, mutations or query keys.
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [tableExpanded, setTableExpanded] = useState(true);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) setMoreMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMoreMenuOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreMenuOpen]);

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

  const { data: anomalies = [] } = useQuery({
    queryKey: ["scoreAnomalies"],
    queryFn: () => api.getScoreAnomalies("pending"),
    refetchInterval: 30000,
  });

  const dismissAnomalyMutation = useMutation({
    mutationFn: (id: number) => api.dismissAnomaly(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["scoreAnomalies"] }),
  });

  const reexamineAnomalyMutation = useMutation({
    mutationFn: (id: number) => api.reexamineAnomaly(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scoreAnomalies"] });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      queryClient.invalidateQueries({ queryKey: ["batchStatus"] });
    },
  });

  const bulkDismissMutation = useMutation({
    mutationFn: (ids: number[]) => api.bulkDismissAnomalies(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scoreAnomalies"] });
      setSelectedAnomalyIds(new Set());
    },
  });

  const bulkReexamineMutation = useMutation({
    mutationFn: (ids: number[]) => api.bulkReexamineAnomalies(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scoreAnomalies"] });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      queryClient.invalidateQueries({ queryKey: ["batchStatus"] });
      setSelectedAnomalyIds(new Set());
    },
  });

  const { data: lists = [] } = useQuery({
    queryKey: ["lists"],
    queryFn: api.getLists,
  });

  // Fetch list members when a specific list is selected
  const { data: listCompanies } = useQuery({
    queryKey: ["listCompanies", selectedList],
    queryFn: () => api.getListCompanies(selectedList!),
    enabled: !!selectedList,
  });

  const { data: frameworks = [] } = useQuery({
    queryKey: ["frameworks"],
    queryFn: api.getFrameworks,
  });

  // Persist the current selection so it survives a page reload.
  useEffect(() => {
    writeStoredId(DASH_SELECTED_LIST_KEY, selectedList);
  }, [selectedList]);
  useEffect(() => {
    writeStoredId(DASH_SELECTED_FRAMEWORK_KEY, selectedFramework);
  }, [selectedFramework]);

  // Guard against a rehydrated id that no longer exists (list/framework deleted
  // since the last visit). Only run once the relevant query has returned rows so
  // we never clear a valid selection just because data hasn't loaded yet.
  useEffect(() => {
    if (selectedList != null && lists.length > 0 &&
        !lists.some((l: any) => l.id === selectedList)) {
      setSelectedList(null);
    }
  }, [lists, selectedList]);
  useEffect(() => {
    if (selectedFramework != null && frameworks.length > 0 &&
        !frameworks.some((f: any) => f.id === selectedFramework)) {
      setSelectedFramework(null);
    }
  }, [frameworks, selectedFramework]);

  const companies = companiesData?.companies || [];
  const stats = companiesData?.stats || { total: 0, completed: 0, avgScore: 0 };

  // First filter by selected list, then by search
  const listFilteredCompanies = useMemo(() => {
    if (!selectedList) return companies;
    if (!listCompanies) return [];
    const listCompanyIds = new Set(listCompanies.map((c: any) => c.id));
    return companies.filter((c: any) => listCompanyIds.has(c.id));
  }, [companies, selectedList, listCompanies]);

  const filteredCompanies = listFilteredCompanies.filter((c: any) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.sector || "").toLowerCase().includes(search.toLowerCase()) ||
    (c.country || "").toLowerCase().includes(search.toLowerCase())
  );

  // Score distribution (based on list-filtered companies)
  const scoreDistribution = useMemo(() => {
    const completedCompanies = listFilteredCompanies.filter((c: any) => c.analysisStatus === "completed" && c.totalScore !== null);
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
  }, [listFilteredCompanies]);

  const maxBucketCount = Math.max(...scoreDistribution.buckets.map((b) => b.count), 1);

  // Off-peak scheduling toggle
  const [offPeakOnly, setOffPeakOnly] = useState(false);

  // Mutations
  const analyzeMutation = useMutation({
    mutationFn: (opts: { frameworkId: number; listId?: number; offPeakOnly?: boolean; scoreOnly?: boolean }) => api.analyze(opts),
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

  const resumeMutation = useMutation({
    // Clear the alert that is actually showing (LLM credit vs. residential-proxy
    // credit) so the single Resume button works for either kind.
    mutationFn: () => api.resumeSystem(batchStatus?.alert?.kind || "credit_exhaustion"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["batchStatus"] }),
    onError: (error: any) => alert(`Resume failed: ${error.message}`),
  });

  const reexamineMutation = useMutation({
    mutationFn: () => api.reexamineFailures(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["batchStatus"] });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
    },
    onError: (error: any) => alert(`Re-examine failed: ${error.message}`),
  });

  const finalizeMutation = useMutation({
    mutationFn: () => api.finalizeBatchReview(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["batchStatus"] });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
    },
    onError: (error: any) => alert(`Finalise failed: ${error.message}`),
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

  const fullResetListMutation = useMutation({
    mutationFn: (listId: number) => api.fullResetList(listId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["companies"] }),
  });

  const fullResetAllMutation = useMutation({
    mutationFn: () => api.fullResetAll(),
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

  // ── Document-discovery coverage (low + critical tiers) ────────────────────
  const { data: lowDiscovery } = useQuery({
    queryKey: ["lowDiscovery", effectiveFrameworkId ?? null],
    queryFn: () => api.getLowDiscovery(effectiveFrameworkId),
    refetchInterval: 30000,
  });
  // Signal-split: the red section is "too few documents found" (discovery),
  // the amber section is "enough found but too few retrieved" (fetch/retrieval
  // rate). Fall back to the old field names for a stale cached API response.
  const criticalDiscRows = lowDiscovery?.discoveryTooLow ?? lowDiscovery?.criticalDiscovery ?? [];
  const lowDiscRows = lowDiscovery?.lowRetrieval ?? lowDiscovery?.lowDiscovery ?? [];

  const rerunDiscoveryMutation = useMutation({
    mutationFn: (companyIds: number[]) => api.rerunLowDiscovery(companyIds, effectiveFrameworkId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      queryClient.invalidateQueries({ queryKey: ["batchStatus"] });
      queryClient.invalidateQueries({ queryKey: ["lowDiscovery"] });
      setSelectedLowDiscIds(new Set());
      setSelectedCriticalDiscIds(new Set());
    },
    onError: (error: any) => alert(`Re-run failed: ${error.message}`),
  });

  // ── Understated — pending domain review ───────────────────────────────────
  // Companies touched by a domain Andy has approved as primary-eligible on the
  // Source Domains page. A scoreOnly re-run re-classifies their existing corpus
  // under the new policy without re-fetching documents.
  const { data: affectedCompanies } = useQuery({
    queryKey: ["affectedCompanies"],
    queryFn: () => api.getAffectedCompanies(),
    refetchInterval: 60000,
  });
  const affectedRows: any[] = Array.isArray(affectedCompanies) ? affectedCompanies : [];

  const rerunAffectedMutation = useMutation({
    mutationFn: (companyIds: number[]) => {
      if (!effectiveFrameworkId) throw new Error("No framework selected");
      // Re-score ONLY: re-classify the existing document corpus under the updated
      // domain policy without re-running discovery/fetch.
      return api.analyze({ frameworkId: effectiveFrameworkId, companyIds, scoreOnly: true });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      queryClient.invalidateQueries({ queryKey: ["batchStatus"] });
      queryClient.invalidateQueries({ queryKey: ["affectedCompanies"] });
      setSelectedAffectedIds(new Set());
    },
    onError: (error: any) => alert(`Re-run failed: ${error.message}`),
  });

  const handleAnalyze = () => {
    if (!effectiveFrameworkId) return alert("No framework selected");
    analyzeMutation.mutate({
      frameworkId: effectiveFrameworkId,
      listId: selectedList || undefined,
      offPeakOnly,
    });
  };

  const handleRescore = () => {
    if (!effectiveFrameworkId) return alert("No framework selected");
    analyzeMutation.mutate({
      frameworkId: effectiveFrameworkId,
      listId: selectedList || undefined,
      offPeakOnly,
      scoreOnly: true,
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
          <p className="text-2xl font-bold text-gray-900">{selectedList ? listFilteredCompanies.length : stats.total}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Analyzed</p>
          <p className="text-2xl font-bold text-green-600">{selectedList ? listFilteredCompanies.filter((c: any) => c.analysisStatus === "completed").length : stats.completed}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Average Score</p>
          <p className="text-2xl font-bold text-blue-600">{(() => { const scored = (selectedList ? listFilteredCompanies : companies).filter((c: any) => c.analysisStatus === "completed" && c.totalScore !== null); return scored.length > 0 ? Math.round(scored.reduce((sum: number, c: any) => sum + c.totalScore, 0) / scored.length) : 0; })()}%</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Batch Status</p>
          <p className="text-2xl font-bold text-gray-900">
            {batchStatus?.running ? `${batchStatus.completed}/${batchStatus.total}` : "Idle"}
          </p>
        </div>
      </div>

      {/* Credit-exhaustion / system pause alert */}
      {batchStatus?.alert && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-amber-900">
                  {batchStatus.alert.kind === "proxy_credit_exhaustion"
                    ? "Processing paused — residential proxy out of credit"
                    : "Processing paused — API credit exhausted"}
                  {batchStatus.alert.provider ? ` (${batchStatus.alert.provider})` : ""}
                </p>
                <p className="text-xs text-amber-800 mt-1">{batchStatus.alert.message}</p>
                <p className="text-[11px] text-amber-700 mt-1">
                  Jobs are safely re-queued (no progress lost). They resume automatically once credit is detected, or click Resume after topping up.
                </p>
              </div>
            </div>
            <button
              onClick={() => resumeMutation.mutate()}
              disabled={resumeMutation.isPending}
              className="flex items-center gap-1 px-3 py-1 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 flex-shrink-0"
            >
              <RotateCcw className="w-3 h-3" /> Resume
            </button>
          </div>
        </div>
      )}

      {/* Batch completion review gate */}
      {batchStatus?.review && (
        <div className="bg-orange-50 border border-orange-300 rounded-lg p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-orange-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-orange-900">
                  Batch finished with {batchStatus.review.failedCount} failed{" "}
                  {batchStatus.review.failedCount === 1 ? "company" : "companies"} — review required
                  {batchStatus.review.reviewableCount > 1 && (
                    <span className="ml-1 font-normal">
                      (1 of {batchStatus.review.reviewableCount} batches awaiting review)
                    </span>
                  )}
                </p>
                <p className="text-xs text-orange-800 mt-1">
                  Results have <strong>not</strong> been saved yet. Re-examine the failures, or discard them and finalise the batch to publish results.
                </p>
                {batchStatus.review.failures && batchStatus.review.failures.length > 0 && (
                  <div className="mt-2">
                    <button
                      onClick={() => setReviewExpanded((v) => !v)}
                      className="text-xs text-orange-700 underline hover:text-orange-900"
                    >
                      {reviewExpanded ? "Hide" : "Show"} failed companies
                    </button>
                    {reviewExpanded && (
                      <ul className="mt-1 max-h-48 overflow-y-auto text-xs text-orange-800 list-disc list-inside space-y-0.5">
                        {batchStatus.review.failures.map((f: any) => (
                          <li key={f.id ?? f.companyId ?? f.name}>
                            {f.name || f.companyName || `Company #${f.companyId ?? f.id}`}
                            {f.error ? ` — ${f.error}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2 flex-shrink-0">
              <button
                onClick={() => reexamineMutation.mutate()}
                disabled={reexamineMutation.isPending || finalizeMutation.isPending}
                className="flex items-center gap-1 px-3 py-1 text-sm bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
              >
                <RotateCcw className="w-3 h-3" /> Re-examine Failures
              </button>
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      `Discard ${batchStatus.review?.failedCount} failed companies and finalise the batch? This saves all successful results to the Results page and cannot be undone.`
                    )
                  ) {
                    finalizeMutation.mutate();
                  }
                }}
                disabled={reexamineMutation.isPending || finalizeMutation.isPending}
                className="flex items-center gap-1 px-3 py-1 text-sm bg-white border border-orange-400 text-orange-700 rounded hover:bg-orange-100 disabled:opacity-50"
              >
                <XCircle className="w-3 h-3" /> Discard &amp; Finalise
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Score Anomalies — Review Suggested */}
      {anomalies.length > 0 && (
        <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-purple-600" />
              <span className="text-sm font-semibold text-purple-900">
                Review Suggested — {anomalies.length} outlier{anomalies.length !== 1 ? "s" : ""} detected
              </span>
              <span className="text-xs text-purple-600">
                Companies with scores significantly different from sector/country peers
              </span>
            </div>
            <button
              onClick={() => setAnomalyExpanded((v) => !v)}
              className="text-xs text-purple-700 underline hover:text-purple-900"
            >
              {anomalyExpanded ? "Collapse" : "Expand"}
            </button>
          </div>

          {anomalyExpanded && (
            <div className="mt-3">
              {/* Bulk action bar */}
              {selectedAnomalyIds.size > 0 && (
                <div className="flex items-center gap-3 mb-2 p-2 bg-purple-100 rounded">
                  <span className="text-xs font-medium text-purple-800">{selectedAnomalyIds.size} selected</span>
                  <button
                    onClick={() => bulkReexamineMutation.mutate(Array.from(selectedAnomalyIds))}
                    disabled={bulkReexamineMutation.isPending}
                    className="px-2 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
                  >
                    Re-examine selected
                  </button>
                  <button
                    onClick={() => bulkDismissMutation.mutate(Array.from(selectedAnomalyIds))}
                    disabled={bulkDismissMutation.isPending}
                    className="px-2 py-1 text-xs bg-white border border-purple-300 text-purple-700 rounded hover:bg-purple-50 disabled:opacity-50"
                  >
                    Dismiss selected
                  </button>
                  <button
                    onClick={() => setSelectedAnomalyIds(new Set())}
                    className="px-2 py-1 text-xs text-purple-600 hover:text-purple-800"
                  >
                    Clear
                  </button>
                </div>
              )}

              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-purple-100 sticky top-0">
                    <tr>
                      <th className="p-1.5 text-left">
                        <input
                          type="checkbox"
                          checked={selectedAnomalyIds.size === anomalies.length && anomalies.length > 0}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedAnomalyIds(new Set(anomalies.map((a: any) => a.id)));
                            } else {
                              setSelectedAnomalyIds(new Set());
                            }
                          }}
                        />
                      </th>
                      <th className="p-1.5 text-left text-purple-800">Company</th>
                      <th className="p-1.5 text-left text-purple-800">Sector</th>
                      <th className="p-1.5 text-left text-purple-800">Country</th>
                      <th className="p-1.5 text-right text-purple-800">Actual</th>
                      <th className="p-1.5 text-right text-purple-800">Expected</th>
                      <th className="p-1.5 text-right text-purple-800">Residual</th>
                      <th className="p-1.5 text-left text-purple-800">Reason</th>
                      <th className="p-1.5 text-center text-purple-800">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {anomalies.map((a: any) => (
                      <tr key={a.id} className={`border-t border-purple-100 ${selectedAnomalyIds.has(a.id) ? "bg-purple-100" : "hover:bg-purple-50"}`}>
                        <td className="p-1.5">
                          <input
                            type="checkbox"
                            checked={selectedAnomalyIds.has(a.id)}
                            onChange={(e) => {
                              const next = new Set(selectedAnomalyIds);
                              if (e.target.checked) next.add(a.id);
                              else next.delete(a.id);
                              setSelectedAnomalyIds(next);
                            }}
                          />
                        </td>
                        <td className="p-1.5 font-medium text-gray-900">{a.companyName}</td>
                        <td className="p-1.5 text-gray-600">{a.sector || "—"}</td>
                        <td className="p-1.5 text-gray-600">{a.country || "—"}</td>
                        <td className={`p-1.5 text-right font-medium ${a.residual > 0 ? "text-green-700" : "text-red-700"}`}>
                          {a.actualScore?.toFixed(0)}%
                        </td>
                        <td className="p-1.5 text-right text-gray-600">{a.expectedScore?.toFixed(0)}%</td>
                        <td className={`p-1.5 text-right font-bold ${a.residual > 0 ? "text-green-700" : "text-red-700"}`}>
                          {a.residual > 0 ? "+" : ""}{a.residual?.toFixed(0)}pp
                        </td>
                        <td className="p-1.5 text-gray-500 max-w-xs truncate" title={a.reason}>{a.reason}</td>
                        <td className="p-1.5 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => reexamineAnomalyMutation.mutate(a.id)}
                              disabled={reexamineAnomalyMutation.isPending}
                              className="px-1.5 py-0.5 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
                              title="Re-examine this company"
                            >
                              Re-examine
                            </button>
                            <button
                              onClick={() => dismissAnomalyMutation.mutate(a.id)}
                              disabled={dismissAnomalyMutation.isPending}
                              className="px-1.5 py-0.5 text-xs text-purple-600 border border-purple-300 rounded hover:bg-purple-50 disabled:opacity-50"
                              title="Dismiss — score is correct"
                            >
                              Dismiss
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Understated — pending domain review (approved Source Domains) */}
      {affectedRows.length > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-emerald-600" />
              <span className="text-sm font-semibold text-emerald-900">
                Understated — pending domain review — {affectedRows.length} compan{affectedRows.length !== 1 ? "ies" : "y"}
              </span>
              <span className="text-xs text-emerald-600">
                These companies have documents on a domain you approved on Source Domains. Re-run (score only) to re-classify their existing corpus under the new policy.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => rerunAffectedMutation.mutate(affectedRows.map((r: any) => r.companyId))}
                disabled={rerunAffectedMutation.isPending}
                className="px-2 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
              >
                Re-run all ({affectedRows.length})
              </button>
              <button
                onClick={() => setAffectedExpanded((v) => !v)}
                className="text-xs text-emerald-700 underline hover:text-emerald-900"
              >
                {affectedExpanded ? "Collapse" : "Expand"}
              </button>
            </div>
          </div>

          {affectedExpanded && (
            <div className="mt-3">
              {selectedAffectedIds.size > 0 && (
                <div className="flex items-center gap-3 mb-2 p-2 bg-emerald-100 rounded">
                  <span className="text-xs font-medium text-emerald-800">{selectedAffectedIds.size} selected</span>
                  <button
                    onClick={() => rerunAffectedMutation.mutate(Array.from(selectedAffectedIds))}
                    disabled={rerunAffectedMutation.isPending}
                    className="px-2 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Re-run selected (score only)
                  </button>
                  <button
                    onClick={() => setSelectedAffectedIds(new Set())}
                    className="px-2 py-1 text-xs text-emerald-600 hover:text-emerald-800"
                  >
                    Clear
                  </button>
                </div>
              )}

              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-emerald-100 sticky top-0">
                    <tr>
                      <th className="p-1.5 text-left">
                        <input
                          type="checkbox"
                          checked={selectedAffectedIds.size === affectedRows.length && affectedRows.length > 0}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedAffectedIds(new Set(affectedRows.map((r: any) => r.companyId)));
                            else setSelectedAffectedIds(new Set());
                          }}
                        />
                      </th>
                      <th className="p-1.5 text-left text-emerald-800">Company</th>
                      <th className="p-1.5 text-left text-emerald-800">Sector</th>
                      <th className="p-1.5 text-left text-emerald-800">Country</th>
                      <th className="p-1.5 text-right text-emerald-800" title="Third-party documents on an approved domain that could be re-classified as issuer.">Affected docs</th>
                      <th className="p-1.5 text-right text-emerald-800">Current score</th>
                      <th className="p-1.5 text-left text-emerald-800">Status</th>
                      <th className="p-1.5 text-center text-emerald-800">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {affectedRows.map((r: any) => (
                      <tr key={r.companyId} className={`border-t border-emerald-100 ${selectedAffectedIds.has(r.companyId) ? "bg-emerald-100" : "hover:bg-emerald-50"}`}>
                        <td className="p-1.5">
                          <input
                            type="checkbox"
                            checked={selectedAffectedIds.has(r.companyId)}
                            onChange={(e) => {
                              const next = new Set(selectedAffectedIds);
                              if (e.target.checked) next.add(r.companyId);
                              else next.delete(r.companyId);
                              setSelectedAffectedIds(next);
                            }}
                          />
                        </td>
                        <td className="p-1.5 font-medium text-gray-900">
                          <button onClick={() => onViewCompany(r.companyId)} className="hover:underline text-left">{r.name}</button>
                        </td>
                        <td className="p-1.5 text-gray-600">{r.sector || "—"}</td>
                        <td className="p-1.5 text-gray-600">{r.country || "—"}</td>
                        <td className="p-1.5 text-right text-gray-700">{r.affectedDocCount}</td>
                        <td className="p-1.5 text-right text-gray-700">{r.totalScore ?? "—"}</td>
                        <td className="p-1.5">
                          {r.pendingReRun ? (
                            <span className="inline-block px-1.5 py-0.5 rounded-full bg-emerald-200 text-emerald-900 font-medium">Pending re-run</span>
                          ) : (
                            <span className="text-gray-500">Up to date</span>
                          )}
                        </td>
                        <td className="p-1.5 text-center">
                          <button
                            onClick={() => rerunAffectedMutation.mutate([r.companyId])}
                            disabled={rerunAffectedMutation.isPending}
                            className="px-1.5 py-0.5 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                            title="Re-score this company under the updated domain policy (no re-fetch)"
                          >
                            Re-run
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Document Discovery Too Low — critical tier (red) */}
      {criticalDiscRows.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-600" />
              <span className="text-sm font-semibold text-red-900">
                Document Discovery Too Low — {criticalDiscRows.length} compan{criticalDiscRows.length !== 1 ? "ies" : "y"}
              </span>
              <span className="text-xs text-red-600">
                Fewer than {lowDiscovery?.thresholds?.criticalMinDocs ?? 10} documents were found in search — the evidence base is too thin to score reliably
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => rerunDiscoveryMutation.mutate(criticalDiscRows.map((r: any) => r.id))}
                disabled={rerunDiscoveryMutation.isPending}
                className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                Re-run all ({criticalDiscRows.length})
              </button>
              <button
                onClick={() => setCriticalDiscExpanded((v) => !v)}
                className="text-xs text-red-700 underline hover:text-red-900"
              >
                {criticalDiscExpanded ? "Collapse" : "Expand"}
              </button>
            </div>
          </div>

          {criticalDiscExpanded && (
            <div className="mt-3">
              {selectedCriticalDiscIds.size > 0 && (
                <div className="flex items-center gap-3 mb-2 p-2 bg-red-100 rounded">
                  <span className="text-xs font-medium text-red-800">{selectedCriticalDiscIds.size} selected</span>
                  <button
                    onClick={() => rerunDiscoveryMutation.mutate(Array.from(selectedCriticalDiscIds))}
                    disabled={rerunDiscoveryMutation.isPending}
                    className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                  >
                    Re-run selected
                  </button>
                  <button
                    onClick={() => setSelectedCriticalDiscIds(new Set())}
                    className="px-2 py-1 text-xs text-red-600 hover:text-red-800"
                  >
                    Clear
                  </button>
                </div>
              )}

              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-red-100 sticky top-0">
                    <tr>
                      <th className="p-1.5 text-left">
                        <input
                          type="checkbox"
                          checked={selectedCriticalDiscIds.size === criticalDiscRows.length && criticalDiscRows.length > 0}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedCriticalDiscIds(new Set(criticalDiscRows.map((r: any) => r.id)));
                            else setSelectedCriticalDiscIds(new Set());
                          }}
                        />
                      </th>
                      <th className="p-1.5 text-left text-red-800">Company</th>
                      <th className="p-1.5 text-left text-red-800">Sector</th>
                      <th className="p-1.5 text-left text-red-800">Country</th>
                      <th className="p-1.5 text-right text-red-800">Fetched / Discovered</th>
                      <th className="p-1.5 text-right text-red-800" title="Fraction of discovered documents that were actually downloaded (fetched ÷ discovered).">Fetch ratio</th>
                      <th className="p-1.5 text-right text-red-800" title="Company's overall framework score (same figure shown in Results).">Score</th>
                      <th className="p-1.5 text-left text-red-800">Flags</th>
                      <th className="p-1.5 text-center text-red-800">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {criticalDiscRows.map((r: any) => (
                      <tr key={r.id} className={`border-t border-red-100 ${selectedCriticalDiscIds.has(r.id) ? "bg-red-100" : "hover:bg-red-50"}`}>
                        <td className="p-1.5">
                          <input
                            type="checkbox"
                            checked={selectedCriticalDiscIds.has(r.id)}
                            onChange={(e) => {
                              const next = new Set(selectedCriticalDiscIds);
                              if (e.target.checked) next.add(r.id);
                              else next.delete(r.id);
                              setSelectedCriticalDiscIds(next);
                            }}
                          />
                        </td>
                        <td className="p-1.5 font-medium text-gray-900">
                          <button onClick={() => onViewCompany(r.id)} className="hover:underline text-left">{r.name}</button>
                        </td>
                        <td className="p-1.5 text-gray-600">{r.sector || "—"}</td>
                        <td className="p-1.5 text-gray-600">{r.country || "—"}</td>
                        <td className="p-1.5 text-right text-gray-700">{r.documentsFetched} / {r.documentsDiscovered}</td>
                        <td className="p-1.5 text-right font-bold text-red-700">{Math.round((r.fetchRatio ?? 0) * 100)}%</td>
                        <td className={`p-1.5 text-right font-medium ${getScoreColor(r.score ?? null)}`}>{r.score != null ? `${Math.round(r.score)}%` : "—"}</td>
                        <td className="p-1.5 text-gray-500">
                          <DiscoveryFlagCell budgetExceeded={r.budgetExceeded} lowEvidence={r.lowEvidence} />
                        </td>
                        <td className="p-1.5 text-center">
                          <button
                            onClick={() => rerunDiscoveryMutation.mutate([r.id])}
                            disabled={rerunDiscoveryMutation.isPending}
                            className="px-1.5 py-0.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                            title="Re-run discovery + analysis for this company"
                          >
                            Re-run
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Low Document Discovery — low tier (amber) */}
      {lowDiscRows.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-amber-600" />
              <span className="text-sm font-semibold text-amber-900">
                Low Retrieval Rate — {lowDiscRows.length} compan{lowDiscRows.length !== 1 ? "ies" : "y"}
              </span>
              <span className="text-xs text-amber-600">
                Documents were found but under {Math.round((lowDiscovery?.thresholds?.lowDiscoveryRatio ?? 0.7) * 100)}% could be retrieved — re-running retries the un-fetched documents
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => rerunDiscoveryMutation.mutate(lowDiscRows.map((r: any) => r.id))}
                disabled={rerunDiscoveryMutation.isPending}
                className="px-2 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
              >
                Re-run all ({lowDiscRows.length})
              </button>
              <button
                onClick={() => setLowDiscExpanded((v) => !v)}
                className="text-xs text-amber-700 underline hover:text-amber-900"
              >
                {lowDiscExpanded ? "Collapse" : "Expand"}
              </button>
            </div>
          </div>

          {lowDiscExpanded && (
            <div className="mt-3">
              {selectedLowDiscIds.size > 0 && (
                <div className="flex items-center gap-3 mb-2 p-2 bg-amber-100 rounded">
                  <span className="text-xs font-medium text-amber-800">{selectedLowDiscIds.size} selected</span>
                  <button
                    onClick={() => rerunDiscoveryMutation.mutate(Array.from(selectedLowDiscIds))}
                    disabled={rerunDiscoveryMutation.isPending}
                    className="px-2 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                  >
                    Re-run selected
                  </button>
                  <button
                    onClick={() => setSelectedLowDiscIds(new Set())}
                    className="px-2 py-1 text-xs text-amber-600 hover:text-amber-800"
                  >
                    Clear
                  </button>
                </div>
              )}

              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-amber-100 sticky top-0">
                    <tr>
                      <th className="p-1.5 text-left">
                        <input
                          type="checkbox"
                          checked={selectedLowDiscIds.size === lowDiscRows.length && lowDiscRows.length > 0}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedLowDiscIds(new Set(lowDiscRows.map((r: any) => r.id)));
                            else setSelectedLowDiscIds(new Set());
                          }}
                        />
                      </th>
                      <th className="p-1.5 text-left text-amber-800">Company</th>
                      <th className="p-1.5 text-left text-amber-800">Sector</th>
                      <th className="p-1.5 text-left text-amber-800">Country</th>
                      <th className="p-1.5 text-right text-amber-800">Fetched / Discovered</th>
                      <th className="p-1.5 text-right text-amber-800" title="Fraction of discovered documents that were actually downloaded (fetched ÷ discovered).">Fetch ratio</th>
                      <th className="p-1.5 text-right text-amber-800" title="Company's overall framework score (same figure shown in Results).">Score</th>
                      <th className="p-1.5 text-left text-amber-800">Flags</th>
                      <th className="p-1.5 text-center text-amber-800">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lowDiscRows.map((r: any) => (
                      <tr key={r.id} className={`border-t border-amber-100 ${selectedLowDiscIds.has(r.id) ? "bg-amber-100" : "hover:bg-amber-50"}`}>
                        <td className="p-1.5">
                          <input
                            type="checkbox"
                            checked={selectedLowDiscIds.has(r.id)}
                            onChange={(e) => {
                              const next = new Set(selectedLowDiscIds);
                              if (e.target.checked) next.add(r.id);
                              else next.delete(r.id);
                              setSelectedLowDiscIds(next);
                            }}
                          />
                        </td>
                        <td className="p-1.5 font-medium text-gray-900">
                          <button onClick={() => onViewCompany(r.id)} className="hover:underline text-left">{r.name}</button>
                        </td>
                        <td className="p-1.5 text-gray-600">{r.sector || "—"}</td>
                        <td className="p-1.5 text-gray-600">{r.country || "—"}</td>
                        <td className="p-1.5 text-right text-gray-700">{r.documentsFetched} / {r.documentsDiscovered}</td>
                        <td className="p-1.5 text-right font-bold text-amber-700">{Math.round((r.fetchRatio ?? 0) * 100)}%</td>
                        <td className={`p-1.5 text-right font-medium ${getScoreColor(r.score ?? null)}`}>{r.score != null ? `${Math.round(r.score)}%` : "—"}</td>
                        <td className="p-1.5 text-gray-500">
                          <DiscoveryFlagCell budgetExceeded={r.budgetExceeded} lowEvidence={r.lowEvidence} critical={r.critical} />
                        </td>
                        <td className="p-1.5 text-center">
                          <button
                            onClick={() => rerunDiscoveryMutation.mutate([r.id])}
                            disabled={rerunDiscoveryMutation.isPending}
                            className="px-1.5 py-0.5 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                            title="Re-run discovery + analysis for this company"
                          >
                            Re-run
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Batch Progress */}
      {batchStatus?.running && (() => {
        // Prefer the honest activeRun summary; fall back to legacy flat fields.
        const run = batchStatus.activeRun;
        const isReexam = run?.kind === "reexam";
        const total = run?.total ?? batchStatus.total ?? 0;
        const completed = run?.completed ?? batchStatus.completed ?? 0;
        const failed = run?.failed ?? batchStatus.failed ?? 0;
        const inFlight = run?.inFlight ?? 0;
        const pending = run?.pending ?? 0;
        const done = completed + failed;
        const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
        const started = formatStarted(run?.startedAt);
        const eta = formatEta(run?.etaSeconds);
        const title = isReexam ? "Re-examination running" : "Batch analysis running";
        return (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
              <span className="text-sm font-medium text-blue-800">
                {title}{total > 1 ? `: ${completed}/${total} completed` : ""}
                {failed > 0 && `, ${failed} failed`}
              </span>
            </div>
            <button
              onClick={() => cancelBatchMutation.mutate()}
              className="flex items-center gap-1 px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200"
            >
              <Square className="w-3 h-3" /> Cancel
            </button>
          </div>
          {total > 1 && (
            <div className="w-full bg-blue-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-blue-700 mt-1.5">
            {started && <span>{started}</span>}
            {eta && <span className="font-medium">{eta}</span>}
            <span>{inFlight} processing{pending > 0 ? ` · ${pending} queued` : ""}</span>
          </div>
          {batchStatus.currentCompany && (
            <p className="text-xs text-blue-600 mt-1">Currently: {batchStatus.currentCompany}</p>
          )}
        </div>
        );
      })()}

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
              {activeFramework ? (
                <option value="">{activeFramework.name} (active)</option>
              ) : (
                // No active framework: show a real placeholder so the selector
                // isn't silently empty — the user must explicitly pick one.
                <option value="" disabled>Select a framework…</option>
              )}
              {frameworks.filter((f: any) => !f.isActive).map((f: any) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 items-center">
            {/* Primary action — single prominent Analyze button. */}
            <button
              onClick={handleAnalyze}
              disabled={batchStatus?.running || companies.length === 0}
              className="flex items-center gap-1.5 px-5 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title={`Analyze ${selectedList ? "selected list" : "all companies"} with ${effectiveFrameworkName || "active framework"} (full discovery + scoring)`}
            >
              <Play className="w-4 h-4" /> Analyze
            </button>
            {/* Secondary run actions grouped behind a More menu to declutter. */}
            <div className="relative" ref={moreMenuRef}>
              <button
                type="button"
                onClick={() => setMoreMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                className="flex items-center gap-1 px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                title="More actions"
              >
                <MoreHorizontal className="w-4 h-4" /> More
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${moreMenuOpen ? "rotate-180" : ""}`} />
              </button>
              {moreMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 mt-1 min-w-[15rem] rounded-md border border-gray-200 bg-white shadow-lg py-1 z-50"
                >
                  <button
                    role="menuitem"
                    onClick={() => { setMoreMenuOpen(false); handleRescore(); }}
                    disabled={batchStatus?.running || companies.length === 0}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Re-score using existing evidence (no re-fetch — deterministic, fast, cheap)"
                  >
                    <RotateCcw className="w-4 h-4 text-green-600" /> Re-score (no re-fetch)
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setMoreMenuOpen(false); handleReset(); }}
                    disabled={batchStatus?.running || companies.length === 0}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-left text-amber-700 hover:bg-amber-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={selectedList ? "Reset all companies in selected list (clear scores, keep cached documents)" : "Reset all companies (clear scores, keep cached documents)"}
                  >
                    <RotateCcw className="w-4 h-4" /> {selectedList ? "Reset List" : "Reset All"}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      const target = selectedList
                        ? `all companies in "${lists.find((l: any) => l.id === selectedList)?.name || "this list"}"`
                        : `ALL ${companies.length} companies`;
                      if (confirm(`FULL RESET ${target}?\n\nThis will purge ALL documents (including previously fetched ones), scores, and diagnostics. Every company will start from scratch on next analysis.`)) {
                        if (selectedList) {
                          fullResetListMutation.mutate(selectedList);
                        } else {
                          fullResetAllMutation.mutate();
                        }
                      }
                    }}
                    disabled={batchStatus?.running || companies.length === 0}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-left text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={selectedList ? "Full reset: purge ALL documents and start from scratch" : "Full reset: purge ALL documents for all companies"}
                  >
                    <Trash2 className="w-4 h-4" /> Full Reset
                  </button>
                  <div className="my-1 border-t border-gray-100" />
                  <button
                    role="menuitem"
                    onClick={() => { setMoreMenuOpen(false); handleExport(); }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-100"
                    title="Export companies as CSV"
                  >
                    <Download className="w-4 h-4" /> Export CSV
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {/* Off-peak scheduling toggle */}
        <div className="flex items-center gap-3 mt-3">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={offPeakOnly}
              onChange={(e) => setOffPeakOnly(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">
              {offPeakOnly ? "Run during off-peak only" : "Run now"}
            </span>
          </label>
          {offPeakOnly && (
            <span className="text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded">
              50% cheaper — jobs deferred to off-peak hours (outside 01:00-04:00 &amp; 06:00-10:00 UTC)
            </span>
          )}
        </div>
        {effectiveFrameworkName && (
          <p className="text-xs text-gray-500 mt-2">
            Will analyze {selectedList ? "companies in selected list" : `all ${stats.total} companies`} using{" "}
            <strong>{effectiveFrameworkName}</strong>
            {offPeakOnly && <span className="text-green-600"> (off-peak scheduling enabled)</span>}
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
      {fullResetListMutation.isSuccess && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <Trash2 className="w-4 h-4 text-red-600" />
          <span className="text-sm text-red-700">
            Full reset complete. {(fullResetListMutation.data as any)?.resetCount} companies purged (all documents removed).
          </span>
        </div>
      )}
      {fullResetAllMutation.isSuccess && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <Trash2 className="w-4 h-4 text-red-600" />
          <span className="text-sm text-red-700">
            Full reset complete. {(fullResetAllMutation.data as any)?.resetCount} companies purged (all documents removed).
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
          <p className="text-xs text-gray-400 mb-4">{scoreDistribution.total} of {selectedList ? listFilteredCompanies.length : stats.total} companies scored</p>
          <div className="flex items-end gap-1" style={{ height: "160px" }}>
            {scoreDistribution.buckets.map((bucket) => (
              <div key={bucket.label} className="flex-1 flex flex-col items-center justify-end h-full">
                <span className="text-xs text-gray-600 mb-1">{bucket.count > 0 ? bucket.count : ""}</span>
                <div
                  className="w-full bg-blue-500 rounded-t transition-all"
                  style={{
                    height: bucket.count > 0 ? `${Math.max((bucket.count / maxBucketCount) * 100, 3)}%` : "0%",
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
          {/* Export moved into the run bar's "More" menu (secondary action). */}
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

      {/* Company Table (collapsible via progressive disclosure) */}
      <div className="bg-white rounded-lg border overflow-hidden">
        <button
          type="button"
          onClick={() => setTableExpanded((v) => !v)}
          aria-expanded={tableExpanded}
          className="flex w-full items-center justify-between px-4 py-3 text-left border-b bg-gray-50 hover:bg-gray-100"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-gray-700">
            {tableExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            Companies
            <span className="text-xs font-normal text-gray-400">
              ({filteredCompanies.length}{search ? ` of ${companies.length}` : ""})
            </span>
          </span>
          <span className="text-xs text-gray-400">{tableExpanded ? "Hide" : "Show"}</span>
        </button>
        {tableExpanded && (
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
        )}
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
