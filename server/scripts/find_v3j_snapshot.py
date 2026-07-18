#!/usr/bin/env python3
import psycopg2, json
DB = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(DB); cur = conn.cursor()
cur.execute("""SELECT id, batch_id, framework_id, framework_name, companies_count,
                      average_score, list_name, created_at
               FROM analysis_results
               WHERE framework_id=7
               ORDER BY created_at DESC LIMIT 25""")
rows = cur.fetchall()
print("recent framework_7 analysis_results:")
for r in rows:
    print(f"  id={r[0]} batch={r[1]} n={r[4]} avg={r[5]} list={r[6]} created={r[7]}")
# Inspect the structure of the most recent one and any around Jun 20 16:00
print("\n--- inspecting results_data structure of the latest row ---")
cur.execute("SELECT id, created_at, results_data FROM analysis_results WHERE framework_id=7 ORDER BY created_at DESC LIMIT 1")
rid, created, data = cur.fetchone()
print("row id", rid, "created", created)
if isinstance(data, str):
    data = json.loads(data)
print("results_data type:", type(data))
if isinstance(data, dict):
    print("keys:", list(data.keys())[:20])
elif isinstance(data, list):
    print("list len:", len(data), "first item keys:", list(data[0].keys()) if data and isinstance(data[0],dict) else None)
cur.close(); conn.close()
