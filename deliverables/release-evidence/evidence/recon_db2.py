import sys,json; sys.path.insert(0,'/home/ubuntu/release-tools')
from env import PG
import psycopg2
c=psycopg2.connect(PG); c.set_session(readonly=True, autocommit=False); cur=c.cursor()
IDS=[9,25,21,10,11,14,20,15,19,29,24,30]
W0,W1='2026-10-12 01:24:46','2026-10-12 02:18:04'
cur.execute("""
select d.company_id, d.id, d.url, d.type, d.gate_verdict, d.fetch_status, d.fetch_failures, d.failure_reason, d.source_type,
       d.fetched_at, d.created_at, coalesce(dc.content_length, length(d.content), 0) as clen
from documents d left join document_content dc on dc.id=d.content_id
where d.company_id = any(%s)""",(IDS,))
cols=[x[0] for x in cur.description]
rows=[dict(zip(cols,r)) for r in cur.fetchall()]
for r in rows:
    for k in ('fetched_at','created_at'):
        r[k]=r[k].isoformat() if r[k] else None
cur.execute("select company_id, count(*), count(distinct measure_id) from measure_scores where batch_id=1276 group by 1" )
ms=cur.fetchall()
c.rollback()
json.dump({"docs":rows,"measure_scores":ms},open('/tmp/recon_docs.json','w'),default=str)
print(len(rows), ms)
