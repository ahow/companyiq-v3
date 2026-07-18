#!/usr/bin/env python3
"""
Authoritative r12 -> r14 verdict diff (the deliverable artifact).
  Baseline (r12) = analysis_results snapshot id=85 (the state the v3k reviewer evaluated).
  r14            = current measure_scores rows (latest per company/measure) after the
                   v3k-r14 deploy + cohort re-run (batch 135).

Emits:
  - r14_full_diff.csv / .json : every measure row for all completed companies
  - r14_flips.csv             : only rows whose verdict changed r12 -> r14
Columns (per reviewer request): companyId, companyName, measureId, measureTitle,
  r12Verdict, r14Verdict, r12Conf, r14Conf, r12Quotes, r14Quotes,
  r12SourceUrls, r14SourceUrls, snapshotR12Id, runR14.
"""
import psycopg2, json, csv, datetime
DB = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(DB); cur = conn.cursor()
SNAP_R12 = 85
R14_AFTER = datetime.datetime(2026, 6, 21, 0, 30, 0)  # r14 batch 135 started ~00:31

COMPANIES = [(853,"Amazon"),(552,"Oracle"),(1918,"Meta"),(1312,"NVIDIA"),(553,"Microsoft"),
             (420,"Salesforce"),(2063,"Alphabet"),(866,"Apple"),(2412,"Tesla"),(1914,"360 Security")]

def load_snapshot(rid):
    cur.execute("SELECT results_data FROM analysis_results WHERE id=%s", (rid,))
    d = cur.fetchone()[0]
    data = json.loads(d) if isinstance(d, str) else d
    return {c["companyId"]: {m["measureId"]: m for m in c.get("measureScores", [])} for c in data}

r12 = load_snapshot(SNAP_R12)

def load_r14(cid):
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

def info(m):
    if not m: return ("MISSING","",0,"","")
    urls=[q.get("sourceUrl","") for q in m.get("quotes",[])]
    title=m.get("measureTitle") or m.get("title") or ""
    return (m.get("verdict"), m.get("confidence"), len(m.get("quotes",[])),
            " ; ".join(u for u in urls if u), title)

rows=[]; flips=[]; completed=[]
for cid,name in COMPANIES:
    b = r12.get(cid, {})
    cur.execute("SELECT max(created_at) FROM measure_scores WHERE company_id=%s AND framework_id=7", (cid,))
    latest = cur.fetchone()[0]
    fresh = latest is not None and latest > R14_AFTER
    if fresh: completed.append(name)
    cur14 = load_r14(cid) if fresh else {}
    for mid in sorted(set(b)|set(cur14)):
        v12,c12,q12,u12,t12 = info(b.get(mid))
        v14,c14,q14,u14,t14 = info(cur14.get(mid))
        row={"companyId":cid,"companyName":name,"measureId":mid,
             "measureTitle":t12 or t14,
             "r12Verdict":v12,"r14Verdict":v14,"r12Conf":c12,"r14Conf":c14,
             "r12Quotes":q12,"r14Quotes":q14,"r12SourceUrls":u12,"r14SourceUrls":u14,
             "snapshotR12Id":SNAP_R12,"runR14":"batch135"}
        rows.append(row)
        if fresh and v12!=v14 and v14!="MISSING":
            flips.append(row)

cols=["companyId","companyName","measureId","measureTitle","r12Verdict","r14Verdict",
      "r12Conf","r14Conf","r12Quotes","r14Quotes","r12SourceUrls","r14SourceUrls",
      "snapshotR12Id","runR14"]
base="/home/ubuntu/companyiq-v3/"
with open(base+"r14_full_diff.csv","w",newline="") as f:
    w=csv.DictWriter(f, fieldnames=cols); w.writeheader()
    for r in rows: w.writerow({k:r[k] for k in cols})
with open(base+"r14_flips.csv","w",newline="") as f:
    w=csv.DictWriter(f, fieldnames=cols); w.writeheader()
    for r in flips: w.writerow({k:r[k] for k in cols})
json.dump(rows, open(base+"r14_full_diff.json","w"), indent=2, default=str)

print(f"Completed (fresh r14) companies: {completed}")
print(f"Rows: {len(rows)} | r12->r14 flips (fresh only): {len(flips)}")

# Score reconciliation per completed company
print("\n=== Score reconciliation (r12 snapshot vs r14 live) ===")
for cid,name in COMPANIES:
    if name not in completed: continue
    cur.execute("SELECT total_score FROM companies WHERE id=%s",(cid,))
    live=cur.fetchone()[0]
    b=r12.get(cid,{})
    met12=sum(1 for m in b.values() if m.get("verdict")=="Yes")
    cur14=load_r14(cid)
    met14=sum(1 for m in cur14.values() if m.get("verdict")=="Yes")
    score12=sum(1 for m in b.values() if m.get("verdict")=="Yes")  # met proxy
    print(f"  {name:11s} r12 met={met12:2d}  ->  r14 met={met14:2d}  (r14 total_score={live})")

print("\n=== Reviewer-flagged measures (r12 -> r14) ===")
FLAGGED=[(553,"3.1a","Microsoft Board Q1"),(553,"7.1","Microsoft partnerships"),
         (2063,"1.1a","Alphabet strategic priority"),(1312,"4.2","NVIDIA"),(853,"9.2","Amazon (claimed fabricated)")]
for cid,pfx,lbl in FLAGGED:
    b=r12.get(cid,{}); cur14=load_r14(cid)
    bk=next((k for k in b if k.startswith(pfx)),None)
    rk=next((k for k in cur14 if k.startswith(pfx)),None)
    v12,c12,q12,_,_=info(b.get(bk)); v14,c14,q14,_,_=info(cur14.get(rk))
    print(f"  {lbl:32s} [{pfx}]: r12={v12}/{q12}q  ->  r14={v14}/{q14}q")

print("\n=== All fresh r12->r14 flips ===")
for r in sorted(flips, key=lambda x:(x['companyName'],x['measureId'])):
    print(f"  {r['companyName']:11s} {r['measureId']:40s} {r['r12Verdict']}/{r['r12Quotes']}q -> {r['r14Verdict']}/{r['r14Quotes']}q")
cur.close(); conn.close()
