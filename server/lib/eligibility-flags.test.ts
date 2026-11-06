/**
 * eligibility-flags.test.ts — focused, DB-free unit tests for Change #3.
 *
 * Run: DATABASE_URL=postgres://x npx tsx server/lib/eligibility-flags.test.ts
 * (DATABASE_URL is only needed because issuer-resolver transitively imports the
 *  pg pool at load time; deriveAliases and everything here is pure — no DB I/O.)
 *
 * Convention: check(name, cond) prints PASS/FAIL and tracks a failure count.
 */

import {
  computeEligibilityFlags,
  isPositiveVerdict,
  type EligibilityFlagId,
  type EligibilityFlagsInput,
} from "./eligibility-flags.js";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond) failures++;
}

function fired(input: EligibilityFlagsInput, id: EligibilityFlagId): boolean {
  const r = computeEligibilityFlags(input);
  const f = r.flags.find((x) => x.id === id);
  return !!f && f.triggered;
}

// A generic, non-AI-governance company to prove topic-agnosticism.
const ACME = { name: "Acme Beverages Corporation", ticker: "ABV", domain: "acme-bev.com", relatedDomains: ["acmebeverages.com"] };

// ─── 0. Advisory invariant: always five flags, always advisoryOnly, dismissible ─
{
  const r = computeEligibilityFlags({
    verdict: "Yes",
    quotes: [{ text: "Acme has established a board committee since 2024.", sourceUrl: "https://acme-bev.com/report" }],
    company: ACME,
  });
  check("returns exactly five flags", r.flags.length === 5);
  check("advisoryOnly invariant is true", r.advisoryOnly === true);
  check("every flag is advisory severity and dismissible", r.flags.every((f) => f.severity === "advisory" && f.dismissible === true));
  check("no flag exposes a verdict-mutation field", r.flags.every((f) => !("verdict" in (f as any)) && !("score" in (f as any)) && !("newVerdict" in (f as any))));
  check("triggeredCount matches triggered flags", r.triggeredCount === r.flags.filter((f) => f.triggered).length);
}

// ─── 1. entity-attribution ─────────────────────────────────────────────────────
{
  // Passage mentions a DIFFERENT entity (affiliate/partner), not the target.
  const flaggedInput: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "Globex Logistics announced a robotics partnership with a group affiliate.", sourceUrl: "https://x.com/a" }],
    company: ACME,
  };
  check("entity-attribution FIRES when target not mentioned", fired(flaggedInput, "entity-attribution"));

  const cleanInput: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "Acme Beverages has operated an internal ethics committee since 2023.", sourceUrl: "https://acme-bev.com/x" }],
    company: ACME,
  };
  check("entity-attribution CLEARS when target named", !fired(cleanInput, "entity-attribution"));
}

// ─── 1b. entity-attribution: QUOTES-ONLY signal (the Accenture bug) ─────────────
// Mirrors the scoring gate in analyzer.ts: the entity-attribution flag is the ONLY
// eligibility flag that downgrades. A positive cell is downgraded to No iff the
// entity-attribution flag fires. This predicate replicates that gate so the
// downgrade outcome is asserted here, next to the flag logic that drives it.
function entityGateDowngrades(input: EligibilityFlagsInput): boolean {
  if (!isPositiveVerdict(input.verdict)) return false;
  return fired(input, "entity-attribution");
}
{
  // (b) The Accenture pattern: the rationale/summary NAMES the target, but the
  // supporting QUOTES describe only OTHER entities (clients / case-study
  // subjects). Combined check would pass (summary mentions Acme); quotes-only
  // check must fire → flagged AND downgraded.
  const accenturePattern: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [
      { text: "A global semiconductor company leveraged an AI-powered cloud platform to reduce costs.", sourceUrl: "https://acme-bev.com/thought-leadership" },
      { text: "Metro de Madrid deployed AI algorithms to reduce its annual energy intake by 25%.", sourceUrl: "https://acme-bev.com/thought-leadership" },
    ],
    evidenceSummary: "These are client/industry case examples in Acme Beverages' own report rather than Acme Beverages' own internal objectives, but they are concrete qualifying instances.",
    company: ACME,
  };
  check("entity-attribution FIRES on quotes-only signal when summary names target but quotes do not (Accenture pattern)", fired(accenturePattern, "entity-attribution"));
  check("Accenture pattern → downgraded to No", entityGateDowngrades(accenturePattern) === true);

  // (a)/(c) Normal positive cell: the target IS named in the supporting quotes →
  // not flagged, not downgraded, unaffected.
  const targetInQuotes: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [
      { text: "Acme Beverages deployed its own AI platform internally to reduce its annual energy use by 25%.", sourceUrl: "https://acme-bev.com/report" },
    ],
    evidenceSummary: "Acme Beverages describes its own internal AI deployment.",
    company: ACME,
  };
  check("entity-attribution CLEARS when target named in the supporting quotes", !fired(targetInQuotes, "entity-attribution"));
  check("normal positive cell with target in quotes → NOT downgraded", entityGateDowngrades(targetInQuotes) === false);

  // Guard: a positive cell whose only name mention is in the summary (no quotes)
  // still relies on the combined signal (not the quotes-only branch).
  const summaryOnlyNamed: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [],
    evidenceSummary: "Acme Beverages maintains an internal ethics committee.",
    company: ACME,
  };
  check("entity-attribution does not misfire when no quotes present but summary names target", !fired(summaryOnlyNamed, "entity-attribution"));

  // Softer flags stay advisory: a planned-only cell that DOES name the target in
  // quotes must NOT be downgraded by the entity gate (only entity-attribution gates).
  const plannedButNamed: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "Acme Beverages plans to establish an AI oversight board by 2027.", sourceUrl: "https://acme-bev.com/x" }],
    company: ACME,
  };
  check("planned-only cell that names target in quotes is NOT downgraded by entity gate", entityGateDowngrades(plannedButNamed) === false);
  check("planned-vs-live still fires advisory on that cell", fired(plannedButNamed, "planned-vs-live"));
}

// ─── 2. date-window ─────────────────────────────────────────────────────────────
{
  const stale: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "Acme published its governance charter in 2015.", sourceUrl: "https://acme-bev.com/2015" }],
    company: ACME,
    window: { currentYear: 2026, yearsBack: 3 }, // in-window = 2023..2026
  };
  check("date-window FIRES when newest year outside window", fired(stale, "date-window"));

  const recent: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "Acme published its governance charter in 2015 and refreshed it in 2025.", sourceUrl: "https://acme-bev.com/2025" }],
    company: ACME,
    window: { currentYear: 2026, yearsBack: 3 },
  };
  check("date-window CLEARS when a recent year is present", !fired(recent, "date-window"));

  const noYear: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "Acme maintains a governance charter.", sourceUrl: "https://acme-bev.com/x" }],
    company: ACME,
    window: { currentYear: 2026, yearsBack: 3 },
  };
  check("date-window does NOT fire when no year present (not penalised)", !fired(noYear, "date-window"));
}

// ─── 3. planned-vs-live ─────────────────────────────────────────────────────────
{
  const planned: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "Acme plans to establish an AI oversight board by 2027.", sourceUrl: "https://acme-bev.com/x" }],
    company: ACME,
  };
  check("planned-vs-live FIRES on planned-only language", fired(planned, "planned-vs-live"));

  const live: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "Acme has established an AI oversight board, operating since 2024.", sourceUrl: "https://acme-bev.com/x" }],
    company: ACME,
  };
  check("planned-vs-live CLEARS when live/implemented language present", !fired(live, "planned-vs-live"));
}

// ─── 4. author-vs-adopter ───────────────────────────────────────────────────────
{
  const author: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "Acme offers guidance to customers on how they can adopt responsible practices.", sourceUrl: "https://acme-bev.com/x" }],
    company: ACME,
  };
  check("author-vs-adopter FIRES on authored-for-customers framing", fired(author, "author-vs-adopter"));

  const adopter: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "We have adopted and maintain our own internal responsible-sourcing policy across the group.", sourceUrl: "https://acme-bev.com/x" }],
    company: ACME,
  };
  check("author-vs-adopter CLEARS on own-adoption framing", !fired(adopter, "author-vs-adopter"));
}

// ─── 5. claim-level-source-link ─────────────────────────────────────────────────
{
  const noLink: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "Acme operates an internal ethics committee since 2024." }], // no sourceUrl
    company: ACME,
  };
  check("claim-level-source-link FIRES when no quote carries an HTTP link", fired(noLink, "claim-level-source-link"));

  const withLink: EligibilityFlagsInput = {
    verdict: "Yes",
    quotes: [{ text: "Acme operates an internal ethics committee since 2024.", sourceUrl: "https://acme-bev.com/ethics" }],
    company: ACME,
  };
  check("claim-level-source-link CLEARS when a quote carries an HTTP link", !fired(withLink, "claim-level-source-link"));
}

// ─── 6. Non-positive verdicts → all untriggered ────────────────────────────────
{
  for (const verdict of ["No", "Insufficient evidence", "Evidence absent", "Scoring error"]) {
    const r = computeEligibilityFlags({ verdict, quotes: [{ text: "Globex plans to establish something in 2010." }], company: ACME });
    check(`non-positive verdict '${verdict}' → zero triggered flags`, r.triggeredCount === 0 && r.flags.length === 5);
  }
  check("isPositiveVerdict recognises Yes/Partial only", isPositiveVerdict("Yes") && isPositiveVerdict("Partial") && !isPositiveVerdict("No") && !isPositiveVerdict("Insufficient evidence"));
}

// ─── 7. Topic-agnostic: works for a completely different company/topic ──────────
{
  const bank = { name: "Zenith National Bank", ticker: "ZNB", domain: "zenithbank.example", relatedDomains: [] };
  const flagged = computeEligibilityFlags({
    verdict: "Partial",
    quotes: [{ text: "A different lender plans to launch a green bond programme by 2030." }],
    company: bank,
  });
  // Different entity + planned + no link should all fire — proving generic behaviour.
  const ids = new Set(flagged.flags.filter((f) => f.triggered).map((f) => f.id));
  check("generic company: entity-attribution fires", ids.has("entity-attribution"));
  check("generic company: planned-vs-live fires", ids.has("planned-vs-live"));
  check("generic company: claim-level-source-link fires", ids.has("claim-level-source-link"));
}

// ─── 8. Never throws on malformed input ────────────────────────────────────────
{
  const bad: any[] = [
    undefined,
    null,
    {},
    { verdict: "Yes" },
    { verdict: "Yes", quotes: null, company: null },
    { verdict: "Yes", quotes: [null, { text: 123 }], company: { name: "" } },
    { verdict: "Yes", quotes: [{ text: "x" }], company: { name: "X", ticker: null, aliases: null, relatedDomains: null } },
  ];
  let threw = false;
  for (const b of bad) {
    try {
      const r = computeEligibilityFlags(b);
      if (r.flags.length !== 5 || r.advisoryOnly !== true) threw = true;
    } catch {
      threw = true;
    }
  }
  check("never throws and always returns five advisory flags on bad input", !threw);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
