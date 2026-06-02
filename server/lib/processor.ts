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

async function fetchWithBrowser(url: string): Promise<string> {
  let browser;
  try {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 800 });

    // Block unnecessary resources to speed up loading
    await page.setRequestInterception(true);
    page.on("request", (req) => {
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
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        // Ignore close errors
      }
    }
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
        // HTTP fetch failed (likely WAF/403/timeout) — try browser fallback
        console.log(`[Processor] HTTP fetch failed for ${url} (${httpError.message}), trying browser fallback...`);
        content = await fetchWithBrowser(url);
      }
    }

    if (content) {
      setCachedContent(url, content);
    }

    return content;
  } catch (error: any) {
    console.warn(`[Processor] Failed to process ${url}: ${error.message}`);
    // Final fallback: try browser for any remaining failures
    try {
      const browserContent = await fetchWithBrowser(url);
      if (browserContent) {
        setCachedContent(url, browserContent);
        return browserContent;
      }
    } catch (e) {
      // Ignore
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
