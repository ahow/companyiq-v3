import psycopg2, json
c = psycopg2.connect(open('/tmp/dburl.txt').read().strip()); cur = c.cursor()

# Failed companies with their latest job error and fetch coverage
cur.execute("""
SELECT co.id, co.name,
  (co.discovery_diagnostics->'fetchCoverage'->>'documentsFetched'),
  (co.discovery_diagnostics->'fetchCoverage'->>'documentsDead'),
  (co.discovery_diagnostics->'fetchCoverage'->>'lowEvidence'),
  co.total_score
FROM companies co
WHERE co.workspace_id=3 AND co.analysis_status='failed'
ORDER BY co.id
""")
comps = cur.fetchall()
print(f"=== {len(comps)} failed companies ===")
for r in comps:
    print(f"  id={r[0]:5} fetched={str(r[2]):>4} dead={str(r[3]):>4} lowEv={str(r[4]):>5} score={r[5]} | {r[1][:40]}")

# Look at the most recent failed job error messages for these companies
print("\n=== latest failed-job error messages (grouped) ===")
cur.execute("""
SELECT last_error, COUNT(*) FROM analysis_jobs
WHERE workspace_id=3 AND status='failed' AND last_error IS NOT NULL
GROUP BY last_error ORDER BY 2 DESC LIMIT 15
""")
for err, n in cur.fetchall():
    print(f"  [{n:4}] {str(err)[:120]}")

# How many of these failed companies actually have ok docs in the DB right now?
print("\n=== ok-doc counts for failed companies ===")
cur.execute("""
SELECT co.id, co.name, COUNT(d.id) FILTER (WHERE d.fetch_status='ok') ok_docs,
       COUNT(d.id) FILTER (WHERE d.fetch_status='dead') dead_docs
FROM companies co LEFT JOIN documents d ON d.company_id=co.id
WHERE co.workspace_id=3 AND co.analysis_status='failed'
GROUP BY co.id, co.name ORDER BY ok_docs DESC LIMIT 15
""")
for r in cur.fetchall():
    print(f"  id={r[0]:5} ok={r[2]:>3} dead={r[3]:>3} | {r[1][:40]}")

c.close()
