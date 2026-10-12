import json,re,collections
D=json.load(open('/tmp/recon_docs.json'))
NAMES={9:'CSX',10:'MAGNA',11:'Southern',14:'DARDEN',15:'BCE',19:'CELESTICA',20:'Dominion',21:'Power Assets',24:'AXA',25:'OTSUKA',29:'Idemitsu',30:'BARRATT'}
W0,W1='2026-10-12T01:24:46','2026-10-12T02:18:04'
seen=set();logs=[]
for f in ["/tmp/wklogs_w1.json","/tmp/wklogs_w2.json","/tmp/wklogs_cf79e5a7.json","/tmp/wklogs_w4.json"]:
    for e in json.load(open(f)):
        k=(e["timestamp"],e["message"])
        if k in seen: continue
        seen.add(k);logs.append(e)
logs=[e for e in logs if W0<=e["timestamp"][:19]<=W1]
url2co=collections.defaultdict(set)
for d in D['docs']: url2co[d['url']].add(d['company_id'])
U=re.compile(r"https?://[^\s'\")]+")
FAIL=[("browser-launch-failed",re.compile(r"Browser fetch failed for |Force-headless failed for .*launch failed|browser launch failed|Failed to launch the browser")),
      ("browser-unavailable-left-retryable",re.compile(r"Browser temporarily unavailable for")),
      ("timeout-marked-dead",re.compile(r"TIMEOUT .*marking dead")),
      ("http-fetch-failed",re.compile(r"HTTP fetch failed for |Direct PDF fetch failed for |non-2xx \(\d+\) for "))]
REC=[("firecrawl",re.compile(r"Strategy Firecrawl: recovered (\d+) chars from")),
     ("deferred-retry",re.compile(r"deferred retry recovered (\d+) chars from")),
     ("browser-pdf",re.compile(r"Browser-PDF fetch succeeded for")),
     ("browser-render",re.compile(r"Browser fetch succeeded for|rendered .* chars|browser fallback recovered",re.I))]
def cos(url):
    url=url.rstrip('.,:;')
    if url in url2co: return url2co[url],url
    for u,cs in url2co.items():
        if len(url)>40 and (u.startswith(url) or url.startswith(u)): return cs,u
    return set(),url
ev=collections.defaultdict(lambda: collections.defaultdict(set))  # co -> url -> set(tags)
unmapped=collections.Counter()
for e in logs:
    m=e["message"]
    tags=[t for t,p in FAIL if p.search(m)]+["REC:"+t for t,p in REC if p.search(m)]
    if not tags: continue
    us=U.findall(m)
    if not us: continue
    cs,u=cos(us[0])
    if not cs: unmapped[tags[0]]+=1; continue
    for c in cs:
        if c in NAMES:
            for t in tags: ev[c][u].add(t)
out={}
for c,n in NAMES.items():
    docs=[d for d in D['docs'] if d['company_id']==c]
    touched=[d for d in docs if W0<=(d['fetched_at'] or '')[:19]<=W1 or W0<=(d['created_at'] or '')[:19]<=W1]
    dead=[d for d in docs if d['fetch_status']=='dead']
    deadW=[d for d in touched if d['fetch_status']=='dead']
    pend=[d for d in docs if d['fetch_status']=='pending']
    okfail=[d for d in docs if d['fetch_status']=='ok' and d['fetch_failures']>0]
    okzero=[d for d in docs if d['fetch_status']=='ok' and (d['clen'] or 0)==0]
    logfail={u:t for u,t in ev[c].items() if any(not x.startswith('REC:') for x in t)}
    recovered={u:t for u,t in logfail.items() if any(x.startswith('REC:') for x in t)}
    status={d['url']:d for d in docs}
    unrec={u:t for u,t in logfail.items() if u not in recovered}
    unrec_ok={u for u in unrec if status.get(u,{}).get('fetch_status')=='ok' and (status[u]['clen'] or 0)>0}
    gap=[u for u in unrec if u not in unrec_ok]
    out[n]=dict(company_id=c,docs_total=len(docs),docs_touched_in_batch=len(touched),ok=sum(d['fetch_status']=='ok' for d in docs),
        dead_total=len(dead),dead_touched_in_batch=len(deadW),pending=len(pend),ok_after_failures=len(okfail),ok_zero_content=len(okzero),
        dead_reasons=dict(collections.Counter(d['failure_reason'] for d in dead)),
        dead_first_party_accepted=sum(1 for d in dead if d['source_type']=='first_party' and d['gate_verdict']!='reject'),
        log_failed_urls=len(logfail),log_failed_launch=sum(1 for t in logfail.values() if 'browser-launch-failed' in t or 'browser-unavailable-left-retryable' in t),
        log_recovered_via_fallback=len(recovered),recovered_by=dict(collections.Counter(x for t in recovered.values() for x in t if x.startswith('REC:'))),
        log_failed_but_ok_in_db=len(unrec_ok),log_failed_unrecovered=len(gap),
        gap_urls=[(u,status.get(u,{}).get('fetch_status'),status.get(u,{}).get('failure_reason'),sorted(unrec[u])) for u in gap],
        dead_urls=[(d['url'],d['failure_reason'],d['fetch_failures'],d['source_type'],d['gate_verdict'],d['fetched_at']) for d in dead])
json.dump(out,open('/tmp/recon_out.json','w'),indent=1,default=str)
print("window lines",len(logs),"unmapped",dict(unmapped))
for n,o in out.items(): print(n,{k:v for k,v in o.items() if k not in('gap_urls','dead_urls')})
