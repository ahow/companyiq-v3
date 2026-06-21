#!/usr/bin/env python3
"""
Estimate ETA for the in-flight portfolio run.
Measures how many companies have reached a terminal state (analysis completed,
i.e. companies.total_score written) within recent time windows, and the worker
concurrency, then projects time to drain the pending queue.
"""
import psycopg2, datetime
conn = psycopg2.connect(open("/tmp/dburl.txt").read().strip()); cur = conn.cursor()

now = datetime.datetime.utcnow()

# Companies that have a completed analysis (status completed) updated within windows
def completed_since(minutes):
    # count analysis_jobs that completed within the window (job-level throughput)
    cur.execute("""
        SELECT count(*) FROM analysis_jobs
        WHERE status='completed' AND completed_at > (now() at time zone 'utc') - interval '%s minutes'
    """ % int(minutes))
    return cur.fetchone()[0]

# Overall queue state
cur.execute("SELECT status, count(*) FROM analysis_jobs GROUP BY status ORDER BY 2 DESC")
jobs = dict(cur.fetchall())
pending = jobs.get("pending", 0)
claimed = jobs.get("claimed", 0)

# Company-level status spread
cur.execute("SELECT analysis_status, count(*) FROM companies GROUP BY analysis_status ORDER BY 2 DESC")
comp = cur.fetchall()

print("=== Job queue ===")
for k, v in sorted(jobs.items(), key=lambda x: -x[1]):
    print(f"  {k:12s}: {v}")
print("\n=== Company status ===")
for s, c in comp:
    print(f"  {str(s):12s}: {c}")

# Throughput from companies.updated_at completions
for w in (5, 10, 15, 30, 60):
    n = completed_since(w)
    rate = n / w  # companies per minute
    print(f"\nCompleted in last {w:3d} min: {n:4d}  -> {rate:.2f} companies/min", end="")
    if rate > 0 and pending > 0:
        eta_min = pending / rate
        eta_h = eta_min / 60
        print(f"  -> ETA for {pending} pending: {eta_h:.1f} h ({eta_min/60/24:.1f} days)")
    else:
        print()

# When did this batch start, and how many done since
cur.execute("""
    SELECT count(*) FROM companies
    WHERE analysis_status='completed' AND updated_at > timestamp '2026-06-21 07:07:00'
""")
done_this_batch = cur.fetchone()[0]
print(f"\nCompleted since batch start (07:07 UTC): {done_this_batch}")
cur.close(); conn.close()
