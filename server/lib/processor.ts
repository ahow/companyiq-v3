import axios from "axios";
import * as cheerio from "cheerio";
import pdfParse from "pdf-parse";
import crypto from "crypto";
import puppeteer from "puppeteer-core";

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
const FETCH_TIMEOUT_BINARY = parseInt(process.env.FETCH_TIMEOUT_BINARY_MS || "90000", 10); // 90s for PDF/binary
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

// ─── Fetch with Retry ────────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  opts: { responseType?: "arraybuffer" | "text" } = {}
): Promise<{ data: any; contentType: string }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const sec = isSecHost(url);
      const headers: Record<string, string> = {
        "User-Agent": sec ? SEC_USER_AGENT : USER_AGENT,
        Accept: opts.responseType === "arraybuffer"
          ? "application/pdf"
          : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate",
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
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_DELAY_BASE * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
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

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  try {
    const data = await pdfParse(buffer);
    return data.text || "";
  } catch (error: any) {
    console.warn(`[Processor] PDF parse error: ${error.message}`);
    return "";
  }
}

// ─── Browser-Based Fetching (Puppeteer Fallback) ────────────────────────────

const BROWSER_FETCH_TIMEOUT = 30000;

// Limit how many browser fetches can run at once. Launching/holding many
// Chromium contexts concurrently exhausts the container's process/fork and
// memory budget ("fork: Resource temporarily unavailable"), which previously
// cascaded into an unhandled rejection that crashed the whole process.
const MAX_CONCURRENT_BROWSER = parseInt(process.env.MAX_CONCURRENT_BROWSER || "2", 10);
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

async function getSharedBrowser(): Promise<any> {
  if (sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }
  if (sharedBrowserLaunching) return sharedBrowserLaunching;

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
  sharedBrowserLaunching = puppeteer
    .launch({
      executablePath,
      headless: true,
      // Memory/fork-conservative flags. The worker runs many sequential page
      // loads on a constrained container; these reduce RSS and the number of
      // helper processes Chromium spawns, mitigating the prior
      // "spawn /usr/bin/chromium EAGAIN" fork-exhaustion under load.
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
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
      ],
    })
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
      if (/EAGAIN|Cannot fork|Resource temporarily unavailable|Failed to launch/i.test(msg)) {
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

    // Extract text content from the page
    const content = await page.evaluate(() => {
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

// ─── Main Process Document Function ──────────────────────────────────────────

export async function processDocument(
  url: string,
  type: "pdf" | "html"
): Promise<string> {
  // Check in-memory cache
  const cached = getCachedContent(url);
  if (cached) return cached;

  try {
    let content = "";

    if (type === "pdf" || url.toLowerCase().endsWith(".pdf")) {
      const { data, contentType } = await fetchWithRetry(url, { responseType: "arraybuffer" });
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
          console.log(`[Processor] Cookie warm-up retry did not yield a PDF for ${url} — trying browser fallback`);
          content = await fetchWithBrowser(url);
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
          // 403 on a direct file/PDF link = CDN block — browser can't bypass.
          // Terminal: throw so the pipeline marks this URL dead in one step.
          console.log(`[Processor] HTTP fetch failed for ${url} (403 on direct file), marking permanent`);
          throw new PermanentFetchError(`403 CDN block: ${url}`, 403);
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
    console.warn(`[Processor] Failed to process ${url}: ${error.message}`);
    // Final fallback: try browser only if not a known-dead pattern
    const statusCode = error.response?.status;
    const isPaywall = statusCode === 401;
    const isCdnBlock = statusCode === 403 && /\.(pdf|xlsx|docx|csv|zip)($|\?)/i.test(url);

    if (!isPaywall && !isCdnBlock) {
      try {
        console.log(`[Processor] Final browser fallback for ${url}`);
        const browserContent = await fetchWithBrowser(url);
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
