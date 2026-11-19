// ─── Framework Builder V2 — robustness lint / autofill flags ─────────────────
//
// Central registry for the env flags introduced by the framework-builder
// robustness pass (so new frameworks do not reproduce the Framework-25 defects:
// null requiredSourceTypes, silently-null scope fields, sector-relative scoring
// persona, uncalibrated expectedYesRate treated as validated, undefined terms in
// measure text). Every one of these changes is BUILD-TIME only — none touches the
// live scoring/discovery path — and each is reversible via a single env flag.
//
// All five default so that the change is SAFE TO SHIP:
//   - (a) requiredSourceTypes autofill: default ON — it only ADDS a live abstain
//         gate to newly-built frameworks (strictly safer than null); the backbone
//         guarantees it can never abstain-forever on a real corpus.
//   - (b)-(e) advisory lints / inline checks: default ON — they only ADD
//         `warning`/`info` findings the UX surfaces; they never set a framework
//         invalid (never emit `error`) and never block a draft/save.
//
// Convention matches server/lib/robustness-flags.ts: default-ON flags are
// disabled only by an explicit false/0/off/no.

import { envFlagDefaultOn } from "../robustness-flags.js";

/** (a) At save/draft, auto-populate each measure's requiredSourceTypes from its
 *  disclosureVehicles (+ universal annual/regulatory backbone) instead of leaving
 *  it null, so future frameworks arrive with a live abstain gate. */
export const BUILDER_AUTOFILL_REQUIRED_SOURCE_TYPES = () =>
  envFlagDefaultOn("BUILDER_AUTOFILL_REQUIRED_SOURCE_TYPES");

/** (b) Robustness gate surfaces entityType / sectorScope / universe /
 *  reportingPeriod as four SEPARATE inline per-field checklist items instead of a
 *  single batched "all four set" item. */
export const BUILDER_SCOPE_FIELDS_INLINE = () =>
  envFlagDefaultOn("BUILDER_SCOPE_FIELDS_INLINE");

/** (c) Lint that flags sector-relative materiality phrasing in a cross-sector
 *  framework's scoringPersona (suggested fix: remove the sentence). */
export const BUILDER_LINT_SECTOR_MATERIALITY = () =>
  envFlagDefaultOn("BUILDER_LINT_SECTOR_MATERIALITY");

/** (d) Flag every expectedYesRate as an uncalibrated authoring prior (not a
 *  validated distribution), surfaced inline per measure. */
export const BUILDER_LINT_EXPECTED_YES_RATE_UNCALIBRATED = () =>
  envFlagDefaultOn("BUILDER_LINT_EXPECTED_YES_RATE_UNCALIBRATED");

/** (e) Undefined-term lint — flags vague bar-setting terms (e.g. "critical")
 *  used in measure text without a definition, surfaced inline per measure. */
export const BUILDER_LINT_UNDEFINED_TERMS = () =>
  envFlagDefaultOn("BUILDER_LINT_UNDEFINED_TERMS");
