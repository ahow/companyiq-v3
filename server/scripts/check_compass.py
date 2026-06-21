#!/usr/bin/env python3
import json, psycopg2
c = psycopg2.connect(open('/tmp/dburl.txt').read().strip()); cur = c.cursor()

cur.execute("""SELECT id,name,analysis_status,total_score,measures_met_count,
                      measures_total_count,discovery_diagnostics
               FROM companies WHERE id=1006""")
cid,name,st,score,met,tot,diag = cur.fetchone()
if isinstance(diag,str): diag=json.loads(diag)
diag = diag or {}
print(f"COMPASS GROUP id={cid}")
print(f"  status={st} score={score} met={met}/{tot}")
cov = diag.get('fetchCoverage') or {}
print(f"  fetchCoverage: fetched={cov.get('documentsFetched')} dead={cov.get('documentsDead')} "
      f"disc={cov.get('documentsDiscovered')} ratio={cov.get('fetchRatio')} lowEvidence={cov.get('lowEvidence')}")
print(f"  autoReexam: {diag.get('autoReexam')}")

# corpus chars now
cur.execute("""SELECT COALESCE(SUM(length(COALESCE(dc.content,d.content))),0),
                      COUNT(*) FILTER (WHERE d.fetch_status='ok'),
                      COUNT(*) FILTER (WHERE d.fetch_status='dead'),
                      COUNT(*)
               FROM documents d LEFT JOIN document_content dc ON dc.id=d.content_id
               WHERE d.company_id=1006""")
chars,ok,dead,total = cur.fetchone()
print(f"  docs now: ok={ok} dead={dead} total={total} corpusChars={int(chars or 0):,}")

# recent batches for ws=3 (reexam batches are single-job)
cur.execute("""SELECT id,status,total_jobs,completed_jobs,failed_jobs,started_at
               FROM batch_runs WHERE workspace_id=3 ORDER BY id DESC LIMIT 8""")
print("\nRecent batches:")
for r in cur.fetchall():
    print(f"  batch {r[0]}: status={r[1]} {r[3]}+{r[4]}/{r[2]} started={r[5]}")

# analysis_jobs for compass
cur.execute("""SELECT id,batch_id,status,attempts,last_error,completed_at
               FROM analysis_jobs WHERE company_id=1006 ORDER BY id DESC LIMIT 6""")
print("\nCompass jobs:")
for r in cur.fetchall():
    print(f"  job {r[0]} batch={r[1]} status={r[2]} attempts={r[3]} err={str(r[4])[:60]} done={r[5]}")
c.close()
