import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMultiProposalTurn, ONE_QUESTION_CORRECTIVE_SUFFIX } from "./one-question-guard.js";

// ─── COMPLIANT turns must PASS (violation === false) ───────────────────────

test("single question with many option chips passes", () => {
  const msg = `Which entity type should this framework target?

[[option:Publicly-listed companies]]
[[option:Private companies]]
[[option:Funds / portfolios]]
[[option:Sovereigns / public bodies]]
[[option:Other — tell me]]

Robustness gate: 3/10 items resolved. Open: [synonyms, adjacent topics].`;
  const d = detectMultiProposalTurn(msg);
  assert.equal(d.violation, false, d.reason);
  assert.equal(d.chipGroupCount, 1);
});

test("single question with an embedded example question passes", () => {
  const msg = `Which sub-area structure fits best? For example, would a policy → due diligence → remediation flow work for your topic?

[[option:TCFD four-pillar]]
[[option:Policy → Due diligence → Remediation → Reporting]]
[[option:Custom — tell me what you want]]

Robustness gate: 5/10 items resolved. Open: [examples].`;
  const d = detectMultiProposalTurn(msg);
  assert.equal(d.violation, false, d.reason);
});

test("single question with a trailing trivial confirm tag passes", () => {
  const msg = `I propose we treat the universe as MSCI ACWI. Sound good?

[[option:Yes, proceed]]
[[option:Custom universe — tell me]]`;
  const d = detectMultiProposalTurn(msg);
  assert.equal(d.violation, false, d.reason);
});

test("confirm-tag rephrasing (Right?) passes", () => {
  const msg = `So the reporting period is the last 3 years, most recent preferred. Right?

[[option:Yes, proceed]]
[[option:Change it]]`;
  const d = detectMultiProposalTurn(msg);
  assert.equal(d.violation, false, d.reason);
});

test("numbered example list (statements, not questions) with two chips passes", () => {
  const msg = `Here are candidate positive examples:
1. The board approved a topic policy in 2023.
2. The company set a time-bound target.
3. An externally assured metric was disclosed.

Do these look right?

[[option:Accept all as proposed]]
[[option:I want to change some of these]]

Robustness gate: 8/10 items resolved. Open: [sensitivity].`;
  const d = detectMultiProposalTurn(msg);
  assert.equal(d.violation, false, d.reason);
});

test("question with gate_state fenced block (machine-readable) passes", () => {
  const msg = `Which sensitivity preference do you want?

[[option:Balanced (default)]]
[[option:Precision-leaning]]
[[option:Recall-leaning]]

\`\`\`gate_state
{ "sensitivityPreference": "balanced" }
\`\`\`
Robustness gate: 9/10 items resolved. Open: [target count].`;
  const d = detectMultiProposalTurn(msg);
  assert.equal(d.violation, false, d.reason);
});

// ─── VIOLATING turns must TRIGGER (violation === true) ─────────────────────

test("two distinct questions each with their own chip group triggers", () => {
  const msg = `What entity type should we target?

[[option:Publicly-listed companies]]
[[option:Private companies]]

Also, which universe should we use?

[[option:MSCI ACWI]]
[[option:S&P 500]]`;
  const d = detectMultiProposalTurn(msg);
  assert.equal(d.violation, true, d.reason);
  assert.ok(d.chipGroupCount >= 2);
});

test("enumerated Question 3 / Question 4 bundling triggers", () => {
  const msg = `Question 3: Which sub-area structure do you prefer?
Question 4: What sensitivity level should we use?

[[option:Balanced]]
[[option:Precision-leaning]]`;
  const d = detectMultiProposalTurn(msg);
  assert.equal(d.violation, true, d.reason);
  assert.ok(d.enumeratedHeaderCount >= 2);
});

test("fused wh-question 'What X, and what Y?' triggers", () => {
  const msg = `What entity type, and what sector scope should the framework cover?

[[option:Publicly-listed companies]]
[[option:Private companies]]`;
  const d = detectMultiProposalTurn(msg);
  assert.equal(d.violation, true, d.reason);
  assert.equal(d.multiWhSingleSentence, true);
});

test("two separate prose questions (no enumeration) triggers", () => {
  const msg = `Which anchor frameworks apply here?

Separately, how many measures should the framework contain?

[[option:Compact (12–18)]]
[[option:Balanced (20–30)]]`;
  const d = detectMultiProposalTurn(msg);
  assert.equal(d.violation, true, d.reason);
  assert.ok(d.questionCount >= 2);
});

test("empty / non-string input is a non-violation", () => {
  assert.equal(detectMultiProposalTurn("").violation, false);
  // @ts-expect-error intentional bad input
  assert.equal(detectMultiProposalTurn(null).violation, false);
});

test("corrective suffix is topic-agnostic and non-empty", () => {
  assert.ok(ONE_QUESTION_CORRECTIVE_SUFFIX.length > 0);
  assert.match(ONE_QUESTION_CORRECTIVE_SUFFIX, /ONE QUESTION/);
});
