import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState, useMemo, Fragment } from "react";
import { Globe, Info, ExternalLink, CheckCircle2, ShieldQuestion, Boxes } from "lucide-react";

// ─── Source Domains review page ──────────────────────────────────────────────
// Human-in-the-loop overrides for the provenance classifier. Andy reviews
// registrable domains (eTLD+1) that surfaced in the THIRD-PARTY corpus and marks
// each one:
//   • "Primary-eligible" → the domain becomes eligible like a recognised
//     IR/regulator host, BUT the document must STILL pass the three-tier
//     identity check for the specific company before it is treated as issuer.
//     It is NOT an unconditional promotion.
//   • "Third-party" (default) → silence it (current behaviour).
// Decisions are workspace-scoped and apply across ALL frameworks and ALL future
// runs. An empty policy table = zero behaviour change.

type SuggestedBucket = "recognised_host_identity_miss" | "known_aggregator" | "unrecognised_host";
type Decision = "primary" | "third_party";

interface Candidate {
  registrableDomain: string;
  docCount: number;
  companyCount: number;
  exampleUrls: string[];
  suggestedBucket: SuggestedBucket;
  currentDecision: Decision;
}

const BUCKET_META: Record<SuggestedBucket, { label: string; hint: string; cls: string; Icon: typeof Globe }> = {
  recognised_host_identity_miss: {
    label: "Recognised host · identity miss",
    hint: "Host is a known IR/regulator platform, but the document failed the company identity check. A likely candidate to approve.",
    cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
    Icon: ShieldQuestion,
  },
  unrecognised_host: {
    label: "Unrecognised host",
    hint: "Host is not in any recognised issuer/IR/regulator list. May be a genuine primary document on an unknown platform — worth reviewing.",
    cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
    Icon: Globe,
  },
  known_aggregator: {
    label: "Known aggregator",
    hint: "A known third-party aggregator/news host. Usually leave as Third-party.",
    cls: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
    Icon: Boxes,
  },
};

const BUCKET_ORDER: SuggestedBucket[] = ["recognised_host_identity_miss", "unrecognised_host", "known_aggregator"];

export default function SourceDomainsPage() {
  const queryClient = useQueryClient();
  const [bucketFilter, setBucketFilter] = useState<SuggestedBucket | "all">("all");
  const [decisionFilter, setDecisionFilter] = useState<Decision | "all">("all");
  const [search, setSearch] = useState("");
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);
  // Local optimistic overlay of decisions keyed by registrable domain.
  const [pendingDecision, setPendingDecision] = useState<Record<string, Decision>>({});

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["domainPolicyCandidates"],
    queryFn: () => api.getDomainPolicyCandidates(500),
  });

  const upsertMutation = useMutation({
    mutationFn: (vars: { registrableDomain: string; decision: Decision }) =>
      api.upsertDomainPolicy({ registrableDomain: vars.registrableDomain, decision: vars.decision }),
    onSuccess: () => {
      // Refresh candidates (currentDecision) + the dashboard's affected list.
      queryClient.invalidateQueries({ queryKey: ["domainPolicyCandidates"] });
      queryClient.invalidateQueries({ queryKey: ["affectedCompanies"] });
    },
    onError: (err: any, vars) => {
      // Roll back the optimistic overlay for this row.
      setPendingDecision((prev) => {
        const next = { ...prev };
        delete next[vars.registrableDomain];
        return next;
      });
      alert(`Could not save decision for ${vars.registrableDomain}: ${err.message}`);
    },
  });

  const candidates: Candidate[] = data?.candidates ?? [];
  const total: number = data?.total ?? 0;

  const decisionOf = (c: Candidate): Decision => pendingDecision[c.registrableDomain] ?? c.currentDecision;

  const counts = useMemo(() => {
    const byBucket: Record<string, number> = {};
    let primaries = 0;
    for (const c of candidates) {
      byBucket[c.suggestedBucket] = (byBucket[c.suggestedBucket] ?? 0) + 1;
      if (decisionOf(c) === "primary") primaries++;
    }
    return { byBucket, primaries };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, pendingDecision]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return candidates.filter((c) => {
      if (bucketFilter !== "all" && c.suggestedBucket !== bucketFilter) return false;
      if (decisionFilter !== "all" && decisionOf(c) !== decisionFilter) return false;
      if (q && !c.registrableDomain.toLowerCase().includes(q)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, bucketFilter, decisionFilter, search, pendingDecision]);

  const setDecision = (c: Candidate, decision: Decision) => {
    if (decisionOf(c) === decision) return;
    setPendingDecision((prev) => ({ ...prev, [c.registrableDomain]: decision }));
    upsertMutation.mutate({ registrableDomain: c.registrableDomain, decision });
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center">
          <Globe className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Source Domains</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Review domains that appeared in the third-party corpus and approve genuine primary-document hosts.
          </p>
        </div>
      </div>

      {/* Explainer */}
      <div className="flex gap-3 rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-900/50 dark:bg-blue-900/20 p-4">
        <Info className="w-5 h-5 text-blue-600 dark:text-blue-300 shrink-0 mt-0.5" />
        <div className="text-sm text-blue-900 dark:text-blue-100 space-y-1">
          <p>
            <strong>“Primary-eligible” is not an unconditional promotion.</strong> Marking a domain primary makes it
            eligible like a recognised IR/regulator host, but each document on it must still <strong>pass the
            three-tier identity check</strong> for the specific company before it counts as issuer (primary) disclosure.
            A different company’s document sitting on the same host will not be promoted.
          </p>
          <p>
            The default for every domain is <strong>Third-party</strong>. Decisions are saved per workspace, apply across
            all frameworks, and take effect on the next analysis run. Use the dashboard’s
            “Understated — pending domain review” section to re-score affected companies.
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setBucketFilter("all")}
          className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
            bucketFilter === "all"
              ? "bg-blue-600 text-white border-blue-600"
              : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700"
          }`}
        >
          All buckets ({candidates.length})
        </button>
        {BUCKET_ORDER.map((b) => {
          const meta = BUCKET_META[b];
          return (
            <button
              key={b}
              onClick={() => setBucketFilter(b)}
              title={meta.hint}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                bucketFilter === b
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700"
              }`}
            >
              {meta.label} ({counts.byBucket[b] ?? 0})
            </button>
          );
        })}
        <div className="h-5 w-px bg-gray-300 dark:bg-gray-700 mx-1" />
        <select
          value={decisionFilter}
          onChange={(e) => setDecisionFilter(e.target.value as any)}
          className="px-2 py-1.5 rounded-md text-xs border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
        >
          <option value="all">All decisions</option>
          <option value="primary">Primary-eligible</option>
          <option value="third_party">Third-party</option>
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by domain…"
          className="px-3 py-1.5 rounded-md text-xs border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 w-48"
        />
        <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
          {counts.primaries} marked primary-eligible · {total} domains total
        </span>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-500 dark:text-gray-400">Loading source domains…</div>
        ) : isError ? (
          <div className="p-8 text-center text-sm text-red-600">Failed to load: {(error as any)?.message}</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            {candidates.length === 0
              ? "No third-party source domains found yet. Run an analysis to populate this list."
              : "No domains match the current filters."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0">
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <th className="px-3 py-2">Domain</th>
                  <th className="px-3 py-2 text-right">Docs</th>
                  <th className="px-3 py-2 text-right">Companies</th>
                  <th className="px-3 py-2">Suggested bucket</th>
                  <th className="px-3 py-2">Examples</th>
                  <th className="px-3 py-2 text-center">Decision</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const meta = BUCKET_META[c.suggestedBucket];
                  const BucketIcon = meta.Icon;
                  const decision = decisionOf(c);
                  const isExpanded = expandedDomain === c.registrableDomain;
                  const saving = upsertMutation.isPending && upsertMutation.variables?.registrableDomain === c.registrableDomain;
                  return (
                    <Fragment key={c.registrableDomain}>
                      <tr
                        className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                      >
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                          <div className="flex items-center gap-2">
                            {decision === "primary" && <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />}
                            {c.registrableDomain}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300">{c.docCount}</td>
                        <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300">{c.companyCount}</td>
                        <td className="px-3 py-2">
                          <span
                            title={meta.hint}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${meta.cls}`}
                          >
                            <BucketIcon className="w-3 h-3" />
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {c.exampleUrls.length > 0 ? (
                            <button
                              onClick={() => setExpandedDomain(isExpanded ? null : c.registrableDomain)}
                              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              {isExpanded ? "Hide" : `Show ${c.exampleUrls.length} URL${c.exampleUrls.length !== 1 ? "s" : ""}`}
                            </button>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-center gap-1">
                            <div className="inline-flex rounded-md border border-gray-300 dark:border-gray-600 overflow-hidden">
                              <button
                                onClick={() => setDecision(c, "third_party")}
                                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                                  decision === "third_party"
                                    ? "bg-gray-700 text-white"
                                    : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                                }`}
                              >
                                Third-party
                              </button>
                              <button
                                onClick={() => setDecision(c, "primary")}
                                title="Eligible — the document must still pass the identity check for the company"
                                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                                  decision === "primary"
                                    ? "bg-green-600 text-white"
                                    : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                                }`}
                              >
                                Primary-eligible
                              </button>
                            </div>
                            {saving && <span className="text-[10px] text-gray-400">saving…</span>}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${c.registrableDomain}-ex`} className="bg-gray-50 dark:bg-gray-800/40">
                          <td colSpan={6} className="px-3 py-2">
                            <ul className="space-y-1">
                              {c.exampleUrls.map((u, i) => (
                                <li key={i} className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                                  <ExternalLink className="w-3 h-3 shrink-0 text-gray-400" />
                                  <a href={u} target="_blank" rel="noopener noreferrer" className="hover:underline break-all">
                                    {u}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
