# Bright Data MCP Server — Guide for the Connected AI Agent

> **Read this first.** You (the AI) have access to a set of tools provided by the
> "brightdata" MCP server. These tools let you **read and extract data from any
> public website**, even sites that block bots, require JavaScript, or show
> CAPTCHAs. This document explains exactly what each tool does, when to choose
> one over another, what arguments to pass, what you get back, and how to recover
> from errors. Follow it and you will use the tools correctly and economically.

---

## 1. Mental model

Every tool is a request to **Bright Data**, a commercial web-access service that
sits between you and the open web. Bright Data handles proxy rotation, browser
fingerprinting, retries, and CAPTCHA solving on its own servers. You do **not**
control a browser on the local machine — you ask Bright Data to fetch or drive a
page for you and it returns the result.

There are three "shapes" of work, and a tool family for each:

| You need to… | Use | Cost/Latency |
| --- | --- | --- |
| Read the content of a specific URL | `unlocker_scrape` (HTTP fetch) | Cheapest, fastest |
| Get search-engine results for a query | `serp_search` | Cheap, fast |
| Interact with a page (click, type, scroll, login, solve a visible CAPTCHA, run JS) | `browser_scrape` (cloud browser) | Most expensive, slowest |
| Collect many pages / a whole structured dataset | `web_scraper_trigger` + `web_scraper_get_results` | Async, billed per record |

**Default rule:** Reach for `unlocker_scrape` first. Only escalate to
`browser_scrape` when the content genuinely requires interaction or client-side
rendering that a single fetch can't produce.

---

## 2. Tool reference

### 2.1 `unlocker_scrape` — fetch one URL

Fetch a single public URL through the Web Unlocker. Bright Data unblocks the site
automatically (proxies, fingerprints, and CAPTCHA solving are on by default).

**Arguments**

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `url` | string (URL) | — | **Required.** Must include `https://`. |
| `data_format` | `"html"` \| `"markdown"` \| `"screenshot"` | `"markdown"` | Prefer `markdown` when you intend to *read* the content yourself — it is far smaller and cleaner than HTML. Use `html` when you need raw markup/attributes. Use `screenshot` to *see* the page as a PNG. |
| `country` | 2-letter code | — | Exit-IP country, e.g. `us`, `gb`, `de`. Set this when the page is geo-specific (prices, availability, language). |
| `method` | string | `"GET"` | Rarely change. |
| `wait_for_selector` | string | — | CSS selector that must appear before the page is returned. Use for slow/partial pages. |
| `wait_for_text` | string | — | Text that must appear before returning. |
| `headers` | object | — | Custom request headers. Only works if the zone has the "Custom Headers" feature enabled; otherwise omit. |
| `zone` | string | env default | Override the Unlocker zone name. Leave unset normally. |

**Returns:** the page body as text (markdown/html), or an image block (screenshot).

**When to use:** articles, product pages, docs, JSON endpoints, any "give me the
content at this URL" task.

**When NOT to use:** if you must click through a flow, log in, paginate via
buttons, or the data only appears after user interaction → use `browser_scrape`.

---

### 2.2 `serp_search` — search engines

Run a query on a search engine and get **structured, parsed results** (organic
links, ads, knowledge panels, etc.) instead of raw HTML.

**Arguments**

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `query` | string | — | **Required.** The search terms. |
| `engine` | `google` \| `bing` \| `yandex` \| `duckduckgo` | `google` | |
| `page` | int ≥ 1 | `1` | Results page (1-based). |
| `num` | int 1–100 | — | Results per page (Google). |
| `language` | string | — | UI language (Google `hl`), e.g. `en`. |
| `gl` | string | — | Country of results (Google `gl`), e.g. `us`. |
| `country` | 2-letter | — | Exit-IP country. |
| `mobile` | bool | `false` | Mobile results. |
| `search_type` | `web` \| `images` \| `news` \| `shopping` \| `videos` \| `jobs` | `web` | Google verticals. |
| `parse` | bool | `true` | `true` → parsed JSON (recommended). `false` → raw HTML. |

**Returns:** JSON (when `parse: true`) with keys like `organic`, `pagination`,
`knowledge`, `people_also_ask`, etc. Parse the `organic` array for ranked results
(`title`, `link`, `description`, `rank`).

**Use this instead of** scraping `google.com/search` yourself with `unlocker_scrape`
— `serp_search` returns clean structured data and is purpose-built for it.

---

### 2.3 `unlocker_scrape_async` + `unlocker_get_async_result` — slow pages

For pages that take a long time, start the job asynchronously and poll for it.

1. Call `unlocker_scrape_async` with `{ url, data_format, country }`.
   → returns `{ "response_id": "...", "status": "accepted" }`.
2. Call `unlocker_get_async_result` with `{ response_id }`.
   → if `{ "status": "pending" }`, wait briefly and call again.
   → otherwise you get the page body (or image).

**Polling discipline:** wait a few seconds between polls; do not poll in a tight
loop. Give up after a reasonable number of attempts (e.g. ~10) and report that the
job did not complete.

**Most of the time you do NOT need this** — plain `unlocker_scrape` is synchronous
and simpler. Use async only for known-slow targets or when a sync call times out.

---

### 2.4 `unlocker_success_rate` — diagnostics

Get Bright Data's own success-rate statistics (last 7 days) for a domain. Pass
`example.com` for one domain or `example.*` for all TLDs.

Use this when a site keeps failing and you want to know whether it's generally
hard to unblock (low rate) versus a transient issue.

---

### 2.5 `browser_scrape` — cloud browser automation

Drive a **real browser running in Bright Data's cloud** over CDP. Use it only when
a single fetch isn't enough: JavaScript-rendered content, multi-step flows,
clicking/typing/scrolling, login walls, infinite scroll, or visibly solving a
CAPTCHA mid-flow.

**Arguments**

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `url` | string (URL) | — | **Required.** Page to open first. |
| `actions` | array | — | Ordered steps after the initial load (see below). |
| `solve_captcha` | bool | `true` | Auto-solve CAPTCHAs after navigation. Leave `true` unless you have a reason not to. |
| `captcha_timeout` | int (ms) | `30000` | How long the solver waits to detect a CAPTCHA. |
| `block_ads` | bool | `false` | Enable to save bandwidth on ad-heavy pages. |
| `session_id` | string | — | Reuse the same proxy IP across calls (sticky session) for multi-step flows that must look like one user. |
| `device` | string | — | Emulate a device, e.g. `"iPhone 15 Pro"`. |
| `screenshot` | bool | `false` | Return a full-page PNG. |
| `return_html` | bool | `true` | Return rendered HTML. |
| `return_text` | bool | `false` | Return `document.body.innerText` (cleaner for reading). |
| `wait_until` | `load` \| `domcontentloaded` \| `networkidle0` \| `networkidle2` | `load` | Navigation completion condition. Use `networkidle2` for SPA/JS-heavy sites. |
| `nav_timeout` | int (ms) | `120000` | Navigation timeout. |

**`actions` step types**

| `type` | Fields used | Effect |
| --- | --- | --- |
| `goto` | `url`, `timeout?` | Navigate to another URL. |
| `wait_for_selector` | `selector`, `timeout?` | Wait until an element exists. |
| `wait` | `timeout` | Sleep N ms. |
| `click` | `selector` | Click an element. |
| `type` | `selector`, `text` | Type text into a field. |
| `scroll` | — | Scroll to the bottom (triggers lazy-loading). |
| `solve_captcha` | `timeout?` | Explicitly run the CAPTCHA solver now. |
| `evaluate` | `expression` | Run a JS expression in page context; its return value is collected into `evaluations`. |

**Returns:** a JSON summary block (`finalUrl`, `title`, `captchaStatus`,
`sessionId`, `evaluations`, `log`), optionally followed by text/HTML and/or an
image block.

**Cost note:** this is the heaviest tool. Prefer `unlocker_scrape` for plain reads.
Use `return_text: true` (not full HTML) when you only need to read content, to keep
responses small.

---

### 2.6 `web_scraper_trigger` + `web_scraper_get_results` — bulk/structured collection

For collecting many URLs or a structured dataset (e.g. all fields of many product
pages) using a Bright Data **dataset** (`gd_...`).

1. `web_scraper_trigger` with `{ urls: [...], dataset_id?, include_errors?, custom_output_fields? }`
   → returns `{ "snapshot_id": "s_..." }`.
   - `dataset_id` defaults to the server's `BRIGHTDATA_DATASET_ID` if configured.
   - `custom_output_fields` can be a pipe-separated list like `"url|markdown"`.
   - For full control, pass `extra_inputs` (array of complete input objects) instead of `urls`.
2. `web_scraper_get_results` with `{ snapshot_id, format? }`
   → if `{ "status": "running" | "pending" }`, wait and poll again.
   → when ready, returns the dataset rows (JSON by default).

This flow is **always asynchronous**. Trigger once, then poll with backoff.

---

## 3. Choosing the right tool (decision guide)

```
Is it a search query (you have keywords, want ranked results)?
  → serp_search

Do you have a specific URL and just need its content?
  → unlocker_scrape  (data_format: "markdown" to read, "html" for markup,
                      "screenshot" to see it)
      ↳ Page is slow / times out?           → unlocker_scrape_async + poll
      ↳ Site keeps failing?                 → check unlocker_success_rate

Do you need to interact (click / type / scroll / login / solve a visible CAPTCHA),
or is the content only present after JS runs?
  → browser_scrape  (add `actions`; set wait_until:"networkidle2" for SPAs)

Do you need many pages or a full structured dataset?
  → web_scraper_trigger → web_scraper_get_results (poll)
```

---

## 4. Output handling

- **Text tools** (`unlocker_scrape` html/markdown, `serp_search`, async results,
  dataset results) return text content blocks. Large bodies are truncated at
  ~200k characters with a marker — if you hit truncation and need more, narrow
  the target (a more specific URL/selector) rather than re-fetching repeatedly.
- **Screenshots** return an `image` content block (PNG, base64). Use these to
  *look* at a page, not to extract text — prefer markdown/text for extraction.
- **`serp_search` JSON**: read `organic[]` for results; `pagination` for next pages;
  `knowledge` / `people_also_ask` for rich panels.

---

## 5. Error handling

Tool errors come back as a text block beginning with `Error:` and `isError: true`.
Common Bright Data status codes and what to do:

| Status | Meaning | Your move |
| --- | --- | --- |
| `400` / `401` | Bad request, often missing zone/headers | Check arguments; don't send custom `headers` unless needed. |
| `403` | Forbidden for that URL | The target blocks access; try a different `country`, or `browser_scrape`. |
| `407` | Auth/credentials problem | Configuration issue — report to the user; you can't fix it from arguments. |
| `429` | Auto-throttled (low success rate) | Back off; retry later or fewer times. Don't hammer. |
| `502` / `503` | Unblock/browser check failed | Retry once or twice; consider `browser_scrape` or a different `country`. |
| `404` | Page not found | The URL is wrong/dead. Don't retry blindly. |

**General retry policy:** at most 1–2 retries with a short delay. If a target
consistently fails, say so and suggest an alternative (different tool, country, or
URL) rather than looping.

---

## 6. Best practices (important)

1. **Escalate, don't default.** `unlocker_scrape` → `browser_scrape` only when
   needed. The browser tool is slower and costs more.
2. **Read in markdown/text, not HTML.** Choose `data_format:"markdown"` or
   `return_text:true` whenever you intend to read content yourself. Reserve HTML for
   when you specifically need tags/attributes.
3. **Set `country` for geo-sensitive data** (pricing, availability, localized
   content). Otherwise leave it unset and let Bright Data pick.
4. **CAPTCHAs are handled for you.** Both Unlocker and Browser API solve CAPTCHAs
   automatically. You normally don't do anything; in a browser flow you can add a
   `solve_captcha` action or rely on the default post-navigation solve.
5. **Poll politely.** For async/dataset jobs, wait a few seconds between polls and
   cap your attempts. Never tight-loop.
6. **One question per fetch.** Fetch the most specific URL that answers the task;
   don't crawl broadly when a single page will do.
7. **Respect scope.** These tools are for **public** data. Do not use them to access
   content behind authentication you're not authorized for, to collect personal data
   without a lawful basis, or in violation of a site's Terms of Service. If a task
   asks for that, decline and explain.
8. **Report config gaps.** If a tool returns a configuration error (e.g. Browser API
   not configured, missing dataset id), tell the user what env var to set rather than
   retrying.

---

## 7. Worked examples

**Read an article as markdown**
```json
{ "tool": "unlocker_scrape",
  "arguments": { "url": "https://example.com/blog/post", "data_format": "markdown" } }
```

**Get US Google results for a query**
```json
{ "tool": "serp_search",
  "arguments": { "query": "best noise cancelling headphones 2026",
                 "engine": "google", "gl": "us", "num": 20 } }
```

**Log in and scrape a dashboard (browser flow)**
```json
{ "tool": "browser_scrape",
  "arguments": {
    "url": "https://app.example.com/login",
    "wait_until": "networkidle2",
    "session_id": "run-42",
    "return_text": true,
    "actions": [
      { "type": "type", "selector": "#email", "text": "USER@EXAMPLE.COM" },
      { "type": "type", "selector": "#password", "text": "********" },
      { "type": "click", "selector": "button[type=submit]" },
      { "type": "wait_for_selector", "selector": ".dashboard" }
    ]
  } }
```

**Screenshot a JS-heavy landing page**
```json
{ "tool": "unlocker_scrape",
  "arguments": { "url": "https://example.com", "data_format": "screenshot" } }
```

**Collect many product pages as a dataset**
```json
// 1) trigger
{ "tool": "web_scraper_trigger",
  "arguments": { "urls": ["https://shop.example.com/p/1","https://shop.example.com/p/2"],
                 "custom_output_fields": "url|markdown" } }
// 2) poll until ready
{ "tool": "web_scraper_get_results",
  "arguments": { "snapshot_id": "s_xxxxx", "format": "json" } }
```

---

## 8. Quick reference

| Tool | Sync/Async | Returns | Primary use |
| --- | --- | --- | --- |
| `unlocker_scrape` | sync | text or image | Fetch one URL |
| `unlocker_scrape_async` | async (start) | response_id | Slow page, start job |
| `unlocker_get_async_result` | async (poll) | text or image | Fetch async result |
| `unlocker_success_rate` | sync | JSON | Domain diagnostics |
| `serp_search` | sync | JSON | Search engines |
| `web_scraper_trigger` | async (start) | snapshot_id | Bulk/dataset collection |
| `web_scraper_get_results` | async (poll) | JSON rows | Dataset results |
| `browser_scrape` | sync (long) | JSON + text/html + image | Interactive / JS pages |
