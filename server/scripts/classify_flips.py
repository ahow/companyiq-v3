#!/usr/bin/env python3
"""
Classify each r12->r14 flip:
  GRADER_VARIANCE  - the r14 verdict changed but the underlying source URLs are the
                     same/overlapping (the grader re-judged the same evidence).
  EVIDENCE_CHANGE  - the source URL set changed materially (different docs cited).
This quantifies how much of the churn is model run-to-run variance vs real evidence
movement, and confirms NONE of it is loss of an EDGAR-primary required source.
"""
import psycopg2, json
DB=open("/tmp/dburl.txt").read().strip()
conn=psycopg2.connect(DB); cur=conn.cursor()
SNAP=85
R14_AFTER="2026-06-21 00:30:00"

cur.execute("SELECT results_data FROM analysis_results WHERE id=%s",(SNAP,))
d=cur.fetchone()[0]; snap=json.loads(d) if isinstance(d,str) else d
r12={c["companyId"]:{m["measureId"]:m for m in c.get("measureScores",[])} for c in snap}

def load_r14(cid):
    cur.execute("""SELECT DISTINCT ON (measure_id) measure_id,verdict,quotes
                   FROM measure_scores WHERE company_id=%s AND framework_id=7
                   ORDER BY measure_id,created_at DESC""",(cid,))
    out={}
    for mid,v,q in cur.fetchall():
        ql=q if isinstance(q,list) else (json.loads(q) if q else [])
        out[mid]={"verdict":v,"quotes":ql}
    return out

def norm_urls(qs):
    s=set()
    for q in qs:
        u=(q.get("sourceUrl") or "").split("?")[0].split("#")[0].lower()
        if u: s.add(u)
    return s

COMP=[(853,"Amazon"),(552,"Oracle"),(1918,"Meta"),(1312,"NVIDIA"),(553,"Microsoft"),
      (420,"Salesforce"),(2063,"Alphabet"),(866,"Apple"),(2412,"Tesla")]

import collections
tally=collections.Counter(); detail=[]
EDGAR=("sec.gov",)
for cid,name in COMP:
    b=r12.get(cid,{}); n=load_r14(cid)
    for mid in set(b)&set(n):
        v12=b[mid].get("verdict"); v14=n[mid].get("verdict")
        if v12==v14: continue
        u12=norm_urls(b[mid].get("quotes",[])); u14=norm_urls(n[mid].get("quotes",[]))
        overlap=u12&u14
        # Did r14 LOSE an EDGAR-primary url that r12 had and not replace with another EDGAR-primary?
        edgar12={u for u in u12 if any(e in u for e in EDGAR)}
        edgar14={u for u in u14 if any(e in u for e in EDGAR)}
        lost_edgar = bool(edgar12 - edgar14) and not edgar14
        if not u12 and not u14:
            cls="VERDICT_ONLY_NO_QUOTES"   # 0q both sides, pure grader label
        elif overlap or (u12 and u14 and (u12==u14)):
            cls="GRADER_VARIANCE"          # same source(s), re-judged
        elif u12 and not u14:
            cls="GRADER_DROPPED_TO_0Q"     # had quotes, now none (grader chose not to quote)
        elif u14 and not u12:
            cls="GRADER_GAINED_QUOTES"     # gained evidence (improvement)
        else:
            cls="EVIDENCE_CHANGE"          # different source sets
        tally[cls]+=1
        detail.append((name,mid,f"{v12}->{v14}",cls,"LOST_EDGAR" if lost_edgar else ""))

print("=== Flip classification (r12 -> r14, 9 US filers) ===")
for k,v in tally.most_common(): print(f"  {k:24s}: {v}")
print(f"  TOTAL FLIPS: {sum(tally.values())}")
lost=[d for d in detail if d[4]=="LOST_EDGAR"]
print(f"\n  Flips that LOST EDGAR-primary with NO EDGAR replacement: {len(lost)}")
for d in lost: print("   ",d)
print("\n=== Detail ===")
for name,mid,vt,cls,flag in sorted(detail):
    print(f"  {name:11s} {mid:40s} {vt:18s} {cls} {flag}")
cur.close(); conn.close()
