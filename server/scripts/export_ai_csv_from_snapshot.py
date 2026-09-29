#!/usr/bin/env python3
"""
Rebuild the AI Governance (framework 7) full-portfolio CSV from the saved
analysis_results snapshot (results_data JSON), in the EXACT Results-page format,
with a belt-and-suspenders normalized-ISIN de-duplication pass.

Why snapshot, not live measure_scores: the live measure_scores table has been
overwritten by the current climate run (framework 6). The framework-7 results
survive only in analysis_results.results_data (per-company JSON written at
batch-finish time by saveAnalysisResultsForBatch).

CSV layout (per client/src/pages/ResultsPage.tsx handleExportCSV):
  base = [Company, ISIN, Sector, Country, Total Score (%), Measures Met,
          Measures Total, Coverage Level, Missing Tier 1 Sources]
  per measure (in measure order): Score(=verdict), Rationale(=evidenceSummary),
          Supporting Quote, Source Document, Source Link, Confidence
  final  = Source Documents
"""
import psycopg2, psycopg2.extras, csv, sys, json
from collections import OrderedDict


# --- Binary verdict normalization (mirror of shared/verdict.ts) -------------
# Partial collapses to No everywhere; abstain/error sentinels pass through.
# Kept in lock-step with the canonical TS helper at shared/verdict.ts.
def norm_verdict(v):
    if not isinstance(v, str):
        return "No"
    s = v.strip()
    if s == "":
        return "No"
    if s.lower() == "partial":
        return "No"
    return s


def is_met(verdict, score):
    v = norm_verdict(verdict)
    if v == "Yes":
        return True
    # blank/absent verdict -> fall back to numeric score (met iff score == 1)
    if not isinstance(verdict, str) or verdict.strip() == "":
        return score == 1
    return False

AR_ID = int(sys.argv[2]) if len(sys.argv) > 2 else 35
OUT = sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/companyiq-v3/CompanyIQ_AI_Governance_full_portfolio_dedup.csv"

url = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(url); conn.autocommit = True
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
cur.execute("SELECT framework_name, results_data FROM analysis_results WHERE id=%s", (AR_ID,))
row = cur.fetchone()
rd = row["results_data"]
if isinstance(rd, str):
    rd = json.loads(rd)
print(f"snapshot ar_id={AR_ID} '{row['framework_name']}' companies={len(rd)}")

# --- Canonical measure ordering: union across all companies, ordered by the
#     (category, then first-seen) so column order is stable and complete. ---
measure_order = OrderedDict()  # measureId -> title
for comp in rd:
    for m in comp.get("measureScores", []):
        mid = m.get("measureId")
        if mid is not None and mid not in measure_order:
            measure_order[mid] = (m.get("category") or "", m.get("title") or "")
# sort by (category, title) for deterministic column order
ordered_mids = sorted(measure_order.keys(),
                      key=lambda k: (measure_order[k][0], measure_order[k][1], str(k)))
measure_titles = [measure_order[k][1] for k in ordered_mids]
print(f"measures: {len(ordered_mids)}")

# --- De-duplicate companies on normalized ISIN (keep the higher-scoring /
#     more-complete row if a collision exists; snapshot showed 0, but be safe). ---
def norm_isin(x):
    return (x or "").strip().upper()

def completeness(comp):
    ms = comp.get("measureScores", [])
    answered = sum(1 for m in ms if (m.get("verdict") or "").lower() not in ("", "insufficient evidence", "abstain"))
    return (answered, comp.get("totalScore") or 0, len(comp.get("sourceDocuments") or []))

best = {}
no_isin_rows = []
for comp in rd:
    ni = norm_isin(comp.get("isin"))
    if not ni:
        no_isin_rows.append(comp)
        continue
    if ni not in best or completeness(comp) > completeness(best[ni]):
        best[ni] = comp
deduped = list(best.values()) + no_isin_rows
removed = len(rd) - len(deduped)
print(f"after ISIN dedup: {len(deduped)} rows (removed {removed} duplicate-ISIN rows)")

# stable row order: by company name
deduped.sort(key=lambda c: (c.get("companyName") or "").lower())

# --- Build header exactly like ResultsPage ---
base_headers = ["Company", "ISIN", "Sector", "Country", "Total Score (%)",
                "Measures Met", "Measures Total", "Coverage Level", "Missing Tier 1 Sources"]
header = list(base_headers)
for t in measure_titles:
    header += [f"{t} - Score", f"{t} - Rationale", f"{t} - Supporting Quote",
               f"{t} - Source Document", f"{t} - Source Link", f"{t} - Confidence"]
header += ["Source Documents"]

def first_quote(m):
    qs = m.get("quotes") or []
    if not qs:
        return ("", "", "")
    q = qs[0]
    return (q.get("text") or "", q.get("source") or "", q.get("sourceUrl") or "")

with open(OUT, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(header)
    for comp in deduped:
        ms_by_id = {m.get("measureId"): m for m in comp.get("measureScores", [])}
        missing = comp.get("missingTier1")
        if isinstance(missing, list):
            missing = "; ".join(str(x) for x in missing)
        # Recompute Total Score (%) and Measures Met from binary-normalized
        # measure scores (assessed = non-backfilled rows; met = is_met). This
        # keeps the snapshot export in lock-step with the binary scoring rules
        # (Partial counts as No, not met, not contributing).
        assessed = [m for m in comp.get("measureScores", []) if not m.get("backfilled")]
        bin_measures_met = sum(1 for m in assessed if is_met(m.get("verdict"), m.get("score")))
        bin_total_score = round(100 * bin_measures_met / len(assessed)) if assessed else ""
        rowv = [
            comp.get("companyName") or "",
            comp.get("isin") or "",
            comp.get("sector") or "",
            comp.get("country") or "",
            bin_total_score,
            bin_measures_met,
            comp.get("measuresTotalCount") if comp.get("measuresTotalCount") is not None else "",
            comp.get("coverageLevel") or "",
            missing or "",
        ]
        for mid in ordered_mids:
            m = ms_by_id.get(mid)
            if not m:
                rowv += ["", "", "", "", "", ""]
                continue
            # Supporting quote is only meaningful for a met (Yes) measure.
            if is_met(m.get("verdict"), m.get("score")):
                qt, qsrc, qurl = first_quote(m)
            else:
                qt, qsrc, qurl = ("", "", "")
            rowv += [
                norm_verdict(m.get("verdict")) if not m.get("backfilled") else (m.get("verdict") or ""),
                m.get("evidenceSummary") or "",
                qt, qsrc, qurl,
                m.get("confidence") if m.get("confidence") is not None else "",
            ]
        docs = comp.get("sourceDocuments") or []
        doc_str = " | ".join(
            f"{(d.get('title') or '').strip()} <{(d.get('url') or '').strip()}>" for d in docs
        )
        rowv += [doc_str]
        w.writerow(rowv)

print(f"WROTE {OUT}")
print(f"rows={len(deduped)} cols={len(header)}")
cur.close(); conn.close()
