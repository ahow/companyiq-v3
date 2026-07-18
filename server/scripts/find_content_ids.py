#!/usr/bin/env python3
import psycopg2
DB = open("/tmp/dburl.txt").read().strip()
conn = psycopg2.connect(DB); cur = conn.cursor()

def show(cid, name):
    print(f"\n=== {name} (company_id={cid}) candidate filings ===")
    cur.execute("""
        SELECT d.content_id, d.url, d.title
        FROM documents d
        WHERE d.company_id=%s
          AND d.content_id IS NOT NULL
          AND (d.url ILIKE '%%sec.gov/archives/edgar%%'
               OR d.url ILIKE '%%def14a%%' OR d.title ILIKE '%%def 14a%%'
               OR d.title ILIKE '%%10-k%%' OR d.title ILIKE '%%proxy%%'
               OR d.url ILIKE '%%goog-2025%%')
        ORDER BY d.content_id DESC
        LIMIT 25
    """, (cid,))
    for r in cur.fetchall():
        print(f"  content_id={r[0]:>8}  title={(r[2] or '')[:42]:42s}  url={(r[1] or '')[:90]}")

show(553, "MICROSOFT")
show(2063, "ALPHABET")
cur.close(); conn.close()
