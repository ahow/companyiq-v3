// Tests for applyRecencyGate — the discovery-time filter that trims the
// historical-filing flood. 2026-09-05: rewrote behaviour to keep ALL
// in-window filings + a soft cap on out-of-window historical instances.
//
// Isolated node:test import path (matches discovery.disclosure-queries.test.ts)
// to avoid the vitest-vs-DB-init incompatibility for discovery.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRecencyGate } from "./discovery.js";

interface TestDoc { url: string; title: string; priority: number; }

function d(url: string, title = ""): TestDoc {
  return { url, title, priority: 0 };
}

const nowYear = 2026;

test("keeps ALL in-window annual reports (previously capped at 2)", () => {
  const docs: TestDoc[] = [
    d("https://co.com/ar/annual-report-2026.pdf", "Annual Report 2026"),
    d("https://co.com/ar/annual-report-2025.pdf", "Annual Report 2025"),
    d("https://co.com/ar/annual-report-2024.pdf", "Annual Report 2024"),
    d("https://co.com/ar/annual-report-2023.pdf", "Annual Report 2023"),
  ];
  // Default window 4 → [2023, 2024, 2025, 2026] all in window
  const { kept, dropped } = applyRecencyGate(docs, { nowYear });
  assert.equal(kept.length, 4);
  assert.equal(dropped.length, 0);
});

test("keeps historical filings up to the soft cap (default 2)", () => {
  const docs: TestDoc[] = [
    d("https://co.com/ar/annual-report-2026.pdf", "Annual Report 2026"),
    d("https://co.com/ar/annual-report-2020.pdf", "Annual Report 2020"),
    d("https://co.com/ar/annual-report-2015.pdf", "Annual Report 2015"),
  ];
  // 2020 and 2015 are out of window (window = 2023-2026); soft cap 2 keeps both.
  const { kept, dropped } = applyRecencyGate(docs, { nowYear });
  assert.equal(kept.length, 3);
  assert.equal(dropped.length, 0);
});

test("beyond soft cap, drops the oldest out-of-window filings", () => {
  const docs: TestDoc[] = [
    d("https://co.com/ar/annual-report-2026.pdf", "Annual Report 2026"),
    d("https://co.com/ar/annual-report-2020.pdf", "Annual Report 2020"),
    d("https://co.com/ar/annual-report-2018.pdf", "Annual Report 2018"),
    d("https://co.com/ar/annual-report-2015.pdf", "Annual Report 2015"),
    d("https://co.com/ar/annual-report-2010.pdf", "Annual Report 2010"),
  ];
  const { kept, dropped } = applyRecencyGate(docs, { nowYear, outOfWindowSoftCap: 2 });
  const keptUrls = kept.map(k => k.url);
  const droppedUrls = dropped.map(x => x.url);
  assert.ok(keptUrls.includes("https://co.com/ar/annual-report-2026.pdf"));
  assert.ok(keptUrls.includes("https://co.com/ar/annual-report-2020.pdf"));
  assert.ok(keptUrls.includes("https://co.com/ar/annual-report-2018.pdf"));
  assert.ok(droppedUrls.includes("https://co.com/ar/annual-report-2015.pdf"));
  assert.ok(droppedUrls.includes("https://co.com/ar/annual-report-2010.pdf"));
});

test("does not touch non-periodic documents", () => {
  const docs: TestDoc[] = [
    d("https://co.com/sustainability/nature-policy", "Nature Policy"),
    d("https://co.com/committee-charter.pdf", "Board Committee Charter"),
    d("https://co.com/about/sustainability", "Sustainability"),
  ];
  const { kept, dropped } = applyRecencyGate(docs, { nowYear });
  assert.equal(kept.length, 3);
  assert.equal(dropped.length, 0);
});

test("keeps 10-Ks and 20-Fs separately by type — BHP case fixed", () => {
  const docs: TestDoc[] = [
    d("https://sec.gov/10-K-2026.htm", "Form 10-K 2026"),
    d("https://sec.gov/10-K-2025.htm", "Form 10-K 2025"),
    d("https://sec.gov/20-F-2026.htm", "Form 20-F 2026"),
    d("https://sec.gov/20-F-2025.htm", "Form 20-F 2025"),
    d("https://sec.gov/20-F-2024.htm", "Form 20-F 2024"),
  ];
  // BHP case: all three 20-Fs are in-window (2024, 2025, 2026); previously
  // the cap-of-2 dropped the 2024 filing. Now all should be kept.
  const { kept, dropped } = applyRecencyGate(docs, { nowYear });
  assert.equal(kept.length, 5);
  assert.equal(dropped.length, 0);
  assert.ok(kept.map(k => k.url).includes("https://sec.gov/20-F-2024.htm"));
});

test("keeps filings whose year cannot be detected (fail-open)", () => {
  const docs: TestDoc[] = [
    d("https://co.com/some/annual-report.pdf", "Annual Report"),
    d("https://co.com/ar/annual-report-2026.pdf", "Annual Report 2026"),
  ];
  const { kept, dropped } = applyRecencyGate(docs, { nowYear });
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 0);
});

test("respects opts.windowYears override", () => {
  const docs: TestDoc[] = [
    d("https://co.com/ar/annual-report-2026.pdf", "Annual Report 2026"),
    d("https://co.com/ar/annual-report-2024.pdf", "Annual Report 2024"),
    d("https://co.com/ar/annual-report-2023.pdf", "Annual Report 2023"),
  ];
  // Tight 2-year window → only 2025 and 2026 are in-window; 2024 and 2023 are historical.
  const { kept, dropped } = applyRecencyGate(docs, { nowYear, windowYears: 2, outOfWindowSoftCap: 1 });
  const keptUrls = kept.map(k => k.url);
  const droppedUrls = dropped.map(x => x.url);
  assert.ok(keptUrls.includes("https://co.com/ar/annual-report-2026.pdf"));
  assert.ok(keptUrls.includes("https://co.com/ar/annual-report-2024.pdf"));
  assert.ok(droppedUrls.includes("https://co.com/ar/annual-report-2023.pdf"));
});
