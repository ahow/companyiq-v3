#!/usr/bin/env python3
"""Build a sandbox-reachable Postgres URL from Railway's public TCP proxy vars."""
import os, json, urllib.request, sys

API = "https://backboard.railway.com/graphql/v2"
TOKEN = os.environ["RAILWAY_API_KEY"]
PROJECT = "db04e5b1-...."  # resolved below if needed

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
}

def gql(query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(API, data=body, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

# Find project
me = gql("{ projects { edges { node { id name environments { edges { node { id name } } } services { edges { node { id name } } } } } } }")
proj = None
for e in me["data"]["projects"]["edges"]:
    if e["node"]["name"] == "companyiq-v3":
        proj = e["node"]; break
if not proj:
    print("PROJECT_NOT_FOUND", file=sys.stderr); sys.exit(1)
env_id = None
for e in proj["environments"]["edges"]:
    if e["node"]["name"] == "production":
        env_id = e["node"]["id"]; break
pg_id = None
for e in proj["services"]["edges"]:
    if "postgres" in e["node"]["name"].lower() or "pg" in e["node"]["name"].lower():
        pg_id = e["node"]["id"]; break

q = """query($pid:String!,$eid:String!,$sid:String!){ variables(projectId:$pid, environmentId:$eid, serviceId:$sid) }"""
v = gql(q, {"pid": proj["id"], "eid": env_id, "sid": pg_id})
vars_ = v["data"]["variables"]
# Prefer DATABASE_PUBLIC_URL if present
url = vars_.get("DATABASE_PUBLIC_URL")
if not url:
    host = vars_.get("RAILWAY_TCP_PROXY_DOMAIN")
    port = vars_.get("RAILWAY_TCP_PROXY_PORT")
    pw = vars_.get("POSTGRES_PASSWORD") or vars_.get("PGPASSWORD")
    db = vars_.get("POSTGRES_DB") or "railway"
    user = vars_.get("POSTGRES_USER") or "postgres"
    url = f"postgresql://{user}:{pw}@{host}:{port}/{db}"
print(url)
