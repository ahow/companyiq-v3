#!/usr/bin/env python3
"""fw20-export.py — Export production Framework 20 (row + all measures) to a
timestamped JSON under /home/ubuntu/shared/companyiq-programme/ and print a
verification summary. Read-only.

Usage:  python3 scripts/fw20-export.py [--tag v2_export]
"""
import psycopg2, psycopg2.extras, json, datetime, sys, os

URL = open('/home/ubuntu/.prod_db_url').read().strip()
OUTDIR = '/home/ubuntu/shared/companyiq-programme'
FID = 20
tag = 'export'
if '--tag' in sys.argv:
    tag = sys.argv[sys.argv.index('--tag') + 1]

host = URL.replace('postgresql://', '').replace('postgres://', '').split('@')[-1].split('/')[0]
print(f"[fw20-export] DB host: {host}")

conn = psycopg2.connect(URL)
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
cur.execute("SELECT * FROM frameworks WHERE id=%s", (FID,))
fw = cur.fetchone()
if not fw:
    sys.exit(f"[fw20-export] FATAL: framework {FID} not found")
cur.execute("SELECT * FROM framework_measures WHERE framework_id=%s ORDER BY display_order", (FID,))
measures = cur.fetchall()
conn.close()

def default(o):
    if isinstance(o, (datetime.datetime, datetime.date)):
        return o.isoformat()
    return str(o)

ts = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
path = os.path.join(OUTDIR, f'framework20_{tag}_{ts}.json')
payload = {
    'exportMeta': {'takenAtUTC': ts, 'dbHost': host, 'frameworkId': FID,
                   'measureCount': len(measures)},
    'framework': dict(fw),
    'measures': [dict(m) for m in measures],
}
with open(path, 'w') as f:
    json.dump(payload, f, indent=2, default=default)

# ---------------- verification summary ----------------
print("\n================ VERIFICATION ================")
print(f"name            : {fw['name']}")
print(f"version         : {fw['version']}   (expect 2)")
print(f"is_active       : {fw['is_active']}   (expect False)")
print(f"measure count   : {len(measures)}   (expect 27)")
sas = fw['sub_area_structure']
cats = [(c.get('letter'), c.get('name')) for c in sas.get('categories', [])]
print(f"sub_area type   : {sas.get('type')}   (expect custom)")
print(f"pillars         : {cats}")
from collections import Counter
cn = Counter(m['category_number'] for m in measures)
print(f"by pillar       : {dict(sorted(cn.items()))}   (expect 1:3,2:8,3:10,4:3,5:3)")
af = [a['name'] for a in fw['anchor_frameworks']]
print(f"SEC removed     : {not any('SEC' in a for a in af)}")
print(f"CRIF/PCRAM added: {any('CRIF' in a for a in af)} / {any('PCRAM' in a for a in af)}")
print(f"'renewable energy' in negative_keywords: {'renewable energy' in fw['negative_keywords']}  (expect False)")
rdt = fw['required_doc_types']
print(f"doc types incl transcript/10-Q/FS-notes: "
      f"{any('transcript' in d.lower() for d in rdt)}/"
      f"{any('10-Q' in d for d in rdt)}/"
      f"{any('Financial statement notes' == d for d in rdt)}")
print(f"known_disclosure_urls populated     : {bool(fw['known_disclosure_urls'])}")
print(f"authoritative_filing_types populated: {bool(fw['authoritative_filing_types'])}")
ids = [m['measure_id'] for m in measures]
newids = ['C5-siting-ma-design-standards','C6-asset-portfolio-decisions','C7-supplychain-resilience-actions',
          'C8-water-security','C9-adaptation-investment-appraisal','C10-workforce-heat-stress',
          'D2-early-warning-triggers','D3-recovery-performance','E3-post-event-learning']
print(f"all 9 new measures present          : {all(n in ids for n in newids)}")
# retired v1 ids must be gone
retired = ['1.7-stakeholder-engagement','2.7-business-model-impact','1.1-board-oversight','2.3-acute-hazards']
print(f"v1 ids fully removed                : {not any(r in ids for r in retired)}")
ia = fw.get('intake_artefact') or {}
cl = ia.get('changelog') or []
print(f"changelog entries               : {len(cl)} (last version={cl[-1].get('version') if cl else None})")
print(f"\n[fw20-export] EXPORT_PATH={path}")
