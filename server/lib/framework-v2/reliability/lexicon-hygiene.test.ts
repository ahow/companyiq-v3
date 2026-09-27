import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyAutoCleanDebris,
  isTopicallyAnchored,
  runSurfaceHygiene,
  runLexiconHygiene,
  type SurfaceInput,
} from "./lexicon-hygiene.js";

// One representative string per residue class. Each is chosen so the FIRST matching
// AUTO_CLEAN_DEBRIS entry is the intended class (formatting-debris is checked first, so
// none of these carry a stray "):" or trailing colon except the formatting case).
const RESIDUE_BY_CLASS: Array<{ term: string; reason: string }> = [
  { term: "voting matters:", reason: "formatting-debris" },
  { term: "check the appropriate box", reason: "checkbox-scaffolding" },
  { term: "proxy materials", reason: "proxy-materials" },
  { term: "important notice", reason: "notice-of-availability" },
  { term: "annual meeting of stockholders", reason: "meeting-logistics" },
  { term: "vote by internet", reason: "voting-logistics" },
  { term: "investor@example.com", reason: "contact-detail" },
  { term: "receive paper copies", reason: "receive-materials" },
  { term: "transfer agent", reason: "registrar-residue" },
  { term: "managing member", reason: "signature-attestation" },
  { term: "filing fee", reason: "fee-exhibit-scaffolding" },
  { term: "form 10-k", reason: "form-type-identifier" },
];

test("classifyAutoCleanDebris identifies all 12 residue classes", () => {
  assert.equal(RESIDUE_BY_CLASS.length, 12);
  for (const { term, reason } of RESIDUE_BY_CLASS) {
    assert.equal(classifyAutoCleanDebris(term), reason, `expected "${term}" -> ${reason}`);
  }
});

test("runSurfaceHygiene auto-cleans all 12 residue classes (dropped, not kept)", () => {
  const input: SurfaceInput = {
    surface: "topicSynonyms",
    terms: RESIDUE_BY_CLASS.map((r) => r.term),
    origin: "intake",
  };
  const res = runSurfaceHygiene(input, new Set());
  assert.equal(res.autoCleaned.length, 12, "all 12 residue terms should be auto-cleaned");
  assert.equal(res.kept.length, 0, "no residue term should survive in the lexicon");
  // Every dropped term must carry its debris-class reason in provenance.
  for (const { term, reason } of RESIDUE_BY_CLASS) {
    const p = res.provenance.find((x) => x.term === term);
    assert.ok(p, `provenance missing for ${term}`);
    assert.equal(p!.action, "auto-cleaned");
    assert.equal(p!.flagReason, reason);
  }
});

test("legitimate topic vocabulary is preserved (never auto-cleaned)", () => {
  const legit = [
    "machine learning",
    "generative ai",
    "algorithmic accountability",
    "responsible ai",
    "model governance",
    "biodiversity restoration",
    "scope 3 emissions",
  ];
  // Supplied as the framework's own lexicon => protected.
  const res = runSurfaceHygiene(
    { surface: "topicSynonyms", terms: legit, origin: "intake" },
    new Set(legit.flatMap((t) => t.toLowerCase().split(/\s+/))),
  );
  assert.equal(res.autoCleaned.length, 0, "no legitimate term should be auto-cleaned");
  for (const t of legit) assert.ok(res.kept.includes(t), `${t} should be kept`);
});

test("evidenceKeywords surface IS actually checked (not skipped)", () => {
  const res = runLexiconHygiene({
    surfaces: [
      { surface: "evidenceKeywords", terms: ["transfer agent", "model governance"], origin: "intake" },
    ],
    topicTokens: ["model", "governance"],
  });
  const ek = res.surfaces.find((s) => s.surface === "evidenceKeywords");
  assert.ok(ek, "evidenceKeywords surface should be present in results");
  assert.ok(ek!.autoCleaned.includes("transfer agent"), "debris in evidenceKeywords should be cleaned");
  assert.ok(ek!.kept.includes("model governance"), "protected evidence keyword should be kept");
  // Provenance must record the surface for every term.
  assert.ok(ek!.provenance.every((p) => p.surface === "evidenceKeywords"));
});

test("provenance is populated for every term with required fields", () => {
  const res = runLexiconHygiene({
    surfaces: [
      { surface: "topicSynonyms", terms: ["proxy materials", "responsible ai"], origin: "llm" },
    ],
    topicTokens: ["responsible", "ai"],
  });
  assert.equal(res.provenance.length, 2);
  for (const p of res.provenance) {
    assert.equal(typeof p.term, "string");
    assert.ok(["topicSynonyms", "evidenceKeywords", "documentFilingHints", "retrievalQueryTerms"].includes(p.surface));
    assert.ok(["intake", "llm"].includes(p.origin));
    assert.ok(["auto-cleaned", "flagged-for-review", "kept"].includes(p.action));
  }
});

test("admission predicate: LLM term not topically anchored is flagged for review (kept, not dropped)", () => {
  const topicTokens = new Set(["artificial", "intelligence", "machine", "learning", "algorithmic"]);

  // Anchored LLM term shares a distinctive topic token -> kept clean.
  assert.equal(isTopicallyAnchored("algorithmic accountability", topicTokens), true);
  // Unanchored, non-debris LLM term -> flagged for review (admission not satisfied).
  assert.equal(isTopicallyAnchored("quarterly outlook", topicTokens), false);

  const res = runSurfaceHygiene(
    { surface: "topicSynonyms", terms: ["algorithmic accountability", "quarterly outlook"], origin: "llm" },
    topicTokens,
  );
  const anchored = res.provenance.find((p) => p.term === "algorithmic accountability")!;
  const unanchored = res.provenance.find((p) => p.term === "quarterly outlook")!;
  assert.equal(anchored.action, "kept");
  assert.equal(unanchored.action, "flagged-for-review");
  assert.equal(unanchored.flagReason, "admission-not-anchored");
  // Flagged term is KEPT in the lexicon (reviewable), never silently dropped.
  assert.ok(res.kept.includes("quarterly outlook"));
  assert.equal(res.suspectCount, 1);
});

test("empty and duplicate terms are auto-cleaned with structural reasons", () => {
  const res = runSurfaceHygiene(
    { surface: "topicSynonyms", terms: ["responsible ai", "responsible ai", "", "  "], origin: "intake" },
    new Set(["responsible", "ai"]),
  );
  const dupReasons = res.provenance.filter((p) => p.flagReason === "duplicate");
  const emptyReasons = res.provenance.filter((p) => p.flagReason === "empty");
  assert.equal(dupReasons.length, 1, "second occurrence is a duplicate");
  assert.equal(emptyReasons.length, 2, "blank strings are empty");
  assert.equal(res.kept.length, 1, "only the first responsible ai survives");
});
