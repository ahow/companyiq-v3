#!/usr/bin/env python3
"""fw-v3-apply.py — apply the NEW v3 framework
"Physical Climate Resilience and Business Continuity" (36 measures, 6 pillars
G/U/A/P/R/L) to the PRODUCTION DB as a SEPARATE, INACTIVE framework row.

Modelled on fw20-apply-v2.py but, unlike it, this INSERTS a brand-new frameworks
row (it does NOT update or delete framework 20). Dry-run by DEFAULT; pass
--commit to write in ONE atomic transaction.

On --commit it:
  * INSERTs a new frameworks row (workspace_id=3, version=3, is_active=false,
    production_ready=false, builder_version per content module). Base config is
    the framework-20 pre-baseline backup dict (carries every jsonb config field);
    FRAMEWORK_CONFIG overrides are merged on top; ANCHOR_FRAMEWORKS_ADD is
    appended to the base anchor_frameworks; intake_artefact gets the v3 changelog
    and records derivation from framework 20.
  * INSERTs the 36 authored framework_measures rows against the new framework_id.

SAFETY: framework 20 (v2, 27 measures) and framework 21 are never read-modified
or written. This only ever INSERTs. Idempotent: aborts if a framework row with
the v3 name + version 3 already exists.
"""
import psycopg2, psycopg2.extras, json, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_v3_content as C

DRY = '--commit' not in sys.argv
URL = open('/home/ubuntu/.prod_db_url').read().strip()
BACKUP = '/home/ubuntu/shared/companyiq-programme/framework20_prebaseline_v3_backup_20261101T113828Z.json'
SOURCE_FID = 20  # framework we derive base config from (read-only)

# ---- framework_measures columns to insert (fixed order; matches fw20-apply) ----
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

# ---- frameworks-table column typing ----
FW_TEXT_COLS = {"name", "topic_description", "builder_version", "topic_term",
                "sensitivity_preference", "scoring_persona"}
FW_INT_COLS = {"workspace_id", "version"}
FW_BOOL_COLS = {"is_active", "is_shared", "production_ready"}
# identity / server-managed — never written explicitly
FW_SKIP_COLS = {"id", "created_at", "updated_at"}

banner = "=" * 94
print(banner)
print("FRAMEWORK v3 (NEW ROW) — planned apply  [DRY RUN]" if DRY else "FRAMEWORK v3 (NEW ROW) — COMMIT")
print(banner)

# ---- preflight guards ----
if not os.path.exists(BACKUP):
    sys.exit(f"ABORT: base backup not found: {BACKUP}")
print(f"Base backup present: {BACKUP}")
assert len(C.MEASURES) == 36, f"expected 36 measures, got {len(C.MEASURES)}"
assert len({m['measure_id'] for m in C.MEASURES}) == 36, "duplicate measure_id"
print(f"Authored v3 measures: {len(C.MEASURES)} (OK)")

NEW_NAME = C.FRAMEWORK_CONFIG['name']
NEW_VERSION = C.FRAMEWORK_CONFIG['version']

# ---- build the merged frameworks row dict ----
base = json.load(open(BACKUP))['framework']
row = {k: v for k, v in base.items() if k not in FW_SKIP_COLS}
# merge config overrides
for k, v in C.FRAMEWORK_CONFIG.items():
    row[k] = v
# append anchor frameworks (base + ADD), de-duplicated on name
base_anchors = base.get('anchor_frameworks') or []
have = {a.get('name') for a in base_anchors}
row['anchor_frameworks'] = base_anchors + [a for a in C.ANCHOR_FRAMEWORKS_ADD if a.get('name') not in have]
# hard-pin identity / state
row['name'] = NEW_NAME
row['version'] = NEW_VERSION
row['workspace_id'] = 3
row['is_active'] = False
row['production_ready'] = False
# v3 intake_artefact: fresh changelog + derivation record (do not inherit fw20 history)
row['intake_artefact'] = {
    'changelog': [C.CHANGELOG_ENTRY],
    'derived_from_framework_id': SOURCE_FID,
    'derived_from_version': base.get('version'),
}

conn = psycopg2.connect(URL); conn.autocommit = False
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
dsn = psycopg2.extensions.parse_dsn(URL)
print(f"DB host: {dsn.get('host')}:{dsn.get('port')}  db={dsn.get('dbname')}")

# ---- idempotency guard ----
cur.execute("SELECT id FROM frameworks WHERE name=%s AND version=%s", (NEW_NAME, NEW_VERSION))
existing = cur.fetchone()
if existing:
    print(f"\nALREADY APPLIED: framework id={existing['id']} name={NEW_NAME!r} version={NEW_VERSION} exists.")
    print("Nothing to do (idempotent). Exiting without writes.")
    conn.rollback(); conn.close(); sys.exit(0)

# ---- confirm source framework untouched/readable (read-only) ----
cur.execute("SELECT name, version, is_active, production_ready FROM frameworks WHERE id=%s", (SOURCE_FID,))
src = cur.fetchone()
print(f"Source fw{SOURCE_FID}: name={src['name']!r} version={src['version']} "
      f"is_active={src['is_active']} production_ready={src['production_ready']} (READ-ONLY, untouched)")

# resolve columns to insert = keys that are real columns
cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name='frameworks'")
valid_cols = {r['column_name'] for r in cur.fetchall()}
insert_cols = [c for c in row.keys() if c in valid_cols and c not in FW_SKIP_COLS]
skipped = [c for c in row.keys() if c not in valid_cols]
if skipped:
    print(f"  NOTE: dropping non-column keys: {skipped}")

# ---- plan summary ----
from collections import Counter
print("\n--- NEW FRAMEWORK ROW ---")
print(f"  name            : {NEW_NAME}")
print(f"  workspace_id    : {row['workspace_id']}")
print(f"  version         : {row['version']}")
print(f"  is_active       : {row['is_active']}")
print(f"  production_ready : {row['production_ready']}")
print(f"  builder_version : {row.get('builder_version')}")
print(f"  topic_term      : {row.get('topic_term')!r}")
print(f"  anchor_frameworks: {len(row['anchor_frameworks'])} ({len(base_anchors)} base + {len(row['anchor_frameworks'])-len(base_anchors)} added)")
print(f"  config columns written: {len(insert_cols)}")

print("\n--- 36 MEASURES BY PILLAR ---")
cn = Counter(m['category_number'] for m in C.MEASURES)
catname = {c['number']: c['name'] for c in C.PILLARS['categories']}
catletter = {c['number']: c['letter'] for c in C.PILLARS['categories']}
for num in sorted(cn):
    ids = [m['measure_id'] for m in C.MEASURES if m['category_number'] == num]
    print(f"  Pillar {num} {catletter[num]} {catname[num]:26s} ({cn[num]:2d}): {', '.join(ids)}")
print(f"  critical gate   : {C.CRITICAL_MEASURE_SET}")

if DRY:
    print("\n[DRY RUN] no writes. Re-run with --commit to apply.")
    conn.rollback(); conn.close(); sys.exit(0)

# ---------------- COMMIT PATH (single atomic transaction) ----------------
print("\n[COMMIT] writing in one transaction...")

# 1) INSERT frameworks row
fw_placeholders = []
fw_vals = []
for col in insert_cols:
    v = row[col]
    if col in FW_TEXT_COLS or col in FW_INT_COLS or col in FW_BOOL_COLS:
        fw_placeholders.append("%s"); fw_vals.append(v)
    else:  # jsonb
        fw_placeholders.append("%s::jsonb"); fw_vals.append(json.dumps(v))
sql_fw = (f"INSERT INTO frameworks ({', '.join(insert_cols)}, created_at, updated_at) "
          f"VALUES ({', '.join(fw_placeholders)}, now(), now()) RETURNING id")
cur.execute(sql_fw, fw_vals)
new_id = cur.fetchone()['id']
print(f"  inserted frameworks row id={new_id}")

# 2) INSERT 36 measures
ins_cols = ["framework_id"] + MEASURE_COLS + ["updated_at"]
placeholders = ["%s"] + ["%s::jsonb" if c in JSONB_MEASURE else "%s" for c in MEASURE_COLS] + ["now()"]
sql_m = f"INSERT INTO framework_measures ({', '.join(ins_cols)}) VALUES ({', '.join(placeholders)})"
for m in C.MEASURES:
    r = [new_id]
    for col in MEASURE_COLS:
        v = m[col]
        if col in JSONB_MEASURE:
            r.append(json.dumps(v) if v is not None else None)
        else:
            r.append(v)
    cur.execute(sql_m, r)

# 3) verify counts inside txn
cur.execute("SELECT count(*) AS n FROM framework_measures WHERE framework_id=%s", (new_id,))
n_new = cur.fetchone()['n']
cur.execute("SELECT version, is_active, production_ready, workspace_id FROM frameworks WHERE id=%s", (new_id,))
vr = cur.fetchone()
assert n_new == 36, f"post-insert count {n_new} != 36 — rolling back"
assert vr['version'] == 3, f"version {vr['version']} != 3 — rolling back"
assert vr['is_active'] is False, "is_active must be False — rolling back"
assert vr['production_ready'] is False, "production_ready must be False — rolling back"
# confirm fw20 untouched within the same snapshot
cur.execute("SELECT version, (SELECT count(*) FROM framework_measures WHERE framework_id=%s) AS n FROM frameworks WHERE id=%s",
            (SOURCE_FID, SOURCE_FID))
s = cur.fetchone()
assert s['version'] == 2 and s['n'] == 27, f"fw20 changed unexpectedly (version={s['version']}, measures={s['n']}) — rolling back"
conn.commit()
print(f"[COMMITTED] new framework id={new_id}, measures={n_new}, version={vr['version']}, "
      f"is_active={vr['is_active']}, production_ready={vr['production_ready']}, workspace_id={vr['workspace_id']}")
print(f"[COMMITTED] fw{SOURCE_FID} unchanged: version={s['version']}, measures={s['n']}")
conn.close()
