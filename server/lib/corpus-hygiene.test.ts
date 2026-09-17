/**
 * Tests for opt2 corpus hygiene (near-duplicate dedup + recency filter).
 *
 * Fixtures model the validated 3i case: several copies of the same ESEF/iXBRL
 * year-package fetched under different URLs (near-duplicates), plus a run of
 * annual reports differing only by year (stale versions). Run under tsx:
 *
 *   npx tsx server/lib/corpus-hygiene.test.ts
 */
import assert from "node:assert/strict";
import { applyCorpusHygiene, isCorpusHygieneEnabled, type HygieneDoc } from "./corpus-hygiene";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    pass++;
  } catch (e: any) {
    console.error(`  \u2717 ${name}: ${e.message}`);
    fail++;
  }
}

console.log("Corpus hygiene (opt2) tests");

// A long, realistic ESEF/iXBRL body so the dedup signature exceeds SIG_MIN_CHARS.
const esefBody =
  "3i Group plc Annual ESEF iXBRL reporting package. " +
  "This inline XBRL document contains the primary financial statements, the " +
  "directors' report, the strategic report, and the notes to the accounts as " +
  "tagged for the European Single Electronic Format submission. ".repeat(60);

test("near-duplicate ESEF packages are deduped, longer copy kept", () => {
  const docs: HygieneDoc[] = [
    { id: 1, url: "https://a.example/esef-2024-a.zhtml", title: "3i ESEF 2024 package A", text: esefBody },
    // Same content prefix, fetched under a different URL, but slightly longer body.
    { id: 2, url: "https://b.example/esef-2024-b.zhtml", title: "3i ESEF 2024 package B", text: esefBody + " Appendix: additional tagged notes." },
    // A genuinely different, unique document — must be untouched.
    { id: 3, url: "https://c.example/governance.html", title: "3i Corporate Governance Statement", text: "The board and its committees oversee risk management and AI governance across the group. ".repeat(10) },
  ];
  const { kept, dropped } = applyCorpusHygiene(docs);
  // One near-duplicate dropped.
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, "near-duplicate");
  assert.equal(dropped[0].id, 1, "shorter copy (id 1) should be the one dropped");
  // Two survivors: the longer duplicate + the unique doc.
  const keptIds = kept.map((d) => d.id).sort();
  assert.deepEqual(keptIds, [2, 3]);
});

test("recency filter keeps newest 2 of a versioned series, drops the rest", () => {
  const mk = (year: number): HygieneDoc => ({
    id: year,
    url: `https://ir.example/annual-report-${year}.pdf`,
    title: `3i Group Annual Report ${year}`,
    // Each year's report is textually distinct so dedup does NOT fire here.
    text: `Annual report for financial year ${year}. ` + `Distinct narrative content unique to ${year}. `.repeat(15),
  });
  const docs = [mk(2020), mk(2021), mk(2022), mk(2023), mk(2024)];
  const { kept, dropped } = applyCorpusHygiene(docs);
  const keptYears = kept.map((d) => d.id).sort((a, b) => (a! - b!));
  assert.deepEqual(keptYears, [2023, 2024], "only the newest two years survive");
  // Three stale versions dropped, all flagged stale-version.
  assert.equal(dropped.length, 3);
  assert.ok(dropped.every((d) => d.reason === "stale-version"));
  const droppedYears = dropped.map((d) => d.id).sort((a, b) => (a! - b!));
  assert.deepEqual(droppedYears, [2020, 2021, 2022]);
});

test("single most-recent primary of a type is never dropped (<=2 per stem)", () => {
  const docs: HygieneDoc[] = [
    { id: 1, url: "https://ir.example/ar-2024.pdf", title: "Annual Report 2024", text: "Unique 2024 annual report content. ".repeat(20) },
    { id: 2, url: "https://ir.example/ar-2023.pdf", title: "Annual Report 2023", text: "Unique 2023 annual report content. ".repeat(20) },
  ];
  const { kept, dropped } = applyCorpusHygiene(docs);
  assert.equal(dropped.length, 0, "a 2-member stem group is never touched");
  assert.equal(kept.length, 2);
});

test("non-duplicate, unversioned docs pass through untouched", () => {
  const docs: HygieneDoc[] = [
    { id: 1, url: "https://x.example/a.html", title: "AI Ethics Policy", text: "Our AI ethics policy content. ".repeat(20) },
    { id: 2, url: "https://x.example/b.html", title: "Data Governance Framework", text: "Our data governance framework content. ".repeat(20) },
    { id: 3, url: "https://x.example/c.html", title: "Risk Management Overview", text: "Our risk management overview content. ".repeat(20) },
  ];
  const { kept, dropped } = applyCorpusHygiene(docs);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map((d) => d.id), [1, 2, 3], "input order preserved");
});

test("short docs (below signature min) are never deduped", () => {
  const docs: HygieneDoc[] = [
    { id: 1, url: "https://s.example/1", title: "Tiny A", text: "short" },
    { id: 2, url: "https://s.example/2", title: "Tiny B", text: "short" },
  ];
  const { kept, dropped } = applyCorpusHygiene(docs);
  assert.equal(dropped.length, 0, "signatures under 200 chars are ignored");
  assert.equal(kept.length, 2);
});

test("combined: dedup then recency on a mixed corpus", () => {
  const docs: HygieneDoc[] = [
    // Two near-duplicate ESEF copies (2024) — one dropped as near-duplicate.
    { id: 10, url: "https://a/esef-2024-a", title: "ESEF 2024 A", text: esefBody },
    { id: 11, url: "https://a/esef-2024-b", title: "ESEF 2024 B", text: esefBody },
    // Versioned annual report series — newest 2 kept.
    { id: 20, url: "https://a/ar-2021", title: "Annual Report 2021", text: "AR 2021 distinct. ".repeat(20) },
    { id: 21, url: "https://a/ar-2022", title: "Annual Report 2022", text: "AR 2022 distinct. ".repeat(20) },
    { id: 22, url: "https://a/ar-2023", title: "Annual Report 2023", text: "AR 2023 distinct. ".repeat(20) },
  ];
  const { kept, dropped } = applyCorpusHygiene(docs);
  const reasons = dropped.map((d) => d.reason).sort();
  assert.deepEqual(reasons, ["near-duplicate", "stale-version"]);
  // Survivors: one ESEF copy + AR 2022 + AR 2023 = 3.
  assert.equal(kept.length, 3);
  assert.ok(kept.some((d) => d.title.startsWith("ESEF 2024")));
  assert.ok(kept.some((d) => d.id === 21));
  assert.ok(kept.some((d) => d.id === 22));
  assert.ok(!kept.some((d) => d.id === 20), "AR 2021 dropped as stale");
});

test("flag defaults ON, disabled only by explicit 'false'", () => {
  const orig = process.env.CORPUS_HYGIENE;
  try {
    delete process.env.CORPUS_HYGIENE;
    assert.equal(isCorpusHygieneEnabled(), true, "default ON");
    process.env.CORPUS_HYGIENE = "true";
    assert.equal(isCorpusHygieneEnabled(), true);
    process.env.CORPUS_HYGIENE = "false";
    assert.equal(isCorpusHygieneEnabled(), false, "explicit false disables");
  } finally {
    if (orig === undefined) delete process.env.CORPUS_HYGIENE;
    else process.env.CORPUS_HYGIENE = orig;
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
