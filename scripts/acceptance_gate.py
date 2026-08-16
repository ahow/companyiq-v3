#!/usr/bin/env python3
"""
CompanyIQ v3 — Acceptance Gate (drop into repo as scripts/acceptance_gate.py)

Run BEFORE claiming any commit is done:
    BASE=https://app-production-9929.up.railway.app \
    EMAIL=... PASSWORD=... \
    python3 scripts/acceptance_gate.py

What it does (fully automated, ~70-90 min):
  1. Two full runs of list 5 on fw3 (financed emissions).
  2. Two full runs of list 5 on fw8 (modern slavery).
  3. Computes the gate and exits 0 (PASS) / 1 (FAIL) with a printed table.

GATE (all must hold):
  G1  Golden positives hold  : Citigroup>=35, BNP>=40, Mizuho>=30 (fw3);
                               Barclays>0, Santander>0, HSBC measure 1.2 == Yes (fw8)
  G2  Recoveries don't regress: SMFG fw3 >= its prior best; HSBC fw8 >= prior best
  G3  No average drop        : fw3 avg >= BASELINE_FW3, fw8 avg >= BASELINE_FW8
  G4  Wall time              : every batch completes < 30 min, 0 failed jobs
  G5  Determinism            : per-topic two-run mean |delta| < 3

Update the BASELINE_* constants ONLY when a genuine improvement is accepted
by the reviewer — never to make a red gate green.
"""
import json, os, sys, time, urllib.request, http.cookiejar

BASE = os.environ["BASE"]
EMAIL = os.environ["EMAIL"]
PASSWORD = os.environ["PASSWORD"]

# ── Accepted baselines (reviewer-controlled; see docstring) ──────────────────
BASELINE_FW3 = 24.0          # last accepted climate average (pre-regression target: 29)
BASELINE_FW3_TARGET = 29.0   # the level at which the 47caffc regression is "undone"
BASELINE_FW8 = 12.0
PRIOR_BEST = {"fw3:SMFG": 7, "fw8:HSBC": 10}
LIST_ID = 5
MAX_BATCH_SECONDS = 30 * 60

cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with op.open(req, data, timeout=180) as r:
        return json.loads(r.read().decode())

def wait_batch(max_seconds=MAX_BATCH_SECONDS):
    t0 = time.time()
    while True:
        time.sleep(30)
        st = call("GET", "/api/batch/status")
        if not st.get("running"):
            return time.time() - t0, 0
        if st.get("failed", 0) > 0:
            pass  # keep waiting; failures counted at the end
        if time.time() - t0 > max_seconds:
            return time.time() - t0, st.get("failed", 0) or -1  # -1 = timed out

def latest_snapshot(framework_id, after_ts):
    res = call("GET", "/api/results")
    items = res if isinstance(res, list) else res.get("results", res) or []
    for it in items:
        if it.get("frameworkId") == framework_id and it.get("createdAt", "") >= after_ts:
            return call("GET", f"/api/results/{it['id']}")
    return None

def run_topic(framework_id):
    runs, walls = [], []
    for i in (1, 2):
        ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        kicked = call("POST", "/api/analyze", {"frameworkId": framework_id, "listId": LIST_ID})
        assert kicked.get("success"), f"analyze launch failed: {kicked}"
        wall, failed = wait_batch()
        walls.append((wall, failed))
        snap = latest_snapshot(framework_id, ts)
        assert snap, f"no results snapshot after fw{framework_id} run {i} — G4 FAIL (snapshot persistence)"
        runs.append({c["companyName"]: c for c in snap["resultsData"]})
    return runs, walls

def score(rd, sub):
    n = next((k for k in rd if sub.lower() in k.lower()), None)
    return (rd[n].get("totalScore") or 0) if n else None

def measure_verdict(rd, sub, measure_prefix):
    n = next((k for k in rd if sub.lower() in k.lower()), None)
    if not n: return None
    for m in rd[n].get("measureScores") or []:
        if str(m.get("measureId", "")).startswith(measure_prefix):
            return str(m.get("verdict", ""))
    return None

def main():
    call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    results, gate = {}, []

    for fw, label in ((3, "fw3"), (8, "fw8")):
        runs, walls = run_topic(fw)
        rA, rB = runs
        common = set(rA) & set(rB)
        avgB = sum((rB[c].get("totalScore") or 0) for c in rB) / max(len(rB), 1)
        mean_d = sum(abs((rA[c].get("totalScore") or 0) - (rB[c].get("totalScore") or 0)) for c in common) / max(len(common), 1)
        results[label] = {"avg": round(avgB, 2), "mean_delta": round(mean_d, 2), "walls": walls, "runB": rB}

    fw3, fw8 = results["fw3"], results["fw8"]
    # G1 positives
    gate.append(("G1 Citigroup>=35", (score(fw3["runB"], "citigroup") or 0) >= 35))
    gate.append(("G1 BNP>=40",       (score(fw3["runB"], "bnp") or 0) >= 40))
    gate.append(("G1 Mizuho>=30",    (score(fw3["runB"], "mizuho") or 0) >= 30))
    gate.append(("G1 Barclays>0",    (score(fw8["runB"], "barclays") or 0) > 0))
    gate.append(("G1 Santander>0",   (score(fw8["runB"], "santander") or 0) > 0))
    gate.append(("G1 HSBC 1.2==Yes", (measure_verdict(fw8["runB"], "hsbc", "1.2") or "").lower().startswith("yes")))
    # G2 recoveries don't regress
    gate.append(("G2 SMFG fw3 no-regress", (score(fw3["runB"], "sumitomo mitsui financial") or 0) >= PRIOR_BEST["fw3:SMFG"]))
    gate.append(("G2 HSBC fw8 no-regress", (score(fw8["runB"], "hsbc") or 0) >= PRIOR_BEST["fw8:HSBC"]))
    # G3 averages
    gate.append((f"G3 fw3 avg>={BASELINE_FW3}", fw3["avg"] >= BASELINE_FW3))
    gate.append((f"G3 fw8 avg>={BASELINE_FW8}", fw8["avg"] >= BASELINE_FW8))
    # G4 wall time + failures (snapshot presence already asserted in run_topic)
    for label in ("fw3", "fw8"):
        for i, (wall, failed) in enumerate(results[label]["walls"], 1):
            gate.append((f"G4 {label} run{i} <30min", wall < MAX_BATCH_SECONDS and failed == 0))
    # G5 determinism
    gate.append(("G5 fw3 mean|d|<3", fw3["mean_delta"] < 3))
    gate.append(("G5 fw8 mean|d|<3", fw8["mean_delta"] < 3))

    print(f"\nfw3 avg={fw3['avg']} (accepted baseline {BASELINE_FW3}; regression closed at >= {BASELINE_FW3_TARGET})")
    print(f"fw8 avg={fw8['avg']}  | determinism fw3 {fw3['mean_delta']}, fw8 {fw8['mean_delta']}\n")
    ok = True
    for name, passed in gate:
        print(("PASS  " if passed else "FAIL  ") + name)
        ok = ok and passed
    if fw3["avg"] < BASELINE_FW3_TARGET:
        print(f"NOTE  climate regression still open ({fw3['avg']} < {BASELINE_FW3_TARGET}) — gate does not block on this, the reviewer does")
    call("POST", "/api/auth/logout")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
