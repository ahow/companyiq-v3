#!/usr/bin/env python3
"""
Deterministic v3j -> v3k evidence-pack provenance diff.

For each company/measure, compares the SET of source-document URLs present in the
evidence pack (and the force-included annual filing) between the v3j baseline and
v3k (HEAD). Classifies each measure as:
  - SAME           : identical source set
  - ENFORCED       : v3j had a mirror/proxy/quarterly source that v3k removed
                     (i.e. a source-quality improvement)
  - GAINED_PRIMARY : v3k added an EDGAR-primary/10-K source not in v3j
  - SUPPRESSED?     : v3k lost a source that is NOT a mirror/proxy/quarterly
                     (potential collateral suppression -> needs review)
"""
import json, re, sys, os

COMPANIES = ["amazon", "oracle", "meta", "salesforce", "alphabet"]

def load(name, build):
    p = f"/tmp/{name}_{build}_prov.json"
    if not os.path.exists(p):
        return None
    return json.load(open(p))

MIRROR_HOSTS = ("stocklight.com", "fortune.com", "annualreports.com", "last10k.com",
                "bullfincher.io", "wisesheets", "wheresyoured.at")

def host(u):
    m = re.match(r"https?://([^/]+)", u or "")
    return (m.group(1) if m else u or "").lower()

def is_edgar(u):
    return "sec.gov/archives/edgar" in (u or "").lower()

def is_mirror(u):
    h = host(u)
    return any(mh in h for mh in MIRROR_HOSTS) or (("annual" in (u or "").lower() or "10-k" in (u or "").lower() or "10k" in (u or "").lower()) and not is_edgar(u) and "pdf" in (u or "").lower())

# EDGAR accession-form heuristics for quarterly vs annual via the doc stem date is
# not reliable from URL alone; we instead rely on the recorded forceIncludedDocUrl
# change and whether the dropped doc is a known 10-Q stem. We mark EDGAR docs whose
# stem date differs from the v3k forced 10-K as "other-period EDGAR" (informational).

def classify_change(v3j_srcs, v3k_srcs, v3j_force, v3k_force):
    sj, sk = set(v3j_srcs), set(v3k_srcs)
    if sj == sk and (v3j_force or "") == (v3k_force or ""):
        return "SAME", []
    dropped = sj - sk
    gained = sk - sj
    notes = []
    enforced = False
    suppressed = []
    for d in dropped:
        if is_mirror(d):
            enforced = True; notes.append(f"dropped MIRROR {d}")
        elif is_edgar(d):
            notes.append(f"dropped EDGAR(other-period) {d}")
        else:
            suppressed.append(d); notes.append(f"dropped OTHER {d}")
    for g in gained:
        if is_edgar(g):
            notes.append(f"gained EDGAR {g}")
        else:
            notes.append(f"gained {g}")
    # force-include change is the strongest signal for filing-bound measures
    if (v3j_force or "") != (v3k_force or ""):
        notes.append(f"FORCE {v3j_force or '∅'} -> {v3k_force or '∅'}")
    if suppressed:
        return "SUPPRESSED?", notes
    if enforced or ((v3j_force or "") != (v3k_force or "")):
        return "ENFORCED", notes
    if gained:
        return "GAINED_PRIMARY", notes
    return "CHANGED", notes

def main():
    summary_rows = []
    detail = {}
    for name in COMPANIES:
        vj = load(name, "v3j"); vk = load(name, "HEAD")
        if not vj or not vk:
            print(f"!! missing data for {name}"); continue
        mj = {m["measureId"]: m for m in vj["measures"]}
        mk = {m["measureId"]: m for m in vk["measures"]}
        rows = []
        tally = {}
        for mid in sorted(set(mj) | set(mk)):
            a = mj.get(mid, {}); b = mk.get(mid, {})
            cls, notes = classify_change(a.get("sources", []), b.get("sources", []),
                                         a.get("forceIncludedDocUrl"), b.get("forceIncludedDocUrl"))
            tally[cls] = tally.get(cls, 0) + 1
            rows.append((mid, cls, notes))
        detail[name] = rows
        summary_rows.append((name, vj.get("reservedAnnualUrl",""), vk.get("reservedAnnualUrl",""), tally))
        print(f"\n===== {vj['company']}  (v3j corpusDocs={len(vj['corpusSourceUrls'])} -> v3k={len(vk['corpusSourceUrls'])}) =====")
        print(f"  v3j reservedAnnualUrl: {vj.get('reservedAnnualUrl','') or '(none)'}")
        print(f"  v3k reservedAnnualUrl: {vk.get('reservedAnnualUrl','') or '(none)'}")
        print(f"  tally: {tally}")
        for mid, cls, notes in rows:
            if cls != "SAME":
                print(f"   [{cls:14}] {mid}")
                for n in notes:
                    print(f"        - {n}")
    # write machine-readable
    json.dump({"summary":[{"company":r[0],"v3j_reserved":r[1],"v3k_reserved":r[2],"tally":r[3]} for r in summary_rows],
               "detail":{k:[{"measureId":x[0],"class":x[1],"notes":x[2]} for x in v] for k,v in detail.items()}},
              open("/home/ubuntu/companyiq-v3/prov_diff_result.json","w"), indent=2)
    print("\nwrote prov_diff_result.json")

if __name__ == "__main__":
    main()
