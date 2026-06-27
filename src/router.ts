/**
 * Cost-aware routing for the Bright Data MCP server.
 * -------------------------------------------------
 * Goal: spend as little Bright Data credit as possible.
 *
 * Strategy (auto-detect + in-memory hard-domain skip-list):
 *   Tier 0  - plain `fetch` with realistic browser headers   (FREE)
 *   Tier 1  - Bright Data Web Unlocker                        (PAID, only on block)
 *
 * Every request first tries a direct, free HTTP fetch. We inspect the status
 * code, headers and body for anti-bot signatures (Cloudflare, Akamai,
 * Imperva/Incapsula, PerimeterX, DataDome, CAPTCHAs, 403/429/503...). Only on
 * a detected block do we escalate to Bright Data and actually spend money.
 *
 * Skip-list: when a domain blocks the free tier, we remember it in-memory for a
 * while so subsequent calls skip the doomed free attempt and go straight to
 * Bright Data — saving the wasted latency. Entries expire (TTL) so we re-probe
 * periodically in case a site drops its protection. Nothing is persisted to
 * disk; the memory resets when the server restarts.
 *
 * Dependency-free (Node 18+ global fetch); slots in without touching
 * client.ts / browser.ts.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import type { BrightDataClient } from "./client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmartScrapeOptions {
  url: string;
  /** Desired output. Direct tier returns html or a best-effort markdown. */
  dataFormat?: "html" | "markdown";
  country?: string;
  method?: string;
  headers?: Record<string, string>;
  /** Wait conditions forwarded to Bright Data only (the free tier can't wait). */
  waitForSelector?: string;
  waitForText?: string;

  // Routing knobs ----------------------------------------------------------
  /** Skip the free attempt and go straight to Bright Data. */
  forceBrightData?: boolean;
  /** Never escalate; fail instead of spending credit. */
  freeOnly?: boolean;
  /** Ignore the skip-list and always attempt the free tier. */
  ignoreSkipList?: boolean;
  /** Abort the free fetch after this many ms (default 12000). */
  directTimeoutMs?: number;
  /** Treat any direct response under this many bytes as suspect (default 0 = off). */
  minBodyBytes?: number;
  /** Minimum ms between free-tier requests to the same domain (0 = off). */
  rateLimitMs?: number;

  // Dependencies -----------------------------------------------------------
  client: BrightDataClient;
  unlockerZone: string;
}

export interface SmartScrapeResult {
  /** Which tier ultimately produced the data. */
  tier: "direct" | "unlocker";
  /** Did this cost Bright Data credit? */
  paid: boolean;
  status?: number;
  finalUrl?: string;
  /** Why we escalated (null if the free tier succeeded). */
  blockReason: string | null;
  /** Did we skip the free tier because this domain is on the skip-list? */
  skippedFreeTier: boolean;
  dataFormat: "html" | "markdown";
  text?: string;
  /** Step-by-step trace so the agent/user can see the cost decision. */
  log: string[];
}

// ---------------------------------------------------------------------------
// In-memory hard-domain skip-list
// ---------------------------------------------------------------------------

interface SkipConfig {
  /** Consecutive free-tier blocks before a domain is skipped. Default 1. */
  threshold: number;
  /** How long a skip entry stays hot, in ms. Default 30 min. */
  ttlMs: number;
}

const SKIP_CONFIG: SkipConfig = {
  threshold: Number(process.env.SMART_SKIP_THRESHOLD ?? 1),
  ttlMs: Number(process.env.SMART_SKIP_TTL_MS ?? 30 * 60_000),
};

interface SkipEntry {
  failures: number;
  /** epoch ms of the most recent block. */
  lastFailed: number;
  lastReason: string;
}

const skipList = new Map<string, SkipEntry>();

// ---------------------------------------------------------------------------
// Skip-list persistence (survives server restarts)
// ---------------------------------------------------------------------------

const SKIP_FILE = process.env.SMART_SKIP_FILE ?? "./smart_skip_list.json";

function loadSkipList(): void {
  if (!existsSync(SKIP_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(SKIP_FILE, "utf8")) as Array<{ host: string } & SkipEntry>;
    const now = Date.now();
    for (const { host, ...entry } of data) {
      if (now - entry.lastFailed <= SKIP_CONFIG.ttlMs) {
        skipList.set(host, entry);
      }
    }
  } catch { /* ignore corrupt file */ }
}

function saveSkipList(): void {
  try {
    writeFileSync(SKIP_FILE, JSON.stringify(skipListSnapshot(), null, 2));
  } catch { /* ignore write errors */ }
}

loadSkipList();

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Should we skip the free tier for this host? (true once it's hit threshold and entry is fresh) */
export function shouldSkipDirect(host: string, now = Date.now()): SkipEntry | null {
  const e = skipList.get(host);
  if (!e) return null;
  if (now - e.lastFailed > SKIP_CONFIG.ttlMs) {
    skipList.delete(host); // expired — allow a fresh free probe
    return null;
  }
  return e.failures >= SKIP_CONFIG.threshold ? e : null;
}

/** Record a free-tier block for this host. */
export function markHardDomain(host: string, reason: string, now = Date.now()): void {
  const e = skipList.get(host);
  if (e) {
    e.failures += 1;
    e.lastFailed = now;
    e.lastReason = reason;
  } else {
    skipList.set(host, { failures: 1, lastFailed: now, lastReason: reason });
  }
  saveSkipList();
}

/** A host let us through for free — forget any prior block. */
export function clearHardDomain(host: string): void {
  skipList.delete(host);
  saveSkipList();
}

/** Inspect / debug the current skip-list (used by a debug tool, tests). */
export function skipListSnapshot(): Array<{ host: string } & SkipEntry> {
  return [...skipList.entries()].map(([host, e]) => ({ host, ...e }));
}

/** Test helper. */
export function _resetSkipList(): void {
  skipList.clear();
}

// ---------------------------------------------------------------------------
// Cookie jar (in-memory, per hostname)
// ---------------------------------------------------------------------------

const cookieJar = new Map<string, Record<string, string>>();

function applyCookies(host: string, headers: Record<string, string>): void {
  const jar = cookieJar.get(host);
  if (jar && Object.keys(jar).length > 0) {
    headers["Cookie"] = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function storeCookies(host: string, resp: Response): void {
  const setCookie = resp.headers.get("set-cookie");
  if (!setCookie) return;
  const jar = cookieJar.get(host) ?? {};
  // Split on ", " only when followed by a cookie name= (rough but stdlib-free)
  for (const cookie of setCookie.split(/,(?=\s*\w+=)/)) {
    const pair = cookie.trim().split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  cookieJar.set(host, jar);
}

// ---------------------------------------------------------------------------
// Rate limiter (per hostname)
// ---------------------------------------------------------------------------

const lastRequestMs = new Map<string, number>();

async function rateLimit(host: string, delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  const last = lastRequestMs.get(host) ?? 0;
  const wait = delayMs - (Date.now() - last);
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  lastRequestMs.set(host, Date.now());
}

// ---------------------------------------------------------------------------
// Block detection
// ---------------------------------------------------------------------------

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Status codes that almost always mean "you've been blocked / challenged". */
const HARD_BLOCK_STATUS = new Set([401, 403, 429, 444, 503]);
/** Cloudflare-specific origin/edge error codes. */
const CLOUDFLARE_STATUS = new Set([520, 521, 522, 523, 524, 525, 526, 527, 530]);

interface ProbeInput {
  status: number;
  headers: Headers;
  body: string;
  minBodyBytes: number;
}

/**
 * Returns a human-readable reason string if the response looks like an
 * anti-bot block/challenge, or null if it looks like genuine content.
 */
export function detectBlock(p: ProbeInput): string | null {
  const { status, headers } = p;
  const body = p.body ?? "";
  const lc = body.toLowerCase();

  const server = (headers.get("server") || "").toLowerCase();
  const cfMitigated = (headers.get("cf-mitigated") || "").toLowerCase();
  const hasCfRay = headers.has("cf-ray");
  const setCookie = (headers.get("set-cookie") || "").toLowerCase();

  // --- Header-level signatures -------------------------------------------
  if (cfMitigated.includes("challenge")) return "cloudflare: cf-mitigated=challenge header";
  if (server.includes("akamaighost")) return "akamai: AkamaiGHost server header";
  if (server.includes("imperva") || setCookie.includes("incap_ses") || setCookie.includes("visid_incap"))
    return "imperva/incapsula: cookie/server signature";

  // --- Status-level signatures -------------------------------------------
  if (CLOUDFLARE_STATUS.has(status)) return `cloudflare edge error ${status}`;
  if (HARD_BLOCK_STATUS.has(status)) {
    if (hasCfRay || server.includes("cloudflare")) return `cloudflare challenge (HTTP ${status})`;
    if (server.includes("akamai")) return `akamai challenge (HTTP ${status})`;
    return `hard block status ${status}`;
  }

  // --- Body-level signatures (work even on HTTP 200 challenge pages) ------
  const bodyMarkers: Array<[RegExp, string]> = [
    [/just a moment\s*\.{0,3}/i, "cloudflare: 'Just a moment...' interstitial"],
    [/cf[-_]browser[-_]verification|cf[-_]chl[-_]|challenge-platform/i, "cloudflare: challenge-platform script"],
    [/attention required!?\s*\|?\s*cloudflare/i, "cloudflare: 'Attention Required' block page"],
    [/_cf_chl_opt|turnstile/i, "cloudflare: turnstile/challenge token"],
    [/akamai|reference\s*#\s*[0-9a-f.]+/i, "akamai: reference-id error page"],
    [/access denied.*you don't have permission to access/i, "generic access-denied wall"],
    [/_incapsula_|incapsula incident id/i, "imperva/incapsula incident page"],
    [/pardon our interruption/i, "imperva: 'Pardon Our Interruption' page"],
    [/px-captcha|perimeterx|_px\d?=/i, "perimeterx human-verification"],
    [/datadome|geo\.captcha-delivery\.com/i, "datadome captcha"],
    [/please enable (javascript and )?cookies|enable js and cookies to continue/i, "js+cookies challenge gate"],
    [/g-recaptcha|recaptcha\/api\.js|hcaptcha\.com\/captcha/i, "captcha widget present"],
    [/are you (a )?human|verify you are (a )?human|bot detection/i, "human-verification prompt"],
  ];
  for (const [re, reason] of bodyMarkers) {
    if (re.test(lc)) return reason;
  }

  // --- Suspiciously empty body on a 2xx -----------------------------------
  if (status >= 200 && status < 300 && p.minBodyBytes > 0 && body.length < p.minBodyBytes) {
    return `suspiciously small body (${body.length} < ${p.minBodyBytes} bytes)`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tier 0 — free direct fetch
// ---------------------------------------------------------------------------

interface DirectResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  headers: Headers;
  body: string;
  networkError?: string;
  isPdf?: boolean;
}

async function directFetch(opts: SmartScrapeOptions): Promise<DirectResult> {
  const host = hostnameOf(opts.url);
  await rateLimit(host, opts.rateLimitMs ?? 0);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.directTimeoutMs ?? 12_000);

  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    ...(opts.headers ?? {}),
  };
  applyCookies(host, headers);

  try {
    const resp = await fetch(opts.url, {
      method: opts.method ?? "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    storeCookies(host, resp);
    lastRequestMs.set(host, Date.now());

    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("application/pdf")) {
      return { ok: resp.ok, status: resp.status, finalUrl: resp.url || opts.url, headers: resp.headers, body: "", isPdf: true };
    }

    const body = await resp.text();
    return { ok: resp.ok, status: resp.status, finalUrl: resp.url || opts.url, headers: resp.headers, body };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      finalUrl: opts.url,
      headers: new Headers(),
      body: "",
      networkError: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Minimal, dependency-free HTML -> Markdown (for the free tier only)
// ---------------------------------------------------------------------------

export function htmlToMarkdown(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  for (let i = 6; i >= 1; i--) {
    const re = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, "gi");
    s = s.replace(re, (_m, t) => `\n\n${"#".repeat(i)} ${strip(t)}\n\n`);
  }
  s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
    const label = strip(t);
    return label ? `[${label}](${href})` : href;
  });
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${strip(t)}`);
  s = s.replace(/<\/(p|div|section|article|header|footer|tr|ul|ol)>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = strip(s);
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function strip(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/[ \t]+\n/g, "\n");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function smartScrape(opts: SmartScrapeOptions): Promise<SmartScrapeResult> {
  const log: string[] = [];
  const dataFormat = opts.dataFormat ?? "markdown";
  const minBodyBytes = opts.minBodyBytes ?? 0;
  const host = hostnameOf(opts.url);

  // Decide whether to even attempt the free tier.
  let skipFree = false;
  if (opts.forceBrightData) {
    skipFree = true;
    log.push("forceBrightData=true: skipping free tier");
  } else if (!opts.ignoreSkipList) {
    const hot = shouldSkipDirect(host);
    if (hot) {
      skipFree = true;
      log.push(
        `skip-list: ${host} blocked ${hot.failures}x (last: ${hot.lastReason}); ` +
          `skipping free tier to save a wasted attempt`
      );
    }
  }

  // ---- Tier 0: free direct fetch ----------------------------------------
  if (!skipFree) {
    log.push(`tier0: GET ${opts.url} via direct fetch (free)`);
    const direct = await directFetch(opts);

    if (direct.isPdf) {
      log.push("tier0: PDF detected — escalating to Bright Data for proper extraction");
      // ponytail: don't mark domain as hard; PDFs aren't anti-bot blocks
    } else if (direct.networkError) {
      log.push(`tier0: network error: ${direct.networkError}`);
      markHardDomain(host, `network: ${direct.networkError}`);
    } else {
      const reason = detectBlock({
        status: direct.status,
        headers: direct.headers,
        body: direct.body,
        minBodyBytes,
      });

      if (!reason && direct.ok) {
        log.push(`tier0: success (HTTP ${direct.status}) — no Bright Data credit spent`);
        clearHardDomain(host);
        return {
          tier: "direct",
          paid: false,
          status: direct.status,
          finalUrl: direct.finalUrl,
          blockReason: null,
          skippedFreeTier: false,
          dataFormat,
          text: dataFormat === "markdown" ? htmlToMarkdown(direct.body) : direct.body,
          log,
        };
      }

      const why = reason ?? `HTTP ${direct.status}`;
      log.push(`tier0: escalating — ${why}`);
      markHardDomain(host, why);
    }

    if (opts.freeOnly) {
      log.push("freeOnly=true: refusing to spend credit; returning best-effort free result");
      return {
        tier: "direct",
        paid: false,
        status: direct.status,
        finalUrl: direct.finalUrl,
        blockReason: direct.networkError ?? "blocked on free tier (no escalation: freeOnly)",
        skippedFreeTier: false,
        dataFormat,
        text: dataFormat === "markdown" ? htmlToMarkdown(direct.body) : direct.body,
        log,
      };
    }
  } else if (opts.freeOnly) {
    log.push("freeOnly=true but free tier skipped: nothing to return");
    return {
      tier: "direct",
      paid: false,
      blockReason: "skipped free tier and freeOnly=true",
      skippedFreeTier: true,
      dataFormat,
      text: "",
      log,
    };
  }

  // ---- Tier 1: Bright Data Web Unlocker (PAID) --------------------------
  log.push(`tier1: Bright Data Web Unlocker zone="${opts.unlockerZone}" (PAID)`);
  const expect =
    opts.waitForSelector || opts.waitForText
      ? { element: opts.waitForSelector, text: opts.waitForText }
      : undefined;

  const res = await opts.client.request({
    url: opts.url,
    zone: opts.unlockerZone,
    format: "raw",
    method: opts.method ?? "GET",
    country: opts.country,
    dataFormat,
    headers: opts.headers,
    expect,
  });

  log.push("tier1: Bright Data returned content (credit spent)");
  return {
    tier: "unlocker",
    paid: true,
    finalUrl: opts.url,
    blockReason: log.find((l) => l.includes("escalating") || l.includes("skip-list")) ?? "forced",
    skippedFreeTier: skipFree,
    dataFormat,
    text: res.text ?? "",
    log,
  };
}
