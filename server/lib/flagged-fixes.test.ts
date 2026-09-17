/**
 * Focused unit tests for the 3i FLAGGED FIXES.
 *
 * FIX 1 (DOMAIN_CORROBORATION_PERSIST): an independently-corroborated domain
 *   (e.g. from FMP's durable ISIN→website field) passed to resolveIssuerProfile
 *   is seeded into verifiedDomains EVEN WHEN companies.domain entered the run
 *   NULL, restoring verifiedDomainCount:1 the same run. Off => not seeded.
 *   (The discovery.ts clear-suppression that keeps a corroborated cached domain
 *    from being NULL-wiped is exercised end-to-end by the live 3i verification
 *    run; here we cover the seeding mechanism that produces verifiedDomainCount.)
 *
 * FIX 2 (ISSUER_SUMMARY_FROM_DIAGNOSTICS): the issuerProfileSummary sidecar
 *   reads verifiedDomainCount / resolutionPath from the ProfileDiagnostics
 *   object (via retrievalDiagnostics.issuerProfile) instead of the raw
 *   IssuerProfile object (whose "verified" domain filter is always 0 and whose
 *   resolutionPath is always []). Off / diagnostics-absent => prior read.
 *
 * Run: DATABASE_URL="postgres://x:x@localhost:5432/x" npx tsx server/lib/flagged-fixes.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveIssuerProfile } from "./issuer-profile.js";
import { buildIssuerProfileSummary } from "./pipeline.js";

// ─── FIX 1 — corroboration seeds verifiedDomains ────────────────────────────

test("FIX1: corroboratedDomains seed verifiedDomains when domain enters NULL (flag on)", async () => {
  process.env.DOMAIN_CORROBORATION_PERSIST = "1";
  process.env.ISSUER_SEED_VERIFIED_DOMAIN = "1";
  // isin:null => no FIGI network call; domain:null simulates the NULL-wipe entry
  const { profile, diagnostics } = await resolveIssuerProfile({
    companyId: 999001,
    companyName: "3i Group plc",
    isin: null,
    ticker: null,
    domain: null,
    sector: null,
    country: "GB",
    corroboratedDomains: ["3i.com"],
  });
  assert.ok(
    profile.verifiedDomains.includes("3i.com"),
    `expected verifiedDomains to include corroborated 3i.com, got [${profile.verifiedDomains.join(",")}]`,
  );
  assert.equal(diagnostics.verifiedDomainCount, 1, "verifiedDomainCount should be 1");
  assert.ok(
    diagnostics.resolutionPath.some((s) => s.startsWith("domain-corroborated(")),
    `resolutionPath should record corroboration, got [${diagnostics.resolutionPath.join(",")}]`,
  );
});

test("FIX1: corroboratedDomains are IGNORED when flag off (prior behaviour)", async () => {
  process.env.DOMAIN_CORROBORATION_PERSIST = "0";
  process.env.ISSUER_SEED_VERIFIED_DOMAIN = "1";
  const { profile, diagnostics } = await resolveIssuerProfile({
    companyId: 999002,
    companyName: "3i Group plc",
    isin: null,
    ticker: null,
    domain: null,
    sector: null,
    country: "GB",
    corroboratedDomains: ["3i.com"],
  });
  assert.ok(
    !profile.verifiedDomains.includes("3i.com"),
    `with flag off, 3i.com must NOT be seeded, got [${profile.verifiedDomains.join(",")}]`,
  );
  assert.equal(diagnostics.verifiedDomainCount, 0, "verifiedDomainCount should be 0 with flag off");
  assert.ok(
    !diagnostics.resolutionPath.some((s) => s.startsWith("domain-corroborated(")),
    "resolutionPath must not record corroboration with flag off",
  );
  // restore default-on for any subsequent tests
  process.env.DOMAIN_CORROBORATION_PERSIST = "1";
});

// ─── FIX 2 — issuerProfileSummary from diagnostics ──────────────────────────

// Mirrors the real objects: IssuerProfile carries domainCandidates whose status
// is only ever "accepted"/"rejected" (never "verified") and has NO resolutionPath.
const rawProfile = {
  legalName: "3i Group plc",
  figiName: "3I GROUP PLC",
  aliases: [{ value: "3i" }, { value: "III" }],
  domainCandidates: [{ domain: "3i.com", status: "accepted" }],
  // no resolutionPath field
};
// ProfileDiagnostics as persisted on retrievalDiagnostics.issuerProfile.
const retrievalDiagnostics = {
  issuerProfile: {
    legalName: "3i Group plc",
    figiName: "3I GROUP PLC",
    aliasCount: 5,
    verifiedDomainCount: 1,
    resolutionPath: ["figi-resolved", "aliases-generated(5)", "domain-corroborated(1)"],
  },
};

test("FIX2: summary reads correct verifiedDomainCount + resolutionPath from diagnostics (flag on)", () => {
  const summary = buildIssuerProfileSummary(rawProfile, retrievalDiagnostics, true);
  assert.equal(summary.verifiedDomainCount, 1, "verifiedDomainCount must come from diagnostics (1)");
  assert.deepEqual(
    summary.resolutionPath,
    ["figi-resolved", "aliases-generated(5)", "domain-corroborated(1)"],
    "resolutionPath must come from diagnostics",
  );
  assert.equal(summary.aliasCount, 5);
  assert.equal(summary.legalName, "3i Group plc");
});

test("FIX2: demonstrates the OLD bug when reading from the raw profile (flag off)", () => {
  const summary = buildIssuerProfileSummary(rawProfile, retrievalDiagnostics, false);
  // Old read: no "verified" status => 0; no resolutionPath field => [].
  assert.equal(summary.verifiedDomainCount, 0, "old read yields 0 (the bug this fix corrects)");
  assert.deepEqual(summary.resolutionPath, [], "old read yields [] (the bug this fix corrects)");
});

test("FIX2: falls back to prior read when diagnostics object is absent (flag on)", () => {
  const summary = buildIssuerProfileSummary(rawProfile, {}, true);
  assert.equal(summary.verifiedDomainCount, 0, "no diagnostics => fallback read");
  assert.deepEqual(summary.resolutionPath, []);
});
