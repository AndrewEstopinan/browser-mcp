#!/usr/bin/env node
/**
 * Bright Data MCP Server
 * ----------------------
 * Exposes Bright Data's Web Access APIs as Model Context Protocol tools so an
 * AI agent can browse and extract data from any public website:
 *
 *   smart_scrape               - cost-aware fetch: free first, Bright Data only if blocked
 *   smart_scrape_batch         - fetch multiple URLs concurrently
 *   smart_crawl                - follow links up to a depth/page limit
 *   smart_diff                 - detect page changes since last fetch
 *   smart_extract              - extract JSON-LD, OG tags, and meta from a page
 *   parse_feed                 - parse RSS / Atom feeds and XML sitemaps
 *   check_robots               - check robots.txt before scraping
 *   smart_scrape_skiplist      - inspect the in-memory hard-domain skip-list
 *   unlocker_scrape            - fetch any URL (html / markdown / screenshot)
 *   unlocker_scrape_async      - start a long-running unlock job
 *   unlocker_get_async_result  - poll an async unlock job
 *   unlocker_success_rate      - per-domain success-rate stats
 *   serp_search                - structured search results (Google/Bing/Yandex/DDG)
 *   web_scraper_trigger        - trigger a Crawl / Web Scraper dataset job
 *   web_scraper_get_results    - poll & download dataset results
 *   browser_scrape             - cloud browser automation w/ auto CAPTCHA solving
 *   web_data_*                 - 35 structured vertical dataset tools
 *
 * Transport: stdio (the standard MCP transport for local servers).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig, type BrightDataConfig } from "./config.js";
import { BrightDataClient, BrightDataApiError } from "./client.js";
import { buildSearchUrl } from "./serp.js";
import { runBrowserTask, type BrowserAction } from "./browser.js";
import { registerWebDataTools } from "./web-data.js";
import { smartScrape, skipListSnapshot, htmlToMarkdown, detectBlock } from "./router.js";
import { cacheGet, cacheSet, cachePeek, DEFAULT_CACHE_TTL_MS } from "./cache.js";
import { extractMainContent, extractMeta, extractJsonLd, parseFeed, parseSitemap, parseRobots } from "./extract.js";
import { smartScrapeBatch, smartCrawl } from "./crawl.js";

const VERSION = "1.1.0";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let cfg: BrightDataConfig;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`[brightdata-mcp] ${(e as Error).message}`);
  process.exit(1);
}

const client = new BrightDataClient(cfg);

const server = new McpServer({
  name: "brightdata-mcp-server",
  version: VERSION,
});

// Small helpers for uniform tool results -----------------------------------

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function ok(blocks: ContentBlock[]) {
  return { content: blocks };
}
function text(t: string) {
  return ok([{ type: "text", text: t }]);
}
function fail(e: unknown) {
  const msg =
    e instanceof BrightDataApiError
      ? e.message
      : e instanceof Error
        ? e.message
        : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

function truncate(s: string, max = 200_000): string {
  return s.length > max
    ? s.slice(0, max) + `\n\n…[truncated ${s.length - max} chars]`
    : s;
}

// ---------------------------------------------------------------------------
// 0. Smart scrape: cost-aware router (free first, Bright Data only if blocked)
// ---------------------------------------------------------------------------

server.registerTool(
  "smart_scrape",
  {
    title: "Scrape a URL (cost-aware: free first, Bright Data only if blocked)",
    description:
      "PREFERRED scraping tool. Fetches a page as cheaply as possible: it first " +
      "tries a FREE direct HTTP request, and only falls back to the PAID Bright " +
      "Data Web Unlocker if it detects an anti-bot wall (Cloudflare, Akamai, " +
      "Imperva/Incapsula, PerimeterX, DataDome, a CAPTCHA, or a 403/429/503). " +
      "An in-memory skip-list remembers hard domains so repeat calls skip the " +
      "doomed free attempt. Most sites cost $0. The result reports which tier " +
      "was used and whether credit was spent. Use this instead of unlocker_scrape " +
      "for read-only fetches; reserve browser_scrape for real JS interaction.",
    inputSchema: {
      url: z.string().url().describe("Full target URL including https://"),
      data_format: z
        .enum(["html", "markdown", "content_only"])
        .default("markdown")
        .describe("Output format. 'content_only' strips nav/ads and returns just the main article text."),
      country: z
        .string()
        .length(2)
        .optional()
        .describe("2-letter exit-IP country (only applies if it escalates to Bright Data)."),
      method: z.string().default("GET").describe("HTTP method."),
      headers: z.record(z.string()).optional().describe("Custom request headers for both tiers."),
      wait_for_selector: z.string().optional().describe("CSS selector to wait for (Bright Data tier only)."),
      wait_for_text: z.string().optional().describe("Text to wait for (Bright Data tier only)."),
      force_bright_data: z
        .boolean()
        .default(false)
        .describe("Skip the free attempt and go straight to the paid Unlocker."),
      free_only: z
        .boolean()
        .default(false)
        .describe("Never spend credit; return best-effort free result even if blocked."),
      ignore_skip_list: z
        .boolean()
        .default(false)
        .describe("Ignore the hard-domain skip-list and always try the free tier first."),
      direct_timeout_ms: z
        .number()
        .int()
        .default(12000)
        .describe("Abort the free fetch after this many ms, then escalate."),
      min_body_bytes: z
        .number()
        .int()
        .default(0)
        .describe("Treat a 2xx response smaller than this as a block (0 = off)."),
      rate_limit_ms: z
        .number()
        .int()
        .default(0)
        .describe("Minimum ms between free-tier requests to the same domain (0 = off)."),
      use_cache: z.boolean().default(false).describe("Return a cached response if one exists and isn't expired."),
      cache_ttl_ms: z
        .number()
        .int()
        .default(DEFAULT_CACHE_TTL_MS)
        .describe("Cache TTL in ms (default 1 hour). Only used when use_cache=true."),
      respect_robots: z
        .boolean()
        .default(false)
        .describe("Check robots.txt before fetching. Returns an error if the path is disallowed."),
    },
  },
  async (args) => {
    try {
      // Robots.txt check
      if (args.respect_robots) {
        const robotsUrl = new URL("/robots.txt", args.url).href;
        const path = new URL(args.url).pathname;
        let robotsTxt = cacheGet(robotsUrl, "text");
        if (!robotsTxt) {
          try {
            const resp = await fetch(robotsUrl, { signal: AbortSignal.timeout(5_000) });
            if (resp.ok) {
              robotsTxt = await resp.text();
              cacheSet(robotsUrl, "text", robotsTxt, 24 * 60 * 60_000);
            }
          } catch { /* if robots.txt unreachable, allow */ }
        }
        if (robotsTxt) {
          const { allowed, matchedRule } = parseRobots(robotsTxt, path);
          if (!allowed) return text(JSON.stringify({ blocked: true, reason: `robots.txt disallows this path`, rule: matchedRule }));
        }
      }

      // Cache read
      const cacheFormat = args.data_format;
      if (args.use_cache) {
        const cached = cacheGet(args.url, cacheFormat);
        if (cached) return ok([
          { type: "text", text: JSON.stringify({ cached: true, data_format: cacheFormat }) },
          { type: "text", text: truncate(cached) },
        ]);
      }

      const result = await smartScrape({
        url: args.url,
        dataFormat: args.data_format === "content_only" ? "html" : args.data_format,
        country: args.country,
        method: args.method,
        headers: args.headers,
        waitForSelector: args.wait_for_selector,
        waitForText: args.wait_for_text,
        forceBrightData: args.force_bright_data,
        freeOnly: args.free_only,
        ignoreSkipList: args.ignore_skip_list,
        directTimeoutMs: args.direct_timeout_ms,
        minBodyBytes: args.min_body_bytes,
        rateLimitMs: args.rate_limit_ms,
        client,
        unlockerZone: cfg.unlockerZone,
      });

      let outputText = result.text ?? "";
      if (args.data_format === "content_only") outputText = extractMainContent(outputText);

      if (args.use_cache) cacheSet(args.url, cacheFormat, outputText, args.cache_ttl_ms);

      const summary = {
        tier: result.tier,
        paid: result.paid,
        cost: result.paid ? "Bright Data credit spent" : "FREE (no credit)",
        skipped_free_tier: result.skippedFreeTier,
        status: result.status,
        final_url: result.finalUrl,
        block_reason: result.blockReason,
        data_format: args.data_format,
        log: result.log,
      };

      return ok([
        { type: "text", text: JSON.stringify(summary, null, 2) },
        { type: "text", text: truncate(outputText) },
      ]);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "smart_scrape_skiplist",
  {
    title: "Inspect the cost-router skip-list",
    description:
      "Show the in-memory list of domains currently being sent straight to Bright " +
      "Data (because the free tier was blocked recently). Useful for debugging cost.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(JSON.stringify(skipListSnapshot(), null, 2));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 0b. Batch scraping
// ---------------------------------------------------------------------------

server.registerTool(
  "smart_scrape_batch",
  {
    title: "Scrape multiple URLs concurrently (cost-aware)",
    description:
      "Fetch an array of URLs in parallel using the same free-first routing as smart_scrape. " +
      "Returns an array of {url, success, text, tier, paid} objects. Use this instead of " +
      "calling smart_scrape in a loop — it's significantly faster.",
    inputSchema: {
      urls: z.array(z.string().url()).min(1).max(50).describe("URLs to fetch (max 50)."),
      data_format: z.enum(["html", "markdown", "content_only"]).default("markdown"),
      concurrency: z.number().int().min(1).max(10).default(5).describe("Max parallel fetches."),
      force_bright_data: z.boolean().default(false),
      free_only: z.boolean().default(false),
      direct_timeout_ms: z.number().int().default(12000),
      rate_limit_ms: z.number().int().default(0),
    },
  },
  async (args) => {
    try {
      const results = await smartScrapeBatch(
        args.urls,
        {
          dataFormat: args.data_format === "content_only" ? "html" : args.data_format,
          forceBrightData: args.force_bright_data,
          freeOnly: args.free_only,
          directTimeoutMs: args.direct_timeout_ms,
          rateLimitMs: args.rate_limit_ms,
          client,
          unlockerZone: cfg.unlockerZone,
        },
        args.concurrency
      );

      if (args.data_format === "content_only") {
        for (const r of results) {
          if (r.success && r.text) r.text = extractMainContent(r.text);
        }
      }

      const paid = results.filter((r) => r.paid).length;
      const failed = results.filter((r) => !r.success).length;
      const summary = { total: results.length, paid, free: results.length - paid - failed, failed };
      return ok([
        { type: "text", text: JSON.stringify(summary, null, 2) },
        { type: "text", text: truncate(JSON.stringify(results, null, 2)) },
      ]);
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 0c. Crawl with link following
// ---------------------------------------------------------------------------

server.registerTool(
  "smart_crawl",
  {
    title: "Crawl a site by following links",
    description:
      "Start at a URL, follow links up to a depth/page limit, and return content from each page. " +
      "Stays on the same hostname by default. Use url_filter to restrict which paths are visited.",
    inputSchema: {
      start_url: z.string().url().describe("Starting URL."),
      max_pages: z.number().int().min(1).max(50).default(10).describe("Maximum pages to fetch."),
      max_depth: z.number().int().min(0).max(5).default(2).describe("Maximum link depth from start."),
      url_filter: z.string().optional().describe("Regex pattern — only follow links that match."),
      same_host_only: z.boolean().default(true).describe("Restrict crawl to the starting hostname."),
      data_format: z.enum(["html", "markdown"]).default("markdown"),
      force_bright_data: z.boolean().default(false),
      free_only: z.boolean().default(false),
      rate_limit_ms: z.number().int().default(500).describe("ms between requests to same domain (default 500 for crawls)."),
    },
  },
  async (args) => {
    try {
      const results = await smartCrawl(
        args.start_url,
        {
          dataFormat: args.data_format,
          forceBrightData: args.force_bright_data,
          freeOnly: args.free_only,
          rateLimitMs: args.rate_limit_ms,
          client,
          unlockerZone: cfg.unlockerZone,
        },
        { maxPages: args.max_pages, maxDepth: args.max_depth, urlFilter: args.url_filter, sameHostOnly: args.same_host_only }
      );

      const paid = results.filter((r) => r.paid).length;
      const summary = { pages_fetched: results.length, paid, free: results.length - paid };
      return ok([
        { type: "text", text: JSON.stringify(summary, null, 2) },
        { type: "text", text: truncate(JSON.stringify(results.map((r) => ({ url: r.url, depth: r.depth, tier: r.tier, paid: r.paid, links_found: r.linksFound, text: r.text.slice(0, 2000) })), null, 2)) },
      ]);
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 0d. Page change detection
// ---------------------------------------------------------------------------

server.registerTool(
  "smart_diff",
  {
    title: "Detect changes on a page since last fetch",
    description:
      "Fetch a URL and compare it to the previously cached version. Returns whether the page " +
      "changed, when it was last seen, and both versions so you can inspect what's different. " +
      "First call always stores a baseline; subsequent calls detect changes.",
    inputSchema: {
      url: z.string().url(),
      data_format: z.enum(["html", "markdown", "content_only"]).default("markdown"),
      force_bright_data: z.boolean().default(false),
      free_only: z.boolean().default(false),
    },
  },
  async (args) => {
    try {
      const previous = cachePeek(args.url, args.data_format);

      const result = await smartScrape({
        url: args.url,
        dataFormat: args.data_format === "content_only" ? "html" : args.data_format,
        forceBrightData: args.force_bright_data,
        freeOnly: args.free_only,
        client,
        unlockerZone: cfg.unlockerZone,
      });

      let current = result.text ?? "";
      if (args.data_format === "content_only") current = extractMainContent(current);

      cacheSet(args.url, args.data_format, current, 365 * 24 * 60 * 60_000); // keep indefinitely

      const changed = !previous || previous.body !== current;
      const summary = {
        changed,
        previous_fetched_at: previous ? new Date(previous.cachedAt).toISOString() : null,
        tier: result.tier,
        paid: result.paid,
      };

      return ok([
        { type: "text", text: JSON.stringify(summary, null, 2) },
        ...(previous && changed
          ? [
              { type: "text" as const, text: `--- PREVIOUS (${new Date(previous.cachedAt).toISOString()}) ---\n${truncate(previous.body, 50_000)}` },
              { type: "text" as const, text: `--- CURRENT ---\n${truncate(current, 50_000)}` },
            ]
          : [{ type: "text" as const, text: truncate(current) }]),
      ]);
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 0e. Structured metadata extraction
// ---------------------------------------------------------------------------

server.registerTool(
  "smart_extract",
  {
    title: "Extract structured metadata from a page",
    description:
      "Fetch a page and extract structured data: JSON-LD schema.org objects, Open Graph tags, " +
      "Twitter card meta, standard meta description/keywords, and page title. Returns clean JSON. " +
      "Useful for getting product info, article metadata, or any schema.org markup without parsing HTML.",
    inputSchema: {
      url: z.string().url(),
      force_bright_data: z.boolean().default(false),
      free_only: z.boolean().default(false),
      use_cache: z.boolean().default(true).describe("Use cached HTML if available (default true)."),
    },
  },
  async (args) => {
    try {
      let html: string;
      const cached = args.use_cache ? cacheGet(args.url, "html") : null;
      if (cached) {
        html = cached;
      } else {
        const result = await smartScrape({
          url: args.url,
          dataFormat: "html",
          forceBrightData: args.force_bright_data,
          freeOnly: args.free_only,
          client,
          unlockerZone: cfg.unlockerZone,
        });
        html = result.text ?? "";
        if (html) cacheSet(args.url, "html", html);
      }

      const extracted = {
        meta: extractMeta(html),
        json_ld: extractJsonLd(html),
      };

      return text(JSON.stringify(extracted, null, 2));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 0f. Feed and sitemap parsing
// ---------------------------------------------------------------------------

server.registerTool(
  "parse_feed",
  {
    title: "Parse an RSS feed, Atom feed, or XML sitemap",
    description:
      "Fetch and parse an RSS 2.0 feed, Atom 1.0 feed, or XML sitemap. Auto-detects the format " +
      "from content-type and content. Returns structured JSON with items/entries or sitemap URLs. " +
      "Free direct fetch — no Bright Data credit unless the feed is behind a wall.",
    inputSchema: {
      url: z.string().url().describe("URL of the feed or sitemap."),
      free_only: z.boolean().default(true),
    },
  },
  async (args) => {
    try {
      const result = await smartScrape({
        url: args.url,
        dataFormat: "html",
        freeOnly: args.free_only,
        client,
        unlockerZone: cfg.unlockerZone,
      });

      const raw = result.text ?? "";
      const isSitemap = /<(?:urlset|sitemapindex)[^>]*>/i.test(raw);
      const isFeed = /<(?:rss|feed|channel)[^>]*>/i.test(raw);

      if (isSitemap) {
        return text(JSON.stringify({ type: "sitemap", entries: parseSitemap(raw) }, null, 2));
      }
      if (isFeed) {
        return text(JSON.stringify(parseFeed(raw), null, 2));
      }
      return text(JSON.stringify({ type: "unknown", raw: raw.slice(0, 500) }));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 0g. robots.txt compliance check
// ---------------------------------------------------------------------------

server.registerTool(
  "check_robots",
  {
    title: "Check if a URL is allowed by robots.txt",
    description:
      "Fetch and parse the site's robots.txt, then check whether the given URL path is " +
      "permitted for the wildcard (*) user-agent. Returns the verdict and the matching rule. " +
      "robots.txt is cached for 24 hours.",
    inputSchema: {
      url: z.string().url().describe("The URL you want to check (not the robots.txt URL itself)."),
    },
  },
  async (args) => {
    try {
      const robotsUrl = new URL("/robots.txt", args.url).href;
      const path = new URL(args.url).pathname;

      let robotsTxt = cacheGet(robotsUrl, "text");
      if (!robotsTxt) {
        const resp = await fetch(robotsUrl, { signal: AbortSignal.timeout(8_000) });
        if (!resp.ok) return text(JSON.stringify({ allowed: true, reason: `robots.txt returned HTTP ${resp.status} — assuming allowed` }));
        robotsTxt = await resp.text();
        cacheSet(robotsUrl, "text", robotsTxt, 24 * 60 * 60_000);
      }

      const { allowed, matchedRule } = parseRobots(robotsTxt, path);
      return text(JSON.stringify({ url: args.url, path, allowed, matched_rule: matchedRule ?? "none (default allow)" }, null, 2));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 1. Unlocker: fetch any URL
// ---------------------------------------------------------------------------

server.registerTool(
  "unlocker_scrape",
  {
    title: "Scrape any URL (Web Unlocker)",
    description:
      "Always spends Bright Data credit. For read-only fetches prefer smart_scrape — " +
      "it tries a free direct request first and only falls back here when the site " +
      "actively blocks it. Use unlocker_scrape directly only when you need screenshot " +
      "output, want to force Bright Data unconditionally, or smart_scrape has already " +
      "confirmed the site is hard-blocked.",
    inputSchema: {
      url: z.string().url().describe("Full target URL including https://"),
      data_format: z
        .enum(["html", "markdown", "screenshot"])
        .default("markdown")
        .describe("Output transform: html, markdown, or a PNG screenshot."),
      country: z
        .string()
        .length(2)
        .optional()
        .describe("2-letter ISO country code for the exit IP, e.g. us, gb, de."),
      method: z.string().default("GET").describe("HTTP method."),
      wait_for_selector: z
        .string()
        .optional()
        .describe("CSS selector that must appear before returning (x-unblock-expect)."),
      wait_for_text: z
        .string()
        .optional()
        .describe("Text that must appear on the page before returning."),
      headers: z
        .record(z.string())
        .optional()
        .describe("Custom request headers (requires the Custom Headers feature on the zone)."),
      zone: z.string().optional().describe("Override the Unlocker zone name."),
    },
  },
  async (args) => {
    try {
      const expect =
        args.wait_for_selector || args.wait_for_text
          ? { element: args.wait_for_selector, text: args.wait_for_text }
          : undefined;
      const res = await client.request({
        url: args.url,
        zone: args.zone ?? cfg.unlockerZone,
        format: "raw",
        method: args.method,
        country: args.country,
        dataFormat: args.data_format,
        headers: args.headers,
        expect,
      });
      if (args.data_format === "screenshot" && res.bytes) {
        return ok([
          {
            type: "image",
            data: Buffer.from(res.bytes).toString("base64"),
            mimeType: "image/png",
          },
        ]);
      }
      return text(truncate(res.text ?? ""));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 2. Unlocker async + poll
// ---------------------------------------------------------------------------

server.registerTool(
  "unlocker_scrape_async",
  {
    title: "Start an async unlock job",
    description:
      "Start an asynchronous Web Unlocker request for slow/heavy pages. Returns a " +
      "response_id you later pass to unlocker_get_async_result.",
    inputSchema: {
      url: z.string().url(),
      data_format: z.enum(["html", "markdown", "screenshot"]).default("markdown"),
      country: z.string().length(2).optional(),
      zone: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const res = await client.request(
        {
          url: args.url,
          zone: args.zone ?? cfg.unlockerZone,
          format: "raw",
          country: args.country,
          dataFormat: args.data_format,
        },
        true
      );
      if (!res.responseId) {
        return text(
          "Async request accepted, but no response_id header was returned. " +
            "Body:\n" + truncate(res.text ?? "")
        );
      }
      return text(
        JSON.stringify({ response_id: res.responseId, status: "accepted" }, null, 2)
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "unlocker_get_async_result",
  {
    title: "Get async unlock result",
    description:
      "Retrieve the result of an async unlock job. If still processing, returns a " +
      "PENDING status - poll again shortly.",
    inputSchema: {
      response_id: z.string().describe("The id returned by unlocker_scrape_async."),
      zone: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const res = await client.getAsyncResult(args.response_id, args.zone ?? cfg.unlockerZone);
      if (res.text === "__PENDING__") {
        return text(JSON.stringify({ status: "pending", response_id: args.response_id }));
      }
      if (res.bytes) {
        return ok([
          {
            type: "image",
            data: Buffer.from(res.bytes).toString("base64"),
            mimeType: "image/png",
          },
        ]);
      }
      return text(truncate(res.text ?? ""));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 3. Success-rate stats
// ---------------------------------------------------------------------------

server.registerTool(
  "unlocker_success_rate",
  {
    title: "Domain success-rate stats",
    description:
      "Return Web Unlocker success-rate statistics (past 7 days) for a domain. " +
      "Use a wildcard like 'example.*' to get all TLDs.",
    inputSchema: {
      domain: z.string().describe("e.g. example.com or example.*"),
    },
  },
  async (args) => {
    try {
      const stats = await client.successRate(args.domain);
      return text(JSON.stringify(stats, null, 2));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 4. SERP search
// ---------------------------------------------------------------------------

server.registerTool(
  "serp_search",
  {
    title: "Search engine results (free DDG or paid SERP API)",
    description:
      "Run a web search. For DuckDuckGo queries, tries a FREE direct fetch first " +
      "and only falls back to the paid Bright Data SERP API if blocked. For Google, " +
      "Bing, and Yandex, always uses the paid SERP API (no free public API exists). " +
      "Returns structured JSON (parse=true) or raw HTML/Markdown (parse=false).",
    inputSchema: {
      query: z.string().describe("The search query."),
      engine: z
        .enum(["google", "bing", "yandex", "duckduckgo"])
        .default("google"),
      page: z.number().int().min(1).default(1).describe("Results page (1-based)."),
      num: z.number().int().min(1).max(100).optional().describe("Results per page (Google)."),
      language: z.string().optional().describe("UI language code (Google hl), e.g. en."),
      gl: z.string().optional().describe("Country of results (Google gl), e.g. us."),
      country: z.string().length(2).optional().describe("Exit-IP country code."),
      mobile: z.boolean().default(false).describe("Return mobile results."),
      search_type: z
        .enum(["web", "images", "news", "shopping", "videos", "jobs"])
        .default("web"),
      parse: z
        .boolean()
        .default(true)
        .describe("true => parsed JSON; false => raw HTML."),
      zone: z.string().optional().describe("Override the SERP zone name."),
    },
  },
  async (args) => {
    try {
      // Free tier: DuckDuckGo lite endpoint (no API key, no credit).
      if (args.engine === "duckduckgo" && !args.parse) {
        const ddgUrl =
          `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(args.query)}` +
          (args.page > 1 ? `&s=${(args.page - 1) * 25}` : "");
        try {
          const resp = await fetch(ddgUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; bot/1.0)" },
            signal: AbortSignal.timeout(10_000),
          });
          if (resp.ok) {
            const html = await resp.text();
            const block = detectBlock({ status: resp.status, headers: resp.headers, body: html, minBodyBytes: 500 });
            if (!block) return text(truncate(htmlToMarkdown(html)));
          }
        } catch { /* fall through to Bright Data */ }
      }

      const url = buildSearchUrl({
        engine: args.engine,
        query: args.query,
        page: args.page,
        num: args.num,
        language: args.language,
        gl: args.gl,
        mobile: args.mobile,
        searchType: args.search_type,
      });
      const res = await client.request({
        url,
        zone: args.zone ?? cfg.serpZone,
        format: args.parse ? "json" : "raw",
        country: args.country,
      });
      return text(truncate(res.text ?? ""));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 5. Crawl / Web Scraper API
// ---------------------------------------------------------------------------

server.registerTool(
  "web_scraper_trigger",
  {
    title: "Trigger a Crawl / Web Scraper job",
    description:
      "Trigger a Bright Data dataset (Web Scraper / Crawl API) collection over one " +
      "or more URLs. Returns a snapshot_id to poll with web_scraper_get_results. " +
      "Requires a dataset_id (gd_...) - either passed here or via BRIGHTDATA_DATASET_ID.",
    inputSchema: {
      urls: z.array(z.string().url()).min(1).describe("Target URLs to collect."),
      dataset_id: z
        .string()
        .optional()
        .describe("Dataset id (gd_...). Defaults to BRIGHTDATA_DATASET_ID."),
      include_errors: z.boolean().default(true),
      custom_output_fields: z
        .string()
        .optional()
        .describe("Pipe-separated output fields, e.g. 'url|markdown'."),
      extra_inputs: z
        .array(z.record(z.any()))
        .optional()
        .describe("Advanced: full input objects instead of plain URLs (overrides 'urls')."),
    },
  },
  async (args) => {
    try {
      const datasetId = args.dataset_id ?? cfg.defaultDatasetId;
      if (!datasetId) {
        return fail(
          new Error(
            "No dataset_id provided and BRIGHTDATA_DATASET_ID is not set. " +
              "Find dataset ids at https://brightdata.com/cp/datasets."
          )
        );
      }
      const inputs =
        args.extra_inputs && args.extra_inputs.length > 0
          ? args.extra_inputs
          : args.urls.map((u) => ({ url: u }));
      const res = await client.triggerDataset({
        datasetId,
        inputs,
        includeErrors: args.include_errors,
        customOutputFields: args.custom_output_fields,
      });
      return text(JSON.stringify(res, null, 2));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "web_scraper_get_results",
  {
    title: "Get Crawl / Web Scraper results",
    description:
      "Check progress and, when ready, download the data for a snapshot_id returned " +
      "by web_scraper_trigger. If the job is still running, returns its status.",
    inputSchema: {
      snapshot_id: z.string(),
      format: z.enum(["json", "ndjson", "jsonl", "csv"]).default("json"),
    },
  },
  async (args) => {
    try {
      const progress = await client.datasetProgress(args.snapshot_id);
      if (progress.status && progress.status !== "ready") {
        return text(JSON.stringify({ status: progress.status, progress }, null, 2));
      }
      const snap = await client.datasetSnapshot(args.snapshot_id, args.format);
      if (snap.text === "__PENDING__") {
        return text(JSON.stringify({ status: "pending", snapshot_id: args.snapshot_id }));
      }
      return text(truncate(snap.text));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 6. Browser API (cloud browser + CAPTCHA solving)
// ---------------------------------------------------------------------------

server.registerTool(
  "browser_scrape",
  {
    title: "Cloud browser automation (Browser API)",
    description:
      "Drive a real, remote cloud browser (Puppeteer over CDP) for JavaScript-heavy " +
      "sites and multi-step flows. Supports automatic CAPTCHA solving, ad blocking, " +
      "device emulation, sticky sessions, clicks/typing/scrolling, and returns " +
      "rendered HTML, inner text, and/or a full-page screenshot. No local browser is " +
      "required - everything runs on Bright Data's infrastructure. Requires " +
      "BRIGHTDATA_BROWSER_AUTH to be set.",
    inputSchema: {
      url: z.string().url().describe("Initial URL to open."),
      actions: z
        .array(
          z.object({
            type: z.enum([
              "goto",
              "wait_for_selector",
              "wait",
              "click",
              "type",
              "scroll",
              "evaluate",
              "solve_captcha",
            ]),
            url: z.string().url().optional(),
            selector: z.string().optional(),
            text: z.string().optional(),
            timeout: z.number().int().optional(),
            expression: z.string().optional(),
          })
        )
        .optional()
        .describe("Ordered interactions performed after the initial navigation."),
      solve_captcha: z.boolean().default(true).describe("Auto-solve CAPTCHAs after navigation."),
      captcha_timeout: z.number().int().default(30000).describe("Captcha.solve detect timeout (ms)."),
      block_ads: z.boolean().default(false),
      session_id: z.string().optional().describe("Sticky proxy session id to reuse an IP."),
      device: z.string().optional().describe('Device to emulate, e.g. "iPhone 15 Pro".'),
      screenshot: z.boolean().default(false).describe("Return a full-page PNG screenshot."),
      return_html: z.boolean().default(true),
      return_text: z.boolean().default(false),
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
        .default("load"),
      nav_timeout: z.number().int().default(120000),
    },
  },
  async (args) => {
    try {
      if (!cfg.browserAuth) {
        return fail(
          new Error(
            "BRIGHTDATA_BROWSER_AUTH is not set. Add your Browser API zone credentials " +
              "('USER:PASS' from the zone Overview tab) to use browser_scrape."
          )
        );
      }
      const result = await runBrowserTask({
        auth: cfg.browserAuth,
        host: cfg.browserHost,
        url: args.url,
        actions: args.actions as BrowserAction[] | undefined,
        solveCaptcha: args.solve_captcha,
        captchaTimeout: args.captcha_timeout,
        blockAds: args.block_ads,
        sessionId: args.session_id,
        device: args.device,
        screenshot: args.screenshot,
        returnHtml: args.return_html,
        returnText: args.return_text,
        waitUntil: args.wait_until,
        navTimeout: args.nav_timeout,
      });

      const blocks: ContentBlock[] = [];
      const summary = {
        finalUrl: result.finalUrl,
        title: result.title,
        captchaStatus: result.captchaStatus,
        sessionId: result.sessionId,
        evaluations: result.evaluations,
        log: result.log,
      };
      blocks.push({ type: "text", text: JSON.stringify(summary, null, 2) });
      if (result.text) blocks.push({ type: "text", text: truncate(result.text) });
      if (result.html) blocks.push({ type: "text", text: truncate(result.html) });
      if (result.screenshotBase64) {
        blocks.push({
          type: "image",
          data: result.screenshotBase64,
          mimeType: "image/png",
        });
      }
      return ok(blocks);
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------------------------------------------------------------------------
// 7. Structured web_data_* tools (35 vertical dataset scrapers)
// ---------------------------------------------------------------------------

registerWebDataTools(server, client, cfg);

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[brightdata-mcp] v${VERSION} ready — ` +
      `bright_data=${cfg.apiKey ? `configured (unlocker="${cfg.unlockerZone}", serp="${cfg.serpZone}")` : "NOT configured (free-tier tools only)"}, ` +
      `browser=${cfg.browserAuth ? "configured" : "not configured"}.`
  );
}

main().catch((e) => {
  console.error("[brightdata-mcp] fatal:", e);
  process.exit(1);
});
