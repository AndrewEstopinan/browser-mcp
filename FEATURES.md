# browser-mcp Features

## How routing works

Every tool that fetches content follows the same cost ladder:

1. **Free direct fetch** — plain `fetch` with realistic browser headers. Costs nothing.
2. **Bright Data Web Unlocker** — paid proxy tier, triggered only when the free fetch hits an anti-bot wall (Cloudflare, Akamai, Imperva, PerimeterX, DataDome, CAPTCHA, 403/429/503).

An in-memory **skip-list** (persisted to `smart_skip_list.json`) remembers which domains blocked the free tier so repeat calls skip the wasted attempt and go straight to Bright Data. Entries expire after 30 minutes (configurable) so the server re-probes in case a site drops its protection.

`BRIGHTDATA_API_KEY` is **optional** — the server starts and all free-tier tools work without it. Paid tools return a clear error asking you to configure the key.

---

## Tools

### `smart_scrape`
The primary fetch tool. Tries a free direct request first; escalates to Bright Data only if blocked.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `url` | required | Full URL including `https://` |
| `data_format` | `markdown` | `html`, `markdown`, or `content_only` (main article text only, strips nav/ads) |
| `force_bright_data` | `false` | Skip the free attempt and go straight to paid |
| `free_only` | `false` | Never spend credit; return best-effort free result even if blocked |
| `ignore_skip_list` | `false` | Always try free tier first regardless of skip-list |
| `direct_timeout_ms` | `12000` | Abort the free fetch after this many ms |
| `min_body_bytes` | `0` | Treat a 2xx response smaller than this as a block (0 = off) |
| `rate_limit_ms` | `0` | Minimum ms between free-tier requests to the same domain |
| `use_cache` | `false` | Return a cached response if available and not expired |
| `cache_ttl_ms` | `3600000` | Cache TTL in ms (1 hour default) |
| `respect_robots` | `false` | Check `robots.txt` before fetching; returns an error if disallowed |
| `country` | — | 2-letter exit-IP country (Bright Data tier only) |
| `headers` | — | Custom request headers |
| `wait_for_selector` | — | CSS selector to wait for (Bright Data tier only) |
| `wait_for_text` | — | Text to wait for (Bright Data tier only) |

**`content_only` format:** strips `<nav>`, `<footer>`, `<header>`, `<aside>`, `<script>`, `<style>`, ads, and sidebars. Finds `<main>`, `<article>`, or `[role="main"]` and returns just that content as Markdown. Saves significant context tokens on article/documentation pages.

**PDF auto-escalation:** if the free fetch returns `Content-Type: application/pdf`, the server automatically escalates to Bright Data for proper extraction without marking the domain as hard-blocked.

---

### `smart_scrape_batch`
Fetch multiple URLs concurrently using the same free-first routing. Returns an array of `{url, success, text, tier, paid}` objects plus a cost summary. Much faster than calling `smart_scrape` in a loop.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `urls` | required | Array of URLs (max 50) |
| `concurrency` | `5` | Max parallel fetches |
| `data_format` | `markdown` | `html`, `markdown`, or `content_only` |
| `force_bright_data` | `false` | |
| `free_only` | `false` | |
| `rate_limit_ms` | `0` | |

---

### `smart_crawl`
Start at a URL, follow links breadth-first up to a depth and page limit, return content from each page. Stays on the same hostname by default.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `start_url` | required | Starting URL |
| `max_pages` | `10` | Maximum pages to fetch (cap 50) |
| `max_depth` | `2` | Maximum link depth from start (cap 5) |
| `url_filter` | — | Regex — only follow links that match |
| `same_host_only` | `true` | Restrict crawl to the starting hostname |
| `data_format` | `markdown` | `html` or `markdown` |
| `rate_limit_ms` | `500` | Default 500ms between requests (polite crawling) |
| `force_bright_data` | `false` | |
| `free_only` | `false` | |

Returns `{pages_fetched, paid, free}` summary plus per-page `{url, depth, tier, paid, links_found, text}`.

---

### `smart_diff`
Fetch a URL and compare it to the previously cached version. Returns whether the page changed, when it was last seen, and both versions side-by-side. First call stores a baseline; subsequent calls detect changes. Useful for monitoring pricing pages, documentation, or competitor content.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `url` | required | |
| `data_format` | `markdown` | `html`, `markdown`, or `content_only` |
| `force_bright_data` | `false` | |
| `free_only` | `false` | |

Returns `{changed, previous_fetched_at, tier, paid}` plus previous and current content when changed.

---

### `smart_extract`
Fetch a page and extract all structured metadata: JSON-LD schema.org objects, Open Graph tags, Twitter card meta, standard `<meta>` tags, and the page title. Returns clean JSON. Useful for product data, article metadata, or any schema.org markup without parsing HTML yourself.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `url` | required | |
| `force_bright_data` | `false` | |
| `free_only` | `false` | |
| `use_cache` | `true` | Use cached HTML if available |

Returns `{meta: {...}, json_ld: [...]}`.

---

### `parse_feed`
Fetch and parse an RSS 2.0 feed, Atom 1.0 feed, or XML sitemap. Auto-detects the format from content. Returns structured JSON — no HTML parsing needed.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `url` | required | URL of the feed or sitemap |
| `free_only` | `true` | Feeds are almost never behind anti-bot walls |

- **RSS/Atom**: returns `{type, title, items: [{title, link, description, pubDate}]}`
- **Sitemap**: returns `{type: "sitemap", entries: [{loc, lastmod, priority}]}`

---

### `check_robots`
Fetch and parse a site's `robots.txt`, then check whether a specific URL path is permitted for the wildcard `*` user-agent. `robots.txt` is cached for 24 hours. Longest-match rule wins (standard spec).

| Parameter | Default | Description |
|-----------|---------|-------------|
| `url` | required | The URL you want to check (not the robots.txt URL) |

Returns `{url, path, allowed, matched_rule}`.

---

### `smart_scrape_skiplist`
Dump the current in-memory skip-list of domains being routed straight to Bright Data. Useful for debugging cost spikes or understanding which sites are consistently hard-blocked.

---

### `serp_search`
Run a web search. DuckDuckGo queries try a free direct fetch of `lite.duckduckgo.com` first; escalates to Bright Data SERP only if blocked. Google, Bing, and Yandex always use the paid SERP API.

| Engine | Free tier |
|--------|-----------|
| `duckduckgo` | Yes (with `parse=false`) |
| `google` | No |
| `bing` | No |
| `yandex` | No |

---

### `unlocker_scrape`
Always uses paid Bright Data credit. Prefer `smart_scrape` for read-only fetches. Use `unlocker_scrape` directly only when you need screenshot output or want to force Bright Data unconditionally. Also supports async mode via `unlocker_scrape_async` + `unlocker_get_async_result`.

---

### `browser_scrape`
Drive a real remote cloud browser (Puppeteer over CDP) for JavaScript-heavy sites and multi-step flows. Supports CAPTCHA solving, clicks, scrolling, typing, screenshots, and sticky sessions. Always requires `BRIGHTDATA_BROWSER_AUTH`.

---

### `web_data_*` (35 tools)
Pre-built structured scrapers for specific verticals: Amazon products, LinkedIn profiles, Google Maps, Instagram, Reddit, and more. Returns clean structured JSON without any scraping setup.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIGHTDATA_API_KEY` | — | Paid Bright Data API token. Optional — free tools work without it. |
| `BRIGHTDATA_UNLOCKER_ZONE` | `web_unlocker1` | Web Unlocker zone name |
| `BRIGHTDATA_SERP_ZONE` | `serp_api1` | SERP API zone name |
| `BRIGHTDATA_BROWSER_AUTH` | — | Browser API zone credentials (`USER:PASS`) |
| `BRIGHTDATA_BROWSER_HOST` | `brd.superproxy.io:9222` | CDP host |
| `BRIGHTDATA_DATASET_ID` | — | Default dataset id for web scraper tools |
| `SMART_SKIP_THRESHOLD` | `1` | Consecutive free-tier blocks before a domain is skip-listed |
| `SMART_SKIP_TTL_MS` | `1800000` | How long (ms) a skip-list entry stays hot (30 min) |
| `SMART_SKIP_FILE` | `./smart_skip_list.json` | Path to the persisted skip-list |
| `SMART_CACHE_DIR` | `./smart_cache` | Directory for response cache files |
| `SMART_CACHE_TTL_MS` | `3600000` | Default cache TTL (1 hour) |
