import { htmlToMarkdown } from "./router.js";

// ---------------------------------------------------------------------------
// Main content extraction (lightweight readability)
// ---------------------------------------------------------------------------

export function extractMainContent(html: string): string {
  let s = html;
  s = s.replace(/<(script|style|noscript|nav|footer|header|aside|iframe|svg|form)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // Try progressively broader selectors for main content area
  const mainMatch =
    s.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    s.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    s.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/i) ||
    s.match(/<[^>]+class=["'][^"']*\b(?:content|article|main|post|body|entry)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i) ||
    s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);

  return htmlToMarkdown(mainMatch ? mainMatch[1] : s);
}

// ---------------------------------------------------------------------------
// Metadata extraction (title, og:*, twitter:*, meta description)
// ---------------------------------------------------------------------------

export function extractMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};

  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (title) meta.title = title[1].trim();

  // name/property before content
  const re1 = /<meta[^>]+(?:name|property)=["']([^"']+)["'][^>]+content=["']([^"']*?)["'][^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(html)) !== null) meta[m[1]] ??= m[2];

  // content before name/property
  const re2 = /<meta[^>]+content=["']([^"']*?)["'][^>]+(?:name|property)=["']([^"']+)["'][^>]*\/?>/gi;
  while ((m = re2.exec(html)) !== null) meta[m[2]] ??= m[1];

  return meta;
}

// ---------------------------------------------------------------------------
// JSON-LD structured data
// ---------------------------------------------------------------------------

export function extractJsonLd(html: string): unknown[] {
  const results: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try { results.push(JSON.parse(m[1])); } catch { /* skip malformed */ }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Feed parsing (RSS 2.0 + Atom 1.0)
// ---------------------------------------------------------------------------

export interface FeedItem {
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
}

export interface ParsedFeed {
  type: "rss" | "atom";
  title?: string;
  items: FeedItem[];
}

export function parseFeed(xml: string): ParsedFeed {
  const type: "rss" | "atom" = /<feed[^>]*>/i.test(xml) ? "atom" : "rss";
  const chanTitle = xml.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim();

  const itemTag = type === "atom" ? "entry" : "item";
  const items: FeedItem[] = [];
  const itemRe = new RegExp(`<${itemTag}[^>]*>([\\s\\S]*?)<\\/${itemTag}>`, "gi");
  let m: RegExpExecArray | null;

  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const get = (tag: string) =>
      body.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"))?.[1]?.trim();
    items.push({
      title: get("title"),
      link: get("link") ?? body.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1],
      description: get("description") ?? get("summary") ?? get("content"),
      pubDate: get("pubDate") ?? get("published") ?? get("updated"),
    });
  }

  return { type, title: chanTitle, items };
}

// ---------------------------------------------------------------------------
// Sitemap parsing (sitemap.xml + sitemap index)
// ---------------------------------------------------------------------------

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  priority?: string;
}

export function parseSitemap(xml: string): SitemapEntry[] {
  const urls: SitemapEntry[] = [];
  const get = (s: string, tag: string) =>
    s.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i"))?.[1]?.trim();

  const urlRe = /<url>([\s\S]*?)<\/url>/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(xml)) !== null) {
    const loc = get(m[1], "loc");
    if (loc) urls.push({ loc, lastmod: get(m[1], "lastmod"), priority: get(m[1], "priority") });
  }

  // Sitemap index: list of child sitemaps
  if (urls.length === 0) {
    const locRe = /<loc>([\s\S]*?)<\/loc>/g;
    while ((m = locRe.exec(xml)) !== null) urls.push({ loc: m[1].trim() });
  }

  return urls;
}

// ---------------------------------------------------------------------------
// robots.txt parsing
// ---------------------------------------------------------------------------

export function parseRobots(robotsTxt: string, path: string): { allowed: boolean; matchedRule?: string } {
  let inScope = false;
  const rules: Array<{ allow: boolean; pattern: string }> = [];

  for (const rawLine of robotsTxt.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("User-agent:")) {
      inScope = line.slice(11).trim() === "*";
    } else if (inScope) {
      if (line.startsWith("Disallow:")) {
        const p = line.slice(9).trim();
        if (p) rules.push({ allow: false, pattern: p });
      } else if (line.startsWith("Allow:")) {
        const p = line.slice(6).trim();
        if (p) rules.push({ allow: true, pattern: p });
      }
    }
  }

  // Longest matching rule wins
  let match: { allow: boolean; pattern: string } | null = null;
  for (const rule of rules) {
    if (path.startsWith(rule.pattern)) {
      if (!match || rule.pattern.length > match.pattern.length) match = rule;
    }
  }

  return match
    ? { allowed: match.allow, matchedRule: `${match.allow ? "Allow" : "Disallow"}: ${match.pattern}` }
    : { allowed: true };
}
