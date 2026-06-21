#!/usr/bin/env python3
"""
Offline validation of the v3k-r15 auto-reexamination gate.

For each known company, this replicates EXACTLY the decision predicate used by
maybeAutoReexamine() in pipeline.ts:

    WOULD_RETRY  <=>  score <= 0
                       AND autoReexam.count < AUTO_REEXAM_MAX (2)
                       AND fetchCoverage.lowEvidence == true   (degraded retrieval)
                       AND corpusChars < AUTO_REEXAM_MAX_CHARS (100_000)

Expected outcomes:
  - ACWA Power (degraded, thin corpus) -> WOULD_RETRY = True
  - Ajinomoto (huge corpus)            -> WOULD_RETRY = False (thinCorpus False)
  - BHEL / others (legitimate)         -> WOULD_RETRY = False
"""
import os, sys, json
import psycopg2

AUTO_REEXAM_MAX = 2
AUTO_REEXAM_MAX_CHARS = 100_000

DBURL = open("/tmp/dburl.txt").read().strip()

# (label, name_like) — resolve IDs by name so we don't depend on stale IDs.
TARGETS = [
    ("ACWA Power",  "%ACWA%"),
    ("Ajinomoto",   "%Ajinomoto%"),
    ("BHEL",        "%Bharat Heavy%"),
]

EXPECTED = {
    "ACWA Power": True,
    "Ajinomoto": False,
    "BHEL": False,
}

def corpus_chars(cur, cid):
    cur.execute("""
        SELECT COALESCE(SUM(length(COALESCE(dc.content, d.content))), 0)
        FROM documents d LEFT JOIN document_content dc ON dc.id = d.content_id
        WHERE d.company_id = %s AND d.fetch_status = 'ok'
    """, (cid,))
    return int(cur.fetchone()[0] or 0)

def decide(score, diag, chars):
    coverage = (diag or {}).get("fetchCoverage")
    reexam = (diag or {}).get("autoReexam") or {"count": 0}
    if score is None:
        score = 0
    if score > 0:
        return False, "score>0"
    if (reexam.get("count") or 0) >= AUTO_REEXAM_MAX:
        return False, "retry budget exhausted"
    degraded = bool(coverage) and coverage.get("lowEvidence") is True
    thin = chars < AUTO_REEXAM_MAX_CHARS
    if not degraded or not thin:
        return False, f"legitimate zero (degraded={degraded}, thin={thin})"
    return True, "fetch-coverage artifact"

def main():
    conn = psycopg2.connect(DBURL)
    cur = conn.cursor()
    all_ok = True
    for label, like in TARGETS:
        cur.execute("""
            SELECT id, name, total_score, discovery_diagnostics
            FROM companies WHERE name ILIKE %s ORDER BY id LIMIT 1
        """, (like,))
        row = cur.fetchone()
        if not row:
            print(f"[{label}] NOT FOUND (like {like}) — skipping")
            continue
        cid, name, score, diag = row
        if isinstance(diag, str):
            diag = json.loads(diag)
        chars = corpus_chars(cur, cid)
        would, reason = decide(score, diag, chars)
        cov = (diag or {}).get("fetchCoverage") or {}
        exp = EXPECTED.get(label)
        status = "PASS" if (exp is None or would == exp) else "FAIL"
        if exp is not None and would != exp:
            all_ok = False
        print(f"[{label}] id={cid} name={name!r}")
        print(f"    score={score} corpusChars={chars:,} "
              f"lowEvidence={cov.get('lowEvidence')} fetchRatio={cov.get('fetchRatio')} "
              f"fetched={cov.get('documentsFetched')} dead={cov.get('documentsDead')} disc={cov.get('documentsDiscovered')}")
        print(f"    autoReexam={(diag or {}).get('autoReexam')}")
        print(f"    -> WOULD_RETRY={would} ({reason}) | expected={exp} | {status}")
        print()
    cur.close(); conn.close()
    print("OVERALL:", "ALL PASS" if all_ok else "SOME FAIL")
    sys.exit(0 if all_ok else 2)

if __name__ == "__main__":
    main()
