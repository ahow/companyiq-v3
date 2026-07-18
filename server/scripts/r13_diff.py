#!/usr/bin/env python3
"""
Authoritative r12 -> r13 verdict diff.
  Baseline (r12) = analysis_results snapshot id=85 (the state the reviewer evaluated).
  r13            = current measure_scores rows (latest per company/measure) after the
                   v3k-r13 deploy + cohort re-run.

Emits full per-measure diff + flips view + targeted check of reviewer-flagged measures.
Columns: companyId, companyName, measureId, r12Verdict, r13Verdict, r12Conf, r13Conf,
         r12Quotes, r13Quotes, r12SourceUrls, r13SourceUrls.
"""
import psycopg2, json, csv
DB = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(DB); cur = conn.cursor()
SNAP_R12 = 85

COMPANIES = [(853,"Amazon"),(552,"Oracle"),(1918,"Meta"),(1312,"NVIDIA"),(553,"Microsoft"),
             (420,"Salesforce"),(2063,"Alphabet"),(866,"Apple"),(2412,"Tesla"),(1914,"360 Security")]
# 360 Security (1914) may still be analyzing; included only if it has fresh r13 rows.

def load_snapshot(rid):
    cur.execute("SELECT results_data FROM analysis_results WHERE id=%s", (rid,))
    d = cur.fetchone()[0]
    data = json.loads(d) if isinstance(d, str) else d
    return {c["companyId"]: {m["measureId"]: m for m in c.get("measureScores", [])} for c in data}

r12 = load_snapshot(SNAP_R12)

def load_r13(cid):
    # latest row per measure_id for this company
    cur.execute("""
        SELECT DISTINCT ON (measure_id) measure_id, verdict, confidence, quotes, score, created_at
        FROM measure_scores WHERE company_id=%s AND framework_id=7
        ORDER BY measure_id, created_at DESC
    """, (cid,))
    out = {}
    for mid, verdict, conf, quotes, score, ts in cur.fetchall():
        q = quotes if isinstance(quotes, list) else (json.loads(quotes) if quotes else [])
        out[mid] = {"verdict": verdict, "confidence": conf, "quotes": q, "score": score, "ts": ts}
    return out

def info_snap(m):
    if not m: return ("MISSING","",0,"")
    urls=[q.get("sourceUrl","") for q in m.get("quotes",[])]
    return (m.get("verdict"), m.get("confidence"), len(m.get("quotes",[])), " ; ".join(u for u in urls if u))

def info_r13(m):
    if not m: return ("MISSING","",0,"")
    urls=[q.get("sourceUrl","") for q in m.get("quotes",[])]
    return (m.get("verdict"), m.get("confidence"), len(m.get("quotes",[])), " ; ".join(u for u in urls if u))

rows=[]; flips=[]
for cid,name in COMPANIES:
    b = r12.get(cid, {})
    cur.execute("SELECT max(created_at) FROM measure_scores WHERE company_id=%s AND framework_id=7", (cid,))
    latest = cur.fetchone()[0]
    # Only treat as r13 if fresh (after the r13 run start ~2026-06-20 23:50)
    import datetime
    fresh = latest is not None and latest > datetime.datetime(2026,6,20,23,50,0)
    cur13 = load_r13(cid) if fresh else {}
    for mid in sorted(set(b)|set(cur13)):
        v12,c12,q12,u12 = info_snap(b.get(mid))
        v13,c13,q13,u13 = info_r13(cur13.get(mid))
        row={"companyId":cid,"companyName":name,"measureId":mid,
             "r12Verdict":v12,"r13Verdict":v13,"r12Conf":c12,"r13Conf":c13,
             "r12Quotes":q12,"r13Quotes":q13,"r12SourceUrls":u12,"r13SourceUrls":u13,
             "r13Fresh":fresh}
        rows.append(row)
        if fresh and v12!=v13 and v13!="MISSING":
            flips.append(row)

cols=["companyId","companyName","measureId","r12Verdict","r13Verdict","r12Conf","r13Conf",
      "r12Quotes","r13Quotes","r12SourceUrls","r13SourceUrls"]
with open("/home/ubuntu/companyiq-v3/r13_full_diff.csv","w",newline="") as f:
    w=csv.DictWriter(f, fieldnames=cols); w.writeheader()
    for r in rows: w.writerow({k:r[k] for k in cols})
with open("/home/ubuntu/companyiq-v3/r13_flips.csv","w",newline="") as f:
    w=csv.DictWriter(f, fieldnames=cols); w.writeheader()
    for r in flips: w.writerow({k:r[k] for k in cols})
json.dump(rows, open("/home/ubuntu/companyiq-v3/r13_full_diff.json","w"), indent=2, default=str)

print(f"Rows: {len(rows)} | r12->r13 flips (fresh only): {len(flips)}")
print("\n=== Reviewer-flagged measures (r12 -> r13) ===")
FLAGGED=[(553,"3.1a"),(553,"7.1"),(553,"4.3"),(2063,"1.1a"),(1312,"4.2"),(1312,"4.3"),(853,"9.2")]
for cid,pfx in FLAGGED:
    nm=dict(COMPANIES)[cid]
    b=r12.get(cid,{}); cur13=load_r13(cid)
    bk=next((k for k in b if k.startswith(pfx)),None)
    rk=next((k for k in cur13 if k.startswith(pfx)),None)
    v12,c12,q12,_=info_snap(b.get(bk)); v13,c13,q13,_=info_r13(cur13.get(rk))
    print(f"  {nm:10s} {pfx:5s}: r12={v12}/{c12}/{q12}q  ->  r13={v13}/{c13}/{q13}q")

print("\n=== All fresh flips ===")
for r in flips:
    print(f"  {r['companyName']:11s} {r['measureId']:38s} {r['r12Verdict']}/{r['r12Quotes']}q -> {r['r13Verdict']}/{r['r13Quotes']}q")
cur.close(); conn.close()
