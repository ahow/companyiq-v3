#!/usr/bin/env python3
import psycopg2
conn = psycopg2.connect(open("/tmp/dburl.txt").read().strip()); cur = conn.cursor()

print("=== Completions per 5-min bucket (this batch) ===")
cur.execute("""
  SELECT to_timestamp(floor(extract(epoch from completed_at)/300)*300) AT TIME ZONE 'UTC' AS bucket,
         count(*)
  FROM analysis_jobs
  WHERE status='completed' AND completed_at > timestamp '2026-06-21 07:05:00'
  GROUP BY 1 ORDER BY 1
""")
for b, c in cur.fetchall():
    print(f"  {b}  {c}")

print("\n=== Claimed (in-flight) jobs ===")
cur.execute("""SELECT id, company_id, company_name, worker_id, claimed_at, attempts
               FROM analysis_jobs WHERE status='claimed' ORDER BY claimed_at""")
for r in cur.fetchall():
    print("  ", r)

print("\n=== Distinct workers seen this batch ===")
cur.execute("""SELECT worker_id, count(*) , min(claimed_at), max(completed_at)
               FROM analysis_jobs
               WHERE claimed_at > timestamp '2026-06-21 07:05:00'
               GROUP BY worker_id ORDER BY 2 DESC""")
for r in cur.fetchall():
    print("  ", r)

print("\n=== Recent failures this batch (last 10) ===")
cur.execute("""SELECT company_name, left(coalesce(last_error,''),160), completed_at, attempts
               FROM analysis_jobs
               WHERE status='failed' AND completed_at > timestamp '2026-06-21 07:05:00'
               ORDER BY completed_at DESC LIMIT 10""")
for r in cur.fetchall():
    print("  ", r)

print("\n=== Pending jobs: attempts distribution ===")
cur.execute("SELECT attempts, count(*) FROM analysis_jobs WHERE status='pending' GROUP BY attempts ORDER BY 1")
for r in cur.fetchall():
    print("  attempts=", r[0], "count=", r[1])

cur.close(); conn.close()
