import sys,json,re,collections; sys.path.insert(0,'/home/ubuntu/v25run')
from db import q
IDS=[9,10,15,20,14,19,24,29]
NAMES={9:'CSX',10:'MAGNA',15:'BCE',20:'Dominion',14:'DARDEN',19:'CELESTICA',24:'AXA',29:'Idemitsu'}
W0,W1='2026-10-12T16:55:56','2026-10-12T17:31:10'
docs=q("""select d.company_id,d.url,d.gate_verdict,d.fetch_status,d.fetch_failures,d.failure_reason,d.source_type,
 d.fetched_at::text fetched_at,d.created_at::text created_at,coalesce(dc.content_length,length(d.content),0) clen
 from documents d left join document_content dc on dc.id=d.content_id where d.company_id=any(%s)""",(IDS,))
for d in docs:
    for k in ('fetched_at','created_at'): d[k]=(d[k] or '').replace(' ','T')
seen=set();logs=[]
for x in open('logs.jsonl'):
    e=json.loads(x);k=(e['timestamp'],e['message'])
    if k in seen or not (W0<=e['timestamp'][:19]<=W1): continue
    seen.add(k);logs.append(e)
url2co=collections.defaultdict(set)
for d in docs: url2co[d['url']].add(d['company_id'])
U=re.compile(r"https?://[^\s'\")]+")
FAIL=[("browser-launch-failed",re.compile(r"Browser fetch failed for |Force-headless failed for .*launch failed|browser launch failed|Failed to launch the browser")),
      ("browser-unavailable-left-retryable",re.compile(r"Browser temporarily unavailable for")),
      ("timeout-marked-dead",re.compile(r"TIMEOUT .*marking dead")),
      ("http-fetch-failed",re.compile(r"HTTP fetch failed for |Direct PDF fetch failed for |non-2xx \(\d+\) for "))]
REC=[("firecrawl",re.compile(r"Strategy Firecrawl: recovered (\d+) chars from")),
     ("deferred-retry",re.compile(r"deferred retry recovered (\d+) chars from")),
     ("browser-pdf",re.compile(r"Browser-PDF fetch succeeded for")),
     ("direct-retry",re.compile(r"direct-retry recovered (\d+) chars from"))]
pref={}
def cos(url):
    url=url.rstrip('.,:;')
    if url in url2co: return url2co[url],url
    if url in pref: return pref[url]
    r=(set(),url)
    for u,cs in url2co.items():
        if len(url)>40 and (u.startswith(url) or url.startswith(u)): r=(cs,u);break
    pref[url]=r; return r
ev=collections.defaultdict(lambda: collections.defaultdict(set)); unmapped=collections.Counter(); launch_lines=0
for e in logs:
    m=e['message']
    tags=[t for t,p in FAIL if p.search(m)]+["REC:"+t for t,p in REC if p.search(m)]
    if not tags: continue
    if 'browser-launch-failed' in tags: launch_lines+=1
    us=U.findall(m)
    if not us: unmapped[tags[0]]+=1; continue
    cs,u=cos(us[0])
    if not cs: unmapped[tags[0]]+=1; continue
    for c in cs:
        for t in tags: ev[c][u].add(t)
inwin=lambda d: W0<=d['fetched_at'][:19]<=W1 or W0<=d['created_at'][:19]<=W1
out={}
for c,n in NAMES.items():
    D=[d for d in docs if d['company_id']==c]; st={d['url']:d for d in D}
    lf={u:t for u,t in ev[c].items() if any(not x.startswith('REC:') for x in t)}
    rec={u:t for u,t in lf.items() if any(x.startswith('REC:') for x in t)}
    unrec={u:t for u,t in lf.items() if u not in rec}
    okdb={u for u in unrec if st.get(u,{}).get('fetch_status')=='ok' and (st[u]['clen'] or 0)>0}
    gap=[u for u in unrec if u not in okdb]
    deadW=[d for d in D if d['fetch_status']=='dead' and inwin(d)]
    ok=sum(d['fetch_status']=='ok' for d in D)
    out[n]=dict(company_id=c,doc_rows=len(D),touched=sum(inwin(d) for d in D),ok=ok,dead_in_window=len(deadW),
      dead_reasons=dict(collections.Counter(d['failure_reason'] for d in deadW)),
      failed_urls=len(lf),launch_fail_urls=sum(1 for t in lf.values() if 'browser-launch-failed' in t or 'browser-unavailable-left-retryable' in t),
      recovered=len(rec),recovered_by=dict(collections.Counter(x[4:] for t in rec.values() for x in t if x.startswith('REC:'))),
      ok_no_logged_rec=len(okdb),gap=len(gap),
      gap_first_party=sum(1 for u in gap if st.get(u,{}).get('source_type')=='first_party'),
      gap_urls=[(u,st.get(u,{}).get('fetch_status'),st.get(u,{}).get('failure_reason'),st.get(u,{}).get('source_type'),sorted(unrec[u])) for u in gap])
json.dump(out,open('recon1277_out.json','w'),indent=1,default=str)
print('window lines',len(logs),'launch-fail lines',launch_lines,'unmapped',dict(unmapped))
for n,o in out.items(): print(n,{k:v for k,v in o.items() if k!='gap_urls'})
