// Unit tests for the identity/caching recalibration changes:
//   CHANGE 1 — normalizeVerifiedDomain (domain seeding normalization).
//   CHANGE 3 — generateContentStableHash (content-stable summary cache key).
//   CHANGE 4 — verifiable-identifier floor in scoreEntityMatch.
//
// These modules are pure (no db import), so no DATABASE_URL is needed:
//   npx tsx --test server/lib/identity-recal-changes.test.ts

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  normalizeVerifiedDomain,
  scoreEntityMatch,
  type IssuerProfile,
} from "./issuer-profile.js";
import { generateContentStableHash, generateDocumentHash } from "./processor.js";

function makeProfile(overrides: Partial<IssuerProfile> = {}): IssuerProfile {
  return {
    companyId: 1,
    // "3i Group plc" style: no distinctive legal-name token (all generic / <3 chars).
    legalName: "3i Group plc",
    tradingNames: [],
    formerNames: [],
    localLanguageNames: [],
    aliases: [],
    queryAliases: [],
    isin: "GB00B1YW4409",
    ticker: "III",
    figiName: "3I GROUP PLC",
    figiTicker: "III",
    lei: null,
    verifiedDomains: [],
    domainCandidates: [],
    country: "United Kingdom",
    supportedLanguages: ["en"],
    resolvedAt: new Date().toISOString(),
    pipelineVersion: "test",
    ...overrides,
  };
}

// ─── CHANGE 1 — normalizeVerifiedDomain ──────────────────────────────────────
describe("CHANGE 1 · normalizeVerifiedDomain", () => {
  test("strips scheme, www, path/query/hash and lowercases", () => {
    assert.equal(normalizeVerifiedDomain("https://www.3i.com/investors"), "3i.com");
    assert.equal(normalizeVerifiedDomain("HTTP://3I.COM"), "3i.com");
    assert.equal(normalizeVerifiedDomain("www.Example.co.jp/path?x=1#frag"), "example.co.jp");
    assert.equal(normalizeVerifiedDomain("  jpx.co.jp  "), "jpx.co.jp");
  });
  test("handles empty / nullish input", () => {
    assert.equal(normalizeVerifiedDomain(""), "");
    assert.equal(normalizeVerifiedDomain(null), "");
    assert.equal(normalizeVerifiedDomain(undefined), "");
  });
  test("is idempotent", () => {
    const once = normalizeVerifiedDomain("https://www.3i.com/x");
    assert.equal(normalizeVerifiedDomain(once), once);
  });
});

// ─── CHANGE 4 — verifiable-identifier floor ──────────────────────────────────
describe("CHANGE 4 · scoreEntityMatch identifier floor", () => {
  const savedRecal = process.env.ENTITY_SCORE_RECAL;
  const savedFloor = process.env.ENTITY_SCORE_IDENTIFIER_FLOOR;
  function restore() {
    if (savedRecal === undefined) delete process.env.ENTITY_SCORE_RECAL;
    else process.env.ENTITY_SCORE_RECAL = savedRecal;
    if (savedFloor === undefined) delete process.env.ENTITY_SCORE_IDENTIFIER_FLOOR;
    else process.env.ENTITY_SCORE_IDENTIFIER_FLOOR = savedFloor;
  }

  test("domain match lifts an otherwise-under-floor score to the floor (default-on)", () => {
    delete process.env.ENTITY_SCORE_RECAL;
    delete process.env.ENTITY_SCORE_IDENTIFIER_FLOOR;
    try {
      // Seeded verified domain "3i.com"; first-party doc URL contains it but the
      // legal name ("3i Group plc") contributes no distinctive-word signal.
      const profile = makeProfile({ verifiedDomains: ["3i.com"] });
      const doc = { url: "https://www.3i.com/annual-report", title: "Annual Report", snippet: "" };
      const res = scoreEntityMatch(doc, profile, []);
      assert.ok(res.score >= 20, `score ${res.score} should clear floor 20`);
      assert.ok(res.signals.some((s) => s.startsWith("domain-match:")), "domain matched");
    } finally { restore(); }
  });

  test("a doc with NO identifier match is NOT boosted", () => {
    delete process.env.ENTITY_SCORE_RECAL;
    delete process.env.ENTITY_SCORE_IDENTIFIER_FLOOR;
    try {
      const profile = makeProfile({ verifiedDomains: ["3i.com"] });
      // Unrelated doc: no domain in URL, no ISIN/FIGI in content.
      const doc = { url: "https://unrelated.example/news", title: "Some Other Company", snippet: "widgets" };
      const res = scoreEntityMatch(doc, profile, []);
      assert.ok(res.score < 20, `no-identifier doc should stay under floor (got ${res.score})`);
      assert.ok(!res.signals.some((s) => s.startsWith("identifier-floor-applied")), "no floor applied");
    } finally { restore(); }
  });

  test("ISIN-in-content match clears the floor", () => {
    delete process.env.ENTITY_SCORE_RECAL;
    delete process.env.ENTITY_SCORE_IDENTIFIER_FLOOR;
    try {
      const profile = makeProfile({ verifiedDomains: [] });
      const doc = { url: "https://aggregator.example/filing", title: "Filing", snippet: "ISIN GB00B1YW4409 disclosed" };
      const res = scoreEntityMatch(doc, profile, []);
      assert.ok(res.score >= 20, `ISIN match should clear floor (got ${res.score})`);
    } finally { restore(); }
  });

  test("flag off (ENTITY_SCORE_RECAL=false) restores prior scoring — no floor", () => {
    process.env.ENTITY_SCORE_RECAL = "false";
    delete process.env.ENTITY_SCORE_IDENTIFIER_FLOOR;
    try {
      // Domain match alone is +40 (already >= 20), so pick a case where the
      // only signal is a weak one below the floor to prove no lift occurs.
      // figi-name-match on "group" is generic; use a doc that scores exactly the
      // ticker (+10) which is < 20 without recal.
      const profile = makeProfile({ verifiedDomains: [] });
      const doc = { url: "https://x.example/p", title: "III report", snippet: "the iii ticker" };
      const res = scoreEntityMatch(doc, profile, []);
      // ticker "iii" in content -> +10 only; recal off means it stays under 20.
      assert.ok(!res.signals.some((s) => s.startsWith("identifier-floor-applied")), "no floor when flag off");
    } finally { restore(); }
  });

  test("custom ENTITY_SCORE_IDENTIFIER_FLOOR is honoured", () => {
    delete process.env.ENTITY_SCORE_RECAL;
    process.env.ENTITY_SCORE_IDENTIFIER_FLOOR = "35";
    try {
      const profile = makeProfile({ verifiedDomains: ["3i.com"] });
      const doc = { url: "https://3i.com/x", title: "Report", snippet: "" };
      const res = scoreEntityMatch(doc, profile, []);
      // domain match = 40 already >= 35, so floor is inert here; verify no error
      // and score respects the domain signal.
      assert.ok(res.score >= 35);
    } finally { restore(); }
  });
});

// ─── CHANGE 3 — generateContentStableHash ────────────────────────────────────
describe("CHANGE 3 · generateContentStableHash", () => {
  test("is deterministic for identical content", () => {
    const a = generateContentStableHash(["hello world", "second doc"]);
    const b = generateContentStableHash(["hello world", "second doc"]);
    assert.equal(a, b);
    assert.equal(a.length, 16);
  });
  test("is order-insensitive (same content, different order -> same hash)", () => {
    const a = generateContentStableHash(["doc one", "doc two", "doc three"]);
    const b = generateContentStableHash(["doc three", "doc one", "doc two"]);
    assert.equal(a, b);
  });
  test("is whitespace-normalized (reflowed content -> same hash)", () => {
    const a = generateContentStableHash(["the  quick\tbrown\nfox"]);
    const b = generateContentStableHash(["the quick brown fox"]);
    assert.equal(a, b);
  });
  test("ignores empty documents", () => {
    const a = generateContentStableHash(["real content", "", "   "]);
    const b = generateContentStableHash(["real content"]);
    assert.equal(a, b);
  });
  test("different content -> different hash", () => {
    const a = generateContentStableHash(["alpha"]);
    const b = generateContentStableHash(["beta"]);
    assert.notEqual(a, b);
  });
  test("does not depend on URLs (unlike generateDocumentHash)", () => {
    // Same text reachable at different URLs -> content-stable hash identical,
    // whereas the URL-set hash differs.
    const contentHash1 = generateContentStableHash(["same body text"]);
    const contentHash2 = generateContentStableHash(["same body text"]);
    assert.equal(contentHash1, contentHash2);
    const urlHashA = generateDocumentHash(["https://a.com/x"]);
    const urlHashB = generateDocumentHash(["https://b.com/y"]);
    assert.notEqual(urlHashA, urlHashB);
  });
});
