#!/usr/bin/env python3
import psycopg2, json
DB = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(DB); cur = conn.cursor()
cur.execute("""SELECT column_name FROM information_schema.columns
               WHERE table_name='framework_measures' ORDER BY ordinal_position""")
print("framework_measures cols:", [r[0] for r in cur.fetchall()])
# try to find measures for framework 7
cur.execute("SELECT * FROM framework_measures LIMIT 0")
colnames=[d[0] for d in cur.description]
cur.execute("SELECT * FROM framework_measures WHERE framework_id=7 ORDER BY display_order")
rows=cur.fetchall()
print(f"\n{len(rows)} measures for framework 7:\n")
idx={c:i for i,c in enumerate(colnames)}
for r in rows:
    mid = r[idx.get("measure_id")] if "measure_id" in idx else None
    title = r[idx.get("title")] if "title" in idx else ""
    rst = None
    for cand in ["required_source_types","requiredSourceTypes","required_sources"]:
        if cand in idx:
            rst = r[idx[cand]]
            break
    print(f"  {mid:38s} req={rst}")
cur.close(); conn.close()
