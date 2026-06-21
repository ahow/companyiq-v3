#!/usr/bin/env python3
"""
Scan completed companies and classify each (near-)zero result as either a
FETCH-COVERAGE ARTIFACT (gate WOULD retry) or a LEGITIMATE zero (gate would NOT
retry), using the exact r15 predicate. Also prints aggregate counts so we can
gauge how many auto-reexaminations the gate would schedule across the cohort.
"""
import json, sys
import psycopg2

AUTO_REEXAM_MAX = 2
AUTO_REEXAM_MAX_CHARS = 100_000
DBURL = open("/tmp/dburl.txt").read().strip()

def main():
    conn = psycopg2.connect(DBURL); cur = conn.cursor()
    # All completed companies with score 0 (or null).
    cur.execute("""
        SELECT id, name, COALESCE(total_score,0) AS score, discovery_diagnostics
        FROM companies
        WHERE analysis_status = 'completed' AND COALESCE(total_score,0) <= 0
        ORDER BY id
    """)
    rows = cur.fetchall()
    would, wouldnt, no_diag = [], [], []
    for cid, name, score, diag in rows:
        if isinstance(diag, str):
            diag = json.loads(diag)
        diag = diag or {}
        cov = diag.get("fetchCoverage")
        reexam = diag.get("autoReexam") or {"count": 0}
        # corpus chars
        cur.execute("""
            SELECT COALESCE(SUM(length(COALESCE(dc.content,d.content))),0)
            FROM documents d LEFT JOIN document_content dc ON dc.id=d.content_id
            WHERE d.company_id=%s AND d.fetch_status='ok'
        """, (cid,))
        chars = int(cur.fetchone()[0] or 0)
        if not cov:
            no_diag.append((cid, name, chars))
            continue
        degraded = cov.get("lowEvidence") is True
        thin = chars < AUTO_REEXAM_MAX_CHARS
        budget_ok = (reexam.get("count") or 0) < AUTO_REEXAM_MAX
        if degraded and thin and budget_ok:
            would.append((cid, name, chars, cov))
        else:
            wouldnt.append((cid, name, chars, cov, degraded, thin, budget_ok))

    print(f"Completed zero-score companies: {len(rows)}")
    print(f"  WOULD auto-reexamine (fetch-coverage artifact): {len(would)}")
    print(f"  would NOT (legitimate / large / budget): {len(wouldnt)}")
    print(f"  no fetchCoverage diag yet: {len(no_diag)}")
    print()
    print("=== WOULD AUTO-REEXAMINE (sample up to 25) ===")
    for cid, name, chars, cov in would[:25]:
        print(f"  id={cid:<5} chars={chars:>8,} ratio={cov.get('fetchRatio')} "
              f"fetched={cov.get('documentsFetched')} dead={cov.get('documentsDead')} "
              f"disc={cov.get('documentsDiscovered')} | {name}")
    print()
    print("=== WOULD NOT (sample up to 15, with reason) ===")
    for cid, name, chars, cov, degraded, thin, budget_ok in wouldnt[:15]:
        reason = []
        if not degraded: reason.append("not-degraded")
        if not thin: reason.append("large-corpus")
        if not budget_ok: reason.append("budget-exhausted")
        print(f"  id={cid:<5} chars={chars:>9,} lowEv={cov.get('lowEvidence')} "
              f"ratio={cov.get('fetchRatio')} | {','.join(reason)} | {name}")
    cur.close(); conn.close()

if __name__ == "__main__":
    main()
