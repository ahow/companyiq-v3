#!/usr/bin/env python3
"""
Step A: Sync companies stuck in 'analyzing' whose latest job actually COMPLETED.

These companies finished analysis (real score persisted) but their
analysis_status field was never flipped from 'analyzing' -> 'completed'
because the worker died between writing results and updating status.

Safe: only updates the analysis_status field; never touches scores or documents.
Only flips companies whose most-recent job is 'completed'.

Usage:
  python sync_stale_analyzing.py            # dry run (no writes)
  python sync_stale_analyzing.py --apply    # perform the update
"""
import sys
import psycopg2

DRY = "--apply" not in sys.argv

conn = psycopg2.connect(open("/tmp/dburl.txt").read().strip())
cur = conn.cursor()

# Identify analyzing companies whose latest job completed.
SELECT_TARGETS = """
with az as (
  select id from companies where workspace_id=3 and analysis_status='analyzing'
),
latest as (
  select j.company_id, j.status,
         row_number() over (
           partition by j.company_id
           order by j.completed_at desc nulls last, j.claimed_at desc nulls last, j.id desc
         ) rn
  from analysis_jobs j
  where j.company_id in (select id from az)
)
select c.id, c.name, c.total_score
from companies c
join latest l on l.company_id = c.id and l.rn = 1
where l.status = 'completed'
order by c.id
"""

cur.execute(SELECT_TARGETS)
targets = cur.fetchall()
print(f"Found {len(targets)} 'analyzing' companies whose latest job is COMPLETED.")
print("Sample:")
for r in targets[:10]:
    print(f"  company={r[0]} {str(r[1])[:32]:<32} score={r[2]}")

if DRY:
    print("\n[DRY RUN] No changes written. Re-run with --apply to update.")
    conn.close()
    sys.exit(0)

ids = [r[0] for r in targets]
if not ids:
    print("Nothing to update.")
    conn.close()
    sys.exit(0)

# Flip only these specific company IDs, and only if still 'analyzing' (guard against races).
cur.execute(
    """
    update companies
       set analysis_status='completed', updated_at=now()
     where workspace_id=3
       and analysis_status='analyzing'
       and id = any(%s)
    """,
    (ids,),
)
print(f"\n[APPLIED] Updated {cur.rowcount} companies to analysis_status='completed'.")
conn.commit()
conn.close()
