import psycopg2, datetime
c = psycopg2.connect(open('/tmp/dburl.txt').read().strip()); cur = c.cursor()

print("=== company status ===")
cur.execute("SELECT analysis_status,COUNT(*) FROM companies WHERE workspace_id=3 GROUP BY 1 ORDER BY 2 DESC")
for s, n in cur.fetchall(): print(f"  {str(s):14}{n}")

cur.execute("SELECT COUNT(*) FROM companies WHERE workspace_id=3 AND analysis_status='completed' AND total_score>0")
print("completed w/ score>0 :", cur.fetchone()[0])
cur.execute("SELECT COUNT(*) FROM companies WHERE workspace_id=3 AND analysis_status='completed' AND (total_score=0 OR total_score IS NULL)")
print("completed w/ score=0 :", cur.fetchone()[0])

print("\n=== auto-reexam activity (companies with autoReexam set) ===")
cur.execute("""SELECT analysis_status,
  (discovery_diagnostics->'autoReexam'->>'count') AS cnt, COUNT(*)
  FROM companies WHERE workspace_id=3 AND discovery_diagnostics ? 'autoReexam'
  GROUP BY 1,2 ORDER BY 3 DESC""")
rows = cur.fetchall()
if rows:
    for st, cnt, n in rows: print(f"  status={st:12} autoReexam.count={cnt}  -> {n}")
else:
    print("  (none)")

print("\n=== single-job (re-exam) batches created in last 45 min ===")
cur.execute("""SELECT COUNT(*) FROM batch_runs
  WHERE total_jobs=1 AND started_at > now() - interval '45 minutes'""")
print("  count:", cur.fetchone()[0])

print("\n=== portfolio batch 136 ===")
cur.execute("SELECT id,status,completed_jobs,total_jobs,started_at FROM batch_runs WHERE id=136")
print(" ", cur.fetchone())

print("\n=== recently failed companies (sample) ===")
cur.execute("""SELECT id,name,analysis_status,
  (discovery_diagnostics->'fetchCoverage'->>'documentsFetched') f,
  (discovery_diagnostics->'fetchCoverage'->>'documentsDead') d
  FROM companies WHERE workspace_id=3 AND analysis_status='failed' LIMIT 12""")
for r in cur.fetchall(): print("  ", r)

print("\n=== jobs table state ===")
cur.execute("SELECT status,COUNT(*) FROM analysis_jobs WHERE workspace_id=3 GROUP BY 1 ORDER BY 2 DESC")
for s, n in cur.fetchall(): print(f"  {str(s):12}{n}")

c.close()
