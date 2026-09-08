import axios from "axios";
import * as cheerio from "cheerio";
import pdfParse from "pdf-parse";
import { normaliseTableHorizonMarkers } from "./table-horizon-normaliser";
import crypto from "crypto";
import puppeteer from "puppeteer-core";
import { spawn } from "child_process";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";

/**
 * Thrown when a document URL fails for a reason that will NOT resolve on retry
 * within the same run (e.g. 401 paywall, 403 CDN block on a direct file). The
 * pipeline uses this to mark such URLs 'dead' in a single step instead of
 * burning 3 retry passes (and, for slow timeouts, minutes of budget) on a URL
 * that is never going to succeed.
 */
export class PermanentFetchError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "PermanentFetchError";
    this.statusCode = statusCode;
  }
}

// Thrown when the browser fallback could not RUN (Chromium failed to launch, or
// the launch circuit is open) — as opposed to running and returning unusable
// content. This is a TRANSIENT condition: the URL should stay pending and be
// retried on a later pass once browser capacity recovers, NOT marked dead.
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

// REVIEWER FIX v3d (issue #3): thrown when a direct-file/PDF fetch failed AND the
// browser-PDF fallback RAN but returned no usable bytes THIS pass for a reason
// that may be transient (WAF edge hiccup, HTTP/2 stream reset, intermittent 5xx
// on Akamai-fronted IR sites like ir.tesla.com). Previously these were thrown as
// PermanentFetchError and marked dead immediately, which silently discarded
// high-value IR PDFs. Treating them as TRANSIENT keeps the URL retryable across
// passes; the per-document failure cap still eventually retires a truly dead URL.
export class TransientFetchError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "TransientFetchError";
    this.statusCode = statusCode;
  }
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// SEC EDGAR (and sec.report) enforce a Fair Access policy: requests must send a
// descriptive User-Agent that identifies the requester, otherwise they are
// rejected with HTTP 403. A browser-style UA is NOT accepted. With a compliant
// UA + Accept-Encoding, plain HTTP fetches of SEC documents succeed, which means
// no Chromium browser fallback is needed for the dominant document source and
// the worker avoids fork-exhaustion ("spawn /usr/bin/chromium EAGAIN").
const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT || "CompanyIQ Research admin@pullcite.com";

function isSecHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "www.sec.gov" || h === "sec.gov" || h.endsWith(".sec.gov") || h.endsWith("sec.report");
  } catch {
    return false;
  }
}

// Large annual-report PDFs (often 10–20 MB) routinely take 25–40s to download
// over the network. The previous 15s timeout caused such files to be marked
// "dead" even though they were perfectly reachable. We now use a generous
// default and an even larger timeout for binary/PDF responses. Both stay below
// the pipeline's PER_DOCUMENT_TIMEOUT_MS (default 45s) unless overridden, so a
// genuinely hung request is still cut off by the outer guard.
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT_MS || "40000", 10); // 40s for HTML
const FETCH_TIMEOUT_BINARY = parseInt(process.env.FETCH_TIMEOUT_BINARY_MS || "25000", 10); // 25s: fail fast on WAF-hung PDFs so the browser-PDF fallback fits inside PER_DOCUMENT_TIMEOUT_MS
const MAX_RETRIES = 2;
const RETRY_DELAY_BASE = 2000;

// ─── In-Memory Content Cache ─────────────────────────────────────────────────

const contentCache = new Map<string, string>();
const CACHE_MAX_SIZE = 100;

function getCacheKey(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function getCachedContent(url: string): string | undefined {
  return contentCache.get(getCacheKey(url));
}

function setCachedContent(url: string, content: string): void {
  if (contentCache.size >= CACHE_MAX_SIZE) {
    const firstKey = contentCache.keys().next().value;
    if (firstKey) contentCache.delete(firstKey);
  }
  contentCache.set(getCacheKey(url), content);
}

// ─── SEC-Mirror URL Canonicalization (browser-free WAF bypass) ───────────────
// Many issuers serve copies of their SEC filings from an Akamai/Imperva-fronted
// investor-relations CDN, e.g. Tesla's
//   https://ir.tesla.com/_flysystem/s3/sec/<accession18>/<file>
//   https://assets-ir.tesla.com/...
// Those CDNs 403 every non-interactive client, and on a worker where Chromium
// can't launch the browser-PDF fallback can't run either, so the genuine filing
// is lost. But the SAME filing is always available, un-protected, on EDGAR.
//
// This helper detects an IR-portal `_flysystem/s3/sec/<accession>/` mirror URL,
// resolves the subject CIK + the real primary document filename from EDGAR's
// full-text search API (keyed only by the accession number — no per-issuer
// config), and rewrites the URL to the canonical, plain-HTTP-fetchable EDGAR
// document. Topic- and issuer-agnostic; benefits any issuer that mirrors EDGAR
// filings behind a WAF. Falls back to the original URL when resolution fails.
const secMirrorCache = new Map<string, string>();

function extractMirrorAccession(url: string): string | null {
  // Match `/_flysystem/s3/sec/<18 digits>/...` (Tesla et al.). The 18-digit run
  // is an SEC accession number without dashes.
  const m = url.match(/\/sec\/(\d{18})\//);
  return m ? m[1] : null;
}

function dashAccession(acc18: string): string {
  return `${acc18.slice(0, 10)}-${acc18.slice(10, 12)}-${acc18.slice(12)}`;
}

async function canonicalizeSecMirrorUrl(url: string): Promise<string> {
  let acc18: string | null = null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    // Only attempt for IR-portal mirrors, never for sec.gov itself.
    if (host.endsWith(".sec.gov") || host === "sec.gov") return url;
    acc18 = extractMirrorAccession(url);
  } catch {
    return url;
  }
  if (!acc18) return url;
  if (secMirrorCache.has(url)) return secMirrorCache.get(url)!;

  const dashed = dashAccession(acc18);
  try {
    // efts.sec.gov returns transient 500s under load; retry with spaced backoff
    // (SEC fair-access ~10 req/s). A few hundred ms between tries reliably clears
    // the 5xx, which is what recovers the remaining IR-mirror filings.
    let resp: any = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await axios.get("https://efts.sec.gov/LATEST/search-index", {
        params: { q: `"${dashed}"` },
        headers: { "User-Agent": SEC_USER_AGENT, Accept: "application/json" },
        timeout: 15000,
        validateStatus: () => true,
      });
      if (r.status === 200 && r.data?.hits) { resp = r; break; }
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
    if (!resp) {
      console.warn(`[Processor] SEC mirror canonicalization: efts unavailable for ${dashed} after retries`);
      return url;
    }
    const hits: any[] = resp.data?.hits?.hits || [];
    // Prefer the primary document (htm) for the matching accession.
    let chosen: { cik: string; file: string } | null = null;
    for (const h of hits) {
      const id = String(h?._id || ""); // "<accession-dashed>:<file>"
      const ciks: string[] = h?._source?.ciks || [];
      if (!id.startsWith(dashed + ":") || ciks.length === 0) continue;
      const file = id.slice(dashed.length + 1);
      const cik = String(parseInt(ciks[0], 10)); // strip leading zeros
      // Skip obvious exhibits/graphics; prefer a main filing document.
      if (/\.(jpg|png|gif|css|js)$/i.test(file)) continue;
      chosen = { cik, file };
      if (/\.htm/i.test(file) && !/ex\d/i.test(file)) break; // primary htm wins
    }
    if (chosen) {
      const canonical = `https://www.sec.gov/Archives/edgar/data/${chosen.cik}/${acc18}/${chosen.file}`;
      secMirrorCache.set(url, canonical);
      console.log(`[Processor] Canonicalized SEC mirror -> EDGAR: ${url} => ${canonical}`);
      return canonical;
    }
    // Fallback: the full-submission text always exists at a deterministic path,
    // but it still needs the CIK; if any hit carried a CIK, use the .txt bundle.
    const anyCik = hits.find((h) => (h?._source?.ciks || []).length > 0)?._source?.ciks?.[0];
    if (anyCik) {
      const cik = String(parseInt(anyCik, 10));
      const canonical = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc18}/${dashed}.txt`;
      secMirrorCache.set(url, canonical);
      console.log(`[Processor] Canonicalized SEC mirror -> EDGAR (.txt bundle): ${url} => ${canonical}`);
      return canonical;
    }
  } catch (e: any) {
    console.warn(`[Processor] SEC mirror canonicalization failed for ${url}: ${e?.message}`);
  }
  return url;
}

// ─── Fetch with Retry ────────────────────────────────────────────────────────

// Rotated User-Agents for defended hosts (reduces fingerprint-based blocking)
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

async function fetchWithRetry(
  url: string,
  opts: { responseType?: "arraybuffer" | "text"; maxAttempts?: number } = {}
): Promise<{ data: any; contentType: string }> {
  let lastError: Error | null = null;
  // Rewrite IR-portal SEC-mirror URLs (WAF-blocked) to canonical EDGAR URLs
  // (plain HTTP, no browser needed) BEFORE attempting the fetch.
  url = await canonicalizeSecMirrorUrl(url);
  // Binary (PDF) fetches default to a single attempt: a WAF that hangs will hang
  // again on retry, and the retry would consume the per-document budget that the
  // browser-PDF fallback needs. Callers can override.
  const maxAttempts = opts.maxAttempts ?? (opts.responseType === "arraybuffer" ? 1 : MAX_RETRIES);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const sec = isSecHost(url);
      // Harden fetch: rotate User-Agent on retry to reduce fingerprint-based blocking
      const ua = sec ? SEC_USER_AGENT : USER_AGENTS[attempt % USER_AGENTS.length];
      // Instruction 18: Full realistic-browser HTTP headers for all fetches.
      // Present a plausible-Chrome fingerprint to WAF-defended hosts.
      const headers: Record<string, string> = {
        "User-Agent": ua,
        Accept: opts.responseType === "arraybuffer"
          ? "application/pdf,application/octet-stream,*/*"
          : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-GB,en;q=0.9",
        "Sec-Ch-Ua": '"Not.A/Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": opts.responseType === "arraybuffer" ? "document" : "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        // Add Referer for non-SEC hosts (some WAFs check for it)
        ...(sec ? {} : { "Referer": (() => { try { return new URL(url).origin + "/"; } catch { return ""; } })() }),
      };
      const isBinary = opts.responseType === "arraybuffer";
      const response = await axios.get(url, {
        headers,
        timeout: isBinary ? FETCH_TIMEOUT_BINARY : FETCH_TIMEOUT,
        responseType: opts.responseType || "text",
        maxRedirects: 5,
        // Allow large reports (annual reports can exceed 25 MB).
        maxContentLength: 64 * 1024 * 1024,
        maxBodyLength: 64 * 1024 * 1024,
        validateStatus: (status) => status < 400,
      });

      return {
        data: response.data,
        contentType: String(response.headers["content-type"] || ""),
      };
    } catch (error: any) {
      lastError = error;
      if (attempt < maxAttempts - 1) {
        // Randomized jitter delay to avoid rate-limit fingerprinting
        const baseDelay = RETRY_DELAY_BASE * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 1500);
        await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
      }
    }
  }

  // R7g — Last-resort fallback: for .xhtml (ESEF filings on filings.xbrl.org
  // and mirror sites), retry with Accept-Encoding: identity and manually
  // gunzip the response if it starts with the gzip magic bytes. This handles
  // Apache indexes that serve gzipped content without the correct
  // Content-Encoding header, defeating Node's auto-decompression.
  const urlLower = url.toLowerCase();
  if (opts.responseType !== "arraybuffer" && (urlLower.endsWith(".xhtml") || urlLower.endsWith(".xml") || urlLower.includes("filings.xbrl.org"))) {
    try {
      const { fetchWithGzipFallback } = await import("./r6-discovery.js");
      const res = await fetchWithGzipFallback(url, FETCH_TIMEOUT);
      if (res.ok && res.content) {
        console.log(`[fetch] R7g gzip-fallback recovered ${url} (${res.content.length} chars)`);
        return { data: res.content, contentType: "application/xhtml+xml" };
      }
    } catch { /* fall through to lastError */ }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

// ─── Bot-Protection Cookie Warm-up (Incapsula / Cloudflare-style) ─────────────
// Some issuer sites (e.g. www.airbus.com via Imperva/Incapsula) answer a cold
// request for a direct file with HTTP 200 + a tiny HTML challenge interstitial
// instead of the real document. A normal browser succeeds only because it
// already holds a session cookie (e.g. incap_ses_*). We replicate that: GET the
// site origin once to collect Set-Cookie, then re-request the file with those
// cookies + a same-origin Referer. The cookie is cached per host so we pay the
// warm-up cost at most once per host per worker process.

const hostCookieJar = new Map<string, { cookie: string; ts: number }>();
const COOKIE_TTL_MS = 20 * 60 * 1000; // refresh warm-up cookies every 20 min

/** Heuristic: does this HTML body look like a bot-protection challenge page? */
function looksLikeChallenge(html: string): boolean {
  if (!html) return false;
  const head = html.slice(0, 4000).toLowerCase();
  return (
    head.includes("_incapsula_resource") ||
    head.includes("incident id") ||
    head.includes("request unsuccessful") ||
    head.includes("cf-browser-verification") ||
    head.includes("checking your browser") ||
    head.includes("just a moment...") ||
    head.includes("attention required")
  );
}

/**
 * Heuristic: does this fetched HTML look like a client-side-rendered SPA shell or
 * a "please enable JavaScript" stub rather than the real document content?
 *
 * Many non-US issuer/disclosure hosts (e.g. Chinese portals such as Futubull,
 * cninfo, SSE/SZSE, and SPA-based IR sites) return HTTP 200 with a tiny shell that
 * hydrates content client-side. A plain HTTP fetch then yields near-empty text,
 * which (a) fails issuer verification as "generic/empty" and (b) gets terminally
 * rejected — a major cause of the systematic zero-scoring of Chinese-listed
 * issuers. Detecting the shell lets us escalate to the JS-executing browser path
 * BEFORE the content is judged, so the real (often Chinese-language) text is
 * recovered and then handled by translation + CJK-aware retrieval downstream.
 *
 * We treat content as a shell when the extracted visible text is very short, OR
 * when it contains an explicit enable-JavaScript message.
 */
function isLikelyJsShell(rawHtml: string, extractedText: string): boolean {
  const t = (extractedText || "").trim();
  const head = (rawHtml || "").slice(0, 6000).toLowerCase();
  const enableJsMsg =
    head.includes("enable javascript") ||
    head.includes("please enable js") ||
    head.includes("requires javascript") ||
    head.includes("\u8bf7\u542f\u7528javascript") || // "please enable JavaScript" (zh)
    head.includes("\u5f00\u542fjavascript") ||
    head.includes("javascript\u3092\u6709\u52b9"); // (ja)
  // Real disclosures are long; a few hundred chars of visible text after stripping
  // scripts almost always means the body was not server-rendered.
  const tooShort = t.length < parseInt(process.env.JS_SHELL_MIN_TEXT || "400", 10);
  return enableJsMsg || tooShort;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Collect (and cache) session cookies by GET-ing the site origin. */
async function warmCookiesForUrl(url: string): Promise<string | null> {
  const origin = originOf(url);
  if (!origin) return null;
  const host = new URL(origin).host;
  const cached = hostCookieJar.get(host);
  if (cached && Date.now() - cached.ts < COOKIE_TTL_MS) return cached.cookie;
  try {
    const resp = await axios.get(origin + "/", {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate",
      },
      timeout: FETCH_TIMEOUT,
      maxRedirects: 5,
      validateStatus: () => true, // even a challenge page Set-Cookies the session
    });
    const setCookies: string[] = ([] as string[]).concat(
      (resp.headers["set-cookie"] as any) || []
    );
    const cookie = setCookies
      .map((c) => c.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
    if (cookie) {
      hostCookieJar.set(host, { cookie, ts: Date.now() });
      return cookie;
    }
  } catch (e: any) {
    console.warn(`[Processor] Cookie warm-up failed for ${origin}: ${e.message}`);
  }
  return null;
}

/**
 * Re-fetch a URL after warming bot-protection cookies. Sends the captured
 * session cookie plus a same-origin Referer. Returns the response or null on
 * failure (caller falls back to the browser).
 */
async function fetchWithWarmCookies(
  url: string,
  opts: { responseType?: "arraybuffer" | "text" } = {}
): Promise<{ data: any; contentType: string } | null> {
  const cookie = await warmCookiesForUrl(url);
  if (!cookie) return null;
  const origin = originOf(url);
  const isBinary = opts.responseType === "arraybuffer";
  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: isBinary
          ? "application/pdf"
          : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        Cookie: cookie,
        ...(origin ? { Referer: origin + "/" } : {}),
      },
      timeout: isBinary ? FETCH_TIMEOUT_BINARY : FETCH_TIMEOUT,
      responseType: opts.responseType || "text",
      maxRedirects: 5,
      maxContentLength: 64 * 1024 * 1024,
      maxBodyLength: 64 * 1024 * 1024,
      validateStatus: (status) => status < 400,
    });
    return {
      data: response.data,
      contentType: String(response.headers["content-type"] || ""),
    };
  } catch (e: any) {
    console.warn(`[Processor] Warm-cookie retry failed for ${url}: ${e.message}`);
    return null;
  }
}

// ─── HTML Processing ─────────────────────────────────────────────────────────

function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);

  // Remove noise elements
  $("script, style, nav, footer, header, aside, .cookie-banner, .nav, .footer, .sidebar, [role='navigation'], [role='banner']").remove();

  // Prefer main content areas
  let contentEl = $("main, article, [role='main']").first();
  if (contentEl.length === 0) {
    // Fallback: find the highest-text-density div
    contentEl = $("body");
  }

  let text = contentEl.text();

  // Clean up whitespace
  text = text
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();

  return text;
}

// ─── PDF Processing ──────────────────────────────────────────────────────────

// Minimum character count that we consider a "successful" text extraction.
// Below this we treat the extraction as failed and escalate to the next
// fallback (image-based / scanned PDFs commonly yield a handful of stray
// glyphs via pdf-parse but no real text).
const PDF_TEXT_MIN_CHARS = 100;

/**
 * Spawn a child process, write `input` (if any) to its stdin, and collect
 * stdout as a Buffer with a hard timeout and output cap. Never rejects on a
 * non-zero exit — resolves with whatever stdout was captured (empty on error)
 * so the caller can decide whether to escalate. stderr is captured only for
 * diagnostics.
 */
function runProcessCollect(
  cmd: string,
  args: string[],
  opts: { input?: Buffer; timeoutMs: number; maxBuffer: number },
): Promise<{ stdout: Buffer; code: number | null; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e: any) {
      resolve({ stdout: Buffer.alloc(0), code: null, timedOut: false, error: e?.message });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let timedOut = false;
    let stderr = "";

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(chunks),
        code,
        timedOut,
        error: stderr.slice(0, 500) || undefined,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
      finish(null);
    }, opts.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      total += d.length;
      if (total <= opts.maxBuffer) {
        chunks.push(d);
      } else if (!settled) {
        // Cap exceeded — kill and keep what we have.
        try { child.kill("SIGKILL"); } catch {}
        finish(child.exitCode);
      }
    });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", (e: any) => {
      if (!settled) { stderr += ` ${e?.message || e}`; finish(null); }
    });
    child.on("close", (code) => finish(code));

    if (opts.input) {
      try {
        child.stdin?.write(opts.input);
        child.stdin?.end();
      } catch {
        // stdin write can fail if the child already exited; the close/error
        // handlers will settle the promise.
      }
    } else {
      try { child.stdin?.end(); } catch {}
    }
  });
}

/**
 * Fallback 1: pdftotext (poppler-utils) reading the PDF from stdin and writing
 * plain text to stdout. Handles many PDFs that pdf-parse mishandles (compressed
 * object streams, unusual encodings). Returns "" on any failure.
 */
async function extractViaPdftotext(buffer: Buffer): Promise<string> {
  try {
    const res = await runProcessCollect(
      "pdftotext",
      ["-q", "-enc", "UTF-8", "-", "-"],
      { input: buffer, timeoutMs: 60_000, maxBuffer: 50 * 1024 * 1024 },
    );
    const text = res.stdout.toString("utf8");
    if (res.timedOut) {
      console.log(`[Processor] pdftotext fallback timed out after 60s (${text.length} chars captured)`);
    } else if (res.error) {
      console.log(`[Processor] pdftotext fallback stderr: ${res.error}`);
    }
    return text;
  } catch (e: any) {
    console.log(`[Processor] pdftotext fallback threw: ${e?.message}`);
    return "";
  }
}

/**
 * Fallback 2: OCR for image-based / scanned PDFs. Rasterises the first 8 pages
 * with pdftoppm (poppler-utils) at 150dpi and runs tesseract on each page image.
 * Concatenates all recognised text. Bounded by a per-page timeout and an overall
 * OCR budget so a pathological document cannot stall the pipeline. Always cleans
 * up temp files. Returns whatever text was recognised (may be short).
 */
async function extractViaOcr(buffer: Buffer): Promise<string> {
  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString("hex");
  const tmpPdf = path.join(tmpDir, `ciq_ocr_${token}.pdf`);
  const tmpBase = path.join(tmpDir, `ciq_ocr_${token}`);
  const createdFiles: string[] = [tmpPdf];
  const OCR_TOTAL_BUDGET_MS = 120_000;
  const started = Date.now();
  try {
    await fsp.writeFile(tmpPdf, buffer);

    // Rasterise first 8 pages to JPEG at 150dpi → <tmpBase>-1.jpg, -2.jpg, ...
    const ppm = await runProcessCollect(
      "pdftoppm",
      ["-jpeg", "-r", "150", "-l", "8", tmpPdf, tmpBase],
      { input: undefined, timeoutMs: 60_000, maxBuffer: 1024 },
    );
    if (ppm.timedOut) {
      console.log(`[Processor] OCR: pdftoppm timed out — aborting OCR`);
    }

    // Collect generated page images.
    const entries = await fsp.readdir(tmpDir).catch(() => [] as string[]);
    const baseName = path.basename(tmpBase);
    const pageImages = entries
      .filter((f) => f.startsWith(baseName) && f.toLowerCase().endsWith(".jpg"))
      .sort()
      .map((f) => path.join(tmpDir, f));
    for (const img of pageImages) createdFiles.push(img);

    if (pageImages.length === 0) {
      console.log(`[Processor] OCR: no page images produced by pdftoppm`);
      return "";
    }

    const parts: string[] = [];
    for (const img of pageImages) {
      if (Date.now() - started > OCR_TOTAL_BUDGET_MS) {
        console.log(`[Processor] OCR: overall 120s budget exceeded — stopping at ${parts.length} page(s)`);
        break;
      }
      const t = await runProcessCollect(
        "tesseract",
        [img, "stdout", "-l", "eng", "--psm", "1"],
        { input: undefined, timeoutMs: 30_000, maxBuffer: 20 * 1024 * 1024 },
      );
      const pageText = t.stdout.toString("utf8").trim();
      if (pageText) parts.push(pageText);
    }
    const ocrText = parts.join("\n\n");
    console.log(`[Processor] OCR fallback recognised ${ocrText.length} chars across ${parts.length} page(s)`);
    return ocrText;
  } catch (e: any) {
    console.log(`[Processor] OCR fallback threw: ${e?.message}`);
    return "";
  } finally {
    for (const f of createdFiles) {
      await fsp.unlink(f).catch(() => {});
    }
  }
}

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  // ── Path 1: pdf-parse (primary) ──────────────────────────────────────────
  try {
    const data = await pdfParse(buffer);
    const raw = data.text || "";
    // I81: horizon-marker table normaliser — inlines time-horizon markers
    // next to bullet-only rows so the flattened PDF preserves the table's
    // short/medium/long-term semantics after chunking. Format-agnostic: a
    // no-op on documents that don't contain such a header. Applied ONLY on
    // the pdf-parse path (the fallbacks below produce plain OCR/CLI text).
    const normalised = normaliseTableHorizonMarkers(raw);
    if (normalised.detected && normalised.annotationsAdded > 0) {
      console.log(`[Processor] Structured horizon-marker table detected — annotated ${normalised.annotationsAdded} rows`);
    }
    if (normalised.text && normalised.text.trim().length >= PDF_TEXT_MIN_CHARS) {
      return normalised.text;
    }
    console.log(`[Processor] pdf-parse yielded ${normalised.text.trim().length} chars (< ${PDF_TEXT_MIN_CHARS}) — trying pdftotext fallback`);
  } catch (error: any) {
    console.warn(`[Processor] PDF parse error: ${error.message} — trying pdftotext fallback`);
  }

  // ── Path 2: pdftotext (poppler-utils) fallback ───────────────────────────
  try {
    const viaCli = await extractViaPdftotext(buffer);
    if (viaCli && viaCli.trim().length >= PDF_TEXT_MIN_CHARS) {
      console.log(`[Processor] pdftotext fallback succeeded (${viaCli.trim().length} chars)`);
      return viaCli;
    }
    console.log(`[Processor] pdftotext yielded ${viaCli.trim().length} chars (< ${PDF_TEXT_MIN_CHARS}) — trying OCR fallback`);
  } catch (e: any) {
    console.log(`[Processor] pdftotext fallback error: ${e?.message} — trying OCR fallback`);
  }

  // ── Path 3: OCR (pdftoppm + tesseract) fallback ──────────────────────────
  // For image-based/scanned PDFs. Return whatever OCR recovers — any text is
  // more useful than empty for these documents.
  try {
    const viaOcr = await extractViaOcr(buffer);
    return viaOcr || "";
  } catch (e: any) {
    console.log(`[Processor] OCR fallback error: ${e?.message}`);
    return "";
  }
}

// ─── Browser-Based Fetching (Puppeteer Fallback) ────────────────────────────

// Fix C: env-driven (default 45s) so large WAF-defended issuer PDFs (20+ MB
// annual/sustainability reports) have headroom to download via the browser path.
const BROWSER_FETCH_TIMEOUT = parseInt(process.env.BROWSER_FETCH_TIMEOUT_MS || "45000", 10);

// Limit how many browser fetches can run at once. Launching/holding many
// Chromium contexts concurrently exhausts the container's process/fork and
// memory budget ("fork: Resource temporarily unavailable"), which previously
// cascaded into an unhandled rejection that crashed the whole process.
// Instruction 12: Reduced from 2 to 1 to prevent Chromium fork storms.
// With 8 worker replicas, even 1 per worker = 8 concurrent browser processes cluster-wide.
const MAX_CONCURRENT_BROWSER = parseInt(process.env.MAX_CONCURRENT_BROWSER || "1", 10);
let activeBrowserFetches = 0;
const browserWaiters: Array<() => void> = [];

async function acquireBrowserSlot(): Promise<void> {
  if (activeBrowserFetches < MAX_CONCURRENT_BROWSER) {
    activeBrowserFetches++;
    return;
  }
  await new Promise<void>((resolve) => browserWaiters.push(resolve));
  activeBrowserFetches++;
}

function releaseBrowserSlot(): void {
  activeBrowserFetches = Math.max(0, activeBrowserFetches - 1);
  const next = browserWaiters.shift();
  if (next) next();
}

// A single shared Chromium instance is reused across fetches (one new *page* per
// fetch) instead of launching a fresh browser per document. This drastically
// reduces process spawns under batch load.
let sharedBrowser: any = null;
let sharedBrowserLaunching: Promise<any> | null = null;

// Circuit breaker: when Chromium cannot be launched because the container is out
// of fork/process budget ("spawn /usr/bin/chromium EAGAIN" / "Cannot fork"),
// retrying the launch for every single URL only deepens the fork storm and slows
// the whole worker to a crawl. Instead, after a launch failure we open a cooldown
// window during which browser fallback is skipped entirely (the fetch simply
// returns empty and the analyzer proceeds with the documents it could fetch over
// HTTP). The window auto-resets so transient pressure can recover.
const BROWSER_LAUNCH_COOLDOWN_MS = parseInt(process.env.BROWSER_LAUNCH_COOLDOWN_MS || "120000", 10);
let browserLaunchBlockedUntil = 0;

function isBrowserCircuitOpen(): boolean {
  return Date.now() < browserLaunchBlockedUntil;
}

function tripBrowserCircuit(reason: string): void {
  browserLaunchBlockedUntil = Date.now() + BROWSER_LAUNCH_COOLDOWN_MS;
  console.warn(
    `[Processor] Chromium launch circuit OPEN for ${Math.round(BROWSER_LAUNCH_COOLDOWN_MS / 1000)}s (reason: ${reason}). ` +
    `Skipping browser fallback until cooldown expires.`
  );
}

/**
 * Fix 2b (session-primed recovery): clear the browser launch circuit so a
 * last-resort recovery pass gets a fresh attempt. The circuit trips during the
 * resource-intensive main fetch phase (many concurrent large-PDF browser
 * fetches cause transient fork/EAGAIN pressure) and then stays open for the
 * cooldown window — which would otherwise cause every recovery fetch to be
 * skipped even though the fork pressure has already passed. Resetting is safe:
 * the very next launch attempt re-trips the circuit if the container is still
 * genuinely out of process budget.
 */
export function resetBrowserCircuit(): void {
  if (browserLaunchBlockedUntil !== 0) {
    console.log(`[Processor] Browser launch circuit reset (was open until ${new Date(browserLaunchBlockedUntil).toISOString()})`);
  }
  browserLaunchBlockedUntil = 0;
}

async function launchChromiumWithRetry(executablePath: string): Promise<any> {
  // NOTE: we deliberately do NOT pass --single-process. While it reduces the
  // number of helper processes, in this container it is the dominant cause of
  // "Failed to launch the browser process: Code: null" crashes under concurrent
  // load. --no-zygote + --disable-dev-shm-usage is Puppeteer's recommended
  // container combo and launches far more reliably.
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-zygote",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--mute-audio",
    "--no-first-run",
    "--disable-software-rasterizer",
    "--js-flags=--max-old-space-size=256",
    // Force HTTP/1.1. Akamai/Cloudflare WAFs in front of investor-relations PDFs
    // (e.g. Adobe, NVIDIA) fingerprint and reset HTTP/2 connections, surfacing as
    // ERR_HTTP2_PROTOCOL_ERROR and yielding zero bytes. Over HTTP/1.1 the same
    // requests are served normally (verified: Adobe 10-K + AI Ethics PDFs).
    "--disable-http2",
  ];
  const MAX_LAUNCH_ATTEMPTS = parseInt(process.env.BROWSER_LAUNCH_ATTEMPTS || "3", 10);
  let lastErr: any = null;
  for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt++) {
    try {
      return await puppeteer.launch({ executablePath, headless: true, args, protocolTimeout: 120000 });
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || err);
      // Transient fork/resource pressure — back off and retry rather than
      // immediately giving up (which would strand high-value PDFs).
      if (attempt < MAX_LAUNCH_ATTEMPTS && /EAGAIN|Cannot fork|Resource temporarily unavailable|Failed to launch|Code: null/i.test(msg)) {
        const backoff = 1500 * attempt + Math.floor(Math.random() * 1000);
        console.warn(`[Processor] Chromium launch attempt ${attempt}/${MAX_LAUNCH_ATTEMPTS} failed (${msg.split("\n")[0].slice(0, 80)}) — retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function getSharedBrowser(): Promise<any> {
  if (sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }
  if (sharedBrowserLaunching) return sharedBrowserLaunching;

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
  sharedBrowserLaunching = launchChromiumWithRetry(executablePath)
    .then((b: any) => {
      sharedBrowser = b;
      sharedBrowserLaunching = null;
      // If Chromium dies, clear the handle so the next call relaunches.
      b.on("disconnected", () => {
        if (sharedBrowser === b) sharedBrowser = null;
      });
      return b;
    })
    .catch((err: any) => {
      sharedBrowserLaunching = null;
      const msg = String(err?.message || err);
      if (/EAGAIN|Cannot fork|Resource temporarily unavailable|Failed to launch|Code: null/i.test(msg)) {
        tripBrowserCircuit(msg.split("\n")[0].slice(0, 120));
      }
      throw err;
    });
  return sharedBrowserLaunching;
}

export async function closeSharedBrowser(): Promise<void> {
  if (sharedBrowser) {
    try { await sharedBrowser.close(); } catch { /* ignore */ }
    sharedBrowser = null;
  }
}

async function fetchWithBrowser(url: string): Promise<string> {
  // If the launch circuit is open, skip immediately without acquiring a slot or
  // attempting another fork. This prevents per-URL launch storms when the
  // container is out of process budget.
  if (isBrowserCircuitOpen()) {
    return "";
  }
  await acquireBrowserSlot();
  let page: any = null;
  try {
    const browser = await getSharedBrowser();
    page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 800 });

    // Block unnecessary resources to speed up loading
    await page.setRequestInterception(true);
    page.on("request", (req: any) => {
      const resourceType = req.resourceType();
      if (["image", "media", "font", "stylesheet"].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: BROWSER_FETCH_TIMEOUT,
    });

    // Wait a moment for any JS-rendered content
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Extract text content from the page. The evaluate() call is destructive
    // (it removes noise DOM nodes), so this must run AFTER we capture rawHtml.
    const extractText = async (): Promise<string> => page.evaluate(() => {
      // Remove noise elements
      const removeSelectors = [
        "script", "style", "nav", "footer", "header", "aside",
        ".cookie-banner", ".nav", ".footer", ".sidebar",
        "[role='navigation']", "[role='banner']"
      ];
      removeSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      });

      // Prefer main content areas
      const mainEl = document.querySelector("main, article, [role='main']");
      const targetEl = mainEl || document.body;
      return targetEl?.textContent?.replace(/\s+/g, " ").trim() || "";
    });

    // Fix N: capture the raw HTML BEFORE the destructive text extraction so we
    // can detect a WAF/bot challenge interstitial. Then extract text.
    let rawHtml = "";
    try { rawHtml = await page.content(); } catch { rawHtml = ""; }
    let content = await extractText();

    // Fix N: WAF session priming fallback for HTML pages. Mirrors the PDF path
    // (fetchPdfViaBrowser / fetchIssuerPdfsWithPrimedSession): some issuer-domain
    // HTML pages behind Akamai/Imperva/Cloudflare return an empty shell or a
    // challenge interstitial on the first cold navigation because the WAF trust
    // cookies (_abck, bm_sv, reese84, incap_ses_*, …) are only issued after the
    // sensor JS runs on the origin. When the first pass yields near-empty content
    // or a recognised challenge page, prime the WAF session on the origin and
    // re-navigate once. Purely additive: non-WAF hosts that returned real content
    // on the first pass never enter this branch, so behaviour is unchanged.
    const needsPrime =
      content.length <= 50 || isChallengeSnippet(rawHtml) || looksLikeChallenge(rawHtml);
    if (needsPrime) {
      const origin = originOf(url);
      if (origin) {
        try {
          await page.setExtraHTTPHeaders(WAF_PRIME_HEADERS);
          const primed = await primeWafSession(page, origin);
          if (primed) {
            await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const reExtracted = await extractText();
            if (reExtracted && reExtracted.length > content.length) {
              content = reExtracted;
            }
          }
        } catch (primeErr: any) {
          console.warn(`[Processor] Fix N: WAF prime retry failed for ${url}: ${String(primeErr?.message || primeErr).slice(0, 80)}`);
        }
      }
    }

    return content;
  } catch (error: any) {
    console.warn(`[Processor] Browser fetch failed for ${url}: ${error.message}`);
    return "";
  } finally {
    // Close only the page (the shared browser is reused), then free the slot.
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    releaseBrowserSlot();
  }
}

/**
 * Fetch a PDF (or other binary doc) that sits behind a WAF/CDN bot-protection
 * layer (Akamai, Cloudflare, Imperva) which blocks plain Node/axios requests by
 * TLS/HTTP-2 fingerprint but trusts a real browser session.
 *
 * Strategy:
 *  1. Navigate Chromium to the URL's ORIGIN so the WAF issues its trust cookies
 *     to a genuine browser session (the same reason a human never sees the block).
 *  2. From inside that trusted page context, run `fetch(url)` and read the
 *     response as an arraybuffer, then hand the raw bytes back to Node as base64.
 *     This reuses the browser's cookies, TLS fingerprint and HTTP/2 stack, so the
 *     WAF serves the real PDF instead of killing the stream.
 *  3. Parse the bytes with the existing pdf-parse path.
 *
 * Returns extracted text, or "" if the browser path also fails / is unavailable.
 */
// ─── WAF Session Priming (Akamai / Imperva, topic-independent) ───────────────
// Akamai Bot Manager and Imperva/Incapsula issue their trust cookies (`_abck`,
// `bm_sv`, `ak_bmsc`, `reese84`, `incap_ses_*`) only AFTER a real browser has
// loaded a navigable HTML page on the origin and executed the sensor JS. The
// earlier in-page fetch fired before those cookies were present, so Akamai-
// fronted IR portals (e.g. ir.tesla.com) kept returning interstitials and the
// PDFs were marked dead. This helper navigates the origin, sets realistic
// client-hint / fetch-metadata headers, and polls document.cookie until the
// sensor cookies settle (re-navigating once if needed). It is generic: any
// Akamai/Imperva-protected host benefits, regardless of analysis topic.
const WAF_COOKIE_RE = /(_abck|bm_sv|bm_sz|ak_bmsc|reese84|incap_ses_|visid_incap_|nlbi_)/i;
const WAF_PRIME_HEADERS: Record<string, string> = {
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="120", "Not(A:Brand";v="24", "Google Chrome";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
};

// Classify a small HTML body as a Cloudflare/WAF challenge or block page.
// Module-level so both the browser-based recovery strategies and the Fix K
// Node.js direct-download path (nodeFetchPdf) can share one definition.
function isChallengeSnippet(s: string): boolean {
  return /just a moment|cf-browser-verification|challenge-platform|cf-chl|attention required|access denied|_cf_chl_opt|enable javascript and cookies/i.test(s || "");
}

async function primeWafSession(page: any, origin: string): Promise<boolean> {
  const budgetMs = parseInt(process.env.WAF_PRIME_BUDGET_MS || "7000", 10);
  const deadline = Date.now() + budgetMs;
  const hasWafCookie = async (): Promise<boolean> => {
    try {
      const cookies = await page.cookies();
      return Array.isArray(cookies) && cookies.some((c: any) => WAF_COOKIE_RE.test(c?.name || ""));
    } catch {
      return false;
    }
  };
  let navigations = 0;
  while (Date.now() < deadline && navigations < 2) {
    try {
      await page.goto(origin + "/", { waitUntil: "networkidle2", timeout: BROWSER_FETCH_TIMEOUT });
    } catch {
      // best-effort: an interstitial nav still Set-Cookies the sensor token
    }
    navigations++;
    // Let the Akamai/Imperva sensor JS run and post back its token.
    for (let i = 0; i < 6 && Date.now() < deadline; i++) {
      if (await hasWafCookie()) return true;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  return await hasWafCookie();
}

/**
 * Fix K — Strategy C: Download a PDF via a direct Node.js (axios) HTTPS
 * request, bypassing the Chromium CDP channel.
 *
 * Why Strategies A and B fail for large PDFs:
 *   A) page.goto + resp.buffer() must buffer the ENTIRE body inside Chrome
 *      before the promise resolves — large sustainability reports (often 10–50 MB)
 *      consistently exceed perPdfTimeoutMs (45 s default).
 *   B) inPageFetch serialises the whole body as base64 over the CDP WebSocket —
 *      equally slow and memory-intensive for large binaries.
 *
 * Strategy C: after WAF priming the browser holds clearance cookies in its jar.
 * We extract them with page.cookies() and replay them on an axios GET that uses
 * the Node.js HTTPS stack directly — no CDP serialisation, no Chrome navigation
 * state machine, socket-inactivity timeout instead of a wall-clock body buffer.
 * The result is either fast success (cookie accepted → streaming download) or
 * fast failure (WAF rejects → 403/200+challenge snippet in < 1 s) — far cheaper
 * than burning 45 s per URL in Chrome before diagnosing the failure.
 *
 * Limitation: strict Akamai deployments that bind _abck to the Chrome JA3
 * fingerprint will reject Node.js requests even with the correct cookie. In that
 * case Strategy C returns a waf_block/challenge_page result and the caller falls
 * back to Strategies A and B as before. No regression — C is additive.
 */
async function nodeFetchPdf(
  url: string,
  cookieHeader: string,
  referer: string,
  timeoutMs: number,
): Promise<{ buf: Buffer | null; status: number; bytes: number; snippet: string }> {
  if (!cookieHeader) return { buf: null, status: 0, bytes: 0, snippet: "no_cookies" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      signal: controller.signal as any,
      maxRedirects: 5,
      timeout: 30000,               // socket inactivity timeout (per chunk)
      maxContentLength: 100 * 1024 * 1024,
      validateStatus: () => true,   // never throw on 4xx/5xx
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/pdf,*/*;q=0.9",
        "Referer": referer,
        "Cookie": cookieHeader,
        ...WAF_PRIME_HEADERS,
      },
    });
    clearTimeout(timer);
    const status: number = response?.status ?? 0;
    const raw = response?.data;
    const buf: Buffer = raw ? Buffer.from(raw as ArrayBuffer) : Buffer.alloc(0);
    const bytes = buf.length;
    const isPdf = bytes >= 5 && buf.slice(0, 5).toString("latin1") === "%PDF-";
    let snippet = "";
    if (!isPdf && bytes > 0 && bytes < 200_000) {
      try { snippet = buf.slice(0, 600).toString("utf8"); } catch { snippet = ""; }
    }
    return { buf: isPdf ? buf : null, status, bytes, snippet };
  } catch (e: any) {
    clearTimeout(timer);
    return { buf: null, status: 0, bytes: 0, snippet: String(e?.message ?? e).slice(0, 200) };
  }
}

// Fix 2b: exported so the pipeline's PDF-fallback discovery can invoke the
// browser PDF path directly for inaccessible issuer-domain documents.
export async function fetchPdfViaBrowser(url: string): Promise<string> {
  if (isBrowserCircuitOpen()) {
    // Browser fallback is temporarily unavailable — signal TRANSIENT so the
    // caller keeps the URL retryable rather than marking it permanently dead.
    throw new BrowserUnavailableError(`browser circuit open: ${url}`);
  }
  await acquireBrowserSlot();
  let page: any = null;
  let browserLaunched = false;
  try {
    const browser = await getSharedBrowser();
    browserLaunched = true;
    page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders(WAF_PRIME_HEADERS);

    // Strategy A (primary): navigate directly to the PDF URL and capture the
    // response body bytes. Over HTTP/1.1 (forced via --disable-http2) the WAF
    // serves the real PDF with a 200 application/pdf response. This is the most
    // reliable path because it uses Chromium's own network stack end-to-end.
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: BROWSER_FETCH_TIMEOUT });
      if (resp && resp.ok()) {
        const ct = String(resp.headers()["content-type"] || "").toLowerCase();
        const bodyBuf: Buffer = await resp.buffer();
        if (bodyBuf && bodyBuf.length > 0) {
          const isPdf = bodyBuf.slice(0, 5).toString("latin1") === "%PDF-" || ct.includes("application/pdf");
          if (isPdf && bodyBuf.slice(0, 5).toString("latin1") === "%PDF-") {
            const text = await extractTextFromPdf(bodyBuf);
            if (text) {
              console.log(`[Processor] Browser-PDF (direct nav) succeeded for ${url} (${bodyBuf.length}B PDF)`);
              return text;
            }
          }
        }
      }
    } catch (navErr: any) {
      // Direct navigation can fail on some interstitials; fall through to the
      // in-page fetch strategy below.
      console.log(`[Processor] Browser-PDF direct nav did not yield bytes for ${url} (${String(navErr?.message || navErr).slice(0, 80)}) — trying in-page fetch`);
    }

    // Strategy B (fallback): PRIME the WAF session on the origin (Akamai/Imperva
    // issue their trust cookies only after the sensor JS runs on a real HTML
    // page), then fetch the binary from inside the now-trusted page context.
    const origin = originOf(url);
    let wafPrimed = false;
    if (origin) {
      wafPrimed = await primeWafSession(page, origin);
      console.log(`[Processor] WAF session prime for ${origin} -> ${wafPrimed ? "sensor cookies present" : "no sensor cookies (continuing)"}`);
    }

    // REVIEWER FIX v3d (issue #3) + open-item follow-up: Tesla IR PDFs on
    // ir.tesla.com (Akamai) were dying en masse. Akamai validates Referer +
    // Accept on direct file fetches and rejects requests lacking a primed sensor
    // session. With the session primed above we now send explicit Accept/Referer
    // headers and try credentialed THEN uncredentialed. If the first pass returns
    // nothing AND the session was not yet primed, we re-prime and retry once.
    const inPageFetch = async (): Promise<string | null> => page.evaluate(async (target: string, originUrl: string) => {
      // esbuild's keepNames wraps named inner helpers with __name(fn,"name"); that
      // helper does not exist in the browser realm, so the serialized callback throws
      // "__name is not defined". Provide an identity shim as the very first statement.
      (globalThis as any).__name = (globalThis as any).__name || function (f: any) { return f; };
      const toB64 = (buf: ArrayBuffer): string => {
        let binary = "";
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
        }
        return btoa(binary);
      };
      const attempt = async (creds: RequestCredentials): Promise<string | null> => {
        try {
          const resp = await fetch(target, {
            credentials: creds,
            headers: { Accept: "application/pdf,*/*", Referer: originUrl },
          });
          if (!resp.ok) return null;
          const buf = await resp.arrayBuffer();
          if (!buf || buf.byteLength === 0) return null;
          return toB64(buf);
        } catch {
          return null;
        }
      };
      return (await attempt("include")) || (await attempt("omit"));
    }, url, (origin || url));

    let base64: string | null = await inPageFetch();
    if (!base64 && origin && !wafPrimed) {
      // Re-prime once (the sensor token may have arrived late) and retry.
      const reprimed = await primeWafSession(page, origin);
      if (reprimed) {
        console.log(`[Processor] Re-primed WAF session for ${origin} — retrying in-page PDF fetch for ${url}`);
        base64 = await inPageFetch();
      }
    }

    if (!base64) {
      console.log(`[Processor] Browser-PDF in-page fetch returned no bytes for ${url}`);
      return "";
    }

    const buf = Buffer.from(base64, "base64");
    const looksLikePdf = buf.slice(0, 5).toString("latin1") === "%PDF-";
    if (looksLikePdf) {
      const text = await extractTextFromPdf(buf);
      if (text) {
        console.log(`[Processor] Browser-PDF fetch succeeded for ${url} (${buf.length}B PDF)`);
        return text;
      }
      return "";
    }
    // Not a PDF — could be an HTML doc served at a .pdf URL; extract as HTML.
    const asText = buf.toString("utf8");
    if (asText && !looksLikeChallenge(asText)) {
      return extractTextFromHtml(asText);
    }
    return "";
  } catch (error: any) {
    const msg = String(error?.message || error);
    const isLaunchFailure = /EAGAIN|Cannot fork|Resource temporarily unavailable|Failed to launch|Code: null/i.test(msg) || !browserLaunched;
    if (isLaunchFailure) {
      tripBrowserCircuit(msg.split("\n")[0].slice(0, 120));
      // The browser never actually ran — TRANSIENT. Keep the URL retryable.
      throw new BrowserUnavailableError(`browser launch failed: ${url} (${msg.split("\n")[0].slice(0, 80)})`);
    }
    // Browser ran but the in-page fetch / parse failed — treat as unusable content.
    console.warn(`[Processor] Browser-PDF fetch failed for ${url}: ${msg}`);
    return "";
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
    releaseBrowserSlot();
  }
}

/**
 * Fix 2b (session-primed batch recovery): fetch several issuer-domain PDFs that
 * all live on the SAME origin, reusing ONE WAF-primed browser page for the whole
 * batch instead of opening a fresh page and re-priming the origin for every URL
 * (what per-URL `fetchPdfViaBrowser` does).
 *
 * Why this is the right structural fix (not a per-company workaround):
 *  - Class of problem: any issuer whose IR/ESG site is a WAF-defended SPA (TSMC,
 *    SMFG, Tesla, …) exposes its real disclosures only as large PDFs that need a
 *    primed browser session. Recovering 10–15 such PDFs by re-priming per URL is
 *    both slow (blows the time budget) and fork-heavy (trips the launch circuit).
 *  - Priming ONCE and reusing the page's WAF-clearance cookies for all direct PDF
 *    navigations on that origin is far cheaper and is exactly what a real browser
 *    session does.
 *
 * Behaviour:
 *  - Resets the launch circuit first (last-resort recovery deserves a fresh try;
 *    the main-phase fork pressure has already passed by the time we get here).
 *  - Primes the WAF once on the origin root, then for each URL uses Strategy A
 *    (direct navigation — the most reliable path over forced HTTP/1.1) and falls
 *    back to an in-page credentialed fetch that reuses the primed cookies.
 *  - Bounded by an OVERALL budget (independent of the main fetch-phase budget) so
 *    it can never run unbounded, and a per-PDF timeout.
 *  - Returns a Map of url -> extracted text for the PDFs it recovered.
 *  - Optionally fills `opts.outcomes` with a compact per-URL diagnostic so the
 *    caller can PERSIST why each PDF failed. This is essential because Railway's
 *    log rate-limiter drops the verbose per-document console output during a
 *    scoring burst, so stdout cannot be relied on to explain recovery failures.
 */
export interface PdfRecoveryOutcome {
  url: string;
  ok: boolean;
  reason: string;          // 'ok' | 'http_404' | 'waf_block' | 'challenge_page' | 'empty_bytes' | 'not_pdf' | 'no_text' | 'nav_timeout' | 'nav_error' | 'browser_launch_failure' | 'budget_exhausted' | 'session_setup_failed' | 'error'
  httpStatus?: number;
  bytes?: number;
  chars?: number;
  ms?: number;
}

export async function fetchIssuerPdfsWithPrimedSession(
  origin: string,
  urls: string[],
  opts?: { overallBudgetMs?: number; perPdfTimeoutMs?: number; outcomes?: PdfRecoveryOutcome[] }
): Promise<Map<string, string>> {
  const recovered = new Map<string, string>();
  const outcomes = opts?.outcomes;
  const note = (o: PdfRecoveryOutcome) => { if (outcomes) outcomes.push(o); };
  if (!origin || urls.length === 0) return recovered;

  const overallBudgetMs = opts?.overallBudgetMs ?? parseInt(process.env.PDF_RECOVERY_BUDGET_MS || "180000", 10); // 3 min
  const perPdfTimeoutMs = opts?.perPdfTimeoutMs ?? BROWSER_FETCH_TIMEOUT;
  const deadline = Date.now() + overallBudgetMs;

  // Last-resort recovery: clear any stale launch-circuit cooldown left over from
  // the main fetch phase so we actually get a browser here.
  resetBrowserCircuit();

  await acquireBrowserSlot();
  let page: any = null;
  let browserLaunched = false;
  try {
    const browser = await getSharedBrowser();
    browserLaunched = true;
    page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders(WAF_PRIME_HEADERS);

    // Prime the WAF session ONCE for the whole batch.
    const wafPrimed = await primeWafSession(page, origin);
    console.log(`[Processor] PDF-recovery: primed WAF for ${origin} -> ${wafPrimed ? "sensor cookies present" : "no sensor cookies (continuing)"}; ${urls.length} candidate PDF(s)`);

    // Fix K — Strategy C: extract the browser's WAF-clearance cookies to use in
    // direct Node.js HTTPS requests (nodeFetchPdf). This lets us attempt each PDF
    // via the Node HTTP stack before falling back to the CDP-based Strategies A/B.
    let cookieHeader = "";
    try {
      const pageCookies: Array<{ name: string; value: string }> = await page.cookies();
      cookieHeader = pageCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch {
      cookieHeader = "";
    }

    // In-page credentialed fetch that reuses the primed cookies (Strategy B).
    // Returns a diagnostic object so the caller can persist WHY a fetch failed
    // (HTTP status, byte count, and a short body snippet for WAF/challenge
    // detection) — stdout is unreliable on Railway under log rate-limiting.
    const inPageFetch = async (target: string): Promise<{ base64: string | null; status: number; bytes: number; snippet: string }> =>
      page.evaluate(async (t: string, originUrl: string) => {
      // esbuild's keepNames wraps named inner helpers with __name(fn,"name"); that
      // helper does not exist in the browser realm, so the serialized callback throws
      // "__name is not defined". Provide an identity shim as the very first statement.
      (globalThis as any).__name = (globalThis as any).__name || function (f: any) { return f; };
      const toB64 = (buf: ArrayBuffer): string => {
        let binary = "";
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
        }
        return btoa(binary);
      };
      const attempt = async (creds: RequestCredentials): Promise<{ base64: string | null; status: number; bytes: number; snippet: string }> => {
        try {
          const resp = await fetch(t, { credentials: creds, headers: { Accept: "application/pdf,*/*", Referer: originUrl } });
          const buf = await resp.arrayBuffer();
          const bytes = buf ? buf.byteLength : 0;
          const head = bytes ? new Uint8Array(buf).slice(0, 5) : new Uint8Array();
          const isPdf = head.length === 5 && String.fromCharCode(...head) === "%PDF-";
          // Small non-PDF body → likely a WAF block / challenge page. Capture a snippet.
          let snippet = "";
          if (!isPdf && bytes > 0 && bytes < 200000) {
            try { snippet = new TextDecoder().decode(new Uint8Array(buf).slice(0, 600)); } catch { snippet = ""; }
          }
          if (!resp.ok) return { base64: null, status: resp.status, bytes, snippet };
          if (!bytes) return { base64: null, status: resp.status, bytes: 0, snippet };
          if (!isPdf) return { base64: null, status: resp.status, bytes, snippet };
          return { base64: toB64(buf), status: resp.status, bytes, snippet: "" };
        } catch (e) {
          return { base64: null, status: 0, bytes: 0, snippet: String(e).slice(0, 200) };
        }
      };
      const first = await attempt("include");
      if (first.base64) return first;
      const second = await attempt("omit");
      // Prefer whichever attempt carries the more informative status/snippet.
      return second.base64 || second.status ? second : first;
    }, target, origin);

    for (let urlIdx = 0; urlIdx < urls.length; urlIdx++) {
      const url = urls[urlIdx];
      const t0 = Date.now();
      if (Date.now() >= deadline) {
        // Note ALL remaining URLs as budget_exhausted so Fix E can persist
        // diagnostics for every candidate, not just the one that triggered the
        // deadline. Without this, remaining URLs keep their original failure_reason.
        const remaining = urls.length - urlIdx;
        console.warn(
          `[Processor] PDF-recovery: overall budget (${Math.round(overallBudgetMs / 1000)}s) exhausted for ${origin}` +
          ` — stopping with ${recovered.size} recovered; marking ${remaining} remaining URL(s) as budget_exhausted`,
        );
        for (let j = urlIdx; j < urls.length; j++) {
          note({ url: urls[j], ok: false, reason: "budget_exhausted", ms: 0 });
        }
        break;
      }
      try {
        let text = "";
        let httpStatus: number | undefined;
        let bytes: number | undefined;
        let reason = "no_text";

        // Fix K — Strategy C: direct Node.js HTTPS download using browser-extracted
        // WAF-clearance cookies. Fast success or fast failure — avoids 45 s Chrome
        // timeout per large PDF. Falls through to Strategy A/B if C doesn't get a PDF.
        if (cookieHeader) {
          try {
            const cRes = await nodeFetchPdf(url, cookieHeader, origin, perPdfTimeoutMs);
            if (cRes.status) httpStatus = cRes.status;
            if (cRes.bytes) bytes = cRes.bytes;
            if (cRes.buf) {
              text = (await extractTextFromPdf(cRes.buf)) || "";
              if (text) {
                console.log(`[Processor] PDF-recovery [C]: node-fetch yielded ${text.length} chars from ${url.slice(0, 80)}`);
              } else {
                reason = "no_text";
              }
            } else if (cRes.status === 404) {
              // Definitively missing — skip A/B
              reason = "http_404";
              note({ url, ok: false, reason, httpStatus, bytes, chars: 0, ms: Date.now() - t0 });
              console.log(`[Processor] PDF-recovery [C]: 404 for ${url.slice(0, 80)} — skipping A/B`);
              continue;
            } else {
              // WAF block, empty, or challenge — log and fall through to A/B
              const cReason = cRes.bytes === 0 ? "empty_bytes"
                : isChallengeSnippet(cRes.snippet) ? "challenge_page"
                : (cRes.status && cRes.status >= 400) ? "waf_block"
                : "empty_bytes";
              console.log(
                `[Processor] PDF-recovery [C]: node-fetch result: status=${cRes.status} bytes=${cRes.bytes}` +
                ` reason=${cReason} — falling back to A/B for ${url.slice(0, 60)}`,
              );
            }
          } catch (cErr: any) {
            console.log(`[Processor] PDF-recovery [C]: node-fetch error: ${String(cErr?.message ?? cErr).slice(0, 80)} — falling back to A/B`);
          }
        }

        // Strategy A: direct navigation to the PDF, reusing the primed session.
        if (!text) {
          try {
            const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: perPdfTimeoutMs });
            if (resp) {
              httpStatus = resp.status();
              const ct = String(resp.headers()["content-type"] || "").toLowerCase();
              if (resp.ok()) {
                const bodyBuf: Buffer = await resp.buffer();
                if (bodyBuf && bodyBuf.length > 0) {
                  bytes = bodyBuf.length;
                  const isPdf = bodyBuf.slice(0, 5).toString("latin1") === "%PDF-" || ct.includes("application/pdf");
                  if (isPdf && bodyBuf.slice(0, 5).toString("latin1") === "%PDF-") {
                    text = (await extractTextFromPdf(bodyBuf)) || "";
                  }
                }
              }
            }
          } catch (navErr: any) {
            reason = /timeout/i.test(String(navErr?.message || navErr)) ? "nav_timeout" : "nav_error";
            console.log(`[Processor] PDF-recovery [A]: direct nav failed for ${url.slice(0, 60)} (${String(navErr?.message || navErr).slice(0, 60)}) — trying B`);
          }
        }

        // Strategy B: in-page credentialed fetch using the primed cookies.
        if (!text) {
          const r = await inPageFetch(url);
          if (r.status) httpStatus = r.status;
          if (r.bytes) bytes = r.bytes;
          if (r.base64) {
            const buf = Buffer.from(r.base64, "base64");
            if (buf.slice(0, 5).toString("latin1") === "%PDF-") {
              text = (await extractTextFromPdf(buf)) || "";
              if (!text) reason = "no_text"; // PDF fetched but text extraction empty
            } else {
              reason = "not_pdf";
            }
          } else if (r.status === 404) {
            reason = "http_404";
          } else if (r.status === 403 || r.status === 401 || r.status === 429) {
            reason = isChallengeSnippet(r.snippet) ? "challenge_page" : "waf_block";
          } else if (r.bytes === 0) {
            reason = "empty_bytes";
          } else if (isChallengeSnippet(r.snippet)) {
            reason = "challenge_page";
          } else if (r.status && r.status >= 400) {
            reason = "waf_block";
          } else if (r.bytes && r.bytes > 0) {
            // 2xx but not a PDF and not a recognised challenge page — we got an
            // HTML body (SPA shell / wrong URL) instead of the PDF.
            reason = "not_pdf";
          }
        }

        if (text && text.length > 200) {
          recovered.set(url, text);
          note({ url, ok: true, reason: "ok", httpStatus, bytes, chars: text.length, ms: Date.now() - t0 });
          console.log(`[Processor] PDF-recovery: recovered ${text.length} chars from ${url.slice(0, 90)}`);
        } else {
          if (text && text.length <= 200) reason = "no_text";
          note({ url, ok: false, reason, httpStatus, bytes, chars: text.length, ms: Date.now() - t0 });
          console.log(`[Processor] PDF-recovery: no usable content from ${url.slice(0, 90)} [reason=${reason} status=${httpStatus ?? "-"} bytes=${bytes ?? "-"}]`);
        }
      } catch (err: any) {
        const msg = String(err?.message || err);
        // A launch failure here means the container is genuinely out of budget —
        // stop the batch rather than hammering it further.
        if (/EAGAIN|Cannot fork|Resource temporarily unavailable|Failed to launch|Code: null/i.test(msg)) {
          tripBrowserCircuit(msg.split("\n")[0].slice(0, 120));
          note({ url, ok: false, reason: "browser_launch_failure", ms: Date.now() - t0 });
          console.warn(`[Processor] PDF-recovery: browser launch failure — aborting batch for ${origin} (${msg.slice(0, 80)})`);
          break;
        }
        note({ url, ok: false, reason: "error", ms: Date.now() - t0 });
        console.warn(`[Processor] PDF-recovery: failed for ${url.slice(0, 90)}: ${msg.slice(0, 100)}`);
      }
    }
  } catch (error: any) {
    const msg = String(error?.message || error);
    if (!browserLaunched || /EAGAIN|Cannot fork|Resource temporarily unavailable|Failed to launch|Code: null/i.test(msg)) {
      tripBrowserCircuit(msg.split("\n")[0].slice(0, 120));
    }
    console.warn(`[Processor] PDF-recovery: session setup failed for ${origin}: ${msg.slice(0, 120)}`);
    // Fix L: note ALL URLs as session_setup_failed so Fix E can persist diagnostics
    // even when the browser never reached the URL loop. Without this, the outer
    // catch leaves recoveryOutcomes empty and Fix E skips the DB UPDATE for
    // every URL in this origin batch — they retain their original failure_reason
    // (timeout/transient) indefinitely.
    for (const u of urls) {
      note({ url: u, ok: false, reason: "session_setup_failed", ms: 0 });
    }
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
    releaseBrowserSlot();
  }
  return recovered;
}

// ─── Main Process Document Function ──────────────────────────────────────────

export async function processDocument(
  url: string,
  type: "pdf" | "html",
  opts?: { forceHeadless?: boolean }
): Promise<string> {
  // Check in-memory cache
  const cached = getCachedContent(url);
  if (cached) return cached;

  // P5: For pinned/known URLs on repeat-failing domains, skip the plain fetch
  // entirely and go straight to headless browser (which handles JS rendering,
  // WAFs, and bot-protection challenges).
  if (opts?.forceHeadless) {
    try {
      console.log(`[Processor] Force-headless fetch for pinned/known URL: ${url.slice(0, 80)}`);
      const isPdfUrl = url.toLowerCase().includes(".pdf");
      const content = isPdfUrl ? await fetchPdfViaBrowser(url) : await fetchWithBrowser(url);
      if (content && content.trim().length > 50) {
        setCachedContent(url, content);
        return content;
      }
    } catch (e: any) {
      console.warn(`[Processor] Force-headless failed for ${url}: ${e.message}`);
    }
    // Fall through to normal path if headless didn't work
  }

  try {
    let content = "";

    if (type === "pdf" || url.toLowerCase().endsWith(".pdf")) {
      let data: any, contentType: string;
      try {
        ({ data, contentType } = await fetchWithRetry(url, { responseType: "arraybuffer" }));
      } catch (pdfHttpError: any) {
        // A direct PDF request can be killed by a WAF at the transport layer
        // (e.g. Akamai HTTP/2 INTERNAL_ERROR, or a 403). axios surfaces this as a
        // thrown error rather than a response. A real browser session usually
        // gets the bytes, so try the WAF-aware browser-PDF path before giving up.
        const sc = pdfHttpError.response?.status;
        if (sc === 401) {
          throw new PermanentFetchError(`401 paywall: ${url}`, 401);
        }
        console.log(`[Processor] Direct PDF fetch failed for ${url} (${pdfHttpError.message}) — trying WAF-aware browser-PDF fetch`);
        try {
          const viaBrowser = await fetchPdfViaBrowser(url);
          if (viaBrowser) {
            setCachedContent(url, viaBrowser);
            return viaBrowser;
          }
        } catch (browserErr: any) {
          // Browser couldn't RUN (launch failure / circuit open) — TRANSIENT.
          // Re-throw so the URL stays pending for a later pass instead of dead.
          if (browserErr instanceof BrowserUnavailableError) throw browserErr;
        }
        // Browser ran but produced no usable content THIS pass — may be a transient
        // WAF/edge condition on IR PDFs. Keep retryable (issue #3) instead of dead.
        throw new TransientFetchError(`PDF fetch failed (browser-PDF empty this pass): ${url}`);
      }
      const buf = Buffer.from(data);
      // Some CDNs return a small HTML challenge/interstitial page with HTTP 200
      // instead of the actual PDF. Detect that (by content-type, magic bytes, or
      // implausibly small size) and fall back to the browser, which can pass the
      // challenge and render the real document.
      const looksLikePdf = buf.slice(0, 5).toString("latin1") === "%PDF-";
      const ctSaysHtml = contentType.toLowerCase().includes("text/html");
      if (!looksLikePdf && (ctSaysHtml || buf.length < 4096)) {
        // Likely a bot-protection challenge (e.g. Incapsula). First try a
        // cookie warm-up + retry — far cheaper and more reliable than a
        // headless browser, and it actually passes Incapsula challenges that
        // the browser fallback often can't on a constrained worker.
        console.log(`[Processor] PDF URL returned non-PDF/interstitial (ct=${contentType}, ${buf.length}B) for ${url} — trying cookie warm-up retry`);
        const warm = await fetchWithWarmCookies(url, { responseType: "arraybuffer" });
        const warmBuf = warm ? Buffer.from(warm.data) : null;
        if (warmBuf && warmBuf.slice(0, 5).toString("latin1") === "%PDF-") {
          console.log(`[Processor] Cookie warm-up retry succeeded for ${url} (${warmBuf.length}B PDF)`);
          content = await extractTextFromPdf(warmBuf);
        } else {
          console.log(`[Processor] Cookie warm-up retry did not yield a PDF for ${url} — trying browser-PDF fetch`);
          // Use the WAF-aware browser PDF path (real browser session reads the
          // bytes), NOT the HTML scraper which returns ~nothing for a PDF.
          content = await fetchPdfViaBrowser(url);
        }
      } else {
        content = await extractTextFromPdf(buf);
      }
    } else {
      try {
        const { data, contentType } = await fetchWithRetry(url);

        // Check if response is actually a PDF
        if (contentType.includes("application/pdf")) {
          const { data: pdfData } = await fetchWithRetry(url, { responseType: "arraybuffer" });
          content = await extractTextFromPdf(Buffer.from(pdfData));
        } else if (looksLikeChallenge(String(data))) {
          // Bot-protection challenge interstitial returned for an HTML page.
          // Warm cookies and retry before falling back to the browser.
          console.log(`[Processor] HTML page returned a bot-challenge interstitial for ${url} — trying cookie warm-up retry`);
          const warm = await fetchWithWarmCookies(url);
          if (warm && warm.contentType.includes("application/pdf")) {
            content = await extractTextFromPdf(Buffer.from(warm.data));
          } else if (warm && !looksLikeChallenge(String(warm.data))) {
            content = extractTextFromHtml(String(warm.data));
          } else {
            content = await fetchWithBrowser(url);
          }
        } else {
          content = extractTextFromHtml(data);
          // SPA / "enable JavaScript" shell escalation: if the server-rendered text
          // is essentially empty (common for Chinese portals and SPA IR sites), the
          // real content is hydrated client-side. Run the JS-executing browser path
          // and adopt it when it returns materially more text. This recovers the
          // (often Chinese-language) disclosure before issuer verification can
          // reject it as an empty/generic page.
          if (isLikelyJsShell(String(data), content)) {
            console.log(`[Processor] HTML for ${url} looks like a JS/SPA shell (${content.length} chars) — escalating to browser render`);
            try {
              const rendered = await fetchWithBrowser(url);
              if (rendered && rendered.trim().length > content.length) {
                console.log(`[Processor] Browser render recovered ${rendered.trim().length} chars for ${url} (was ${content.length})`);
                content = rendered;
              }
            } catch (shellErr: any) {
              // Browser unavailable / failed — keep the stub (better than nothing);
              // a transient BrowserUnavailableError leaves the URL retryable upstream.
              if (shellErr instanceof BrowserUnavailableError) throw shellErr;
              console.log(`[Processor] Browser render for JS shell failed (${shellErr?.message}); keeping HTTP content`);
            }
          }
        }
      } catch (httpError: any) {
        // Determine if browser fallback would be useful
        const statusCode = httpError.response?.status;
        const isPaywall = statusCode === 401;
        const isCdnBlock = statusCode === 403 && /\.(pdf|xlsx|docx|csv|zip)($|\?)/i.test(url);

        if (isPaywall) {
          // 401 = paywall (WSJ, Reuters, FT) — browser won't have credentials either.
          // Terminal: throw so the pipeline marks this URL dead in one step
          // instead of retrying it across passes.
          console.log(`[Processor] HTTP fetch failed for ${url} (401 Unauthorized/paywall), marking permanent`);
          throw new PermanentFetchError(`401 paywall: ${url}`, 401);
        } else if (isCdnBlock) {
          // 403 on a direct file/PDF link = WAF/CDN bot block (Akamai/Cloudflare/
          // Imperva). A plain axios request is blocked by TLS/HTTP-2 fingerprint,
          // but a real browser session frequently passes. Try the WAF-aware
          // browser-PDF path; only mark permanent if THAT also fails. This is the
          // fix for high-value IR PDFs (e.g. Adobe AI Ethics, 10-K) that were
          // previously discarded, artificially deflating well-governed firms.
          console.log(`[Processor] HTTP 403 on direct file ${url} — trying WAF-aware browser-PDF fetch`);
          try {
            content = await fetchPdfViaBrowser(url);
          } catch (browserErr: any) {
            // Browser couldn't RUN — TRANSIENT; keep retryable.
            if (browserErr instanceof BrowserUnavailableError) throw browserErr;
          }
          if (!content) {
            console.log(`[Processor] Browser-PDF fetch also failed for ${url} (403) — keeping retryable (transient)`);
            throw new TransientFetchError(`403 CDN block (browser-PDF empty this pass): ${url}`, 403);
          }
        } else {
          // Timeout, 5xx, 403 on HTML page, network error — browser fallback is valuable
          console.log(`[Processor] HTTP fetch failed for ${url} (${httpError.message}), trying browser fallback...`);
          content = await fetchWithBrowser(url);
        }
      }
    }

    if (content) {
      setCachedContent(url, content);
    }

    return content;
  } catch (error: any) {
    // Propagate terminal failures unchanged so the pipeline can mark the URL
    // dead in a single step (no browser fallback, no retry passes).
    if (error instanceof PermanentFetchError) {
      console.log(`[Processor] Permanent failure for ${url} (${error.message}) — not retrying`);
      throw error;
    }
    // Transient browser-unavailable — re-throw so the pipeline keeps the URL
    // pending for a later pass (do NOT mark dead). Once browser capacity
    // recovers, the high-value PDF can still be fetched.
    if (error instanceof BrowserUnavailableError) {
      console.log(`[Processor] Browser temporarily unavailable for ${url} — leaving retryable`);
      throw error;
    }
    // Transient PDF/edge failure (issue #3) — re-throw so the pipeline records a
    // retryable fetch FAILURE rather than swallowing it (return "" would look like
    // a successful empty fetch). The per-document failure cap still retires it.
    if (error instanceof TransientFetchError) {
      console.log(`[Processor] Transient fetch failure for ${url} — leaving retryable`);
      throw error;
    }
    console.warn(`[Processor] Failed to process ${url}: ${error.message}`);
    // Final fallback: try browser only if not a known-dead pattern
    const statusCode = error.response?.status;
    const isPaywall = statusCode === 401;
    const isCdnBlock = statusCode === 403 && /\.(pdf|xlsx|docx|csv|zip)($|\?)/i.test(url);

    if (!isPaywall && !isCdnBlock) {
      try {
        // For PDF URLs use the WAF-aware byte path (the HTML scraper returns
        // ~nothing for a PDF rendered in Chromium's viewer); otherwise scrape HTML.
        const isPdfUrl = url.toLowerCase().includes(".pdf");
        console.log(`[Processor] Final browser fallback for ${url}${isPdfUrl ? ' (browser-PDF)' : ''}`);
        const browserContent = isPdfUrl ? await fetchPdfViaBrowser(url) : await fetchWithBrowser(url);
        if (browserContent) {
          setCachedContent(url, browserContent);
          return browserContent;
        }
      } catch (e) {
        // Ignore
      }
    } else {
      console.log(`[Processor] Skipping final browser fallback for ${url} (${isPaywall ? '401 paywall' : '403 CDN block'})`);
    }
    return "";
  }
}

// ─── Determine Document Type from URL ────────────────────────────────────────

export function inferDocumentType(url: string): "pdf" | "html" {
  const lower = url.toLowerCase();
  if (lower.endsWith(".pdf") || lower.includes("/pdf/") || lower.includes("format=pdf")) {
    return "pdf";
  }
  return "html";
}

// ─── Generate Document Hash (sorted URL set, not order-sensitive) ────────────

export function generateDocumentHash(urls: string[]): string {
  const sorted = [...urls].sort();
  return crypto.createHash("sha256").update(sorted.join("|||")).digest("hex").slice(0, 16);
}
