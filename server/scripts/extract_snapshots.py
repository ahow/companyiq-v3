#!/usr/bin/env python3
import psycopg2, json
DB = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(DB); cur = conn.cursor()

def load(rid):
    cur.execute("SELECT results_data FROM analysis_results WHERE id=%s", (rid,))
    d = cur.fetchone()[0]
    if isinstance(d, str): d = json.loads(d)
    return d

v3j = load(72)   # baseline
v3k = load(85)   # r12

# Inspect structure of one measureScore item
sample_co = v3j[0]
print("company:", sample_co.get("companyName"), "totalScore:", sample_co.get("totalScore"),
      "met:", sample_co.get("measuresMetCount"), "/", sample_co.get("measuresTotalCount"))
ms = sample_co.get("measureScores")
print("measureScores type:", type(ms), "len:", len(ms) if hasattr(ms,'__len__') else 'n/a')
if isinstance(ms, list) and ms:
    print("first measureScore keys:", list(ms[0].keys()))
    print("first measureScore sample:", json.dumps(ms[0], indent=2)[:1200])
elif isinstance(ms, dict):
    k = list(ms.keys())[0]
    print("dict; first key:", k, "value:", json.dumps(ms[k], indent=2)[:1200])

print("\n--- company-level summary both snapshots ---")
def summ(tag, data):
    print(f"\n[{tag}]")
    for co in data:
        print(f"  {co.get('companyName'):28s} id={co.get('companyId')} total={co.get('totalScore')} met={co.get('measuresMetCount')}/{co.get('measuresTotalCount')}")
summ("v3j id=72", v3j)
summ("v3k id=85", v3k)
cur.close(); conn.close()
