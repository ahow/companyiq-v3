/**
 * scoring-contract.test.ts — focused, DB-free unit tests for Change #4.
 *
 * Run: DATABASE_URL=postgres://x npx tsx server/lib/framework-v2/scoring-contract.test.ts
 * (DATABASE_URL is only needed because a sibling module transitively imports the
 *  pg pool at load time; nothing here touches the database.)
 *
 * Convention: check(name, cond) prints PASS/FAIL and tracks a failure count.
 */

import {
  resolveScoringContract,
  emitHardenedFramework,
  describeDowngrade,
  OUTCOME_TO_VERDICT,
  LOW_CONFIDENCE_POSITIVE_TO_PARTIAL,
  type ScoringContract,
} from "./scoring-contract.js";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond) failures++;
}

// ─── 1. Five outcomes are present, distinct and non-overlapping ────────────────
{
  const c = resolveScoringContract({
    measureId: "M1",
    substantiveDefinition: "The entity publishes an independently assured net-zero transition plan.",
  });
  const o = c.outcomes;
  check("all five outcome definitions present", [o.yes, o.partial, o.notApplicable, o.no, o.noEvidenceFound].every((s) => typeof s === "string" && s.length > 10));
  const set = new Set([o.yes, o.partial, o.notApplicable, o.no, o.noEvidenceFound]);
  check("five outcome definitions are mutually distinct", set.size === 5);
  // no-evidence-found must be DISTINCT from no (evidence of absence)
  check("noEvidenceFound distinct from no", o.noEvidenceFound !== o.no && /distinct/i.test(o.noEvidenceFound));
  check("no = evidence of absence (substantive negative)", /absent|absence|discontinued|not adopted/i.test(o.no));
  check("notApplicable is an applicability judgement, not nondisclosure", /appl(y|ies|icab)/i.test(o.notApplicable));
  // outcome→verdict map covers all five and maps noEvidenceFound to a distinct verdict from no
  check("OUTCOME_TO_VERDICT covers all five", ["yes", "partial", "notApplicable", "no", "noEvidenceFound"].every((k) => typeof (OUTCOME_TO_VERDICT as any)[k] === "string"));
  check("noEvidenceFound verdict differs from no verdict", OUTCOME_TO_VERDICT.noEvidenceFound !== OUTCOME_TO_VERDICT.no);
}

// ─── 2. Explicit precedence: substantiveDefinition wins over fallback/guidance ─
{
  const c = resolveScoringContract({
    measureId: "M2",
    substantiveDefinition: "SUBSTANTIVE BAR",
    fallbackYesCriterion: "FALLBACK BAR",
    scoringGuidance: "GUIDANCE PROSE",
  });
  check("precedence lists substantiveDefinition first", c.precedence[0] === "substantiveDefinition");
  check("Yes bar derived from substantiveDefinition", c.outcomes.yes.includes("SUBSTANTIVE BAR"));
  check("derived contract marked not persisted", c.wasPersisted === false);
  check("separable axes recorded (4 axes kept separate)", c.separableAxes.length === 4 && c.separableAxes.includes("confidence"));
}

// ─── 3. Precedence falls through when higher fields absent ─────────────────────
{
  const c = resolveScoringContract({ measureId: "M3", fallbackYesCriterion: "ONLY FALLBACK" });
  check("falls back to fallbackYesCriterion when no substantive", c.outcomes.yes.includes("ONLY FALLBACK") && c.precedence.includes("fallbackYesCriterion"));
  const d = resolveScoringContract({ measureId: "M4" });
  check("empty measure still yields a well-formed contract", d.outcomes.yes.length > 10 && d.precedence.includes("derived-default"));
}

// ─── 4. Persisted contract is read back verbatim (one source of truth) ─────────
{
  const persistedGuidance = JSON.stringify({
    someExistingKey: "keep me",
    decisionContract: {
      contractVersion: 7,
      measureId: "M5",
      precedence: ["persisted-field"],
      outcomes: {
        yes: "PERSISTED YES",
        partial: "PERSISTED PARTIAL",
        notApplicable: "PERSISTED NA",
        no: "PERSISTED NO",
        noEvidenceFound: "PERSISTED NOEV",
      },
    },
  });
  const c = resolveScoringContract({ measureId: "M5", scoringGuidance: persistedGuidance });
  check("persisted contract is used (wasPersisted true)", c.wasPersisted === true);
  check("persisted outcomes read back verbatim", c.outcomes.yes === "PERSISTED YES" && c.outcomes.noEvidenceFound === "PERSISTED NOEV");
  check("persisted contractVersion preserved", c.contractVersion === 7);
}

// ─── 5. describeDowngrade: NAMED, explicit, applied vs not-applied surfaced ────
{
  const applied = describeDowngrade("Yes", "Low", "downgrade", 1);
  check("downgrade APPLIES on low-confidence Yes with downgrade policy", applied.applied === true && applied.finalVerdict === "Partial");
  check("applied decision carries the named rule id", applied.ruleId === LOW_CONFIDENCE_POSITIVE_TO_PARTIAL.id);
  check("applied decision preserves proposed verdict", applied.proposedVerdict === "Yes");
  check("applied reason names the confidence axis", /confidence/i.test(applied.reason));

  const notLow = describeDowngrade("Yes", "High", "downgrade", 1);
  check("no downgrade when confidence not Low (Yes stands)", notLow.applied === false && notLow.finalVerdict === "Yes");

  const flagPolicy = describeDowngrade("Yes", "Low", "flag", 1);
  check("no downgrade when policy is not 'downgrade'", flagPolicy.applied === false && flagPolicy.finalVerdict === "Yes");

  const notPositive = describeDowngrade("No", "Low", "downgrade", 0);
  check("no downgrade for a non-positive verdict", notPositive.applied === false);

  // In all cases the decision is REPORTED (never silent): a rule id + reason exist.
  check("every decision reports a rule id and reason", [applied, notLow, flagPolicy, notPositive].every((d) => d.ruleId && d.reason.length > 0));
}

// ─── 6. emitHardenedFramework: pure, non-mutating, version+1, contracts carried ─
{
  const framework = { id: 42, name: "Some Framework", version: 3, isActive: true, productionReady: true };
  const measures = [
    { id: 100, measureId: "A1", substantiveDefinition: "Bar A" },
    { id: 101, measureId: "A2", scoringGuidance: "Prose bar B" },
  ];
  const frozenFrameworkJson = JSON.stringify(framework);
  const frozenMeasuresJson = JSON.stringify(measures);

  const out = emitHardenedFramework(framework, measures);

  // Non-mutation: inputs unchanged.
  check("input framework NOT mutated", JSON.stringify(framework) === frozenFrameworkJson);
  check("input measures NOT mutated", JSON.stringify(measures) === frozenMeasuresJson);

  // New framework: version+1, id cleared, name suffixed, not active/prod.
  check("emitted framework version incremented", out.framework.version === 4);
  check("emitted framework id cleared (never reuse original identity)", out.framework.id === undefined);
  check("emitted framework name suffixed", /hardened/i.test(String(out.framework.name)));
  check("emitted framework not active / not production-ready", out.framework.isActive === false && out.framework.productionReady === false);

  // Each measure carries a serialised, re-readable contract.
  check("emitted measure count matches", out.measures.length === 2);
  check("emitted measure id cleared", out.measures.every((m: any) => m.id === undefined));
  const reread = resolveScoringContract(out.measures[0]);
  check("emitted measure's contract is re-readable as persisted", reread.wasPersisted === true);
  check("re-read contract preserves the Yes bar", reread.outcomes.yes.includes("Bar A"));
  check("emit reports changed=true and per-measure notes", out.changed === true && out.notes.length === 2);
}

// ─── 7. emit handles empty/garbage input without throwing ─────────────────────
{
  const a = emitHardenedFramework(null as any, null as any);
  check("emit tolerates null framework", a.changed === false);
  const b = emitHardenedFramework({ name: "F", version: undefined as any }, []);
  check("emit defaults version to 1 when original has none", b.framework.version === 1);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
