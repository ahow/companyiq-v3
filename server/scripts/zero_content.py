#!/usr/bin/env python3
import psycopg2
conn = psycopg2.connect(open("/tmp/dburl.txt").read().strip()); cur = conn.cursor()
ZERO = [843, 887, 920, 938, 1731, 1756, 1987]

for cid in ZERO:
    cur.execute("SELECT name FROM companies WHERE id=%s", (cid,)); name = cur.fetchone()[0]
    # documents with content_id and whether document_content has text for it
    cur.execute("""
      SELECT
        count(*) AS docs,
        count(d.content_id) AS with_cid,
        count(dc.id) AS cid_joined,
        coalesce(sum(dc.content_length),0) AS dc_chars,
        coalesce(sum(length(d.content)),0) AS inline_chars
      FROM documents d
      LEFT JOIN document_content dc ON dc.id = d.content_id
      WHERE d.company_id=%s AND d.gate_verdict='accept'
    """, (cid,))
    docs, with_cid, cid_joined, dc_chars, inline_chars = cur.fetchone()
    print(f"=== {cid} {name}")
    print(f"    accepted docs={docs} with_content_id={with_cid} content_rows_joined={cid_joined} dc_chars={dc_chars} inline_chars={inline_chars}")
    # sample a few accepted+ok docs to see their content state
    cur.execute("""
      SELECT d.id, d.fetch_status, d.content_id, length(d.content), dc.content_length, left(d.url,70)
      FROM documents d LEFT JOIN document_content dc ON dc.id=d.content_id
      WHERE d.company_id=%s AND d.gate_verdict='accept' AND d.fetch_status='ok'
      ORDER BY d.id LIMIT 4
    """, (cid,))
    for r in cur.fetchall():
        print("     sample:", r)
cur.close(); conn.close()
