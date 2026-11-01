#!/usr/bin/env python3
"""fw20-apply-v2.py — apply Framework 20 v2 (Physical Climate Risk Management)
to the PRODUCTION DB, adapted to the binary scoring engine.

Modelled on apply_v4_changes.py: dry-run by DEFAULT; pass --commit to write in
ONE atomic transaction. On commit it:
  * DELETEs the 30 v1 framework_measures rows for framework_id=20 and INSERTs the
    27 authored v2 rows (FK-safe: no FK references framework_measures.id, and
    historical measure_scores reference (framework_id, measure_id) text and are
    left untouched as the v1 baseline).
  * UPDATEs the frameworks row: config R1-R7 + sub_area_structure, version 1->2,
    appends the changelog entry to intake_artefact.changelog. is_active unchanged.

Guards: backup file must exist; exactly 27 measures to insert; framework 20 must
currently be INACTIVE and hold 30 measures.
"""
import psycopg2, psycopg2.extras, json, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw20_v2_content as C

DRY = '--commit' not in sys.argv
URL = open('/home/ubuntu/.prod_db_url').read().strip()
FID = 20
BACKUP = '/home/ubuntu/shared/companyiq-programme/framework20_backup_20261101T015256Z.json'

# ---- frameworks-table columns we write (config change-set). All exist on the row. ----
CONFIG_COLS = list(C.FRAMEWORK_CONFIG.keys())  # sub_area_structure, anti_inference_rules, ... topic_description
# Which of those are jsonb (list/dict) vs plain text:
JSONB_CONFIG = {k for k, v in C.FRAMEWORK_CONFIG.items() if isinstance(v, (list, dict))}

# ---- framework_measures columns to insert (fixed order) ----
MEASURE_COLS = [
    "measure_id", "category", "category_number", "title", "definition",
    "scoring_guidance", "evidence_keywords", "display_order", "required_source_types",
    "primary_assessment_target", "substantive_definition", "what_constitutes_evidence",
    "what_does_not_constitute_evidence", "fallback_yes_criterion", "positive_examples",
    "negative_examples", "coverage_whitelist", "c1_achievement_guidance",
    "min_quote_context_chars", "expected_yes_rate", "disclosure_vehicles",
    "r3_1_exception_metrics", "r3_1_exception_coverage", "flagged_non_discriminating",
    "expected_yes_rate_justification",
]
JSONB_MEASURE = {"evidence_keywords", "required_source_types", "positive_examples",
                 "negative_examples", "coverage_whitelist", "c1_achievement_guidance",
                 "disclosure_vehicles"}

banner = "="*94
print(banner)
print(("FRAMEWORK 20 v2 — planned apply  [DRY RUN]" if DRY else "FRAMEWORK 20 v2 — COMMIT"))
print(banner)

# ---- preflight guards ----
if not os.path.exists(BACKUP):
    sys.exit(f"ABORT: backup not found: {BACKUP}")
print(f"Backup present: {BACKUP}")
assert len(C.MEASURES) == 27, f"expected 27 measures, got {len(C.MEASURES)}"
print(f"Authored v2 measures: {len(C.MEASURES)} (OK)")

conn = psycopg2.connect(URL); conn.autocommit = False
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
print(f"DB host: {psycopg2.extensions.parse_dsn(URL).get('host')}  db={psycopg2.extensions.parse_dsn(URL).get('dbname')}")

cur.execute("SELECT name, is_active, version FROM frameworks WHERE id=%s", (FID,))
fr = cur.fetchone()
if not fr: sys.exit(f"ABORT: framework {FID} not found")
print(f"Framework {FID}: name={fr['name']!r} is_active={fr['is_active']} version={fr['version']}")
if fr['is_active']:
    sys.exit("ABORT: framework 20 is ACTIVE — refusing to edit (safety).")
if fr['version'] != 1:
    print(f"  WARNING: current version is {fr['version']} (expected 1). v2 apply will set version=2.")

cur.execute("SELECT count(*) AS n FROM framework_measures WHERE framework_id=%s", (FID,))
n_cur = cur.fetchone()['n']
print(f"Current v1 measures in DB: {n_cur}")
if n_cur != 30:
    print(f"  WARNING: expected 30 v1 measures, found {n_cur}.")

# ---- diff summary ----
print("\n--- MEASURE CHANGE (v1 -> v2) ---")
print(f"  DELETE {n_cur} rows (framework_id={FID}) ; INSERT {len(C.MEASURES)} rows")
from collections import Counter
cn = Counter(m['category_number'] for m in C.MEASURES)
catname = {c['number']: c['name'] for c in C.PILLARS['categories']}
for num in sorted(cn):
    ids = [m['measure_id'] for m in C.MEASURES if m['category_number'] == num]
    print(f"    Pillar {num} {catname[num]:22s} ({cn[num]:2d}): {', '.join(ids)}")

print("\n--- FRAMEWORK-ROW CONFIG CHANGE (before -> after) ---")
cur.execute(f"SELECT {', '.join(CONFIG_COLS)}, version FROM frameworks WHERE id=%s", (FID,))
before = cur.fetchone()
def _summ(v):
    if isinstance(v, list): return f"list[{len(v)}]"
    if isinstance(v, dict): return f"dict(type={v.get('type')}, cats={len(v.get('categories',[]))})" if 'categories' in v else "dict"
    if v is None: return "NULL"
    s = str(v); return f"text[{len(s)}] {s[:60]!r}..."
for col in CONFIG_COLS:
    print(f"  {col:26s}: {_summ(before[col])}  ->  {_summ(C.FRAMEWORK_CONFIG[col])}")
# spot-check the targeted edits
af_after = [a['name'] for a in C.FRAMEWORK_CONFIG['anchor_frameworks']]
print(f"\n  anchor_frameworks after: SEC-removed={not any('SEC' in a for a in af_after)}, "
      f"CRIF-added={any('CRIF' in a for a in af_after)}, PCRAM-added={any('PCRAM' in a for a in af_after)}")
print(f"  negative_keywords after: 'renewable energy' present={'renewable energy' in C.FRAMEWORK_CONFIG['negative_keywords']}")
print(f"  required_doc_types after: transcript={any('transcript' in d.lower() for d in C.FRAMEWORK_CONFIG['required_doc_types'])}, "
      f"10-Q={any('10-Q' in d for d in C.FRAMEWORK_CONFIG['required_doc_types'])}, "
      f"FS-notes={any('Financial statement notes'==d for d in C.FRAMEWORK_CONFIG['required_doc_types'])}")
print(f"  version: {before['version']} -> 2 ; is_active: UNCHANGED")
print(f"\nChangelog entry to append: version={C.CHANGELOG_ENTRY['version']} date={C.CHANGELOG_ENTRY['date']} "
      f"({len(C.CHANGELOG_ENTRY['changes'])} change lines, {len(C.CHANGELOG_ENTRY['deferred'])} deferred)")

if DRY:
    print("\n[DRY RUN] no writes. Re-run with --commit to apply.")
    conn.rollback(); conn.close(); sys.exit(0)

# ---------------- COMMIT PATH (single atomic transaction) ----------------
print("\n[COMMIT] writing in one transaction...")
# 1) replace measures
cur.execute("DELETE FROM framework_measures WHERE framework_id=%s", (FID,))
ins_cols = ["framework_id"] + MEASURE_COLS + ["updated_at"]
placeholders = ["%s"] + ["%s::jsonb" if c in JSONB_MEASURE else "%s" for c in MEASURE_COLS] + ["now()"]
sql = f"INSERT INTO framework_measures ({', '.join(ins_cols)}) VALUES ({', '.join(placeholders)})"
for m in C.MEASURES:
    row = [FID]
    for col in MEASURE_COLS:
        v = m[col]
        row.append(json.dumps(v) if col in JSONB_MEASURE else v)
    cur.execute(sql, row)

# 2) update frameworks config
set_parts, vals = [], []
for col in CONFIG_COLS:
    if col in JSONB_CONFIG:
        set_parts.append(f"{col}=%s::jsonb"); vals.append(json.dumps(C.FRAMEWORK_CONFIG[col]))
    else:
        set_parts.append(f"{col}=%s"); vals.append(C.FRAMEWORK_CONFIG[col])
set_parts.append("version=2")
set_parts.append("updated_at=now()")
set_parts.append("""intake_artefact = jsonb_set(COALESCE(intake_artefact,'{}'::jsonb),'{changelog}',
                    (COALESCE(intake_artefact->'changelog','[]'::jsonb) || %s::jsonb))""")
vals.append(json.dumps(C.CHANGELOG_ENTRY))
cur.execute(f"UPDATE frameworks SET {', '.join(set_parts)} WHERE id=%s", vals + [FID])

# 3) verify counts inside txn
cur.execute("SELECT count(*) AS n FROM framework_measures WHERE framework_id=%s", (FID,))
n_new = cur.fetchone()['n']
cur.execute("SELECT version, is_active FROM frameworks WHERE id=%s", (FID,))
vr = cur.fetchone()
assert n_new == 27, f"post-insert count {n_new} != 27 — rolling back"
assert vr['version'] == 2, f"version {vr['version']} != 2 — rolling back"
conn.commit()
print(f"[COMMITTED] measures={n_new}, version={vr['version']}, is_active={vr['is_active']} (unchanged).")
conn.close()
