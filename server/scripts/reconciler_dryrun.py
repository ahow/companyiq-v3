#!/usr/bin/env python3
"""Read-only dry-run of the reconciler detection logic against live DB.
Replicates the three SELECTs in reconcileOnce() WITHOUT any writes, so we can
confirm what the reconciler WOULD act on before deploying."""
import os, psycopg2, psycopg2.extras

STUCK_MIN = 40
QA_THIN_CHARS = 100000

url = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(url)
conn.autocommit = True
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

print("=" * 70)
print("LAYER 1: Orphaned jobs / stuck companies (threshold %d min)" % STUCK_MIN)
print("=" * 70)
cur.execute(f"""
  SELECT DISTINCT c.id AS company_id, c.workspace_id, c.name,
         c.analysis_status, j.id AS job_id, j.status AS job_status,
         j.framework_id, j.batch_id, j.claimed_at, c.updated_at
  FROM companies c
  JOIN analysis_jobs j ON j.company_id = c.id
  WHERE (
          (j.status = 'claimed' AND j.claimed_at < NOW() - INTERVAL '{STUCK_MIN} minutes')
          OR
          (c.analysis_status IN ('fetching','analyzing') AND c.updated_at < NOW() - INTERVAL '{STUCK_MIN} minutes')
        )
    AND j.id = (SELECT MAX(id) FROM analysis_jobs j2 WHERE j2.company_id = c.id)
  ORDER BY c.id
""")
orphans = cur.fetchall()
print(f"Found {len(orphans)} orphan candidate(s):")
for o in orphans:
    cur.execute("SELECT 1 FROM measure_scores WHERE company_id=%s AND framework_id=%s LIMIT 1",
                (o["company_id"], o["framework_id"]))
    has_scores = cur.fetchone() is not None
    action = "SYNC->completed (results exist)" if has_scores else "AUTO-RECOVER (re-enqueue)"
    print(f"  - id={o['company_id']:5} {o['name'][:30]:30} job={o['job_id']} "
          f"jobstatus={o['job_status']} compstatus={o['analysis_status']} -> {action}")

print()
print("=" * 70)
print("LAYER 2: Quality-zero FLAG candidates (completed, score<=0, lowEvidence, thin)")
print("=" * 70)
cur.execute("""
  SELECT id, workspace_id, name, total_score, discovery_diagnostics
  FROM companies
  WHERE analysis_status='completed' AND COALESCE(total_score,0) <= 0
  ORDER BY id
""")
zeros = cur.fetchall()
flag_n = 0
skip_already = 0
skip_legit = 0
for z in zeros:
    diag = z["discovery_diagnostics"] or {}
    if isinstance(diag, dict) and diag.get("qaFlag", {}).get("flagged"):
        skip_already += 1
        continue
    fc = diag.get("fetchCoverage") if isinstance(diag, dict) else None
    low = bool(fc and fc.get("lowEvidence") is True)
    if not low:
        skip_legit += 1
        continue
    cur.execute("""SELECT COALESCE(SUM(dc.content_length),0) AS chars
                   FROM documents d JOIN document_content dc ON dc.id=d.content_id
                   WHERE d.company_id=%s AND d.fetch_status='ok'""", (z["id"],))
    chars = cur.fetchone()["chars"] or 0
    if chars >= QA_THIN_CHARS:
        skip_legit += 1
        continue
    flag_n += 1
    print(f"  FLAG id={z['id']:5} {z['name'][:30]:30} score={z['total_score']} chars={chars}")
print(f"\nWould FLAG {flag_n}; skip(already flagged)={skip_already}; skip(legit large/clean zero)={skip_legit}")

print()
print("=" * 70)
print("LAYER 3: Open batches whose jobs are all terminal (would close)")
print("=" * 70)
cur.execute("""
  SELECT b.id,
         COUNT(*) FILTER (WHERE j.status='completed') AS comp,
         COUNT(*) FILTER (WHERE j.status='failed') AS fail,
         COUNT(*) AS tot,
         COUNT(*) FILTER (WHERE j.status IN ('pending','claimed')) AS open_jobs
  FROM batch_runs b JOIN analysis_jobs j ON j.batch_id=b.id
  WHERE b.status='running'
  GROUP BY b.id
  HAVING COUNT(*) FILTER (WHERE j.status IN ('pending','claimed'))=0
  ORDER BY b.id
""")
for b in cur.fetchall():
    print(f"  CLOSE batch {b['id']}: {b['comp']} completed, {b['fail']} failed (tot {b['tot']})")

# Also show currently-open (still has pending/claimed) running batches for context
cur.execute("""
  SELECT b.id, COUNT(*) FILTER (WHERE j.status IN ('pending','claimed')) AS open_jobs
  FROM batch_runs b JOIN analysis_jobs j ON j.batch_id=b.id
  WHERE b.status='running' GROUP BY b.id HAVING COUNT(*) FILTER (WHERE j.status IN ('pending','claimed'))>0
  ORDER BY b.id
""")
print("\nStill-open running batches (have live jobs, NOT closed):")
for b in cur.fetchall():
    print(f"  batch {b['id']}: {b['open_jobs']} open job(s)")

cur.close(); conn.close()
