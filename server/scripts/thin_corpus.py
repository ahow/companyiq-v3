#!/usr/bin/env python3
"""Identify COMPLETED companies whose analysis likely ran on a degraded corpus
(fetch-coverage artifact) vs a legitimately thin/no-AI corpus.

Heuristic flags per completed company:
  - dead_ratio  = dead_docs / max(1, accepted_docs)   (fetch failures)
  - usable_chars = sum(len(content)) over accepted+ok docs
A company is a RE-RUN candidate if usable_chars is very low AND it had docs that
died (i.e., evidence was discovered but failed to fetch), OR usable_chars==0.
"""
import psycopg2
conn = psycopg2.connect(open("/tmp/dburl.txt").read().strip()); cur = conn.cursor()

cur.execute("""
WITH ok AS (
  SELECT d.company_id,
         count(*) FILTER (WHERE d.fetch_status='ok' AND d.gate_verdict='accept') AS ok_accept,
         count(*) FILTER (WHERE d.fetch_status='dead') AS dead,
         count(*) FILTER (WHERE d.gate_verdict='accept') AS accepted,
         coalesce(sum(length(coalesce(dc.content, d.content))) FILTER (WHERE d.fetch_status='ok' AND d.gate_verdict='accept'),0) AS usable_chars
  FROM documents d LEFT JOIN document_content dc ON dc.id=d.content_id
  GROUP BY d.company_id
)
SELECT c.id, c.name, c.country, c.total_score, c.measures_met_count,
       ok.ok_accept, ok.dead, ok.accepted, ok.usable_chars
FROM companies c JOIN ok ON ok.company_id=c.id
WHERE c.analysis_status='completed'
ORDER BY ok.usable_chars ASC
""")
rows = cur.fetchall()
print(f"completed companies analyzed: {len(rows)}\n")

rerun = []
print(f"{'id':>5} {'name':32} {'ctry':12} {'score':>5} {'met':>3} {'okdocs':>6} {'dead':>4} {'chars':>9}  flag")
for cid,name,ctry,score,met,okd,dead,acc,chars in rows:
    flag = ""
    if chars == 0:
        flag = "EMPTY-CORPUS (rerun)"
    elif chars < 50000 and dead and dead >= okd:
        flag = "THIN+DEADFETCH (rerun)"
    elif chars < 20000:
        flag = "THIN (review)"
    if flag.startswith(("EMPTY","THIN+DEAD")):
        rerun.append(cid)
    if chars < 200000 or flag:
        print(f"{cid:>5} {str(name)[:32]:32} {str(ctry)[:12]:12} {str(score):>5} {str(met):>3} {okd:>6} {dead:>4} {chars:>9}  {flag}")

print(f"\nRE-RUN candidates (empty or thin+deadfetch): {len(rerun)} -> {rerun}")
cur.close(); conn.close()
