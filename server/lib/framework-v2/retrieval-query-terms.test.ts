import { test } from "node:test";
import assert from "node:assert/strict";
import {
  referenceDocumentFrequency,
  validateRetrievalQueryTerms,
  parseTermArray,
  generateRetrievalQueryTerms,
  type LlmComplete,
} from "./retrieval-query-terms.js";

test("referenceDocumentFrequency: generic word high DF, discriminator ~0", () => {
  // ubiquitous stop/boilerplate words appear across most reference filings → high DF
  assert.ok(referenceDocumentFrequency("the") >= 0.5, "'the' should be high DF");
  assert.ok(referenceDocumentFrequency("company") >= 0.5, "'company' should be high DF");
  // a genuine topic discriminator appears in none of the generic filings
  assert.equal(referenceDocumentFrequency("chatbot"), 0);
  assert.equal(referenceDocumentFrequency("generative"), 0);
  // empty term → maximally stopword-like
  assert.equal(referenceDocumentFrequency(""), 1);
});

test("validateRetrievalQueryTerms: drops blocklist/high_df/too_short/duplicate/empty; keeps discriminators", () => {
  const { kept, dropped } = validateRetrievalQueryTerms([
    "generative",       // keep
    "machine learning", // keep (multi-word)
    "governance",       // drop: blocklist
    "board",            // drop: blocklist AND high_df
    "a",                // drop: too_short
    "",                 // drop: empty
    "  ",               // drop: empty
    "chatbot",          // keep
    "Chatbot",          // drop: duplicate (case-insensitive)
  ]);
  assert.deepEqual(kept, ["generative", "machine learning", "chatbot"]);
  const reasons = Object.fromEntries(dropped.map((d) => [d.term.trim().toLowerCase() || "(empty)", d.reason]));
  assert.equal(reasons["governance"], "blocklist");
  assert.equal(reasons["a"], "too_short");
  assert.equal(reasons["chatbot"], "duplicate");
  assert.ok(dropped.some((d) => d.reason === "empty"));
});

test("validateRetrievalQueryTerms: preserves original casing and first-seen order", () => {
  const { kept } = validateRetrievalQueryTerms(["LLM", "GPT", "RAG"]);
  assert.deepEqual(kept, ["LLM", "GPT", "RAG"]);
});

test("validateRetrievalQueryTerms: non-array input → empty result, never throws", () => {
  assert.deepEqual(validateRetrievalQueryTerms(null), { kept: [], dropped: [] });
  assert.deepEqual(validateRetrievalQueryTerms(undefined), { kept: [], dropped: [] });
  assert.deepEqual(validateRetrievalQueryTerms("nope" as unknown), { kept: [], dropped: [] });
});

test("parseTermArray: bare array / json fence / balanced blob / garbage", () => {
  assert.deepEqual(parseTermArray('["a","b","c"]'), ["a", "b", "c"]);
  assert.deepEqual(parseTermArray('```json\n["x","y"]\n```'), ["x", "y"]);
  assert.deepEqual(parseTermArray('Here you go:\n["p", "q"] thanks!'), ["p", "q"]);
  assert.deepEqual(parseTermArray("no array at all"), []);
  assert.deepEqual(parseTermArray(""), []);
  assert.deepEqual(parseTermArray(null), []);
  // non-string elements filtered out
  assert.deepEqual(parseTermArray('["a", 1, null, "b"]'), ["a", "b"]);
});

test("generateRetrievalQueryTerms: applies DF gate to LLM output", async () => {
  const stubLlm: LlmComplete = async () => ({
    text: '["generative", "chatbot", "governance", "board", "machine learning"]',
  });
  const res = await generateRetrievalQueryTerms(
    { topicTerm: "artificial intelligence" },
    stubLlm,
  );
  // generic words (governance, board) filtered by the DF/blocklist gate
  assert.deepEqual(res.terms, ["generative", "chatbot", "machine learning"]);
  assert.equal(res.raw.length, 5);
  assert.ok(res.validation.dropped.length >= 2);
});

test("generateRetrievalQueryTerms: degrades to [] on LLM throw", async () => {
  const throwingLlm: LlmComplete = async () => {
    throw new Error("provider down");
  };
  const res = await generateRetrievalQueryTerms({ topicTerm: "ai" }, throwingLlm);
  assert.deepEqual(res, { terms: [], validation: { kept: [], dropped: [] }, raw: [] });
});

test("generateRetrievalQueryTerms: empty topic → [] without calling llm", async () => {
  let called = false;
  const llm: LlmComplete = async () => {
    called = true;
    return { text: "[]" };
  };
  const res = await generateRetrievalQueryTerms({}, llm);
  assert.equal(called, false);
  assert.deepEqual(res.terms, []);
});
