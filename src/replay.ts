import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Minimal HAR types
// ---------------------------------------------------------------------------

interface HarNameValue { name: string; value: string }
interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: HarNameValue[];
    postData?: { text?: string; mimeType?: string };
  };
  response: {
    status: number;
    headers: HarNameValue[];
    content: { text?: string; mimeType?: string };
  };
}

// ---------------------------------------------------------------------------
// Isolated cookie jar (separate from the scraping jar in router.ts)
// ---------------------------------------------------------------------------

function makeCookieJar() {
  const jar = new Map<string, Record<string, string>>();
  return {
    store(host: string, resp: Response) {
      const sc = resp.headers.get("set-cookie");
      if (!sc) return;
      const h = jar.get(host) ?? {};
      for (const cookie of sc.split(/,(?=\s*\w+=)/)) {
        const pair = cookie.trim().split(";")[0];
        const eq = pair.indexOf("=");
        if (eq > 0) h[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
      jar.set(host, h);
    },
    header(host: string): string {
      const h = jar.get(host);
      return h ? Object.entries(h).map(([k, v]) => `${k}=${v}`).join("; ") : "";
    },
  };
}

// ---------------------------------------------------------------------------
// Dynamic value extraction
// Finds token-like values in HTML responses and JSON bodies.
// Only picks up values >=8 chars to avoid false-positive matches on short strings.
// ---------------------------------------------------------------------------

export function extractDynamic(html: string, headers: Headers): Map<string, string> {
  const out = new Map<string, string>();

  // <input type="hidden" name="csrf_token" value="...">
  const inputRe = /<input[^>]+>/gi;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/type=["']hidden["']/i.test(tag)) continue;
    const name = tag.match(/name=["']([^"']+)["']/i)?.[1];
    const val = tag.match(/value=["']([^"']{8,})["']/i)?.[1];
    if (name && val && /token|csrf|nonce|authenticity|_method|state|verify|build_id/i.test(name)) {
      out.set(name, val);
    }
  }

  // <meta name="csrf-token" content="...">
  const metaRe = /<meta[^>]+>/gi;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const name = tag.match(/(?:name|property)=["']([^"']*(?:csrf|token|nonce)[^"']*)["']/i)?.[1];
    const val = tag.match(/content=["']([^"']{8,})["']/i)?.[1];
    if (name && val) out.set(name, val);
  }

  // Response headers: X-CSRF-Token, X-XSRF-TOKEN, etc.
  for (const h of ["x-csrf-token", "x-xsrf-token", "x-request-token", "x-antiforgery-token"]) {
    const v = headers.get(h);
    if (v && v.length >= 8) out.set(h, v);
  }

  // Shallow JSON scan for token-named fields
  const trimmed = html.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const obj = JSON.parse(html) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && v.length >= 8 && /token|csrf|nonce|secret|key|ticket/i.test(k)) {
          out.set(k, v);
        }
      }
    } catch { /* not JSON */ }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Replay engine
// ---------------------------------------------------------------------------

const SKIP_HEADERS = new Set([
  ":authority", ":method", ":path", ":scheme",
  "host", "content-length", "connection", "transfer-encoding",
]);

const SKIP_MIME = /^(image|font|audio|video)\//i;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|mp4|css|js)(\?|$)/i;

export interface ReplayResult {
  index: number;
  url: string;
  method: string;
  status: number;
  skipped?: string;
  correlatedVars: string[];
  bodyPreview: string;
}

export interface ReplayOptions {
  /** Static replacements applied to every request before sending.
   *  Use for credentials and anything that never appears in a response.
   *  e.g. { "recorded_password": "real_password" } */
  substitutions?: Record<string, string>;
  skipAssets?: boolean;  // default true
  dryRun?: boolean;      // default false — show what would be sent without sending
}

export async function replayHar(harPath: string, opts: ReplayOptions = {}): Promise<ReplayResult[]> {
  const har = JSON.parse(readFileSync(harPath, "utf8")) as { log: { entries: HarEntry[] } };
  const entries = har.log.entries;
  const skipAssets = opts.skipAssets ?? true;

  // Pass 1: index every dynamic value found in recorded responses.
  // recordedDynamic: Map<recordedValue, fieldName>
  const recordedDynamic = new Map<string, string>();
  for (const e of entries) {
    const body = e.response.content.text ?? "";
    const headers = new Headers(Object.fromEntries(e.response.headers.map(h => [h.name, h.value])));
    for (const [name, val] of extractDynamic(body, headers)) {
      recordedDynamic.set(val, name);
    }
  }

  const cookies = makeCookieJar();

  // liveSubs: stale recorded value → fresh live value
  // Seeded with manual substitutions, grown automatically during replay.
  const liveSubs = new Map<string, string>(Object.entries(opts.substitutions ?? {}));

  const sub = (s: string): string => {
    for (const [old, fresh] of liveSubs) s = s.replaceAll(old, fresh);
    return s;
  };

  const results: ReplayResult[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const req = e.request;

    // Skip static assets
    if (skipAssets) {
      const mime = e.response.content.mimeType ?? "";
      if (SKIP_MIME.test(mime) || SKIP_EXT.test(req.url)) {
        results.push({ index: i, url: req.url, method: req.method, status: e.response.status, skipped: "asset", correlatedVars: [], bodyPreview: "" });
        continue;
      }
    }

    const url = sub(req.url);
    const method = req.method.toUpperCase();
    const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();

    // Build headers: skip browser-managed ones, apply subs, inject fresh cookies
    const headers: Record<string, string> = {};
    for (const h of req.headers) {
      if (SKIP_HEADERS.has(h.name.toLowerCase())) continue;
      if (h.name.toLowerCase() === "cookie") continue; // jar handles this
      headers[h.name] = sub(h.value);
    }
    const cookieHeader = cookies.header(host);
    if (cookieHeader) headers["Cookie"] = cookieHeader;

    const body = req.postData?.text ? sub(req.postData.text) : undefined;

    if (opts.dryRun) {
      results.push({
        index: i, url, method, status: 0, skipped: "dry-run", correlatedVars: [],
        bodyPreview: JSON.stringify({ headers, body: body?.slice(0, 300) }),
      });
      continue;
    }

    const resp = await fetch(url, { method, headers, body, redirect: "follow" });
    cookies.store(host, resp);

    const respBody = await resp.text();

    // Correlate: find fresh values for fields we saw in recorded responses.
    // When a field name matches, register stale→fresh so every later request gets it.
    const correlatedVars: string[] = [];
    const freshDynamic = extractDynamic(respBody, resp.headers);
    for (const [name, freshVal] of freshDynamic) {
      for (const [recordedVal, recName] of recordedDynamic) {
        if (recName === name && recordedVal !== freshVal && !liveSubs.has(recordedVal)) {
          liveSubs.set(recordedVal, freshVal);
          correlatedVars.push(name);
        }
      }
    }

    results.push({ index: i, url, method, status: resp.status, correlatedVars, bodyPreview: respBody.slice(0, 300) });
  }

  return results;
}
