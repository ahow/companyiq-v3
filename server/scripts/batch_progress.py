#!/usr/bin/env python3
import psycopg2
DB = open("/tmp/dburl.txt").read().strip()
IDS = [553,1312,420,552,853,2063,1918,866,2412,1914]
NAMES = {553:"Microsoft",1312:"NVIDIA",420:"Salesforce",552:"Oracle",853:"Amazon",
         2063:"Alphabet",1918:"Meta",866:"Apple",2412:"Tesla",1914:"360 Security"}
conn = psycopg2.connect(DB); cur = conn.cursor()
cur.execute("""SELECT id, analysis_status, total_score, measures_met_count, measures_total_count, updated_at
               FROM companies WHERE id = ANY(%s) ORDER BY id""", (IDS,))
rows = cur.fetchall()
done = 0
for r in rows:
    cid, st, ts, met, tot, upd = r
    if st in ("complete","completed","idle") and ts is not None:
        done += 1
    print(f"  {NAMES.get(cid,cid):13s} status={str(st):12s} score={ts} met={met}/{tot} upd={upd}")
print(f"\nCompleted (with score): {done}/{len(IDS)}")
cur.close(); conn.close()
