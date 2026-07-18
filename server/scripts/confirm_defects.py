#!/usr/bin/env python3
"""
Confirm each reviewer-flagged defect against (a) the analysis_results snapshots
(id=72 v3j, id=85 v3k r12) and (b) the live measure_scores table for r12.
"""
import psycopg2, json
DB = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(DB); cur = conn.cursor()

def load(rid):
    cur.execute("SELECT results_data FROM analysis_results WHERE id=%s", (rid,))
    d = cur.fetchone()[0]
    return json.loads(d) if isinstance(d,str) else d

v3j = {c["companyId"]: c for c in load(72)}
v3k = {c["companyId"]: c for c in load(85)}

def ms(co, mid):
    for m in co["measureScores"]:
        if m["measureId"] == mid:
            return m
    return None

def show(cid, name, mid):
    a = ms(v3j[cid], mid) if cid in v3j else None
    b = ms(v3k[cid], mid) if cid in v3k else None
    def fmt(m):
        if not m: return "MISSING"
        urls = [q.get("sourceUrl") for q in m.get("quotes",[])]
        return f"{m['verdict']}/{m.get('confidence')}/{len(m.get('quotes',[]))}q :: {urls}"
    print(f"\n[{name} {mid}]")
    print(f"  v3j(id72): {fmt(a)}")
    print(f"  v3k(id85): {fmt(b)}")

# Reviewer-flagged
show(553,"Microsoft","3.1a-ai-board-discussion")
show(553,"Microsoft","7.1-strategic-ai-partnerships")
show(553,"Microsoft","2.1a-ai-use-cases-qualitative")
show(553,"Microsoft","4.3-data-security-privacy-ai")
show(2063,"Alphabet","1.1a-ai-strategic-priority")
show(1312,"NVIDIA","4.2-operationalisation-ai-principles")
show(853,"Amazon","9.2-ai-capex-rd-quantified")   # claimed fabrication
show(853,"Amazon","2.1a-ai-use-cases-qualitative")

# Now confirm against LIVE measure_scores (r12) to check if id=85 == live dashboard
print("\n\n=== LIVE measure_scores (r12) for the flagged rows ===")
cur.execute("""SELECT column_name FROM information_schema.columns 
               WHERE table_name='measure_scores' ORDER BY ordinal_position""")
print("measure_scores cols:", [r[0] for r in cur.fetchall()])
cur.close(); conn.close()
