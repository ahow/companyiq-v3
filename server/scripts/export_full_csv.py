#!/usr/bin/env python3
"""
Generate the full-portfolio CSV for workspace 3 in the EXACT format produced by
the Results page (client/src/pages/ResultsPage.tsx -> handleExportCSV).

Row shape is rebuilt to match server/worker.ts saveAnalysisResultsForBatch:
  company fields + coverage + sourceDocuments + measureScores[{title, score,
  verdict, confidence, evidenceSummary, quotes[{text, source, sourceUrl}]}]

CSV layout (per ResultsPage):
  base = [Company, ISIN, Sector, Country, Total Score (%), Measures Met,
          Measures Total, Coverage Level, Missing Tier 1 Sources]
  per measure (in measure order): Score(=verdict), Rationale(=evidenceSummary),
          Supporting Quote, Source Document, Source Link, Confidence
  final  = Source Documents
"""
import psycopg2, psycopg2.extras, csv, sys

WORKSPACE_ID = 3
FRAMEWORK_ID = 7
OUT = sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/companyiq-v3/CompanyIQ_AI_Governance_full_portfolio.csv"

url = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(url); conn.autocommit = True
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

# 1) Canonical measure ordering for framework 7 (category_number, display_order),
#    derived from the most complete company so titles are stable.
cur.execute("""
  SELECT DISTINCT ON (measure_id) measure_id, title, category_number, display_order
  FROM measure_scores
  WHERE framework_id=%s
  ORDER BY measure_id, created_at DESC
""", (FRAMEWORK_ID,))
measures = cur.fetchall()
# order by category_number then display_order then title (stable)
def _key(m):
    return (m["category_number"] if m["category_number"] is not None else 999,
            m["display_order"] if m["display_order"] is not None else 999,
            m["title"] or "")
measures.sort(key=_key)
measure_titles = []
seen = set()
for m in measures:
    t = m["title"] or ""
    if t and t not in seen:
        seen.add(t); measure_titles.append(t)
print(f"{len(measure_titles)} measure columns")

# 2) All completed companies in workspace 3
cur.execute("""
  SELECT id, name, isin, sector, country, total_score,
         measures_met_count, measures_total_count, discovery_diagnostics
  FROM companies
  WHERE workspace_id=%s AND analysis_status='completed'
  ORDER BY name
""", (WORKSPACE_ID,))
companies = cur.fetchall()
print(f"{len(companies)} companies")

# 3) Preload all measure scores for ws3 (one query), grouped by company
cur.execute("""
  SELECT ms.company_id, ms.title, ms.score, ms.verdict, ms.confidence,
         ms.evidence_summary, ms.quotes
  FROM measure_scores ms
  JOIN companies c ON c.id = ms.company_id
  WHERE c.workspace_id=%s AND ms.framework_id=%s
""", (WORKSPACE_ID, FRAMEWORK_ID))
scores_by_company = {}
for r in cur.fetchall():
    scores_by_company.setdefault(r["company_id"], {})[r["title"]] = r

# 4) Preload fetched (ok) documents per company for Source Documents column + URL map
cur.execute("""
  SELECT d.company_id, d.url, d.title
  FROM documents d
  JOIN companies c ON c.id = d.company_id
  WHERE c.workspace_id=%s AND d.fetch_status='ok'
""", (WORKSPACE_ID,))
docs_by_company = {}
for r in cur.fetchall():
    docs_by_company.setdefault(r["company_id"], []).append({"url": r["url"], "title": r["title"] or r["url"]})

# Build headers (identical to ResultsPage)
base_headers = ["Company", "ISIN", "Sector", "Country", "Total Score (%)",
                "Measures Met", "Measures Total", "Coverage Level", "Missing Tier 1 Sources"]
measure_headers = []
for t in measure_titles:
    measure_headers += [f"{t} - Score", f"{t} - Rationale", f"{t} - Supporting Quote",
                        f"{t} - Source Document", f"{t} - Source Link", f"{t} - Confidence"]
headers = base_headers + measure_headers + ["Source Documents"]

def coverage_of(diag):
    d = diag or {}
    cov = (d.get("coverage") or {})
    return cov.get("coverageLevel", "unknown"), cov.get("missingTier1Types", []) or []

rows_out = []
for c in companies:
    cid = c["id"]
    cov_level, missing_t1 = coverage_of(c["discovery_diagnostics"])
    base_values = [
        c["name"] or "",
        c["isin"] or "",
        c["sector"] or "",
        c["country"] or "",
        c["total_score"] if c["total_score"] is not None else 0,
        c["measures_met_count"] if c["measures_met_count"] is not None else "",
        c["measures_total_count"] if c["measures_total_count"] is not None else "",
        cov_level or "unknown",
        "; ".join(missing_t1),
    ]

    cdocs = docs_by_company.get(cid, [])
    title_to_url = {}
    for d in cdocs:
        if d["title"] and d["url"]:
            title_to_url[d["title"].lower()] = d["url"]
        if d["url"]:
            title_to_url[d["url"].lower()] = d["url"]

    cscores = scores_by_company.get(cid, {})
    measure_values = []
    for t in measure_titles:
        ms = cscores.get(t)
        if ms:
            score = ms["score"] or 0
            verdict = ms["verdict"] or ("Yes" if score > 0 else "No")
            measure_values.append(verdict)                       # (i) Score = verdict
            measure_values.append(ms["evidence_summary"] or "")  # (ii) Rationale
            quotes = ms["quotes"] or []
            quote_texts = [q.get("text") for q in quotes if isinstance(q, dict) and q.get("text")]
            if score > 0 or verdict in ("Yes", "Partial"):
                measure_values.append(" | ".join([q for q in quote_texts if q]))
            else:
                measure_values.append("")
            # (iv) Source Document name(s) + (v) Source Link(s)
            source_names, source_links, seen_src = [], [], set()
            for q in quotes:
                if not isinstance(q, dict):
                    continue
                src = q.get("source")
                if not src:
                    continue
                k = src.lower()
                if k in seen_src:
                    continue
                seen_src.add(k)
                source_names.append(src)
                url = q.get("sourceUrl") or title_to_url.get(k, "")
                if not url:
                    mk = next((kk for kk in title_to_url if kk in k or k in kk), None)
                    url = title_to_url[mk] if mk else ""
                source_links.append(url)
            measure_values.append(" ; ".join(source_names))
            measure_values.append(" ; ".join(source_links))
            measure_values.append(ms["confidence"] or "Low")     # (vi) Confidence
        else:
            measure_values += ["", "", "", "", "", ""]

    source_docs = " ; ".join([f"{d['title'] or ''} [{d['url'] or ''}]" for d in cdocs])
    rows_out.append(base_values + measure_values + [source_docs])

with open(OUT, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
    w.writerow(headers)
    w.writerows(rows_out)

print(f"WROTE {OUT}")
print(f"rows={len(rows_out)} cols={len(headers)}")
cur.close(); conn.close()
