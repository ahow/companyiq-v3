// Unit tests for the oversized-document guard. Pure / in-process only — no
// network. Run with: npx tsx --test server/lib/doc-size-guard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  DEFAULT_MAX_DOC_BYTES,
  getMaxDocBytes,
  capDocumentText,
  readBodyDecompressedCapped,
} from "./doc-size-guard";

// Small cap for fast tests, restored after each case via try/finally.
function withCap<T>(cap: number, fn: () => T): T {
  const prev = process.env.MAX_DOC_BYTES;
  process.env.MAX_DOC_BYTES = String(cap);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MAX_DOC_BYTES;
    else process.env.MAX_DOC_BYTES = prev;
  }
}

// Build a native, pull-based web ReadableStream from a Node Buffer (what fetch's
// resp.body is). A pull source cancels cleanly when the consumer stops early,
// mirroring a real HTTP body.
function webStreamFromBuffer(buf: Buffer): ReadableStream<Uint8Array> {
  const CHUNK = 64 * 1024;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= buf.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + CHUNK, buf.length);
      controller.enqueue(new Uint8Array(buf.subarray(offset, end)));
      offset = end;
    },
  });
}

test("getMaxDocBytes: default when env unset/invalid", () => {
  const prev = process.env.MAX_DOC_BYTES;
  delete process.env.MAX_DOC_BYTES;
  assert.equal(getMaxDocBytes(), DEFAULT_MAX_DOC_BYTES);
  process.env.MAX_DOC_BYTES = "not-a-number";
  assert.equal(getMaxDocBytes(), DEFAULT_MAX_DOC_BYTES);
  process.env.MAX_DOC_BYTES = "1048576";
  assert.equal(getMaxDocBytes(), 1048576);
  if (prev === undefined) delete process.env.MAX_DOC_BYTES;
  else process.env.MAX_DOC_BYTES = prev;
});

test("capDocumentText: under cap returned unchanged", () => {
  withCap(1000, () => {
    const s = "hello world";
    assert.equal(capDocumentText(s, "http://x/a"), s);
  });
});

test("capDocumentText: over cap truncated to <= cap bytes", () => {
  withCap(100, () => {
    const s = "a".repeat(500);
    const out = capDocumentText(s, "http://x/b");
    assert.ok(Buffer.byteLength(out, "utf8") <= 100);
    assert.equal(out.length, 100);
  });
});

test("capDocumentText: multi-byte boundary not corrupted", () => {
  withCap(10, () => {
    // "€" is 3 UTF-8 bytes; 10/3 => 3 full chars (9 bytes), partial dropped.
    const s = "€".repeat(20);
    const out = capDocumentText(s, "http://x/c");
    assert.ok(Buffer.byteLength(out, "utf8") <= 10);
    // Must decode cleanly (no replacement char from a split code unit).
    assert.ok(!out.includes("\uFFFD"));
  });
});

test("readBodyDecompressedCapped: raw stream over cap => truncated", async () => {
  const cap = 50 * 1024;
  const raw = Buffer.alloc(cap * 3, 0x41); // 150KB of 'A'
  const { content, truncated } = await readBodyDecompressedCapped(
    webStreamFromBuffer(raw), "http://x/raw", cap, "test",
  );
  assert.equal(truncated, true);
  assert.equal(Buffer.byteLength(content, "utf8"), cap);
});

test("readBodyDecompressedCapped: raw stream under cap => unchanged", async () => {
  const cap = 50 * 1024;
  const raw = Buffer.from("small body");
  const { content, truncated } = await readBodyDecompressedCapped(
    webStreamFromBuffer(raw), "http://x/raw2", cap, "test",
  );
  assert.equal(truncated, false);
  assert.equal(content, "small body");
});

test("readBodyDecompressedCapped: gzip stream over cap => decompress-truncated", async () => {
  const cap = 50 * 1024;
  // 300KB of compressible content, gzipped -> decompresses well past the cap.
  const original = Buffer.alloc(cap * 6, 0x42);
  const gz = zlib.gzipSync(original);
  const { content, truncated } = await readBodyDecompressedCapped(
    webStreamFromBuffer(gz), "http://x/file.gz", cap, "test",
  );
  assert.equal(truncated, true);
  assert.equal(Buffer.byteLength(content, "utf8"), cap);
  assert.ok(content.split("").every((ch) => ch === "B"));
});

test("readBodyDecompressedCapped: gzip stream under cap => full content", async () => {
  const cap = 50 * 1024;
  const original = Buffer.from("C".repeat(1024));
  const gz = zlib.gzipSync(original);
  const { content, truncated } = await readBodyDecompressedCapped(
    webStreamFromBuffer(gz), "http://x/small.gz", cap, "test",
  );
  assert.equal(truncated, false);
  assert.equal(content, original.toString("utf-8"));
});

test("readBodyDecompressedCapped: null body => empty", async () => {
  const { content, truncated } = await readBodyDecompressedCapped(null, "http://x/null");
  assert.equal(content, "");
  assert.equal(truncated, false);
});
