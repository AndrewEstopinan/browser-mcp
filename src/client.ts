/**
 * HTTP client for Bright Data's REST Web Access APIs.
 *
 * Covers:
 *   - Unlocker API + SERP API  (POST /request, sync and async)
 *   - Async result retrieval    (GET  /unblocker/get_result)
 *   - Unlocker success-rate stats (GET /unblocker/success_rate/{domain})
 *   - Crawl / Web Scraper API    (POST /datasets/v3/trigger, GET progress/snapshot)
 *
 * Uses the global `fetch` (Node 18+). No third-party HTTP dependency.
 */

import type { BrightDataConfig } from "./config.js";

export class BrightDataApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly brdErrorCode?: string;
  constructor(status: number, body: string, brdErrorCode?: string) {
    super(
      `Bright Data API error ${status}${brdErrorCode ? ` (${brdErrorCode})` : ""}: ` +
        (body.length > 500 ? body.slice(0, 500) + "…" : body)
    );
    this.name = "BrightDataApiError";
    this.status = status;
    this.body = body;
    this.brdErrorCode = brdErrorCode;
  }
}

export type ResponseFormat = "raw" | "json";
export type DataFormat = "html" | "markdown" | "screenshot";

export interface RequestOptions {
  url: string;
  zone: string;
  /** "json" wraps the response in {status_code, headers, body}; "raw" returns the page body directly. */
  format?: ResponseFormat;
  method?: string;
  /** ISO 3166-1 alpha-2 country code, e.g. "us", "gb", "de". */
  country?: string;
  /** "markdown" converts to markdown, "screenshot" returns PNG bytes. */
  dataFormat?: DataFormat;
  /** Custom request headers (requires the "Custom Headers & Cookies" feature enabled on the zone). */
  headers?: Record<string, string>;
  /** Wait-for hint: returned page must contain this element/text before responding. */
  expect?: { element?: string; text?: string };
}

export interface UnlockerJsonResponse {
  status_code: number;
  headers: Record<string, string>;
  body: string;
}

export interface RawResult {
  /** Decoded text body (for html/markdown/json/raw). */
  text?: string;
  /** Raw bytes (used for screenshots / binary). */
  bytes?: Uint8Array;
  contentType: string | null;
  /** The async job id, present only on async requests. */
  responseId?: string;
}

export class BrightDataClient {
  private readonly cfg: BrightDataConfig;

  constructor(cfg: BrightDataConfig) {
    this.cfg = cfg;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private extractBrdError(headers: Headers): string | undefined {
    return (
      headers.get("x-brd-error-code") ??
      headers.get("x-luminati-error-code") ??
      undefined
    );
  }

  /**
   * Core POST /request used by both Unlocker and SERP.
   * Returns text for html/markdown/json, or raw bytes for screenshots.
   */
  async request(opts: RequestOptions, async = false): Promise<RawResult> {
    const body: Record<string, unknown> = {
      zone: opts.zone,
      url: opts.url,
      format: opts.format ?? "raw",
      method: opts.method ?? "GET",
    };
    if (opts.country) body.country = opts.country.toLowerCase();
    if (opts.dataFormat && opts.dataFormat !== "html") {
      body.data_format = opts.dataFormat;
    }
    if (opts.headers && Object.keys(opts.headers).length > 0) {
      body.headers = opts.headers;
    }
    if (opts.expect) {
      // Relayed as the x-unblock-expect header via the custom headers channel.
      body.headers = {
        ...(body.headers as Record<string, string> | undefined),
        "x-unblock-expect": JSON.stringify(opts.expect),
      };
    }

    const qs = async ? "?async=true" : "";
    const res = await fetch(`${this.cfg.apiBaseUrl}/request${qs}`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });

    const contentType = res.headers.get("content-type");
    const responseId =
      res.headers.get("x-response-id") ??
      res.headers.get("response-id") ??
      undefined;

    if (!res.ok) {
      const text = await res.text();
      throw new BrightDataApiError(res.status, text, this.extractBrdError(res.headers));
    }

    // Screenshot (and any non-text content) comes back as binary.
    if (opts.dataFormat === "screenshot" || (contentType && contentType.startsWith("image/"))) {
      const buf = new Uint8Array(await res.arrayBuffer());
      return { bytes: buf, contentType, responseId };
    }

    const text = await res.text();
    return { text, contentType, responseId };
  }

  /** Retrieve the result of an async request started with `request(..., true)`. */
  async getAsyncResult(responseId: string, zone?: string): Promise<RawResult> {
    const params = new URLSearchParams({ response_id: responseId });
    if (zone) params.set("zone", zone);
    const res = await fetch(
      `${this.cfg.apiBaseUrl}/unblocker/get_result?${params.toString()}`,
      { method: "GET", headers: this.authHeaders() }
    );

    if (res.status === 202) {
      // Still processing.
      return { text: "__PENDING__", contentType: res.headers.get("content-type") };
    }
    if (!res.ok) {
      const text = await res.text();
      throw new BrightDataApiError(res.status, text, this.extractBrdError(res.headers));
    }
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.startsWith("image/")) {
      const buf = new Uint8Array(await res.arrayBuffer());
      return { bytes: buf, contentType };
    }
    return { text: await res.text(), contentType };
  }

  /** Past-7-day success-rate stats for a domain (e.g. "example.com" or "example.*"). */
  async successRate(domain: string): Promise<Record<string, number>> {
    const res = await fetch(
      `${this.cfg.apiBaseUrl}/unblocker/success_rate/${encodeURIComponent(domain)}`,
      { method: "GET", headers: this.authHeaders() }
    );
    if (!res.ok) {
      throw new BrightDataApiError(res.status, await res.text());
    }
    return (await res.json()) as Record<string, number>;
  }

  // --- Crawl / Web Scraper (Datasets v3) ---------------------------------

  /** Trigger a dataset collection. Returns a snapshot_id to poll later. */
  async triggerDataset(params: {
    datasetId: string;
    inputs: Array<Record<string, unknown>>;
    includeErrors?: boolean;
    customOutputFields?: string;
    type?: "discover_new" | "url_collection";
    discoverBy?: string;
  }): Promise<{ snapshot_id: string }> {
    const qs = new URLSearchParams({ dataset_id: params.datasetId });
    if (params.includeErrors !== undefined) {
      qs.set("include_errors", String(params.includeErrors));
    }
    if (params.customOutputFields) qs.set("custom_output_fields", params.customOutputFields);
    if (params.type) qs.set("type", params.type);
    if (params.discoverBy) qs.set("discover_by", params.discoverBy);

    const res = await fetch(
      `${this.cfg.apiBaseUrl}/datasets/v3/trigger?${qs.toString()}`,
      {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(params.inputs),
      }
    );
    if (!res.ok) {
      throw new BrightDataApiError(res.status, await res.text());
    }
    return (await res.json()) as { snapshot_id: string };
  }

  /** Get the progress/status of a snapshot. */
  async datasetProgress(snapshotId: string): Promise<{
    status: string;
    [k: string]: unknown;
  }> {
    const res = await fetch(
      `${this.cfg.apiBaseUrl}/datasets/v3/progress/${encodeURIComponent(snapshotId)}`,
      { method: "GET", headers: this.authHeaders() }
    );
    if (!res.ok) {
      throw new BrightDataApiError(res.status, await res.text());
    }
    return (await res.json()) as { status: string; [k: string]: unknown };
  }

  /** Download a completed snapshot's data. */
  async datasetSnapshot(
    snapshotId: string,
    format: "json" | "ndjson" | "jsonl" | "csv" = "json"
  ): Promise<{ text: string; contentType: string | null }> {
    const qs = new URLSearchParams({ format });
    const res = await fetch(
      `${this.cfg.apiBaseUrl}/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?${qs.toString()}`,
      { method: "GET", headers: this.authHeaders() }
    );
    if (res.status === 202) {
      return { text: "__PENDING__", contentType: res.headers.get("content-type") };
    }
    if (!res.ok) {
      throw new BrightDataApiError(res.status, await res.text());
    }
    return { text: await res.text(), contentType: res.headers.get("content-type") };
  }
}
