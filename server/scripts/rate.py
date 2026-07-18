#!/usr/bin/env python3
import psycopg2
conn = psycopg2.connect(open("/tmp/dburl.txt").read().strip()); cur = conn.cursor()

# Rollout of 8 replicas completed ~07:50 UTC. Measure completions in windows since.
cur.execute("SELECT status, count(*) FROM analysis_jobs GROUP BY status ORDER BY 2 DESC")
print("jobs:", dict(cur.fetchall()))
cur.execute("SELECT count(*) FROM analysis_jobs WHERE status='claimed'")
print("claimed now:", cur.fetchone()[0])
cur.execute("SELECT count(DISTINCT company_id) FROM analysis_jobs WHERE status='pending'")
pending = cur.fetchone()[0]
print("pending companies:", pending)
cur.execute("SELECT count(*) FROM pg_stat_activity")
print("DB connections:", cur.fetchone()[0])

print("\n=== Completions in recent windows (post 8-replica rollout) ===")
for w in (5, 10, 15, 20):
    cur.execute("""
        SELECT count(*) FROM analysis_jobs
        WHERE status='completed' AND completed_at > (now() at time zone 'utc') - interval '%s minutes'
    """ % w)
    n = cur.fetchone()[0]
    rate = n / w
    line = f"  last {w:2d} min: {n:4d} done -> {rate:.2f}/min"
    if rate > 0:
        eta_h = pending / rate / 60
        line += f"  -> ETA {eta_h:.1f} h ({eta_h/24:.1f} d)"
    print(line)

# completions since rollout (07:50)
cur.execute("SELECT count(*) FROM analysis_jobs WHERE status='completed' AND completed_at > timestamp '2026-06-21 07:50:00'")
print("\ncompleted since rollout 07:50 UTC:", cur.fetchone()[0])
# 5-min bucket trend
print("\n=== 5-min completion buckets since 07:45 ===")
cur.execute("""
  SELECT to_timestamp(floor(extract(epoch from completed_at)/300)*300) AT TIME ZONE 'UTC' AS bucket, count(*)
  FROM analysis_jobs WHERE status='completed' AND completed_at > timestamp '2026-06-21 07:45:00'
  GROUP BY 1 ORDER BY 1
""")
for b, c in cur.fetchall():
    print(f"  {b}  {c}")
cur.close(); conn.close()
