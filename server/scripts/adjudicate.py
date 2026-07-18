#!/usr/bin/env python3
"""
Adjudicate every Yes->non-Yes flip:
 - Look at the v3j citation(s) that produced the Yes.
 - Classify the LOST source. If it was a mirror / 10-Q / DEF14A / marketing/non-authoritative,
   the drop is ENFORCED (correct source-quality enforcement).
 - If v3j cited a legitimate EDGAR-primary 10-K that v3k no longer has anywhere, flag COLLATERAL.
Also report No->Yes flips (improvements).
"""
import json
rows = json.load(open("/home/ubuntu/companyiq-v3/verdict_diff.json"))

def best_cls(cites):
    """Return the most-authoritative classification among a measure's citations."""
    order = ["EDGAR-primary","SEC-other","EDGAR-DEF14A-proxy","third-party-mirror",
             "company-marketing","other-web","no-url"]
    present = [c["cls"] for c in cites]
    for o in order:
        if o in present:
            return o
    return "none"

def has_edgar_primary(cites):
    return any(c["cls"]=="EDGAR-primary" for c in cites)

def adjudicate(r):
    va, vb = r["v3j_verdict"], r["v3k_verdict"]
    ca, cb = r["v3j_cites"], r["v3k_cites"]
    if va=="Yes" and vb!="Yes":
        # what did v3j rely on?
        j_primary = has_edgar_primary(ca)
        k_primary = has_edgar_primary(cb)
        j_best = best_cls(ca)
        if not j_primary:
            # v3j Yes was built on a non-EDGAR-primary source -> enforcement
            return "ENFORCED", f"v3j Yes relied on {j_best} (no EDGAR primary); removed by source-quality gate"
        else:
            # v3j had an EDGAR primary. Did v3k keep any EDGAR primary?
            if k_primary:
                return "RESAMPLE", "v3j & v3k both have EDGAR primary in pack; verdict flip is grader resampling, not source loss"
            else:
                return "COLLATERAL?", "v3j cited EDGAR primary; v3k pack lost EDGAR primary for this measure"
    if va!="Yes" and vb=="Yes":
        return "IMPROVED", f"v3k now cites {best_cls(cb)}"
    return "OTHER", f"{va}->{vb}"

out=[]
for r in rows:
    verdict, reason = adjudicate(r)
    out.append({**r, "classification": verdict, "reason": reason})

json.dump(out, open("/home/ubuntu/companyiq-v3/verdict_diff_adjudicated.json","w"), indent=2)

# Summary by classification
from collections import Counter
c = Counter(o["classification"] for o in out)
print("Classification tally:", dict(c))
print()

# Detail for Yes->No flips, grouped by company
for comp in ["Amazon","Oracle","Meta","NVIDIA","Microsoft","Alphabet","Salesforce","360 Security"]:
    crs=[o for o in out if o["company"]==comp]
    if not crs: continue
    print(f"\n===== {comp} =====")
    for o in crs:
        print(f"  [{o['classification']}] {o['measureId']}  {o['v3j_verdict']}->{o['v3k_verdict']}")
        print(f"     {o['title'][:80]}")
        print(f"     reason: {o['reason']}")
        if o["v3j_verdict"]=="Yes":
            for ct in o["v3j_cites"]:
                print(f"     v3j<- [{ct['cls']}] {ct['form']} {ct['source']} :: {ct['url']}")
        for ct in o["v3k_cites"]:
            print(f"     v3k-> [{ct['cls']}] {ct['form']} {ct['source']} :: {ct['url']}")
