#!/usr/bin/env python3
"""fw20-backup.py — Export production Framework 20 (row + all measures) to a
timestamped JSON backup under /home/ubuntu/shared/companyiq-programme/.

Read-only. Verifies the backup contains 30 measures before writing is considered
successful. Prints the DB host first (deployment-target verification) and the
backup path last.

Usage:  python3 scripts/fw20-backup.py
"""
import psycopg2, psycopg2.extras, json, datetime, sys, os

URL = open('/home/ubuntu/.prod_db_url').read().strip()
OUTDIR = '/home/ubuntu/shared/companyiq-programme'
FID = 20

host = URL.replace('postgresql://', '').replace('postgres://', '')
host = host.split('@')[-1].split('/')[0]
print(f"[fw20-backup] DB host: {host}")

conn = psycopg2.connect(URL)
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

cur.execute("SELECT * FROM frameworks WHERE id=%s", (FID,))
fw = cur.fetchone()
if not fw:
    sys.exit(f"[fw20-backup] FATAL: framework {FID} not found")

cur.execute("SELECT * FROM framework_measures WHERE framework_id=%s ORDER BY display_order", (FID,))
measures = cur.fetchall()
conn.close()

def default(o):
    if isinstance(o, (datetime.datetime, datetime.date)):
        return o.isoformat()
    return str(o)

n = len(measures)
print(f"[fw20-backup] framework='{fw['name']}' version={fw['version']} is_active={fw['is_active']} measures={n}")
if n != 30:
    sys.exit(f"[fw20-backup] FATAL: expected 30 measures, found {n} — aborting before any downstream write.")

ts = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
path = os.path.join(OUTDIR, f'framework20_backup_{ts}.json')
payload = {
    'backupMeta': {
        'takenAtUTC': ts,
        'dbHost': host,
        'frameworkId': FID,
        'measureCount': n,
        'purpose': 'Pre-v2 reversible backup of production Framework 20 (row + all measures).',
    },
    'framework': dict(fw),
    'measures': [dict(m) for m in measures],
}
with open(path, 'w') as f:
    json.dump(payload, f, indent=2, default=default)

# Re-read and verify
with open(path) as f:
    check = json.load(f)
assert len(check['measures']) == 30, "post-write verification failed: measure count != 30"
print(f"[fw20-backup] VERIFIED 30 measures in backup.")
print(f"[fw20-backup] BACKUP_PATH={path}")
