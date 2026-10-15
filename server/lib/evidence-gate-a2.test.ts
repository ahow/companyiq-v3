/**
 * A2 / WP03 — hardened evidence-integrity gate tests (QI01–QI09 + over-rejection
 * and ellipsis fixtures). Pure, deterministic, no LLM, no DB.
 *
 * Each defect fixture asserts the v1→v2 DELTA on identical input (v1 reproduces
 * the old, defective behaviour; v2 is the hardened fix), so the suite doubles as
 * executable proof that the three E6 defects are closed without regressing the
 * positive (don't-over-reject) cases.
 */

import assert from "node:assert/strict";
import { gateEvidence } from "./evidence-gate";

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

console.log("A2/WP03 hardened evidence-gate tests");

// ─── shared fixtures ────────────────────────────────────────────────────────

const RUBRIC_EXAMPLE =
  "The Board's Sustainability Committee has oversight responsibility for nature and biodiversity risks and opportunities, reviewing our TNFD-aligned disclosures annually.";

// A genuine, long in-pack sentence (normalised length comfortably > 120 chars),
// used to exercise the v1 absolute-120 escape hatch.
const GENUINE_PREFIX =
  "In 2023 the group completed a comprehensive double materiality assessment covering water use deforestation and land use change across its owned and franchised operations in every region where it trades";
const INVENTED_TAIL =
  " and subsequently commissioned a fleet of zero emission cargo submarines together with twelve entirely fictional offset plantations on the dark side of the moon none of which appear anywhere in the assembled evidence pack text whatsoever";

const BASE_PACK = `... preamble ... ${GENUINE_PREFIX}. ... more governance and metrics content follows here ...`;

// ─── QI01 — invented suffix: PASS under v1 (120 hatch), FAIL under v2 ────────
test("QI01 invented-suffix: v1 PASSES (absolute-120 hatch defect), v2 FAILS (full coverage)", () => {
  const quotes = [{ text: GENUINE_PREFIX + INVENTED_TAIL, source: "Group Annual Report 2023" }];
  const v1 = gateEvidence({ originalScore: 1, quotes, packText: BASE_PACK, policyVersion: "v1" });
  const v2 = gateEvidence({ originalScore: 1, quotes, packText: BASE_PACK, policyVersion: "v2" });

  assert.equal(v1.gate.policyVersion, "v1");
  assert.equal(v1.gate.quotesValid, 1, "v1 accepts the invented suffix via the 120-char hatch");
  assert.equal(v1.score, 1);

  assert.equal(v2.gate.policyVersion, "v2");
  assert.equal(v2.gate.quotesValid, 0, "v2 requires full-quote coverage → invented tail rejected");
  assert.ok(v2.gate.failures[0].reasons.includes("provenance"));
  assert.equal(v2.score, 0);
  assert.equal(v2.gate.downgraded, true);
});

// ─── QI02 — changed sign/magnitude: PASS under v1 (ASCII strip), FAIL v2 ─────
test("QI02 sign tamper (-5% vs 5%): v1 PASSES (strips minus), v2 FAILS (sign preserved)", () => {
  const PACK = "The group reduced absolute Scope 1 and Scope 2 emissions by 5% in 2023 versus the prior year.";
  const TAMPERED = "The group reduced absolute Scope 1 and Scope 2 emissions by -5% in 2023 versus the prior year.";
  const quotes = [{ text: TAMPERED, source: "Group Climate Report 2023" }];
  const v1 = gateEvidence({ originalScore: 1, quotes, packText: PACK, policyVersion: "v1" });
  const v2 = gateEvidence({ originalScore: 1, quotes, packText: PACK, policyVersion: "v2" });

  assert.equal(v1.gate.quotesValid, 1, "v1 strips the minus so -5% and 5% collide → accepted");
  assert.equal(v2.gate.quotesValid, 0, "v2 keeps the sign so -5% != 5% → rejected");
  assert.ok(v2.gate.failures[0].reasons.includes("provenance"));
  assert.equal(v2.score, 0);
});

test("QI02b magnitude/word tamper (decreased→increased) FAILS under v2", () => {
  const PACK = "In 2023 the company's total water withdrawal decreased 5 percent compared with 2022.";
  const TAMPERED = "In 2023 the company's total water withdrawal increased 5 percent compared with 2022.";
  const v2 = gateEvidence({
    originalScore: 1,
    quotes: [{ text: TAMPERED, source: "Group Report 2023" }],
    packText: PACK,
    policyVersion: "v2",
  });
  assert.equal(v2.gate.quotesValid, 0);
  assert.ok(v2.gate.failures[0].reasons.includes("provenance"));
});

// ─── QI03 — invented source-ID (names doc absent from segments) ─────────────
// Quote is present pack-wide but in NO document segment; source names a doc that
// resolves to no segment. v1 silently falls back to pack-wide (PASS); v2 bounded
// repair finds no segment and FAILS on source-attribution.
test("QI03 invented source-id: v1 PASSES (silent pack-wide fallback), v2 FAILS (source-attribution)", () => {
  const SEG_A = { id: "Kering Universal Registration Document 2023", text: "--- DOCUMENT: Kering Universal Registration Document 2023 [u] --- The board reviewed its nature strategy." };
  const SEG_B = { id: "Kering Climate Report 2023", text: "--- DOCUMENT: Kering Climate Report 2023 [u] --- Scope 1 and 2 emissions fell fourteen percent." };
  const FLOATING = "An uncatalogued analyst remark that lives only in the pack margins and belongs to no document segment at all.";
  const packText = `${SEG_A.text}\n${SEG_B.text}\n${FLOATING}`;
  const quotes = [{ text: FLOATING, source: "Fabricated Sustainability Dossier 2099" }];
  const segs = [SEG_A, SEG_B];

  const v1 = gateEvidence({ originalScore: 1, quotes, packText, documentSegments: segs, policyVersion: "v1" });
  const v2 = gateEvidence({ originalScore: 1, quotes, packText, documentSegments: segs, policyVersion: "v2" });

  assert.equal(v1.gate.quotesValid, 1, "v1 falls back to pack-wide → accepted");
  assert.equal(v2.gate.quotesValid, 0, "v2 cannot attribute to any present segment → rejected");
  assert.ok(v2.gate.failures[0].reasons.includes("source-attribution"));
  assert.equal(v2.score, 0);
});

// ─── QI04 — wrong document / wrong year ─────────────────────────────────────
test("QI04 wrong-document attribution FAILS under v2 (quote from A, cited as B)", () => {
  const SEG_A = { id: "Group Annual Report 2022", text: "--- DOCUMENT: Group Annual Report 2022 [u] --- The group opened its first on-site solar array in 2022." };
  const SEG_B = { id: "Group Annual Report 2023", text: "--- DOCUMENT: Group Annual Report 2023 [u] --- The group expanded renewable procurement in 2023." };
  const A_SENTENCE = "The group opened its first on-site solar array in 2022.";
  const v2 = gateEvidence({
    originalScore: 1,
    quotes: [{ text: A_SENTENCE, source: "Group Annual Report 2023" }], // wrong year
    packText: `${SEG_A.text}\n${SEG_B.text}`,
    documentSegments: [SEG_A, SEG_B],
    policyVersion: "v2",
  });
  assert.equal(v2.gate.quotesValid, 0);
  assert.ok(v2.gate.failures[0].reasons.includes("source-attribution"));
  assert.equal(v2.score, 0);
});

// ─── QI05 — approved whitespace / hyphenation PASSES ────────────────────────
test("QI05 collapsed whitespace + soft-hyphen quote PASSES under v2 (not over-rejected)", () => {
  const PACK = "The company published its first climate transition plan in 2023 and set interim targets.";
  // extra/newline whitespace + a soft hyphen (U+00AD) inside "climate"
  const APPROVED = "The   company published\n its first  cli\u00ADmate transition plan in 2023 and set interim targets.";
  const v2 = gateEvidence({
    originalScore: 1,
    quotes: [{ text: APPROVED, source: "Group Report 2023" }],
    packText: PACK,
    policyVersion: "v2",
  });
  assert.equal(v2.gate.quotesValid, 1, "whitespace/soft-hyphen variation is normalised away → accepted");
  assert.equal(v2.score, 1);
});

// ─── QI06 — CJK / non-Latin auditable ───────────────────────────────────────
test("QI06 CJK auditability: v2 validates genuine & rejects tampered; v1 is blind to both", () => {
  const CJK = "公司在2023年将范围一和范围二的温室气体排放量减少了百分之五。";
  const TAMPERED = "公司在2023年将范围一和范围二的温室气体排放量增加了百分之五。"; // 减少→增加
  const PACK = `preamble ${CJK} trailing`;

  // v2 — Unicode-aware: genuine non-Latin validates, tampered non-Latin rejected.
  const v2genuine = gateEvidence({ originalScore: 1, quotes: [{ text: CJK, source: "集团可持续发展报告2023" }], packText: PACK, policyVersion: "v2" });
  const v2tampered = gateEvidence({ originalScore: 1, quotes: [{ text: TAMPERED, source: "集团可持续发展报告2023" }], packText: PACK, policyVersion: "v2" });
  assert.equal(v2genuine.gate.quotesValid, 1, "v2 validates genuine CJK on its full content");
  assert.equal(v2tampered.gate.quotesValid, 0, "v2 rejects tampered CJK");
  assert.ok(v2tampered.gate.failures[0].reasons.includes("provenance"));

  // v1 — ASCII-strip collapses BOTH to the same incidental digit residue ("2023"),
  // so it cannot tell a genuine CJK quote from a tampered one: it is blind, not auditing.
  const v1genuine = gateEvidence({ originalScore: 1, quotes: [{ text: CJK, source: "集团可持续发展报告2023" }], packText: PACK, policyVersion: "v1" });
  const v1tampered = gateEvidence({ originalScore: 1, quotes: [{ text: TAMPERED, source: "集团可持续发展报告2023" }], packText: PACK, policyVersion: "v1" });
  assert.equal(
    v1genuine.gate.quotesValid,
    v1tampered.gate.quotesValid,
    "v1 cannot distinguish genuine from tampered non-Latin content (blind to the tamper)",
  );
});

// ─── QI07 — rubric-identical genuine text NOT over-rejected ──────────────────
test("QI07 rubric-identical quote with valid provenance + authoritative source PASSES (anti-echo override)", () => {
  const SEG = {
    id: "Kering Sustainability Report 2023",
    text: `--- DOCUMENT: Kering Sustainability Report 2023 [u] --- ${RUBRIC_EXAMPLE}`,
  };
  const v2 = gateEvidence({
    originalScore: 1,
    quotes: [{ text: RUBRIC_EXAMPLE, source: "Kering Sustainability Report 2023" }],
    packText: SEG.text,
    positiveExamples: [RUBRIC_EXAMPLE],
    documentSegments: [SEG],
    policyVersion: "v2",
  });
  assert.equal(v2.gate.quotesValid, 1, "exact provenance + authoritative source beats lexical echo");
  assert.ok(
    !v2.gate.failures.some((f) => f.reasons.includes("anti-echo")),
    "no anti-echo failure recorded",
  );
  assert.equal(v2.score, 1);
});

test("QI07b override does NOT whitelist an unprovenanced echo (QI01 protection intact)", () => {
  // Same rubric text, but NOT in the pack and source resolves to no segment →
  // the override must not apply; the echo is still caught.
  const v2 = gateEvidence({
    originalScore: 1,
    quotes: [{ text: RUBRIC_EXAMPLE, source: "Fabricated Report 2023" }],
    packText: "... an entirely unrelated evidence pack about logistics and warehousing ...",
    positiveExamples: [RUBRIC_EXAMPLE],
    policyVersion: "v2",
  });
  assert.equal(v2.gate.quotesValid, 0);
  const reasons = v2.gate.failures[0].reasons;
  assert.ok(reasons.includes("provenance"), "unprovenanced echo fails provenance");
  assert.ok(reasons.includes("anti-echo"), "unprovenanced echo still fails anti-echo");
});

// ─── QI08 — a valid quote supports only when it meets the exact measure ──────
test("QI08 YES with only a magnitude-tampered quote downgrades to 0 under v2 (sustained under v1)", () => {
  const PACK = "The group cut its absolute greenhouse-gas emissions by 5% during the 2023 reporting year.";
  const TAMPERED = "The group cut its absolute greenhouse-gas emissions by -5% during the 2023 reporting year.";
  const quotes = [{ text: TAMPERED, source: "Group Climate Report 2023" }];
  const v1 = gateEvidence({ originalScore: 1, quotes, packText: PACK, policyVersion: "v1" });
  const v2 = gateEvidence({ originalScore: 1, quotes, packText: PACK, policyVersion: "v2" });
  assert.equal(v1.score, 1, "v1 sustains YES on the tampered figure (defect)");
  assert.equal(v2.score, 0, "v2: the only quote fails the exact measure → YES downgraded");
  assert.equal(v2.gate.downgraded, true);
});

// ─── QI09 — source-ID ambiguity: explicit repair/fail, never silent pack-wide ─
test("QI09 unresolvable source but quote traces to a present segment → BOUNDED REPAIR (valid + recorded)", () => {
  const SEG_A = { id: "Kering Universal Registration Document 2023", text: "--- DOCUMENT: Kering Universal Registration Document 2023 [u] --- The board approved a nature-positive roadmap in 2023." };
  const SEG_B = { id: "Kering Climate Report 2023", text: "--- DOCUMENT: Kering Climate Report 2023 [u] --- Scope 3 emissions were measured for the first time." };
  const A_SENTENCE = "The board approved a nature-positive roadmap in 2023.";
  const packText = `${SEG_A.text}\n${SEG_B.text}`;
  const segs = [SEG_A, SEG_B];
  // Source names neither segment, but the quote genuinely lives in SEG_A.
  const v2 = gateEvidence({
    originalScore: 1,
    quotes: [{ text: A_SENTENCE, source: "Independent Third-Party Note" }],
    packText,
    documentSegments: segs,
    policyVersion: "v2",
  });
  assert.equal(v2.gate.quotesValid, 1, "repaired to the segment it actually traces to");
  assert.ok(v2.gate.repairs && v2.gate.repairs.length === 1, "repair is recorded for audit");
  assert.equal(v2.gate.repairs![0].repairedTo, "Kering Universal Registration Document 2023");
  assert.equal(v2.gate.repairs![0].originalSource, "Independent Third-Party Note");
  assert.equal(v2.score, 1);
});

test("QI09b v1 keeps the SILENT pack-wide fallback (no repair record) — proves the behavioural delta", () => {
  const SEG_A = { id: "Kering Universal Registration Document 2023", text: "--- DOCUMENT: Kering Universal Registration Document 2023 [u] --- The board approved a nature-positive roadmap in 2023." };
  const SEG_B = { id: "Kering Climate Report 2023", text: "--- DOCUMENT: Kering Climate Report 2023 [u] --- Scope 3 emissions were measured for the first time." };
  const A_SENTENCE = "The board approved a nature-positive roadmap in 2023.";
  const v1 = gateEvidence({
    originalScore: 1,
    quotes: [{ text: A_SENTENCE, source: "Independent Third-Party Note" }],
    packText: `${SEG_A.text}\n${SEG_B.text}`,
    documentSegments: [SEG_A, SEG_B],
    policyVersion: "v1",
  });
  assert.equal(v1.gate.quotesValid, 1, "v1 silently accepts via pack-wide fallback");
  assert.ok(!v1.gate.repairs, "v1 performs no bounded repair (no audit record)");
});

// ─── Ellipsis handling (E6-1) ───────────────────────────────────────────────
test("honest ellipsis: both spans genuinely (contiguously) in pack → PASS under v2", () => {
  const PACK =
    "The company set a 2030 net-zero target for Scope 1 and 2. Separately, it committed to zero deforestation across priority commodities by 2025.";
  const QUOTE = "The company set a 2030 net-zero target for Scope 1 and 2 … zero deforestation across priority commodities by 2025.";
  const v2 = gateEvidence({ originalScore: 1, quotes: [{ text: QUOTE, source: "Group Report 2023" }], packText: PACK, policyVersion: "v2" });
  assert.equal(v2.gate.quotesValid, 1, "each ellipsis span independently matches the pack");
  assert.equal(v2.score, 1);
});

test("dishonest ellipsis: second span invented → FAIL under v2 (fragments never merged)", () => {
  const PACK =
    "The company set a 2030 net-zero target for Scope 1 and 2. Separately, it committed to zero deforestation across priority commodities by 2025.";
  const QUOTE = "The company set a 2030 net-zero target for Scope 1 and 2 … and acquired three underwater wind farms staffed entirely by dolphins last spring.";
  const v2 = gateEvidence({ originalScore: 1, quotes: [{ text: QUOTE, source: "Group Report 2023" }], packText: PACK, policyVersion: "v2" });
  assert.equal(v2.gate.quotesValid, 0, "the invented second span is not present → whole quote fails");
  assert.ok(v2.gate.failures[0].reasons.includes("provenance"));
});

// ─── over-rejection guard: ordinary genuine quote still passes ──────────────
test("over-rejection guard: a plain genuine in-pack quote with a good source PASSES under v2", () => {
  const SENTENCE = "The group's remuneration policy links executive pay to verified emissions-reduction milestones.";
  const PACK = `... ${SENTENCE} ... other content ...`;
  const v2 = gateEvidence({
    originalScore: 1,
    quotes: [{ text: SENTENCE, source: "Group Remuneration Report 2023" }],
    packText: PACK,
    positiveExamples: [RUBRIC_EXAMPLE],
    policyVersion: "v2",
  });
  assert.equal(v2.gate.quotesValid, 1);
  assert.equal(v2.score, 1);
});

// ─── binary scoring invariants under v2 ─────────────────────────────────────
test("invariant: NO stays 0 and is never downgraded (v2)", () => {
  const r = gateEvidence({
    originalScore: 0,
    quotes: [{ text: GENUINE_PREFIX, source: "Group Report 2023" }],
    packText: BASE_PACK,
    policyVersion: "v2",
  });
  assert.equal(r.score, 0);
  assert.equal(r.gate.downgraded, false);
});

test("invariant: gate only ever emits 0 or 1 (v2)", () => {
  const r = gateEvidence({
    originalScore: 1,
    quotes: [{ text: GENUINE_PREFIX, source: "Group Report 2023" }],
    packText: BASE_PACK,
    policyVersion: "v2",
  });
  assert.ok(r.score === 0 || r.score === 1, "score is strictly binary");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
