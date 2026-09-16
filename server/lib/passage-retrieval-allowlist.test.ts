// Approach 2c: short-token allowlist keeps curated short tokens (e.g. "AI","ML","5G")
// alive through tokenize()'s length filter, without lowering the global filter.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  setShortTokenAllowlist,
  getShortTokenAllowlist,
} from "./passage-retrieval.js";

test("tokenize drops short tokens by default", () => {
  setShortTokenAllowlist([]); // ensure clean baseline
  const toks = tokenize("we use AI and ML across 5G networks");
  assert.ok(!toks.includes("ai"), "ai should be dropped without allowlist");
  assert.ok(!toks.includes("ml"), "ml should be dropped without allowlist");
  assert.ok(!toks.includes("5g"), "5g should be dropped without allowlist");
  // long tokens survive as before
  assert.ok(toks.includes("networks"));
});

test("setShortTokenAllowlist preserves listed short tokens through tokenize", () => {
  setShortTokenAllowlist(["AI", "ML", "5G"]);
  const toks = tokenize("we use AI and ML across 5G networks");
  assert.ok(toks.includes("ai"), "ai should survive when allowlisted");
  assert.ok(toks.includes("ml"), "ml should survive when allowlisted");
  assert.ok(toks.includes("5g"), "5g should survive when allowlisted");
  setShortTokenAllowlist([]); // reset to avoid cross-test leakage
});

test("allowlist only retains length 1-2 sub-tokens", () => {
  setShortTokenAllowlist(["AI", "machine learning", "LLM"]);
  const kept = getShortTokenAllowlist();
  assert.ok(kept.includes("ai"), "short token retained");
  // multi-char (>2) tokens like 'llm','machine','learning' are NOT added to the
  // short-token allowlist (they already survive tokenize on their own)
  assert.ok(!kept.includes("llm"));
  assert.ok(!kept.includes("machine"));
  assert.ok(!kept.includes("learning"));
  setShortTokenAllowlist([]); // reset
});

test("resetting the allowlist drops the short tokens again", () => {
  setShortTokenAllowlist(["AI"]);
  assert.ok(tokenize("AI systems").includes("ai"));
  setShortTokenAllowlist([]);
  assert.ok(!tokenize("AI systems").includes("ai"));
});
