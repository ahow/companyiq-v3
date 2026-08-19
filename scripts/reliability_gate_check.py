"""Validate a persisted reliability Gate Report before a Tester task exits.

Required environment variables:
  BASE, EMAIL, PASSWORD, TEST_CYCLE_ID, EXPECTED_COMPANY_COUNT, EXPECTED_LABELS

EXPECTED_LABELS is a comma-separated list of the four battery labels expected for
this test cycle. The script is framework-agnostic and does not infer evidence from
batch IDs or timestamps.
"""
import json
import os
import sys
import urllib.cookiejar
import urllib.request

BASE = os.environ["BASE"].rstrip("/")
EMAIL = os.environ["EMAIL"]
PASSWORD = os.environ["PASSWORD"]
TEST_CYCLE_ID = os.environ["TEST_CYCLE_ID"]
EXPECTED_COMPANY_COUNT = int(os.environ["EXPECTED_COMPANY_COUNT"])
EXPECTED_LABELS = [label.strip() for label in os.environ["EXPECTED_LABELS"].split(",") if label.strip()]

cookies = urllib.cookiejar.CookieJar()
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))


def call(method: str, path: str, body=None):
    request = urllib.request.Request(BASE + path, method=method)
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        request.add_header("Content-Type", "application/json")
    with client.open(request, payload, timeout=60) as response:
        return json.loads(response.read().decode())


def fail(message: str):
    print(f"FAIL {message}")
    raise SystemExit(1)


def main():
    if len(EXPECTED_LABELS) != 4:
        fail("EXPECTED_LABELS must contain exactly four labels")
    call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    recovery = call("POST", "/api/reliability/recovery-plan", {
        "testCycleId": TEST_CYCLE_ID,
        "expectedLabels": EXPECTED_LABELS,
    })
    if recovery.get("rerun"):
        fail(f"accepted evidence set is incomplete; rerun labels: {recovery['rerun']}")

    report = call("GET", f"/api/reliability/gate-report/{TEST_CYCLE_ID}")
    if not report.get("complete"):
        fail("Gate Report is not persisted")
    data = report.get("report", {}).get("reportData") or report.get("report", {}).get("report_data")
    if not isinstance(data, dict):
        fail("Gate Report machine-readable JSON is missing")
    if len(data.get("sourceRunKeys", [])) != 4:
        fail("Gate Report does not contain four source run keys")
    gates = data.get("gates")
    if not isinstance(gates, list) or len(gates) != 7 or not all(gate.get("passed") for gate in gates):
        fail("Gate Report does not validate all seven gates")
    if data.get("developerInstructionSpec") is None:
        fail("Developer Instruction Spec is missing")
    if any(item.get("averageScore") is None for item in data.get("fleetAverages", [])):
        fail("Fleet averages are incomplete")
    if any(item.get("scoreA") is None or item.get("scoreB") is None for item in data.get("companyABDelta", [])):
        fail("Per-company A/B deltas are incomplete")
    if data.get("fleetAverages") and any(item.get("averageScore") is None for item in data["fleetAverages"]):
        fail("Fleet averages are incomplete")
    if EXPECTED_COMPANY_COUNT <= 0:
        fail("EXPECTED_COMPANY_COUNT must be positive")
    print(f"PASS Gate Report persisted and validated for {TEST_CYCLE_ID}: seven gates, four source run keys")
    call("POST", "/api/auth/logout")


if __name__ == "__main__":
    main()
