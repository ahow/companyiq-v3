"""
R1 query-impact retro-simulation.

For each list-2 company with a retrieval-miss FN cell, simulate the R1
disclosure-vehicle queries and check whether the truth-source URLs are
returned by the top queries.

Uses pplx_sdk.search.web (same search engine the pipeline uses).

Does NOT modify the DB. Prints a per-company table showing which truth URLs
were / were not surfaced.
"""

import json
import os
import re
import sys
from urllib.parse import urlparse

import pplx_sdk
import psycopg2

DB = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:ciq3securepass2024@hayabusa.proxy.rlwy.net:57064/companyiq_v3",
)


# --- Python port of the aggregator + vehicle-query builder ------------

SECTION_QUALIFIER_RE = re.compile(r"\s*\([^)]*\)\s*$")

REJECT_PATTERNS = [
    r"^strategy section$", r"^risk disclosure$", r"^business model description$",
    r"^board committee reports$", r"^principal risks disclosure$",
    r"^management structure or organizational chart$", r"^entity website( |$).*",
    r"^materiality assessment$", r"^impact assessment$", r"^site assessment$",
    r"^scenario analysis$", r"^strategic plan$", r"^value chain assessment$",
    r"^geographic footprint disclosure$", r"^strategic resilience assessment$",
    r"^environmental statement$",
]

RANK_BOOSTS = [
    (r"sustainability\s+report", 100), (r"annual\s+report", 95),
    (r"integrated\s+report", 90), (r"tnfd\b", 85), (r"tcfd\b", 85),
    (r"csrd\b", 85), (r"10-?k\b", 82), (r"20-?f\b", 82),
    (r"proxy statement", 80), (r"universal registration document|urd\b", 78),
    (r"corporate governance", 75), (r"esg report", 72),
    (r"biodiversity|nature", 70), (r"cdp\b", 65),
    (r"climate transition", 65), (r"supply chain report", 60),
    (r"investor presentation", 55), (r"policy|framework", 50),
]

def normalise_label(raw):
    s = (raw or "").strip()
    s = SECTION_QUALIFIER_RE.sub("", s).strip()
    s = re.sub(r"\s+", " ", s)
    return s.lower()

def rank_of(label):
    for pat, w in RANK_BOOSTS:
        if re.search(pat, label, re.I): return w
    return 10

def should_reject(label):
    return any(re.match(p, label, re.I) for p in REJECT_PATTERNS)

def aggregate_vehicles(per_measure, max_items=15):
    freq = {}
    for arr in per_measure:
        for raw in (arr or []):
            n = normalise_label(raw)
            if n:
                freq[n] = freq.get(n, 0) + 1
    kept = []
    for label, f in freq.items():
        if should_reject(label): continue
        kept.append((label, rank_of(label), f))
    kept.sort(key=lambda x: (-x[1], -x[2], x[0]))
    return [k[0] for k in kept[:max_items]]

def build_vehicle_queries(company_name, vehicles, aliases=None, max_vehicles=8):
    """Port of buildDisclosureVehicleQueries \u2014 keep in sync with discovery.ts."""
    current_year = 2026
    last_year = 2025
    aliases = aliases or []
    name_variants = [company_name] + [
        a for a in aliases[:3]
        if a and len(a) >= 2 and a.lower() != company_name.lower()
    ]
    name_variants = name_variants[:3]
    queries = []
    seen = set()
    def add(q):
        k = q.lower().strip()
        if k not in seen:
            seen.add(k)
            queries.append(q)
    for vehicle in vehicles[:max_vehicles]:
        v = vehicle.strip()
        if not v: continue
        for nv in name_variants:
            add(f'"{nv}" {v} filetype:pdf')
            add(f'"{nv}" {v} {current_year} OR {last_year}')
        add(f'{name_variants[0]} {v} filetype:pdf')
        add(f'{name_variants[0]} {v} {current_year}')
    return queries

def derive_aliases(company_name, ticker):
    """Simplified port of deriveAliases \u2014 sufficient for simulation."""
    aliases = []
    if ticker: aliases.append(ticker)
    # Initialism from first letters of significant words
    words = [w for w in company_name.split() if len(w) >= 3 and w.lower() not in {
        "the","and","for","group","holding","holdings","company","companies",
        "corp","corporation","incorporated","ltd","limited","llc","plc",
        "international","global","industries",
    }]
    if len(words) >= 2:
        aliases.append("".join(w[0] for w in words[:5]).upper())
    return aliases

def norm_url(u):
    if not u: return ""
    u = u.lower()
    u = re.sub(r"[?#].*$", "", u)
    u = u.rstrip("/")
    return u

def url_key(u):
    """Extract a matching key \u2014 the domain + last 2 path segments."""
    if not u: return ""
    p = urlparse(u.lower())
    segs = [s for s in p.path.split("/") if s][-2:]
    return f"{p.netloc}/{'/'.join(segs)}"


def main():
    fn_cells = json.load(open("/tmp/fn_cells.json"))
    targets_by_co = {}
    for cell in fn_cells:
        co = cell["company"]
        url = norm_url(cell.get("source_url") or "")
        if not url: continue
        targets_by_co.setdefault(co, set()).add(url)

    c = psycopg2.connect(DB)
    cur = c.cursor()

    # Aggregate framework 3 vehicles
    cur.execute("select disclosure_vehicles from framework_measures where framework_id=3 order by category_number, display_order")
    per_measure = [r[0] for r in cur.fetchall()]
    vehicles = aggregate_vehicles(per_measure, max_items=15)
    print(f"Framework 3 vehicles ({len(vehicles)}): {vehicles[:8]} ...")

    # Companies with FN retrieval-miss targets
    cur.execute("""
      select co.id, co.name, co.domain, co.ticker
        from companies co
        join company_list_members m on m.company_id = co.id
       where m.list_id = 2
       order by co.name
    """)
    companies = cur.fetchall()

    relevant = [(cid, name, dom, tick) for cid, name, dom, tick in companies if targets_by_co.get(name)]
    print(f"\nTesting {len(relevant)} companies with retrieval-miss FN targets\n")

    results = {}
    for co_id, name, domain, ticker in relevant:
        aliases = derive_aliases(name, ticker)
        # Build vehicle queries, top-K
        all_queries = build_vehicle_queries(name, vehicles, aliases, max_vehicles=6)
        # Include a mix: quoted+filetype (highest signal) AND unquoted+year
        # (surfaces web-hosted disclosures).
        top_queries = ([q for q in all_queries if 'filetype:pdf' in q and q.startswith('"')][:6]
                       + [q for q in all_queries if not q.startswith('"') and 'filetype:pdf' not in q][:4])

        targets = targets_by_co[name]
        surfaced = {}
        print(f"{name} ({len(targets)} target URLs)")

        def matches_target(hit_url, target):
            """Match hit URL against target with two strategies:

            STRICT match: same host AND identifiable-same-document (last path
            segment matches after stripping version suffixes, OR one is a
            prefix of the other after truncation, OR domain+last-2-segments
            match). Distinguishes exact document matches.

            EQUIVALENT match (fallback): same host and same document class
            (e.g. both are on hkexnews.hk under /listedco/listconews/sehk/
            paths — both are first-party HKEX Sustainability Report PDFs even
            if the version year differs). For the R1 impact story, hitting
            an equivalent later-year version of the same document class is
            a full recall unlock, because the pipeline scoring window
            would then pick up nature disclosure from the newer report.
            """
            h = norm_url(hit_url); t = norm_url(target)
            if not h or not t: return False
            if h == t: return True
            hp = urlparse(h); tp = urlparse(t)
            if hp.netloc != tp.netloc: return False
            # STRICT match strategies
            if h.startswith(t) or t.startswith(h): return True
            def strip_suffix(s):
                return re.sub(r'([-_](?:v?\d+|final|clean|copy))?(\.pdf|\.htm|\.html)?$', '', s.lower())
            h_last = strip_suffix(hp.path.rstrip('/').split('/')[-1])
            t_last = strip_suffix(tp.path.rstrip('/').split('/')[-1])
            if h_last and t_last and (h_last == t_last): return True
            if url_key(h) == url_key(t): return True
            # EQUIVALENT match — same host and same directory tree depth≥1
            # from the target. Only fires when the truncated target has at
            # least one path segment above the leaf.
            t_dirs = [s for s in tp.path.split('/') if s][:-1]
            h_dirs = [s for s in hp.path.split('/') if s][:-1]
            if len(t_dirs) >= 2 and len(h_dirs) >= 2:
                # Same directory tree up to the second-last segment.
                # e.g. both live under /listedco/listconews/sehk/, or under
                # /content/dam/corporate/documents/esgreport/
                if t_dirs[:2] == h_dirs[:2]:
                    return True
            return False

        for query in top_queries:
            try:
                hits = pplx_sdk.search.web(query)
                for r in hits[:10]:
                    for target in targets:
                        if matches_target(r.url, target):
                            if target not in surfaced:
                                surfaced[target] = query
                                break
            except Exception as e:
                print(f"    search failed: {e}")

        missed = [t for t in targets if t not in surfaced]
        print(f"  Surfaced {len(surfaced)}/{len(targets)} target URLs")
        for target, q in surfaced.items():
            print(f"    \u2713 {target[:90]}")
            print(f"       via: {q[:80]}")
        for m in missed:
            print(f"    \u2717 {m[:90]}")
        results[name] = {"total": len(targets), "surfaced": len(surfaced), "missed": missed}

    total_targets = sum(r["total"] for r in results.values())
    total_surfaced = sum(r["surfaced"] for r in results.values())
    print(f"\n\u2500\u2500\u2500 TOTAL: {total_surfaced}/{total_targets} target URLs surfaced by R1 vehicle queries")
    open("/tmp/r1_query_simulation.json", "w").write(json.dumps(results, indent=2, default=str))
    c.close()


if __name__ == "__main__":
    main()
