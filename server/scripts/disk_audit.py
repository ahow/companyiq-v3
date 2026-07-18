import psycopg2
c = psycopg2.connect(open('/tmp/dburl.txt').read().strip()); cur = c.cursor()

print("=== document_content table stats ===")
cur.execute("""
SELECT n_live_tup, n_dead_tup, last_autovacuum, last_vacuum, last_autoanalyze
FROM pg_stat_user_tables WHERE relname='document_content'
""")
r = cur.fetchone()
print(f"  live tuples : {r[0]:,}")
print(f"  dead tuples : {r[1]:,}")
print(f"  last_autovacuum : {r[2]}")
print(f"  last_vacuum     : {r[3]}")

cur.execute("SELECT pg_size_pretty(pg_table_size('document_content')), pg_size_pretty(pg_indexes_size('document_content'))")
ts, isz = cur.fetchone()
print(f"  table (heap+toast): {ts}   indexes: {isz}")

print("\n=== row count + content volume ===")
cur.execute("SELECT COUNT(*), pg_size_pretty(SUM(length(content))::bigint), AVG(length(content))::bigint FROM document_content")
n, tot, avg = cur.fetchone()
print(f"  rows: {n:,}   summed content text: {tot}   avg len: {avg:,} chars")

print("\n=== orphaned content (not referenced by any document.content_id) ===")
try:
    cur.execute("""
    SELECT COUNT(*), pg_size_pretty(COALESCE(SUM(length(dc.content)),0)::bigint)
    FROM document_content dc
    WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.content_id = dc.id)
    """)
    on, osz = cur.fetchone()
    print(f"  orphaned rows: {on:,}   approx text: {osz}")
except Exception as e:
    print("  (orphan check failed:", e, ")")

print("\n=== summary_cache + processing_errors (other growth) ===")
cur.execute("SELECT COUNT(*), pg_size_pretty(pg_total_relation_size('summary_cache')) FROM summary_cache")
print("  summary_cache rows:", cur.fetchall())

c.close()
