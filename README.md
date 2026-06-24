# Bright Data MCP Server

A full-featured [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that lets an AI agent **browse and extract data from any public website**
through [Bright Data's Web Access APIs](https://docs.brightdata.com/scraping-automation/introduction).

All heavy lifting — proxy rotation, browser fingerprinting, CAPTCHA solving, and
JavaScript rendering — happens **on Bright Data's cloud infrastructure**, so this
server runs fine on machines that can't (or shouldn't) run a browser locally. The
Browser API tool uses `puppeteer-core`, which speaks CDP to a remote browser and
**never downloads or launches Chromium on your machine**.

## Tools

| Tool | What it does |
| --- | --- |
| `unlocker_scrape` | Fetch any URL as HTML, clean Markdown, or a PNG screenshot. Auto-handles blocking & CAPTCHAs. |
| `unlocker_scrape_async` | Start a long-running unlock job; returns a `response_id`. |
| `unlocker_get_async_result` | Poll/fetch the result of an async unlock job. |
| `unlocker_success_rate` | Per-domain success-rate stats (last 7 days). |
| `serp_search` | Structured search results from Google / Bing / Yandex / DuckDuckGo. |
| `web_scraper_trigger` | Trigger a Crawl / Web Scraper dataset job over one or more URLs. |
| `web_scraper_get_results` | Check progress and download dataset results by `snapshot_id`. |
| `browser_scrape` | Drive a real cloud browser: navigate, click, type, scroll, run JS, auto-solve CAPTCHAs, emulate devices, block ads, return rendered HTML / text / screenshot. |

## Prerequisites

1. A [Bright Data account](https://brightdata.com) and an **API token**
   (Account settings → API tokens, or <https://brightdata.com/cp/setting/users>).
2. One or more **zones** created under **Web Access APIs** in the control panel:
   - a **Web Unlocker** zone (for `unlocker_*` and `serp_search`)
   - a **SERP API** zone (for `serp_search`)
   - a **Browser API** zone (for `browser_scrape`) — copy its `USER:PASS` from the
     zone's *Overview* tab
   - a **Dataset id** (`gd_...`) from <https://brightdata.com/cp/datasets> for the
     Crawl / Web Scraper tools
3. Node.js **18 or newer**.

> Bright Data's free tier includes monthly credits; adding a payment method
> unlocks API access and grants a small verification credit. Usage of all of
> these APIs is billed by Bright Data per their pricing.

## Install & build

```bash
npm install
npm run build
```

## Configure

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `BRIGHTDATA_API_KEY` | yes | — | Bearer token for all REST calls. |
| `BRIGHTDATA_UNLOCKER_ZONE` | no | `web_unlocker1` | Web Unlocker zone name. |
| `BRIGHTDATA_SERP_ZONE` | no | `serp_api1` | SERP API zone name. |
| `BRIGHTDATA_BROWSER_AUTH` | for `browser_scrape` | — | `USER:PASS` of the Browser API zone. |
| `BRIGHTDATA_BROWSER_HOST` | no | `brd.superproxy.io:9222` | CDP host:port. |
| `BRIGHTDATA_DATASET_ID` | for crawl tools | — | Default dataset id (`gd_...`). |
| `BRIGHTDATA_API_BASE_URL` | no | `https://api.brightdata.com` | Override base URL. |

The server reads variables from the real process environment. If you keep them in
`.env`, load it before launching (e.g. `node --env-file=.env dist/index.js` on
Node 20+, or via your MCP client's `env` block below).

## Run

```bash
# Node 20+ can load the .env file directly:
node --env-file=.env dist/index.js

# or rely on environment variables already exported in your shell:
npm start
```

## Use it from an MCP client

Add this to your client's MCP config (Claude Desktop, Cursor, etc.). Pass secrets
through the `env` block rather than committing them:

```json
{
  "mcpServers": {
    "brightdata": {
      "command": "node",
      "args": ["/absolute/path/to/brightdata-mcp/dist/index.js"],
      "env": {
        "BRIGHTDATA_API_KEY": "your_api_key_here",
        "BRIGHTDATA_UNLOCKER_ZONE": "web_unlocker1",
        "BRIGHTDATA_SERP_ZONE": "serp_api1",
        "BRIGHTDATA_BROWSER_AUTH": "brd-customer-XXXX-zone-YYYY:zzzz",
        "BRIGHTDATA_DATASET_ID": "gd_xxxxxxxx"
      }
    }
  }
}
```

## Example tool calls

Fetch a page as Markdown:

```json
{ "tool": "unlocker_scrape", "arguments": { "url": "https://example.com", "data_format": "markdown" } }
```

Search Google:

```json
{ "tool": "serp_search", "arguments": { "query": "best laptops 2026", "engine": "google", "num": 20 } }
```

Drive a cloud browser through a CAPTCHA and screenshot it:

```json
{
  "tool": "browser_scrape",
  "arguments": {
    "url": "https://site-with-captcha.example",
    "solve_captcha": true,
    "screenshot": true,
    "actions": [
      { "type": "wait_for_selector", "selector": "#results" },
      { "type": "click", "selector": "button.load-more" },
      { "type": "scroll" }
    ]
  }
}
```

## How it maps to the Bright Data docs

- **Unlocker / SERP** → `POST https://api.brightdata.com/request`
  with `{ zone, url, format, method, country, data_format }`.
  Async adds `?async=true` and is retrieved via `GET /unblocker/get_result`.
- **Crawl / Web Scraper** → `POST /datasets/v3/trigger?dataset_id=...`,
  polled via `GET /datasets/v3/progress/{id}` and downloaded via
  `GET /datasets/v3/snapshot/{id}`.
- **Browser API** → `puppeteer.connect({ browserWSEndpoint: "wss://USER:PASS@brd.superproxy.io:9222" })`
  plus Bright Data's custom CDP commands: `Captcha.solve`, `Captcha.setAutoSolve`,
  `Unblocker.enableAdBlock`, `Proxy.useSession`, `Emulation.setDevice`,
  `Browser.getSessionId`.

## Responsible use

This server accesses **public** web data through a paid, compliant commercial
service. Respect each target site's Terms of Service and `robots.txt`, applicable
laws (e.g. data-protection rules), and Bright Data's
[Acceptable Use Policy](https://brightdata.com/acceptable-use-policy). Don't use it
to access content behind logins/authentication you aren't authorized to use, or to
collect personal data without a lawful basis.

## License

MIT
