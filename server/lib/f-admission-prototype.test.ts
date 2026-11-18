import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewQuoteAttribution, type CompanyIdentity, type QuoteLike } from "./eligibility-flags.js";

// F — PROTOTYPE: admission-gate loosening paired with attribution tightening,
// behind ADMISSION_GATE_PROTOTYPE (default OFF). These tests assert BOTH:
//   • flag OFF ⇒ attribution is exactly as today, AND
//   • flag ON  ⇒ bare name-mention no longer attributes, but own-doc provenance
//     or a first-party possessive still does; and the blunt case-study
//     pre-rejection no longer gates a quote out before attribution.

function withFlag(value: string | undefined, fn: () => void): void {
  const prev = process.env.ADMISSION_GATE_PROTOTYPE;
  if (value === undefined) delete process.env.ADMISSION_GATE_PROTOTYPE;
  else process.env.ADMISSION_GATE_PROTOTYPE = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.ADMISSION_GATE_PROTOTYPE;
    else process.env.ADMISSION_GATE_PROTOTYPE = prev;
  }
}

const company: CompanyIdentity = { name: "Acme Corporation", domain: "acme.com" };

function attr(quotes: QuoteLike[]): Array<{ index: number; attributedToTarget: boolean; reason?: string }> {
  return reviewQuoteAttribution(quotes, company);
}

// ─── Baseline (flag OFF) = today's behaviour ──────────────────────────────────

test("F OFF: a bare name-mention attributes to the target (today's behaviour)", () => {
  withFlag(undefined, () => {
    const r = attr([{ text: "Acme was ranked highly by analysts this year." }]);
    assert.equal(r[0].attributedToTarget, true);
  });
});

test("F OFF: a case-study quote is pre-rejected (today's behaviour)", () => {
  withFlag(undefined, () => {
    const r = attr([{ text: "Acme partnered with a major retailer to cut our emissions." }]);
    assert.equal(r[0].attributedToTarget, false);
    assert.match(r[0].reason || "", /Case Study/i);
  });
});

// ─── Tightening (flag ON): bare name-mention no longer attributes ─────────────

test("F ON: a bare name-mention alone no longer attributes", () => {
  withFlag("true", () => {
    const r = attr([{ text: "Acme was ranked highly by analysts this year." }]);
    assert.equal(r[0].attributedToTarget, false);
    assert.match(r[0].reason || "", /without own-doc provenance or first-party possessive/i);
  });
});

test("F ON: a first-party possessive co-signal is accepted", () => {
  withFlag("true", () => {
    const r = attr([{ text: "Acme reduced our Scope 1 emissions by 12% this year." }]);
    assert.equal(r[0].attributedToTarget, true);
    assert.match(r[0].reason || "", /first-party possessive/i);
  });
});

test("F ON: own-document provenance (own-domain primary filing) is accepted", () => {
  withFlag("true", () => {
    const r = attr([
      {
        text: "Acme Corporation 2025 Annual Report — sustainability performance summary.",
        source: "Annual Report",
        sourceUrl: "https://acme.com/investors/annual-report-2025.pdf",
      },
    ]);
    assert.equal(r[0].attributedToTarget, true);
  });
});

// ─── Loosening (flag ON): case-study pre-rejection no longer gates out ─────────

test("F ON: case-study phrasing is NOT pre-rejected; attribution decides (loosened)", () => {
  withFlag("true", () => {
    // Same quote the OFF path rejects outright as a case study — under the flag it
    // reaches attribution, where the first-party possessive ("our") carries it.
    const r = attr([{ text: "Acme partnered with a major retailer to cut our emissions." }]);
    assert.equal(r[0].attributedToTarget, true);
    assert.doesNotMatch(r[0].reason || "", /Case Study/i);
  });
});

test("F ON: a loosened case-study quote with NO co-signal still fails attribution", () => {
  withFlag("true", () => {
    // Case-study no longer blocks admission, but with no possessive/own-doc the
    // tightened attribution still rejects a third-party-subject mention.
    const r = attr([{ text: "Acme partnered with a major retailer on their rollout." }]);
    assert.equal(r[0].attributedToTarget, false);
  });
});
