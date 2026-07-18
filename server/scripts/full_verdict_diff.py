#!/usr/bin/env python3
"""
Complete, reproducible verdict diff for ALL 34 measures x 10 companies.
Columns (reviewer Fix 5.3 spec):
 companyId, companyName, measureId, v3jVerdict, v3kVerdict, v3jConfidence, v3kConfidence,
 v3jQuoteCount, v3kQuoteCount, v3jSourceUrls, v3kSourceUrls, snapshotIdV3j, snapshotIdV3k
Emits every row (changed or not) plus a flips-only view.
"""
import psycopg2, json, csv
DB = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(DB); cur = conn.cursor()
SNAP_V3J, SNAP_V3K = 72, 85

def load(rid):
    cur.execute("SELECT results_data FROM analysis_results WHERE id=%s", (rid,))
    d = cur.fetchone()[0]
    return json.loads(d) if isinstance(d,str) else d

v3j = {c["companyId"]: c for c in load(SNAP_V3J)}
v3k = {c["companyId"]: c for c in load(SNAP_V3K)}

def msmap(co): return {m["measureId"]: m for m in co.get("measureScores",[])}

def info(m):
    if not m: return ("MISSING","",0,"")
    urls = [q.get("sourceUrl","") for q in m.get("quotes",[])]
    return (m.get("verdict"), m.get("confidence"), len(m.get("quotes",[])), " ; ".join(urls))

companies = [(853,"Amazon"),(552,"Oracle"),(1918,"Meta"),(1312,"NVIDIA"),(553,"Microsoft"),
             (420,"Salesforce"),(2063,"Alphabet"),(866,"Apple"),(2412,"Tesla"),(1914,"360 Security")]

rows=[]
for cid,name in companies:
    if cid not in v3j or cid not in v3k: continue
    a=msmap(v3j[cid]); b=msmap(v3k[cid])
    for mid in sorted(set(a)|set(b)):
        va,ca,qa,ua = info(a.get(mid))
        vb,cb,qb,ub = info(b.get(mid))
        rows.append({
            "companyId":cid,"companyName":name,"measureId":mid,
            "v3jVerdict":va,"v3kVerdict":vb,"v3jConfidence":ca,"v3kConfidence":cb,
            "v3jQuoteCount":qa,"v3kQuoteCount":qb,"v3jSourceUrls":ua,"v3kSourceUrls":ub,
            "snapshotIdV3j":SNAP_V3J,"snapshotIdV3k":SNAP_V3K,
            "changed": (va!=vb) or (ca!=cb) or (qa!=qb),
            "verdictChanged": va!=vb,
        })

cols=["companyId","companyName","measureId","v3jVerdict","v3kVerdict","v3jConfidence",
      "v3kConfidence","v3jQuoteCount","v3kQuoteCount","v3jSourceUrls","v3kSourceUrls",
      "snapshotIdV3j","snapshotIdV3k"]

with open("/home/ubuntu/companyiq-v3/full_verdict_diff.csv","w",newline="") as f:
    w=csv.DictWriter(f, fieldnames=cols); w.writeheader()
    for r in rows: w.writerow({k:r[k] for k in cols})

flips=[r for r in rows if r["verdictChanged"]]
with open("/home/ubuntu/companyiq-v3/full_verdict_diff_flips.csv","w",newline="") as f:
    w=csv.DictWriter(f, fieldnames=cols); w.writeheader()
    for r in flips: w.writerow({k:r[k] for k in cols})

json.dump(rows, open("/home/ubuntu/companyiq-v3/full_verdict_diff.json","w"), indent=2)

print(f"Total measure rows: {len(rows)} | verdict flips: {len(flips)} | any-change rows: {sum(1 for r in rows if r['changed'])}")
print("\nAll verdict flips:")
for r in flips:
    print(f"  {r['companyName']:13s} {r['measureId']:38s} {r['v3jVerdict']}/{r['v3jConfidence']}/{r['v3jQuoteCount']}q -> {r['v3kVerdict']}/{r['v3kConfidence']}/{r['v3kQuoteCount']}q")
cur.close(); conn.close()
