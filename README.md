# Scout MCP

**Free-first web access for AI agents. Bright Data only when a site actually blocks you.**

Scout is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives your AI agent a full browser and scraping toolkit. Most pages are fetched for free with a plain HTTP request. The paid [Bright Data](https://brightdata.com) tier only kicks in when an anti-bot wall (Cloudflare, Akamai, CAPTCHA, etc.) is detected — which means most research workflows cost nothing.

**No API key required to get started.** Free tools work out of the box. Configure Bright Data only when you need it.

---

## How routing works

Every fetch follows a cost ladder and stops at the first rung that works:

```
1. Free direct fetch  →  realistic browser headers, no cost
2. Bright Data        →  paid proxy + unlocker, only on detected block
```

An in-memory **skip-list** (persisted to disk) remembers which domains blocked the free tier so repeat calls go straight to Bright Data — no wasted attempt. Skip-list entries expire after 30 minutes so the server re-probes in case a site drops its protection.

---

## Tools

### Smart (cost-aware) tools

| Tool | Description |
|------|-------------|
| `smart_scrape` | **Start here.** Free-first fetch with automatic Bright Data fallback. Supports `content_only` format (main article text, strips ads/nav), disk caching, robots.txt checking, per-domain rate limiting, and PDF auto-escalation. |
| `smart_scrape_batch` | Fetch up to 50 URLs in parallel with the same free-first routing. Returns a cost summary. Much faster than looping `smart_scrape`. |
| `smart_crawl` | Start at a URL and follow links up to a configurable depth and page limit. Stays on the same host by default; accepts a URL regex filter. |
| `smart_diff` | Fetch a page and compare it to the last cached version. Stores a baseline on first call; detects changes on every subsequent call. |
| `smart_extract` | Extract structured metadata from a page: JSON-LD schema.org objects, Open Graph tags, Twitter card meta, and standard meta tags. Returns clean JSON. |
| `parse_feed` | Fetch and parse an RSS 2.0 feed, Atom 1.0 feed, or XML sitemap. Returns structured JSON — no HTML parsing needed. |
| `check_robots` | Check whether a URL is permitted by the site's `robots.txt`. Result is cached for 24 hours. |
| `smart_scrape_skiplist` | Dump the current skip-list of hard-blocked domains for cost debugging. |
| `serp_search` | Web search. DuckDuckGo queries try a free direct fetch first. Google, Bing, and Yandex always use the paid Bright Data SERP API. |

### Bright Data tools (always paid)

| Tool | Description |
|------|-------------|
| `unlocker_scrape` | Force a fetch through Bright Data's Web Unlocker. Use when you specifically need a screenshot, or when `smart_scrape` has already confirmed a site is hard-blocked. |
| `unlocker_scrape_async` | Start a long-running unlock job. Returns a `response_id`. |
| `unlocker_get_async_result` | Poll for and retrieve the result of an async unlock job. |
| `unlocker_success_rate` | Per-domain success-rate statistics from the last 7 days. |
| `web_scraper_trigger` | Trigger a Bright Data dataset / Web Scraper crawl job over one or more URLs. |
| `web_scraper_get_results` | Check progress and download results for a crawl job by `snapshot_id`. |
| `browser_scrape` | Drive a real remote cloud browser: navigate, click, type, scroll, run JS, auto-solve CAPTCHAs, emulate devices, block ads, return rendered HTML / text / screenshot. Requires `BRIGHTDATA_BROWSER_AUTH`. |
| `web_data_*` (35 tools) | Pre-built structured scrapers for Amazon, LinkedIn, Google Maps, Instagram, Reddit, and more. Returns clean JSON — no setup. |

---

## Quickstart

```bash
git clone https://github.com/AndrewEstopinan/browser-mcp
cd browser-mcp
npm install && npm run build
node dist/index.js   # works immediately — no API key needed for free tools
```

To unlock paid tools, set `BRIGHTDATA_API_KEY`:

```bash
node --env-file=.env dist/index.js
```

---

## Configuration

Copy `.env.example` to `.env` and fill in what you need.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BRIGHTDATA_API_KEY` | No | — | Enables paid tools. Free tools work without it. |
| `BRIGHTDATA_UNLOCKER_ZONE` | No | `web_unlocker1` | Web Unlocker zone name. |
| `BRIGHTDATA_SERP_ZONE` | No | `serp_api1` | SERP API zone name. |
| `BRIGHTDATA_BROWSER_AUTH` | For `browser_scrape` | — | `USER:PASS` from the Browser API zone. |
| `BRIGHTDATA_BROWSER_HOST` | No | `brd.superproxy.io:9222` | CDP host. |
| `BRIGHTDATA_DATASET_ID` | For crawl tools | — | Default dataset id (`gd_...`). |
| `BRIGHTDATA_API_BASE_URL` | No | `https://api.brightdata.com` | Override API base. |
| `SMART_SKIP_THRESHOLD` | No | `1` | Blocks before a domain is skip-listed. |
| `SMART_SKIP_TTL_MS` | No | `1800000` | Skip-list entry lifetime in ms (30 min). |
| `SMART_SKIP_FILE` | No | `./smart_skip_list.json` | Persisted skip-list path. |
| `SMART_CACHE_DIR` | No | `./smart_cache` | Response cache directory. |
| `SMART_CACHE_TTL_MS` | No | `3600000` | Default cache TTL in ms (1 hour). |

---

## Add to your MCP client

Add this to your Claude Desktop, Cursor, or other MCP client config:

```json
{
  "mcpServers": {
    "scout": {
      "command": "node",
      "args": ["/absolute/path/to/browser-mcp/dist/index.js"],
      "env": {
        "BRIGHTDATA_API_KEY": "your_api_key_here",
        "BRIGHTDATA_UNLOCKER_ZONE": "web_unlocker1",
        "BRIGHTDATA_SERP_ZONE": "serp_api1",
        "BRIGHTDATA_BROWSER_AUTH": "brd-customer-XXXX-zone-YYYY:zzzz"
      }
    }
  }
}
```

For free-only use, omit the `env` block entirely.

---

## Example calls

**Fetch an article (content only, no nav/ads):**
```json
{ "tool": "smart_scrape", "arguments": { "url": "https://example.com/article", "data_format": "content_only" } }
```

**Fetch 10 URLs in parallel:**
```json
{ "tool": "smart_scrape_batch", "arguments": { "urls": ["https://a.com", "https://b.com"], "concurrency": 5 } }
```

**Crawl a docs site up to 20 pages:**
```json
{ "tool": "smart_crawl", "arguments": { "start_url": "https://docs.example.com", "max_pages": 20, "max_depth": 3 } }
```

**Check if a page changed since last time:**
```json
{ "tool": "smart_diff", "arguments": { "url": "https://example.com/pricing" } }
```

**Extract JSON-LD and Open Graph metadata:**
```json
{ "tool": "smart_extract", "arguments": { "url": "https://example.com/product/123" } }
```

**Parse an RSS feed:**
```json
{ "tool": "parse_feed", "arguments": { "url": "https://example.com/feed.xml" } }
```

**Drive a cloud browser through a CAPTCHA:**
```json
{
  "tool": "browser_scrape",
  "arguments": {
    "url": "https://hard-site.example",
    "solve_captcha": true,
    "screenshot": true,
    "actions": [
      { "type": "wait_for_selector", "selector": "#results" },
      { "type": "click", "selector": "button.load-more" }
    ]
  }
}
```

---

## Responsible use

Scout accesses public web data through a paid, compliant commercial service. Respect each target site's Terms of Service and `robots.txt` (use the built-in `check_robots` tool), applicable laws, and Bright Data's [Acceptable Use Policy](https://brightdata.com/acceptable-use-policy). Don't use it to access content behind logins you aren't authorized to use, or to collect personal data without a lawful basis.

---

## License

MIT
