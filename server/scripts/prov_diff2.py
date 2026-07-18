#!/usr/bin/env python3
"""
Primary-source-aware v3j->v3k evidence-pack provenance diff.

For each measure, compare the evidence-pack SOURCE set and the force-included doc
between v3j (a8ec9b6) and v3k (HEAD-r12), and classify the change by its effect on
verdict-driving PRIMARY evidence:

  ENFORCED        v3k removed a mirror / DEF14A-proxy(as-annual) / quarterly-as-annual
                  from the force-include or pack -> correct source-quality enforcement
  GAINED_PRIMARY  v3k force-include now anchors a current EDGAR primary 10-K it didn't before
  COLLATERAL?     v3k LOST a company primary disclosure source (10-K / proxy / sustainability /
                  IR) with NO equal-or-better primary replacement -> candidate over-suppression
  NEUTRAL_CHURN   only secondary/web sources reshuffled; primary-source set unchanged
  SAME            identical pack sources + force doc
"""
import json, re

COMPANIES = ["amazon", "oracle", "meta", "salesforce", "alphabet"]

MIRROR_HOSTS = ("stocklight.com", "fortune.com", "wsj.com", "annualreports.com",
                "stocktitan.net", "bullfincher.io", "last10k.com", "wisesheets.io",
                "stockanalysis.com", "moomoo.com", "tipranks.com", "marketbeat.com",
                "simplywall.st", "wallmine.com")

def host(u):
    m = re.match(r'https?://([^/]+)/?', u or "")
    return m.group(1).lower() if m else ""

def is_edgar(u):
    return "sec.gov/archives/edgar" in (u or "").lower()

def is_edgar_primary_10k(u):
    """EDGAR current 10-K filing: -YYYYMMDD.htm form (not exhibit, not px14a6g, not def14a)."""
    if not is_edgar(u):
        return False
    low = u.lower()
    if "px14a6g" in low or "def14a" in low or "pre14a" in low or "_ex" in low or "ex99" in low \
       or "dex" in low or "sc13g" in low or "ltr" in low:
        return False
    return bool(re.search(r'/[a-z]+-\d{8}\.htm', low))

def is_proxy(u):
    low = (u or "").lower()
    return "def14a" in low or "pre14a" in low or "px14a6g" in low

def is_mirror(u):
    return host(u) in MIRROR_HOSTS

def is_company_primary(u, company):
    """Company-owned authoritative disclosure (IR site, sustainability report, official domain)."""
    h = host(u)
    low = (u or "").lower()
    company_domains = {
        "amazon": ("amazon.com", "aboutamazon.com", "aws.amazon.com", "q4cdn.com", "ir.aboutamazon.com"),
        "oracle": ("oracle.com", "blogs.oracle.com", "investor.oracle.com", "q4cdn.com"),
        "meta": ("meta.com", "fb.com", "about.fb.com", "investor.fb.com", "q4cdn.com", "transparency.fb.com", "ai.meta.com"),
        "salesforce": ("salesforce.com", "investor.salesforce.com", "q4cdn.com"),
        "alphabet": ("alphabet.com", "abc.xyz", "google.com", "blog.google", "sustainability.google", "q4cdn.com", "gstatic.com", "googleapis.com"),
    }
    doms = company_domains.get(company, ())
    if any(d in h for d in doms):
        return True
    # generic sustainability/annual-report PDFs hosted on IR CDNs
    if h.endswith("q4cdn.com") and low.endswith(".pdf"):
        return True
    return False

def classify_url(u, company):
    if is_mirror(u):
        return "MIRROR"
    if is_edgar_primary_10k(u):
        return "EDGAR_10K"
    if is_proxy(u):
        return "PROXY"
    if is_edgar(u):
        return "EDGAR_OTHER"   # exhibit / off-period / sc13g etc.
    if is_company_primary(u, company):
        return "COMPANY_PRIMARY"
    return "SECONDARY"

PRIMARY_KINDS = {"EDGAR_10K", "COMPANY_PRIMARY"}  # verdict-grade primary disclosure

def load(company, ref):
    return json.load(open(f"/tmp/{company}_{ref}_prov.json"))

summary = []
detail = {}
for company in COMPANIES:
    j = load(company, "v3j")
    k = load(company, "HEAD")
    jm = {m["measureId"]: m for m in j["measures"]}
    km = {m["measureId"]: m for m in k["measures"]}
    rows = []
    tally = {}
    for mid in sorted(km.keys()):
        a = jm.get(mid)
        b = km[mid]
        if a is None:
            continue
        ja_src = set(a.get("sources", []))
        kb_src = set(b.get("sources", []))
        jf = (a.get("forceIncludedDocUrl") or "").split("?")[0]
        kf = (b.get("forceIncludedDocUrl") or "").split("?")[0]
        jf_kind = classify_url(jf, company) if jf else "NONE"
        kf_kind = classify_url(kf, company) if kf else "NONE"

        dropped = ja_src - kb_src
        gained  = kb_src - ja_src
        dropped_kinds = {u: classify_url(u, company) for u in dropped}
        gained_kinds  = {u: classify_url(u, company) for u in gained}

        # primary-source sets
        j_primary = {u for u in ja_src if classify_url(u, company) in PRIMARY_KINDS}
        k_primary = {u for u in kb_src if classify_url(u, company) in PRIMARY_KINDS}
        lost_primary = j_primary - k_primary
        gained_primary = k_primary - j_primary

        cls = None
        reasons = []

        # 1) force-include cleaned up (mirror/proxy/quarterly -> EDGAR 10-K)
        if jf_kind in ("MIRROR", "PROXY", "EDGAR_OTHER") and kf_kind == "EDGAR_10K":
            cls = "ENFORCED"; reasons.append(f"force-include {jf_kind}->EDGAR_10K")
        # 2) a mirror was dropped from the pack
        elif any(v == "MIRROR" for v in dropped_kinds.values()):
            cls = "ENFORCED"; reasons.append("mirror removed from pack")
        # 3) force-include now EDGAR 10-K where it wasn't a primary before
        elif kf_kind == "EDGAR_10K" and jf_kind not in ("EDGAR_10K",):
            cls = "GAINED_PRIMARY"; reasons.append(f"force-include now EDGAR_10K (was {jf_kind})")
        # 4) gained a primary, lost none
        elif gained_primary and not lost_primary:
            cls = "GAINED_PRIMARY"; reasons.append("gained primary, lost none")
        # 5) lost a primary with no replacement -> candidate collateral
        elif lost_primary and not gained_primary:
            cls = "COLLATERAL?"; reasons.append("lost primary, no primary replacement")
        # 6) primary set unchanged -> neutral churn / same
        else:
            if ja_src == kb_src and jf == kf:
                cls = "SAME"
            else:
                cls = "NEUTRAL_CHURN"; reasons.append("only secondary/web sources reshuffled")

        tally[cls] = tally.get(cls, 0) + 1
        rows.append({
            "measureId": mid, "class": cls,
            "v3j_force": jf_kind, "v3k_force": kf_kind,
            "lost_primary": sorted(lost_primary),
            "gained_primary": sorted(gained_primary),
            "dropped": {u: dropped_kinds[u] for u in dropped if dropped_kinds[u] in ("MIRROR","PROXY","EDGAR_OTHER","EDGAR_10K","COMPANY_PRIMARY")},
            "reasons": reasons,
        })
    detail[company] = rows
    summary.append({"company": company,
                    "v3j_reserved": j.get("reservedAnnualUrl",""),
                    "v3k_reserved": k.get("reservedAnnualUrl",""),
                    "tally": tally})

print("=== SUMMARY (per-measure pack-provenance classification) ===")
for s in summary:
    print(f"{s['company']:11} {s['tally']}")
print()
print("=== COLLATERAL? candidates (potential over-suppression) ===")
any_col = False
for company in COMPANIES:
    for r in detail[company]:
        if r["class"] == "COLLATERAL?":
            any_col = True
            print(f"[{company}] {r['measureId']}: force {r['v3j_force']}->{r['v3k_force']}")
            for u in r["lost_primary"]:
                print(f"     LOST PRIMARY: {u}")
if not any_col:
    print("(none)")

json.dump({"summary": summary, "detail": detail},
          open("/home/ubuntu/companyiq-v3/prov_diff2_result.json","w"), indent=2)
print("\nwrote prov_diff2_result.json")
