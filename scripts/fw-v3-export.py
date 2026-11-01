#!/usr/bin/env python3
"""fw-v3-export.py — Export the production v3 framework
"Physical Climate Resilience and Business Continuity" (row + all 36 measures) to
a timestamped JSON under /home/ubuntu/shared/companyiq-programme/, MERGING the
full structured machine-readable objects (scopeTrack, attributionRequirement,
applicabilityRule, decisionPredicates[], coverageRule, crossMeasureExclusions[],
claimType, criticalGate, dimension) per measure from the content module, plus
framework-level DIMENSION_WEIGHTS, CRITICAL_MEASURE_SET and the changelog entry.
These structured objects are carried in the EXPORT ARTIFACT ONLY (not DB columns).
Read-only against the DB.

Usage:  python3 scripts/fw-v3-export.py [--tag v3_export]
"""
import psycopg2, psycopg2.extras, json, datetime, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_v3_content as C

URL = open('/home/ubuntu/.prod_db_url').read().strip()
OUTDIR = '/home/ubuntu/shared/companyiq-programme'
NEW_NAME = C.FRAMEWORK_CONFIG['name']
NEW_VERSION = C.FRAMEWORK_CONFIG['version']
tag = 'v3_export'
if '--tag' in sys.argv:
    tag = sys.argv[sys.argv.index('--tag') + 1]

dsn = psycopg2.extensions.parse_dsn(URL)
host = dsn.get('host')
print(f"[fw-v3-export] DB host: {host}:{dsn.get('port')} db={dsn.get('dbname')}")

conn = psycopg2.connect(URL)
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
cur.execute("SELECT * FROM frameworks WHERE name=%s AND version=%s", (NEW_NAME, NEW_VERSION))
fw = cur.fetchone()
if not fw:
    sys.exit(f"[fw-v3-export] FATAL: framework {NEW_NAME!r} v{NEW_VERSION} not found")
FID = fw['id']
cur.execute("SELECT * FROM framework_measures WHERE framework_id=%s ORDER BY display_order", (FID,))
measures = cur.fetchall()
conn.close()


def default(o):
    if isinstance(o, (datetime.datetime, datetime.date)):
        return o.isoformat()
    return str(o)


# merge structured machine-readable objects per measure (export artifact only)
measures_out = []
for m in measures:
    md = dict(m)
    struct = C.STRUCTURED.get(m['measure_id'])
    md['_machineReadable'] = struct  # scopeTrack, attributionRequirement, applicabilityRule, etc.
    measures_out.append(md)

missing_struct = [m['measure_id'] for m in measures if C.STRUCTURED.get(m['measure_id']) is None]

ts = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
path = os.path.join(OUTDIR, f'framework_v3_{tag}_{ts}.json')
payload = {
    'exportMeta': {
        'takenAtUTC': ts, 'dbHost': host, 'frameworkId': FID,
        'name': fw['name'], 'version': fw['version'],
        'isActive': fw['is_active'], 'productionReady': fw['production_ready'],
        'workspaceId': fw['workspace_id'], 'measureCount': len(measures),
    },
    'machineReadableModel': {
        'note': ('Structured decision model preserved for when the schema evolves; '
                 'the current binary engine enforces these via text in '
                 'substantive_definition and scoring_guidance. Not stored as DB columns.'),
        'dimensionWeights': C.DIMENSION_WEIGHTS,
        'criticalMeasureSet': C.CRITICAL_MEASURE_SET,
        'pillars': C.PILLARS,
        'queryFamilies': getattr(C, 'QUERY_FAMILIES', None),
    },
    'changelog': C.CHANGELOG_ENTRY,
    'framework': dict(fw),
    'measures': measures_out,
}
with open(path, 'w') as f:
    json.dump(payload, f, indent=2, default=default)

# ---------------- verification summary ----------------
from collections import Counter
print("\n================ VERIFICATION ================")
print(f"framework id    : {FID}")
print(f"name            : {fw['name']}")
print(f"version         : {fw['version']}   (expect 3)")
print(f"is_active       : {fw['is_active']}   (expect False)")
print(f"production_ready : {fw['production_ready']}   (expect False)")
print(f"workspace_id    : {fw['workspace_id']}   (expect 3)")
print(f"measure count   : {len(measures)}   (expect 36)")
sas = fw['sub_area_structure'] or {}
cats = [(c.get('letter'), c.get('name')) for c in sas.get('categories', [])]
print(f"pillars         : {cats}")
cn = Counter(m['category_number'] for m in measures)
print(f"by pillar       : {dict(sorted(cn.items()))}   (expect 1:6,2:8,3:11,4:6,5:2,6:3)")
print(f"structured objects merged: {len(measures)-len(missing_struct)}/{len(measures)} "
      f"(missing: {missing_struct or 'none'})")
print(f"dimensionWeights: {C.DIMENSION_WEIGHTS}")
print(f"criticalMeasureSet present: {C.CRITICAL_MEASURE_SET}")
print(f"\n[fw-v3-export] EXPORT_PATH={path}")
