import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const CACHE_DIR = process.env.SMART_CACHE_DIR ?? "./smart_cache";
export const DEFAULT_CACHE_TTL_MS = Number(process.env.SMART_CACHE_TTL_MS ?? 60 * 60_000); // 1 hour

interface CacheEntry {
  url: string;
  format: string;
  body: string;
  cachedAt: number;
  ttlMs: number;
}

function cacheFile(url: string, format: string): string {
  const key = createHash("sha1").update(`${url}|${format}`).digest("hex");
  return join(CACHE_DIR, `${key}.json`);
}

export function cacheGet(url: string, format: string): string | null {
  try {
    const file = cacheFile(url, format);
    if (!existsSync(file)) return null;
    const e = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    return Date.now() - e.cachedAt > e.ttlMs ? null : e.body;
  } catch { return null; }
}

export function cacheSet(url: string, format: string, body: string, ttlMs = DEFAULT_CACHE_TTL_MS): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const entry: CacheEntry = { url, format, body, cachedAt: Date.now(), ttlMs };
    writeFileSync(cacheFile(url, format), JSON.stringify(entry));
  } catch { /* ignore write errors */ }
}

/** Peek without TTL check — used by smart_diff to compare any stored version regardless of age. */
export function cachePeek(url: string, format: string): { body: string; cachedAt: number } | null {
  try {
    const file = cacheFile(url, format);
    if (!existsSync(file)) return null;
    const e = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    return { body: e.body, cachedAt: e.cachedAt };
  } catch { return null; }
}
