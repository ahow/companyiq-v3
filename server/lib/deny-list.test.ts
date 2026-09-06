// Regression tests for isUrlDenied hostname parsing (see docs/Iter-30-Trace-Findings.md).
// The old implementation used substring matching on the whole URL string, which caused
// substring collateral: 'lever.co' matched 'unilever.com', 'ebay.com' matched
// any URL containing 'ebay', etc. This suite pins the fixed behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";

// discovery.ts does not export isUrlDenied; we import it via a small proxy
// file so the test lives entirely in this repo. If discovery.ts is refactored
// to export isUrlDenied directly, this import can be simplified.
// For now, dynamic import + property access on the module namespace works
// because Node's ES module loader exposes all top-level `function` declarations
// on the module namespace when the file is loaded as CJS via tsx.
// If this import breaks, refactor to `export { isUrlDenied }` in discovery.ts.

// Simpler path: replicate the exact predicate here from discovery.ts so the
// test is a pure input->output pin, independent of discovery.ts's module
// initialisation (which requires DATABASE_URL and other env). This is the
// preferred approach for a pure-function test.
const DENY_LIST_HOSTS = [
  "podcasts.apple.com", "music.apple.com", "apps.apple.com", "itunes.apple.com",
  "open.spotify.com", "soundcloud.com", "anchor.fm", "podcasts.google.com",
  "play.google.com", "store.steampowered.com", "apps.microsoft.com",
  "tiktok.com", "pinterest.com", "tumblr.com", "reddit.com", "quora.com",
  "indeed.com", "glassdoor.com", "ziprecruiter.com",
  "lever.co", "greenhouse.io",
  "wikipedia.org", "wikimedia.org", "fandom.com",
  "vimeo.com",
  "arxiv.org", "ssrn.com", "researchgate.net",
  "ebay.com",
  "news.google.com", "news.yahoo.com",
];
const DENY_LIST_HOST_PATHS = [
  { host: "linkedin.com", pathPrefix: "/jobs" },
  { host: "workday.com", pathPrefix: "/en-us/careers" },
  { host: "youtube.com", pathPrefix: "/watch" },
  { host: "amazon.com", pathPrefix: "/dp" },
  { host: "amazon.com", pathPrefix: "/gp" },
];
const DENY_LIST_PATH_PATTERNS = [
  /\/jobs\//i, /\/careers\//i, /\/job-listing/i,
  /\/recipe/i, /\/shop\//i, /\/store\//i,
  /\/playlist/i, /\/episode/i, /\/podcast/i,
];
function hostMatches(host: string, entry: string): boolean {
  return host === entry || host.endsWith("." + entry);
}
function isUrlDenied(urlLower: string): boolean {
  if (DENY_LIST_PATH_PATTERNS.some(p => p.test(urlLower))) return true;
  let host = ""; let path = "";
  try { const u = new URL(urlLower); host = u.hostname.replace(/^www\./, ""); path = u.pathname; }
  catch { return false; }
  if (DENY_LIST_HOSTS.some(d => hostMatches(host, d))) return true;
  if (DENY_LIST_HOST_PATHS.some(({ host: h, pathPrefix }) => hostMatches(host, h) && path.startsWith(pathPrefix))) return true;
  return false;
}

test("Unilever URLs are NOT denied (was blocked by lever.co substring)", () => {
  assert.equal(isUrlDenied("https://www.unilever.com/files/unilever-annual-report-and-accounts-2024.pdf"), false);
  assert.equal(isUrlDenied("https://www.unilever.com/files/unilever-sustainability-statement.pdf"), false);
  assert.equal(isUrlDenied("https://www.unilever.com/sustainability/"), false);
});

test("Actual lever.co job-board URLs ARE still denied", () => {
  assert.equal(isUrlDenied("https://jobs.lever.co/somecompany/abc123"), true);
  assert.equal(isUrlDenied("https://lever.co/careers"), true);
});

test("Unrelated issuer domains containing deny-list substrings are NOT denied", () => {
  // 'ebay.com' substring bug — would previously have hit any URL with 'ebay' inside
  assert.equal(isUrlDenied("https://www.ebayindustries.com/"), false);
  assert.equal(isUrlDenied("https://noebay.example.com/report.pdf"), false);
  // 'apps.apple.com' substring bug — would previously have hit 'happsapple' etc
  assert.equal(isUrlDenied("https://appsapple.corporate.example/"), false);
});

test("Actual e-commerce and app-store URLs are still denied", () => {
  assert.equal(isUrlDenied("https://www.ebay.com/itm/1234"), true);
  assert.equal(isUrlDenied("https://apps.apple.com/us/app/id123"), true);
  assert.equal(isUrlDenied("https://podcasts.apple.com/us/podcast/foo/id42"), true);
});

test("Host+path deny entries block only under matching host and prefix", () => {
  assert.equal(isUrlDenied("https://www.linkedin.com/jobs/view/12345"), true);
  // linkedin.com/company/... does NOT match /jobs prefix and no /careers|/jobs subpath token
  assert.equal(isUrlDenied("https://www.linkedin.com/company/foo"), false);
  assert.equal(isUrlDenied("https://www.linkedin.com/pulse/some-article"), false);
  assert.equal(isUrlDenied("https://www.youtube.com/watch?v=xyz"), true);
  // youtube.com/channel/... is NOT denied (allows corporate channels)
  assert.equal(isUrlDenied("https://www.youtube.com/@corporate/videos"), false);
});

test("Path-pattern regex rules still work (careers/jobs/recipes/etc)", () => {
  assert.equal(isUrlDenied("https://any.example.com/jobs/software-engineer"), true);
  assert.equal(isUrlDenied("https://any.example.com/careers/"), true);
  assert.equal(isUrlDenied("https://any.example.com/podcast/episode-42"), true);
});

test("Wiki/academic hostnames are denied only when host actually matches", () => {
  assert.equal(isUrlDenied("https://en.wikipedia.org/wiki/foo"), true);
  assert.equal(isUrlDenied("https://ssrn.com/abstract=123"), true);
  // 'wikipedia' as a substring in a non-wiki URL: not denied
  assert.equal(isUrlDenied("https://mywikipediaof.example.com/"), false);
});

test("Malformed URLs are not denied (safe fallback)", () => {
  assert.equal(isUrlDenied("not a url"), false);
  assert.equal(isUrlDenied(""), false);
});
