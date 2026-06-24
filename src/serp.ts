/**
 * Helpers for building search-engine URLs for the SERP API.
 * The SERP API is invoked through the same POST /request endpoint as the
 * Unlocker; you pass it a real search URL and it returns parsed results.
 */

export type SearchEngine = "google" | "bing" | "yandex" | "duckduckgo";

export interface SerpQuery {
  engine: SearchEngine;
  query: string;
  /** Results page (1-based). Converted to the engine's offset param. */
  page?: number;
  /** Number of results (Google `num`). */
  num?: number;
  /** UI language (Google `hl`). */
  language?: string;
  /** Geo of results (Google `gl`). */
  gl?: string;
  /** Mobile results. */
  mobile?: boolean;
  /** Search vertical for Google: web|images|news|shopping|videos|jobs. */
  searchType?: "web" | "images" | "news" | "shopping" | "videos" | "jobs";
}

export function buildSearchUrl(q: SerpQuery): string {
  const encoded = encodeURIComponent(q.query);
  switch (q.engine) {
    case "google": {
      const p = new URLSearchParams();
      p.set("q", q.query);
      if (q.num) p.set("num", String(q.num));
      if (q.page && q.page > 1) p.set("start", String((q.page - 1) * (q.num ?? 10)));
      if (q.language) p.set("hl", q.language);
      if (q.gl) p.set("gl", q.gl);
      if (q.mobile) p.set("brd_mobile", "1");
      switch (q.searchType) {
        case "images": p.set("tbm", "isch"); break;
        case "news": p.set("tbm", "nws"); break;
        case "shopping": p.set("tbm", "shop"); break;
        case "videos": p.set("tbm", "vid"); break;
        case "jobs": p.set("ibp", "htl;jobs"); break;
        default: break;
      }
      return `https://www.google.com/search?${p.toString()}`;
    }
    case "bing": {
      const p = new URLSearchParams();
      p.set("q", q.query);
      if (q.page && q.page > 1) p.set("first", String((q.page - 1) * (q.num ?? 10) + 1));
      if (q.language) p.set("setlang", q.language);
      return `https://www.bing.com/search?${p.toString()}`;
    }
    case "yandex": {
      const p = new URLSearchParams();
      p.set("text", q.query);
      if (q.page && q.page > 1) p.set("p", String(q.page - 1));
      return `https://yandex.com/search/?${p.toString()}`;
    }
    case "duckduckgo":
      return `https://duckduckgo.com/?q=${encoded}`;
    default:
      return `https://www.google.com/search?q=${encoded}`;
  }
}
