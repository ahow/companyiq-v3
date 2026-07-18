#!/usr/bin/env python3
import psycopg2
conn = psycopg2.connect(open("/tmp/dburl.txt").read().strip()); cur = conn.cursor()

# What columns exist on companies?
cur.execute("""SELECT column_name FROM information_schema.columns WHERE table_name='companies' ORDER BY ordinal_position""")
print("companies cols:", [r[0] for r in cur.fetchall()])

# Completed companies this batch and their scores
cur.execute("""
  SELECT total_score, count(*) FROM companies
  WHERE analysis_status='completed'
  GROUP BY total_score ORDER BY total_score
""")
print("\nscore distribution (completed):")
for s, c in cur.fetchall():
    print(f"  score={s}: {c}")

# List the zero-score completed companies
cur.execute("""
  SELECT id, name, ticker, country, sector, total_score, measures_met_count, measures_total_count, summary
  FROM companies
  WHERE analysis_status='completed' AND (total_score=0 OR total_score IS NULL)
  ORDER BY id
""")
rows = cur.fetchall()
print(f"\nzero/null-score completed companies: {len(rows)}")
for r in rows:
    print("  ", r)

cur.close(); conn.close()
