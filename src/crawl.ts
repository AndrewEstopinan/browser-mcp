import { smartScrape, hostnameOf, htmlToMarkdown } from "./router.js";
import type { SmartScrapeOptions } from "./router.js";

// ---------------------------------------------------------------------------
// Batch scraping
// ---------------------------------------------------------------------------

export interface BatchResult {
  url: string;
  success: boolean;
  text?: string;
  tier?: "direct" | "unlocker";
  paid?: boolean;
  error?: string;
}

export async function smartScrapeBatch(
  urls: string[],
  opts: Omit<SmartScrapeOptions, "url">,
  concurrency = 5
): Promise<BatchResult[]> {
  const results: BatchResult[] = new Array(urls.length);
  for (let i = 0; i < urls.length; i += concurrency) {
    const chunk = await Promise.all(
      urls.slice(i, i + concurrency).map(async (url, j): Promise<[number, BatchResult]> => {
        try {
          const r = await smartScrape({ ...opts, url });
          return [i + j, { url, success: true, text: r.text, tier: r.tier, paid: r.paid }];
        } catch (e) {
          return [i + j, { url, success: false, error: e instanceof Error ? e.message : String(e) }];
        }
      })
    );
    for (const [idx, result] of chunk) results[idx] = result;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

export function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const re = /<a[^>]+href=["']([^"'#][^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const url = new URL(m[1], baseUrl).href;
      if (url.startsWith("http")) links.push(url);
    } catch { /* skip malformed */ }
  }
  return [...new Set(links)];
}

// ---------------------------------------------------------------------------
// Crawl with link following
// ---------------------------------------------------------------------------

export interface CrawlResult {
  url: string;
  text: string;
  tier: "direct" | "unlocker";
  paid: boolean;
  linksFound: number;
  depth: number;
}

export async function smartCrawl(
  startUrl: string,
  opts: Omit<SmartScrapeOptions, "url">,
  {
    maxPages = 10,
    maxDepth = 2,
    urlFilter,
    sameHostOnly = true,
  }: { maxPages?: number; maxDepth?: number; urlFilter?: string; sameHostOnly?: boolean }
): Promise<CrawlResult[]> {
  const startHost = hostnameOf(startUrl);
  const filterRe = urlFilter ? new RegExp(urlFilter) : null;
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const results: CrawlResult[] = [];

  while (queue.length > 0 && results.length < maxPages) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      // Always fetch HTML so we can extract links; convert format in output
      const r = await smartScrape({ ...opts, url, dataFormat: "html" });
      const rawHtml = r.text ?? "";

      const links = extractLinks(rawHtml, url).filter((l) => {
        if (sameHostOnly && hostnameOf(l) !== startHost) return false;
        if (filterRe && !filterRe.test(l)) return false;
        return !visited.has(l);
      });

      results.push({
        url,
        text: opts.dataFormat === "markdown" ? htmlToMarkdown(rawHtml) : rawHtml,
        tier: r.tier,
        paid: r.paid,
        linksFound: links.length,
        depth,
      });

      if (depth < maxDepth) {
        for (const link of links) queue.push({ url: link, depth: depth + 1 });
      }
    } catch { /* skip unreachable URLs, keep crawling */ }
  }

  return results;
}
