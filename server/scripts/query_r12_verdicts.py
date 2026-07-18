#!/usr/bin/env python3
import os, json, psycopg2
DB = open("/tmp/dburl.txt").read().strip()
WS = 3
FW = 7
COMPANIES = {"amazon":853, "oracle":552, "meta":1918, "salesforce":420, "alphabet":2063}
conn = psycopg2.connect(DB)
cur = conn.cursor()
out = {}
for name, cid in COMPANIES.items():
    cur.execute("""
        SELECT measure_id, verdict, score, confidence, created_at,
               jsonb_array_length(COALESCE(quotes,'[]'::jsonb)) AS nq
        FROM measure_scores
        WHERE company_id=%s AND framework_id=%s
        ORDER BY measure_id
    """, (cid, FW))
    rows = []
    for mid, verdict, score, conf, created, nq in cur.fetchall():
        rows.append({"measureId": mid, "verdict": verdict, "score": float(score) if score is not None else None,
                     "confidence": conf, "nQuotes": nq, "created_at": str(created)})
    out[name] = rows
    yes = sum(1 for r in rows if r["verdict"]=="Yes")
    partial = sum(1 for r in rows if r["verdict"]=="Partial")
    no = sum(1 for r in rows if r["verdict"]=="No")
    ins = sum(1 for r in rows if r["verdict"]=="Insufficient evidence")
    print(f"{name:11} n={len(rows):2}  Yes={yes:2} Partial={partial:2} No={no:2} Insuff={ins:2}")
json.dump(out, open("/home/ubuntu/companyiq-v3/r12_verdicts.json","w"), indent=2)
print("wrote r12_verdicts.json")
cur.close(); conn.close()
