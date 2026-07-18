#!/usr/bin/env python3
import json
v3j = json.load(open("/home/ubuntu/companyiq-v3/verdict_diff.json"))
# Load full snapshots to see ALL of Alphabet's v3k measures and whether goog-20251231 10-K appears anywhere
import psycopg2
DB = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(DB); cur = conn.cursor()
def load(rid):
    cur.execute("SELECT results_data FROM analysis_results WHERE id=%s", (rid,))
    d = cur.fetchone()[0]
    return json.loads(d) if isinstance(d,str) else d
j = {c["companyId"]:c for c in load(72)}
k = {c["companyId"]:c for c in load(85)}
A=2063
def dump(tag, co):
    print(f"\n===== Alphabet {tag} =====")
    for m in co["measureScores"]:
        urls=[q.get("sourceUrl","") for q in m.get("quotes",[])]
        has10k = any("goog-2025" in (u or "") and "12" in u for u in urls)
        tag10k = "  <== goog-2025*.htm 10-K" if any("goog-20251231" in (u or "") for u in urls) else ""
        print(f"  {m['measureId']:38s} {m['verdict']:8s}{tag10k}")
        if m['measureId']=="1.1a-ai-strategic-priority":
            for q in m.get("quotes",[]):
                print(f"        - {q.get('source')} :: {q.get('sourceUrl')}")
                print(f"          text: {q.get('text','')[:120]}")
dump("v3j id=72", j[A])
dump("v3k id=85", k[A])

# Does goog-20251231 (FY2025 10-K) appear anywhere in v3k Alphabet?
print("\n--- goog-20251231 10-K presence in v3k Alphabet (any measure) ---")
found=[]
for m in k[A]["measureScores"]:
    for q in m.get("quotes",[]):
        if "goog-20251231" in (q.get("sourceUrl") or ""):
            found.append(m["measureId"])
print("measures citing goog-20251231 in v3k:", sorted(set(found)) or "NONE")
cur.close(); conn.close()
