#!/usr/bin/env python3
import psycopg2, json
conn = psycopg2.connect(open("/tmp/dburl.txt").read().strip()); cur = conn.cursor()

ZERO = [843, 887, 920, 938, 1731, 1756, 1987]

# document table columns
cur.execute("""SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%document%' OR table_name ILIKE '%content%'""")
print("doc-ish tables:", [r[0] for r in cur.fetchall()])

cur.execute("""SELECT column_name FROM information_schema.columns WHERE table_name='documents' ORDER BY ordinal_position""")
print("documents cols:", [r[0] for r in cur.fetchall()])

cur.execute("""SELECT column_name FROM information_schema.columns WHERE table_name='document_content' ORDER BY ordinal_position""")
print("document_content cols:", [r[0] for r in cur.fetchall()])

for cid in ZERO:
    cur.execute("SELECT name, country, measures_total_count, discovery_diagnostics FROM companies WHERE id=%s", (cid,))
    name, country, mtot, diag = cur.fetchone()
    # documents discovered
    cur.execute("SELECT count(*) FROM documents WHERE company_id=%s", (cid,))
    ndocs = cur.fetchone()[0]
    # documents with fetched content (content stored inline on documents.content)
    cur.execute("""
      SELECT count(*), coalesce(sum(length(content)),0)
      FROM documents
      WHERE company_id=%s AND content IS NOT NULL AND length(content)>0
    """, (cid,))
    nfetched, totchars = cur.fetchone()
    # fetch status breakdown + gate verdicts
    cur.execute("SELECT fetch_status, count(*) FROM documents WHERE company_id=%s GROUP BY 1", (cid,))
    fstat = dict(cur.fetchall())
    cur.execute("SELECT gate_verdict, count(*) FROM documents WHERE company_id=%s GROUP BY 1", (cid,))
    gstat = dict(cur.fetchall())
    print(f"\n=== {cid} {name} ({country}) measures_total={mtot}")
    print(f"    documents discovered: {ndocs} | fetched-with-content: {nfetched} | total chars: {totchars}")
    print(f"    fetch_status: {fstat}")
    print(f"    gate_verdict: {gstat}")
    if diag:
        d = diag if isinstance(diag, dict) else json.loads(diag)
        # print compact keys
        print("    discovery_diagnostics keys:", list(d.keys())[:12])
        for k in ("totalCandidates","accepted","rejected","kept","selectedCount","reason","notes"):
            if k in d:
                print(f"      {k}: {str(d[k])[:200]}")

cur.close(); conn.close()
