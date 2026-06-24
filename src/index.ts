#!/usr/bin/env node
/**
 * Bright Data MCP Server
 * ----------------------
 * Exposes Bright Data's Web Access APIs as Model Context Protocol tools so an
 * AI agent can browse and extract data from any public website:
 *
 *   unlocker_scrape            - fetch any URL (html / markdown / screenshot)
 *   unlocker_scrape_async      - start a long-running unlock job
 *   unlocker_get_async_result  - poll an async unlock job
 *   unlocker_success_rate      - per-domain success-rate stats
 *   serp_search                - structured search results (Google/Bing/Yandex/DDG)
 *   web_scraper_trigger        - trigger a Crawl / Web Scraper dataset job
 *   web_scraper_get_results    - poll & download dataset results
 *   browser_scrape             - cloud browser automation w/ auto CAPTCHA solving
 *
 * Transport: stdio (the standard MCP transport for local servers).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { BrightDataClient, BrightDataApiError } from "./client.js";
import { buildSearchUrl } from "./serp.js";
import { runBrowserTask, type BrowserAction } from "./browser.js";

const VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let cfg;
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
// 1. Unlocker: fetch any URL
// ---------------------------------------------------------------------------

server.registerTool(
  "unlocker_scrape",
  {
    title: "Scrape any URL (Web Unlocker)",
    description:
      "Fetch any public web page through Bright Data's Web Unlocker, which " +
      "automatically rotates proxies, manages fingerprints, and solves CAPTCHAs. " +
      "Returns the page as raw HTML, clean Markdown (great for LLMs), or a PNG " +
      "screenshot. Use this for most read-only scraping; use browser_scrape only " +
      "when you need clicks/scrolling/JS interaction.",
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
    title: "Search engine results (SERP API)",
    description:
      "Run a search on Google, Bing, Yandex, or DuckDuckGo and get structured, " +
      "parsed JSON results (organic, ads, knowledge, etc.) via Bright Data's SERP API.",
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
// Connect
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[brightdata-mcp] v${VERSION} ready (unlocker zone="${cfg.unlockerZone}", ` +
      `serp zone="${cfg.serpZone}", browser=${cfg.browserAuth ? "configured" : "not configured"}).`
  );
}

main().catch((e) => {
  console.error("[brightdata-mcp] fatal:", e);
  process.exit(1);
});
