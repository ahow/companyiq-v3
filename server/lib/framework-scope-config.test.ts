import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichFrameworkScopeConfig } from "./framework-scope-config.js";

const base = (): Record<string, any> => ({
  id: 1,
  name: "Some Framework",
  entityType: null,
  universe: null,
  reportingPeriodMonths: null,
  subsidiaryDomains: null,
  intakeArtefact: {
    scopeConfig: {
      entityType: "group",
      universe: "MSCI_ACWI",
      reportingPeriodMonths: 18,
      subsidiaryDomains: ["sub-a.com", "sub-b.com"],
    },
  },
});

test("flag OFF → returns the framework UNCHANGED (same reference)", () => {
  const fw = base();
  const out = enrichFrameworkScopeConfig(fw, { enabled: false });
  assert.equal(out, fw, "must be the same reference");
  assert.equal(out.entityType, null);
});

test("flag ON + no metadata → unchanged (same reference)", () => {
  const fw: any = { id: 2, name: "No Meta" };
  const out = enrichFrameworkScopeConfig(fw, { enabled: true });
  assert.equal(out, fw);
});

test("flag ON + metadata without scopeConfig → unchanged (same reference)", () => {
  const fw: any = { id: 3, name: "Meta no scope", intakeArtefact: { other: 1 } };
  const out = enrichFrameworkScopeConfig(fw, { enabled: true });
  assert.equal(out, fw);
});

test("flag ON + full scopeConfig → all four fields set", () => {
  const fw = base();
  const out = enrichFrameworkScopeConfig(fw, { enabled: true });
  assert.notEqual(out, fw, "must be a shallow clone, not the same reference");
  assert.equal(out.entityType, "group");
  assert.equal(out.universe, "MSCI_ACWI");
  assert.equal(out.reportingPeriodMonths, 18);
  assert.deepEqual(out.subsidiaryDomains, ["sub-a.com", "sub-b.com"]);
  // original not mutated
  assert.equal(fw.entityType, null);
});

test("flag ON but a field already set on framework → NOT overwritten", () => {
  const fw = base();
  fw.entityType = "parent-only";
  (fw as any).reportingPeriodMonths = 12;
  const out = enrichFrameworkScopeConfig(fw, { enabled: true });
  assert.equal(out.entityType, "parent-only", "existing entityType preserved");
  assert.equal(out.reportingPeriodMonths, 12, "existing months preserved");
  // the ones that were null still get filled
  assert.equal(out.universe, "MSCI_ACWI");
  assert.deepEqual(out.subsidiaryDomains, ["sub-a.com", "sub-b.com"]);
});

test("invalid reportingPeriodMonths (0 / negative / NaN / non-number) → ignored", () => {
  for (const bad of [0, -3, Number.NaN, "18", null, undefined]) {
    const fw: any = {
      id: 9,
      entityType: null,
      reportingPeriodMonths: null,
      intakeArtefact: { scopeConfig: { reportingPeriodMonths: bad } },
    };
    const out = enrichFrameworkScopeConfig(fw, { enabled: true });
    assert.equal(out.reportingPeriodMonths ?? null, null, `bad value ${String(bad)} ignored`);
    assert.equal(out, fw, "no change → same reference");
  }
});

test("subsidiaryDomains trims entries and drops empties / non-strings", () => {
  const fw: any = {
    id: 10,
    subsidiaryDomains: null,
    intakeArtefact: {
      scopeConfig: {
        subsidiaryDomains: ["  sub-a.com  ", "", "   ", 42, null, "sub-b.com"],
      },
    },
  };
  const out = enrichFrameworkScopeConfig(fw, { enabled: true });
  assert.deepEqual(out.subsidiaryDomains, ["sub-a.com", "sub-b.com"]);
});

test("subsidiaryDomains all-empty → field not set, unchanged reference", () => {
  const fw: any = {
    id: 11,
    subsidiaryDomains: null,
    intakeArtefact: { scopeConfig: { subsidiaryDomains: ["", "   ", 7] } },
  };
  const out = enrichFrameworkScopeConfig(fw, { enabled: true });
  assert.equal(out, fw);
  assert.equal(out.subsidiaryDomains, null);
});

test("empty-string entityType/universe in scopeConfig → ignored", () => {
  const fw: any = {
    id: 12,
    entityType: null,
    universe: null,
    intakeArtefact: { scopeConfig: { entityType: "   ", universe: "" } },
  };
  const out = enrichFrameworkScopeConfig(fw, { enabled: true });
  assert.equal(out, fw);
  assert.equal(out.entityType, null);
  assert.equal(out.universe, null);
});

test("partial scopeConfig → only present fields set, others untouched", () => {
  const fw: any = {
    id: 13,
    entityType: null,
    universe: null,
    reportingPeriodMonths: null,
    subsidiaryDomains: null,
    intakeArtefact: { scopeConfig: { universe: "CUSTOM" } },
  };
  const out = enrichFrameworkScopeConfig(fw, { enabled: true });
  assert.equal(out.universe, "CUSTOM");
  assert.equal(out.entityType, null);
  assert.equal(out.reportingPeriodMonths, null);
  assert.equal(out.subsidiaryDomains, null);
});
