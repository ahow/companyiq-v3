#!/usr/bin/env python3
import json, time, urllib.request, urllib.error

RK = "6e5eb3b0-f4d3-4b9d-9d6f-93ed818da0b0"
WS = "9360e6ed-39a4-4f0a-bd61-dbcd307e5638"
PID = "db04e5b1-416b-4335-b3bc-056dd81e5bbf"
URL = "https://backboard.railway.app/graphql/v2"

def gql(query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Authorization": f"Bearer {RK}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"errors": [{"http": e.code, "body": e.read().decode()[:200]}]}

# Step 1: services (shallow) via workspace edge
q1 = """
query($id:String!){
  workspace(workspaceId:$id){ projects { edges { node {
    id name environments { edges { node { id name } } }
    services { edges { node { id name } } }
  } } } }
}"""
d = gql(q1, {"id": WS})
if "errors" in d:
    print("STEP1 ERROR:", json.dumps(d["errors"])[:300]); raise SystemExit(1)
proj = None
for pe in d["data"]["workspace"]["projects"]["edges"]:
    if pe["node"]["id"] == PID:
        proj = pe["node"]; break
envs = {e["node"]["name"]: e["node"]["id"] for e in proj["environments"]["edges"]}
svcs = {s["node"]["name"]: s["node"]["id"] for s in proj["services"]["edges"]}
print("ENVS:", envs)
print("SERVICES:", svcs)
env_id = envs.get("production") or list(envs.values())[0]

# Step 2: latest deployment per service (separate top-level query each)
dq = """
query($sid:String!,$eid:String!){
  deployments(first:2, input:{serviceId:$sid, environmentId:$eid}){
    edges { node { id status createdAt meta } }
  }
}"""
for name, sid in svcs.items():
    dd = gql(dq, {"sid": sid, "eid": env_id})
    if "errors" in dd:
        print(f"\n{name}: DEPLOY ERR {json.dumps(dd['errors'])[:200]}")
        continue
    print(f"\n=== {name} ({sid[:8]}) ===")
    for e in dd["data"]["deployments"]["edges"]:
        n = e["node"]
        meta = n.get("meta") or {}
        sha = ""
        if isinstance(meta, dict):
            sha = meta.get("commitHash") or meta.get("commit") or ""
        print(f"  {n['status']:12} {n['createdAt']}  dep={n['id'][:8]}  sha={str(sha)[:10]}")
