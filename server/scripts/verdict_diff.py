#!/usr/bin/env python3
"""
Exact per-measure verdict diff between v3j (analysis_results id=72) and
v3k r12 (id=85). For every measure whose verdict changed, emit the v3j
citation(s) and v3k citation(s) so each flip can be adjudicated against
source provenance (mirror / 10-Q / DEF 14A / non-authoritative vs EDGAR primary).
"""
import psycopg2, json, re, csv
DB = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(DB); cur = conn.cursor()

def load(rid):
    cur.execute("SELECT results_data FROM analysis_results WHERE id=%s", (rid,))
    d = cur.fetchone()[0]
    return json.loads(d) if isinstance(d, str) else d

v3j = {c["companyId"]: c for c in load(72)}
v3k = {c["companyId"]: c for c in load(85)}

def ms_map(co):
    return {m["measureId"]: m for m in co.get("measureScores", [])}

def classify_url(url):
    """Classify a citation source URL by authority/provenance."""
    if not url: return "no-url"
    u = url.lower()
    # EDGAR primary
    if "sec.gov/archives/edgar" in u:
        # form-type hint from filename
        fn = u.rsplit("/",1)[-1]
        if re.search(r"def ?14a|proxy", u) or "def14a" in u:
            return "EDGAR-DEF14A-proxy"
        return "EDGAR-primary"
    if "sec.gov" in u:
        return "SEC-other"
    # known third-party mirrors of filings
    mirrors = ["stocklight.com","annualreports.com","last10k.com","sec.report",
               "bamsec.com","seclive","secdatabase.com","wsj.com/market-data",
               "investing.com","stockanalysis.com","wisesheets","moomoo","marketscreener"]
    if any(m in u for m in mirrors):
        return "third-party-mirror"
    # company IR / blog / press
    if any(k in u for k in ["/blog","/news","press-release","newsroom","/about","aboutamazon","blog.google"]):
        return "company-marketing"
    return "other-web"

def source_form(quote):
    """Infer document form type from quote.source label + url filename."""
    s = (quote.get("source") or "").lower()
    u = (quote.get("sourceUrl") or "").lower()
    if "10-q" in s or re.search(r"-20\d{6}\.htm", u) and "10-q" in s:
        return "10-Q"
    if "10-k" in s: return "10-K"
    if "def 14a" in s or "proxy" in s: return "DEF 14A"
    if "8-k" in s: return "8-K"
    return ""

rows = []
companies = [(853,"Amazon"),(552,"Oracle"),(1918,"Meta"),(1312,"NVIDIA"),
             (553,"Microsoft"),(420,"Salesforce"),(2063,"Alphabet"),
             (866,"Apple"),(2412,"Tesla"),(1914,"360 Security")]

for cid, name in companies:
    if cid not in v3j or cid not in v3k: 
        continue
    a = ms_map(v3j[cid]); b = ms_map(v3k[cid])
    for mid in sorted(set(a)|set(b)):
        ma = a.get(mid); mb = b.get(mid)
        va = ma["verdict"] if ma else "MISSING"
        vb = mb["verdict"] if mb else "MISSING"
        if va == vb:
            continue
        # gather citations
        def cite(m):
            if not m: return []
            out=[]
            for q in m.get("quotes",[]):
                out.append({
                    "source": q.get("source"),
                    "url": q.get("sourceUrl"),
                    "cls": classify_url(q.get("sourceUrl")),
                    "form": source_form(q),
                })
            return out
        ca = cite(ma); cb = cite(mb)
        rows.append({
            "company": name, "companyId": cid,
            "measureId": mid,
            "title": (ma or mb).get("title"),
            "category": (ma or mb).get("category"),
            "v3j_verdict": va, "v3k_verdict": vb,
            "v3j_score": ma.get("score") if ma else None,
            "v3k_score": mb.get("score") if mb else None,
            "v3j_cites": ca, "v3k_cites": cb,
        })

# write full JSON
with open("/home/ubuntu/companyiq-v3/verdict_diff.json","w") as f:
    json.dump(rows, f, indent=2)

# console summary
print(f"Total flipped measures across cohort: {len(rows)}\n")
for cid,name in companies:
    cr=[r for r in rows if r["companyId"]==cid]
    if not cr: continue
    y2n=[r for r in cr if r["v3j_verdict"]=="Yes" and r["v3k_verdict"]!="Yes"]
    n2y=[r for r in cr if r["v3j_verdict"]!="Yes" and r["v3k_verdict"]=="Yes"]
    print(f"{name}: {len(cr)} flips | Yes->non-Yes: {len(y2n)} | non-Yes->Yes: {len(n2y)}")

cur.close(); conn.close()
print("\nWrote /home/ubuntu/companyiq-v3/verdict_diff.json")
