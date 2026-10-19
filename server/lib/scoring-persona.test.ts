/**
 * Deterministic unit tests for the topic-derived scoring persona.
 *
 * buildScoringPersona replaces the former hardcoded "ESG/governance analyst"
 * opening sentence of the scoring system prompt with a persona derived from the
 * framework's OWN topic fields. These tests are fully offline (no DB, no LLM, no
 * scoring batch) and prove the helper is topic/company-agnostic and deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildScoringPersona } from "./analyzer.js";

const SUFFIX = "analyst scoring corporate disclosures against a structured assessment framework.";

test("stored scoringPersona is returned verbatim (builder-generated takes precedence)", () => {
  const stored = "You are an expert water-stewardship analyst scoring corporate disclosures against a structured assessment framework.";
  const out = buildScoringPersona({ scoringPersona: stored, topicTerm: "something else" } as any);
  assert.equal(out, stored);
});

test("derives from topicTerm when no stored persona (AI Management)", () => {
  const out = buildScoringPersona({ topicTerm: "AI Management" } as any);
  assert.equal(
    out,
    `You are an expert AI Management ${SUFFIX}`,
  );
});

test("derives from a wholly unrelated topic (climate) — proves topic-agnosticism", () => {
  const out = buildScoringPersona({ topicTerm: "climate transition" } as any);
  assert.equal(out, `You are an expert climate transition ${SUFFIX}`);
});

test("falls back to topicDescription when topicTerm absent", () => {
  const out = buildScoringPersona({ topicDescription: "modern slavery in supply chains" } as any);
  assert.equal(out, `You are an expert modern slavery in supply chains ${SUFFIX}`);
});

test("falls back to name when topicTerm and topicDescription absent", () => {
  const out = buildScoringPersona({ name: "Data Privacy" } as any);
  assert.equal(out, `You are an expert Data Privacy ${SUFFIX}`);
});

test("neutral generic persona when no topic fields at all — and it contains NO 'ESG'", () => {
  const out = buildScoringPersona({} as any);
  assert.equal(out, `You are an expert ${SUFFIX}`);
  assert.ok(!/ESG/i.test(out), "generic persona must not contain ESG");
  assert.ok(!/governance/i.test(out), "generic persona must not contain governance");
});

test("handles undefined framework → neutral generic", () => {
  const out = buildScoringPersona(undefined);
  assert.equal(out, `You are an expert ${SUFFIX}`);
});

test("agnosticism regression guard: derived AI/climate personas carry no ESG/governance literal", () => {
  for (const topic of ["AI Management", "climate transition", "ocean plastics"]) {
    const out = buildScoringPersona({ topicTerm: topic } as any);
    assert.ok(!out.includes("ESG/governance"), `${topic} persona must not contain "ESG/governance"`);
  }
});

test("sanitises whitespace and caps absurdly long topic strings at 120 chars", () => {
  const messy = "   AI    Management\n\n  Oversight   ";
  const out = buildScoringPersona({ topicTerm: messy } as any);
  assert.equal(out, `You are an expert AI Management Oversight ${SUFFIX}`);

  const long = "x".repeat(500);
  const outLong = buildScoringPersona({ topicTerm: long } as any);
  const topicPart = outLong.slice("You are an expert ".length, outLong.length - (" " + SUFFIX).length);
  assert.ok(topicPart.length <= 120, `topic segment should be capped at 120 chars, got ${topicPart.length}`);
});

test("empty / whitespace-only stored persona is ignored, derivation used instead", () => {
  const out = buildScoringPersona({ scoringPersona: "   ", topicTerm: "AI Management" } as any);
  assert.equal(out, `You are an expert AI Management ${SUFFIX}`);
});

test("source guard: analyzer.ts no longer contains the hardcoded 'ESG/governance analyst' literal", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "analyzer.ts"), "utf8");
  assert.ok(
    !src.includes("ESG/governance analyst"),
    "analyzer.ts must not contain the hardcoded 'ESG/governance analyst' persona",
  );
  assert.ok(
    !src.includes("ESG/governance"),
    "analyzer.ts must not contain the 'ESG/governance' literal at all",
  );
});
