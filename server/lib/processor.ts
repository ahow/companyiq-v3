import axios from "axios";
import * as cheerio from "cheerio";
import pdfParse from "pdf-parse";
import crypto from "crypto";
import puppeteer from "puppeteer-core";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FETCH_TIMEOUT = 15000;
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
      const response = await axios.get(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: opts.responseType === "arraybuffer"
            ? "application/pdf"
            : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        timeout: FETCH_TIMEOUT,
        responseType: opts.responseType || "text",
        maxRedirects: 5,
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
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
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
      const { data } = await fetchWithRetry(url, { responseType: "arraybuffer" });
      content = await extractTextFromPdf(Buffer.from(data));
    } else {
      try {
        const { data, contentType } = await fetchWithRetry(url);

        // Check if response is actually a PDF
        if (contentType.includes("application/pdf")) {
          const { data: pdfData } = await fetchWithRetry(url, { responseType: "arraybuffer" });
          content = await extractTextFromPdf(Buffer.from(pdfData));
        } else {
          content = extractTextFromHtml(data);
        }
      } catch (httpError: any) {
        // Determine if browser fallback would be useful
        const statusCode = httpError.response?.status;
        const isPaywall = statusCode === 401;
        const isCdnBlock = statusCode === 403 && /\.(pdf|xlsx|docx|csv|zip)($|\?)/i.test(url);

        if (isPaywall) {
          // 401 = paywall (WSJ, Reuters, FT) — browser won't have credentials either
          console.log(`[Processor] HTTP fetch failed for ${url} (401 Unauthorized/paywall), skipping browser fallback`);
        } else if (isCdnBlock) {
          // 403 on a direct file/PDF link = CDN block — browser can't bypass
          console.log(`[Processor] HTTP fetch failed for ${url} (403 on direct file), skipping browser fallback`);
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
