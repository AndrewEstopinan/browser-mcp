/**
 * Centralized configuration, loaded from environment variables.
 *
 * Required:
 *   BRIGHTDATA_API_KEY   - Bearer token from https://brightdata.com/cp/setting/users
 *
 * Zone names (create them in the Bright Data control panel -> Web Access APIs):
 *   BRIGHTDATA_UNLOCKER_ZONE  - Web Unlocker zone (default: "web_unlocker1")
 *   BRIGHTDATA_SERP_ZONE      - SERP API zone     (default: "serp_api1")
 *
 * Browser API (cloud browser over CDP):
 *   BRIGHTDATA_BROWSER_AUTH   - "<USER>:<PASS>" zone credentials from the
 *                               Browser API zone's Overview tab. Optional - only
 *                               required if you use the browser_* tools.
 *   BRIGHTDATA_BROWSER_HOST   - CDP host (default: "brd.superproxy.io:9222")
 *
 * Crawl / Web Scraper API:
 *   BRIGHTDATA_DATASET_ID     - default dataset id (gd_...) used by the crawl
 *                               tools when one is not supplied per-call. Optional.
 */

export interface BrightDataConfig {
  apiKey?: string;
  unlockerZone: string;
  serpZone: string;
  browserAuth?: string;
  browserHost: string;
  defaultDatasetId?: string;
  apiBaseUrl: string;
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function loadConfig(): BrightDataConfig {
  const apiKey = readEnv("BRIGHTDATA_API_KEY");

  return {
    apiKey,
    unlockerZone: readEnv("BRIGHTDATA_UNLOCKER_ZONE") ?? "web_unlocker1",
    serpZone: readEnv("BRIGHTDATA_SERP_ZONE") ?? "serp_api1",
    browserAuth: readEnv("BRIGHTDATA_BROWSER_AUTH"),
    browserHost: readEnv("BRIGHTDATA_BROWSER_HOST") ?? "brd.superproxy.io:9222",
    defaultDatasetId: readEnv("BRIGHTDATA_DATASET_ID"),
    apiBaseUrl: readEnv("BRIGHTDATA_API_BASE_URL") ?? "https://api.brightdata.com",
  };
}
