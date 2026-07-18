#!/usr/bin/env python3
import json

r12 = json.load(open("/home/ubuntu/companyiq-v3/r12_verdicts.json"))
diff = json.load(open("/home/ubuntu/companyiq-v3/prov_diff2_result.json"))

def v12(company, mid):
    for r in r12[company]:
        if r["measureId"] == mid:
            return r["verdict"], r["nQuotes"], r["score"]
    return None, None, None

print("=== COLLATERAL? candidates with r12 verdict + v3j/v3k pack source counts ===\n")
for company, rows in diff["detail"].items():
    for r in rows:
        if r["class"] != "COLLATERAL?":
            continue
        verdict, nq, score = v12(company, r["measureId"])
        print(f"[{company}] {r['measureId']}")
        print(f"    r12 verdict={verdict}  nQuotes={nq}  score={score}")
        print(f"    force {r['v3j_force']} -> {r['v3k_force']}")
        for u in r["lost_primary"]:
            print(f"    lost-primary: {u}")
        print()

# Also: for each company, which measures have a No verdict in r12 AND lost a force-include EDGAR_10K?
print("=== Measures where r12 force-include doc is NONE but should arguably be a filing (No verdict) ===\n")
for company, rows in diff["detail"].items():
    for r in rows:
        verdict, nq, score = v12(company, r["measureId"])
        if r["v3k_force"] == "NONE" and r["v3j_force"] in ("EDGAR_10K","COMPANY_PRIMARY") and verdict in ("No","Partial"):
            print(f"[{company}] {r['measureId']} r12={verdict} : force {r['v3j_force']}->NONE")
