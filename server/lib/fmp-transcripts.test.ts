/**
 * Tests for the FMP earnings-call transcript lane with executive-only attribution.
 *
 * Design: /home/ubuntu/shared/companyiq-programme/fmp_transcripts_design_note.md
 *
 * These tests run entirely against committed REAL 3M fixtures (fetched from the
 * live FMP API at authoring time; the API key is never committed). They prove:
 *   - the executive roster is built from key-executives (+ optional ceo),
 *   - executive turns (William Brown CEO, Anurag Maheshwari CFO, Chinmay Trivedi
 *     SVP IR) are KEPT and their text becomes the scored content,
 *   - analyst turns (Andrew Obin, Scott Davis, Jeffrey Sprague) and Operator turns
 *     are EXCLUDED,
 *   - nickname matching works on real data: roster "William Brown" matches the Q1
 *     transcript label "Bill Brown",
 *   - name matching tolerates middle initials and single-letter initials,
 *   - the §3.4 fail-safe excludes the whole transcript on no roster, unparseable
 *     structure, or zero executive turns.
 *
 * Run: node --import tsx --test server/lib/fmp-transcripts.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  canonFirstName,
  namesMatch,
  buildExecutiveRoster,
  segmentTranscript,
  attributeTranscript,
  transcriptUrl,
  type KeyExecutive,
  type RawTranscript,
  type RosterEntry,
} from "./fmp-transcripts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FX = join(__dirname, "__fixtures__", "fmp");

function loadJson(name: string): any {
  return JSON.parse(readFileSync(join(FX, name), "utf8"));
}

const keyExecs: KeyExecutive[] = loadJson("mmm-key-executives.json");
const q2 = (loadJson("mmm-transcript-2025-q2.json") as RawTranscript[])[0];
const q1 = (loadJson("mmm-transcript-2025-q1.json") as RawTranscript[])[0];

// ─── canonFirstName (nickname normalization) ──────────────────────────────────

test("canonFirstName resolves common nicknames to canonical forms", () => {
  assert.equal(canonFirstName("Bill"), "william");
  assert.equal(canonFirstName("bill"), "william");
  assert.equal(canonFirstName("Bob"), "robert");
  assert.equal(canonFirstName("Bobby"), "robert");
  assert.equal(canonFirstName("Jeff"), "jeffrey");
  assert.equal(canonFirstName("Andy"), "andrew");
  assert.equal(canonFirstName("Joe"), "joseph");
  // A name with no nickname mapping passes through lowercased.
  assert.equal(canonFirstName("Anurag"), "anurag");
});

// ─── namesMatch (nickname + initial + middle-initial tolerance) ───────────────

test("namesMatch handles nicknames, initials, middle initials, and suffixes", () => {
  // Real-data nickname case: Q1 label "Bill Brown" vs roster "William Brown".
  assert.ok(namesMatch("Bill Brown", "William Brown"));
  assert.ok(namesMatch("William Brown", "William Brown"));
  // Single-letter initial.
  assert.ok(namesMatch("W. Brown", "William Brown"));
  // Middle initial on the roster side is ignored.
  assert.ok(namesMatch("Bobby George", "Bobby K. George"));
  assert.ok(namesMatch("Bob George", "Bobby K. George"));
  // Suffix tolerance.
  assert.ok(namesMatch("Christian Goralski", "Christian T. Goralski Jr."));
  // Surname mismatch must NOT match.
  assert.ok(!namesMatch("William Smith", "William Brown"));
  // Different first name, same surname must NOT match.
  assert.ok(!namesMatch("Andrew Brown", "William Brown"));
  // An analyst name is not in the roster.
  assert.ok(!namesMatch("Andrew Obin", "William Brown"));
});

// ─── buildExecutiveRoster ─────────────────────────────────────────────────────

test("buildExecutiveRoster includes all active execs and dedups the ceo", () => {
  const roster = buildExecutiveRoster(keyExecs, "William Brown");
  // All 12 fixture execs are active → 12 entries, ceo already present (no dup).
  assert.equal(roster.length, 12);
  const names = roster.map((r) => r.name);
  assert.ok(names.includes("William Brown"));
  assert.ok(names.includes("Anurag Maheshwari"));
  assert.ok(names.includes("Chinmay Trivedi"));
  assert.ok(names.includes("Bobby K. George"));
});

test("buildExecutiveRoster adds the ceo when not already on the roster", () => {
  const minimal: KeyExecutive[] = [{ name: "Anurag Maheshwari", title: "CFO", active: true }];
  const roster = buildExecutiveRoster(minimal, "William Brown");
  assert.equal(roster.length, 2);
  assert.ok(roster.some((r) => r.name === "William Brown"));
});

test("buildExecutiveRoster drops inactive officers", () => {
  const mixed: KeyExecutive[] = [
    { name: "Active Exec", title: "CEO", active: true },
    { name: "Former Exec", title: "Retired", active: false },
  ];
  const roster = buildExecutiveRoster(mixed, null);
  assert.equal(roster.length, 1);
  assert.equal(roster[0].name, "Active Exec");
});

// ─── segmentTranscript ────────────────────────────────────────────────────────

test("segmentTranscript splits the real Q2 transcript into speaker turns", () => {
  const turns = segmentTranscript(q2.content);
  assert.ok(turns.length > 40, `expected many turns, got ${turns.length}`);
  // First meaningful turn should be the Operator opening the call.
  assert.ok(turns.some((t) => t.speaker === "Operator"));
  assert.ok(turns.some((t) => t.speaker === "William Brown"));
  assert.ok(turns.some((t) => t.speaker === "Andrew Obin"));
});

// ─── attributeTranscript: Q2 2025 (direct CEO match) ──────────────────────────

test("attributeTranscript Q2: keeps executives, excludes analysts and operator", () => {
  const roster = buildExecutiveRoster(keyExecs, "William Brown");
  const { attribution, executiveContent } = attributeTranscript(q2.content, roster);

  assert.equal(attribution.kept, true);
  assert.equal(attribution.excludeReason, undefined);
  assert.ok(attribution.executiveTurnCount > 0);

  const roleOf = (speaker: string) =>
    attribution.turns.find((t) => t.speaker === speaker)?.role;

  // Executives kept.
  assert.equal(roleOf("William Brown"), "executive");
  assert.equal(roleOf("Anurag Maheshwari"), "executive"); // CFO — executive, KEPT
  assert.equal(roleOf("Chinmay Trivedi"), "executive"); // SVP IR — executive, KEPT

  // Analysts excluded.
  assert.equal(roleOf("Andrew Obin"), "analyst");
  assert.equal(roleOf("Scott Davis"), "analyst");
  assert.equal(roleOf("Jeffrey Sprague"), "analyst");

  // Operator excluded.
  assert.equal(roleOf("Operator"), "operator");

  // The analyst/operator turns must not be marked kept.
  for (const t of attribution.turns) {
    if (["Andrew Obin", "Scott Davis", "Jeffrey Sprague", "Operator"].includes(t.speaker)) {
      assert.equal(t.kept, false, `${t.speaker} should be excluded`);
    }
  }

  // The scored content contains CEO words but NOT analyst/operator words.
  assert.ok(executiveContent.includes("William Brown:"));
  assert.ok(!executiveContent.includes("Andrew Obin:"));
  assert.ok(!executiveContent.includes("Operator:"));
});

// ─── attributeTranscript: Q1 2025 (nickname match "Bill Brown") ───────────────

test("attributeTranscript Q1: nickname 'Bill Brown' matches roster 'William Brown'", () => {
  const roster = buildExecutiveRoster(keyExecs, "William Brown");
  const { attribution, executiveContent } = attributeTranscript(q1.content, roster);

  assert.equal(attribution.kept, true);

  const billBrown = attribution.turns.find((t) => t.speaker === "Bill Brown");
  assert.ok(billBrown, "expected a 'Bill Brown' turn in the Q1 transcript");
  assert.equal(billBrown!.role, "executive");
  assert.equal(billBrown!.kept, true);

  // Scored content includes the nickname-labelled CEO.
  assert.ok(executiveContent.includes("Bill Brown:"));
  // Analyst variants in Q1 are excluded.
  const roleOf = (speaker: string) =>
    attribution.turns.find((t) => t.speaker === speaker)?.role;
  assert.equal(roleOf("Scott Davis"), "analyst");
});

// ─── Fail-safe (§3.4) ─────────────────────────────────────────────────────────

test("fail-safe: no roster excludes the whole transcript", () => {
  const { attribution, executiveContent } = attributeTranscript(q2.content, []);
  assert.equal(attribution.kept, false);
  assert.equal(attribution.excludeReason, "no_roster");
  assert.equal(executiveContent, "");
});

test("fail-safe: unparseable content excludes the whole transcript", () => {
  const roster: RosterEntry[] = [{ name: "William Brown", title: "CEO" }];
  const blob = "this is just a paragraph of prose with no speaker labels at all and no colons structure";
  const { attribution, executiveContent } = attributeTranscript(blob, roster);
  assert.equal(attribution.kept, false);
  assert.equal(attribution.excludeReason, "unparseable");
  assert.equal(executiveContent, "");
});

test("fail-safe: zero executive turns excludes the whole transcript", () => {
  const roster: RosterEntry[] = [{ name: "William Brown", title: "CEO" }];
  // Only analysts and the operator speak — no roster executive present.
  const analystsOnly = [
    "Operator: Welcome to the call.",
    "Andrew Obin: My first question is on margins.",
    "Scott Davis: A follow-up on capital allocation.",
  ].join("\n");
  const { attribution, executiveContent } = attributeTranscript(analystsOnly, roster);
  assert.equal(attribution.kept, false);
  assert.equal(attribution.excludeReason, "no_executive_turns");
  assert.equal(executiveContent, "");
  assert.equal(attribution.totalTurnCount, 3);
  assert.equal(attribution.executiveTurnCount, 0);
});

// ─── transcriptUrl ────────────────────────────────────────────────────────────

test("transcriptUrl is stable, key-free, and unique per quarter", () => {
  assert.equal(transcriptUrl("mmm", 2025, 2), "fmp-transcript://MMM/2025/Q2");
  assert.notEqual(transcriptUrl("MMM", 2025, 1), transcriptUrl("MMM", 2025, 2));
});
