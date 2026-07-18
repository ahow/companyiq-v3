#!/usr/bin/env python3
import json, csv
data = json.load(open("/home/ubuntu/companyiq-v3/verdict_diff_adjudicated.json"))

def short(cites):
    parts=[]
    for c in cites:
        parts.append(f"[{c['cls']}] {c.get('url') or ''}")
    # dedupe preserve order
    seen=set(); out=[]
    for p in parts:
        if p not in seen:
            seen.add(p); out.append(p)
    return " | ".join(out)

with open("/home/ubuntu/companyiq-v3/verdict_diff.csv","w",newline="") as f:
    w=csv.writer(f)
    w.writerow(["company","measureId","title","category","v3j_verdict","v3k_verdict",
                "classification","reason","v3j_sources","v3k_sources"])
    for r in data:
        w.writerow([r["company"], r["measureId"], r["title"], r["category"],
                    r["v3j_verdict"], r["v3k_verdict"], r["classification"], r["reason"],
                    short(r["v3j_cites"]), short(r["v3k_cites"])])
print("wrote verdict_diff.csv with", len(data), "rows")

# company-level reconciliation table
import psycopg2
DB=open("/tmp/dburl.txt").read().strip()
conn=psycopg2.connect(DB);cur=conn.cursor()
def load(rid):
    cur.execute("SELECT results_data FROM analysis_results WHERE id=%s",(rid,))
    d=cur.fetchone()[0]; return json.loads(d) if isinstance(d,str) else d
j={c["companyId"]:c for c in load(72)}; k={c["companyId"]:c for c in load(85)}
companies=[(853,"Amazon"),(552,"Oracle"),(1918,"Meta"),(1312,"NVIDIA"),(553,"Microsoft"),
           (420,"Salesforce"),(2063,"Alphabet"),(866,"Apple"),(2412,"Tesla"),(1914,"360 Security")]
with open("/home/ubuntu/companyiq-v3/score_reconciliation.csv","w",newline="") as f:
    w=csv.writer(f)
    w.writerow(["company","v3j_score","v3k_score","delta","v3j_met","v3k_met",
                "yes_to_nonyes","nonyes_to_yes","enforced","resample","improved","collateral"])
    for cid,name in companies:
        if cid not in j or cid not in k: continue
        crs=[r for r in data if r["companyId"]==cid]
        y2n=sum(1 for r in crs if r["v3j_verdict"]=="Yes" and r["v3k_verdict"]!="Yes")
        n2y=sum(1 for r in crs if r["v3j_verdict"]!="Yes" and r["v3k_verdict"]=="Yes")
        enf=sum(1 for r in crs if r["classification"]=="ENFORCED")
        res=sum(1 for r in crs if r["classification"]=="RESAMPLE")
        imp=sum(1 for r in crs if r["classification"]=="IMPROVED")
        col=sum(1 for r in crs if r["classification"]=="COLLATERAL?")
        w.writerow([name, j[cid]["totalScore"], k[cid]["totalScore"],
                    k[cid]["totalScore"]-j[cid]["totalScore"],
                    j[cid]["measuresMetCount"], k[cid]["measuresMetCount"],
                    y2n,n2y,enf,res,imp,col])
print("wrote score_reconciliation.csv")
cur.close();conn.close()
