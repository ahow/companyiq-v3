#!/usr/bin/env python3
import psycopg2
DB = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(DB); cur = conn.cursor()
cur.execute("""
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' ORDER BY table_name
""")
tables = [r[0] for r in cur.fetchall()]
print("TABLES:", tables)
print()
# Look for any table with a 'verdict' or 'score' column besides measure_scores
for t in tables:
    cur.execute("""SELECT column_name FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=%s""", (t,))
    cols = [r[0] for r in cur.fetchall()]
    if any(c in cols for c in ("verdict","conclusion_verdict","created_at")) and t != "measure_scores":
        # count rows + min/max created_at if present
        try:
            cur.execute(f"SELECT count(*) FROM {t}")
            n = cur.fetchone()[0]
        except Exception:
            n = "?"
        print(f"{t}: cols={cols} rows={n}")
# Does measure_scores have any history (multiple rows per company/measure)?
cur.execute("""SELECT company_id, measure_id, count(*) c FROM measure_scores
               WHERE framework_id=7 GROUP BY company_id, measure_id HAVING count(*)>1 LIMIT 5""")
print("\nmeasure_scores duplicate (history) rows sample:", cur.fetchall())
cur.close(); conn.close()
