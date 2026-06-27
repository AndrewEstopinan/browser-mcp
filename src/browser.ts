/**
 * Bright Data Browser API integration.
 *
 * Connects Puppeteer (puppeteer-core, no local Chromium needed) to a remote,
 * fully managed cloud browser over CDP via:
 *
 *   wss://<USER>:<PASS>@brd.superproxy.io:9222
 *
 * Exposes Bright Data's custom CDP commands:
 *   - Captcha.solve / Captcha.setAutoSolve  (automatic & manual CAPTCHA solving)
 *   - Unblocker.enableAdBlock               (bandwidth/performance)
 *   - Proxy.useSession                      (sticky proxy peer across navigations)
 *   - Emulation.setDevice                   (device emulation)
 *   - Browser.getSessionId                  (session diagnostics)
 *
 * No browser runs on the host machine - all execution happens on Bright Data's
 * cloud browsers, so this works on machines that cannot run a browser locally.
 */

import puppeteer, { type Browser, type Page, type CDPSession } from "puppeteer-core";

export interface BrowserAction {
  type:
    | "goto"
    | "wait_for_selector"
    | "wait"
    | "click"
    | "type"
    | "scroll"
    | "evaluate"
    | "solve_captcha";
  /** goto */
  url?: string;
  /** wait_for_selector / click / type */
  selector?: string;
  /** type */
  text?: string;
  /** wait (ms) / wait_for_selector timeout (ms) / solve_captcha detectTimeout (ms) */
  timeout?: number;
  /** evaluate: a JS expression evaluated in page context; its result is collected. */
  expression?: string;
}

export interface BrowserTaskInput {
  auth: string;
  host: string;
  url: string;
  /** Optional ordered interactions performed after the initial navigation. */
  actions?: BrowserAction[];
  /** Auto-solve CAPTCHAs after the initial navigation (default true). */
  solveCaptcha?: boolean;
  /** detectTimeout (ms) handed to Captcha.solve (default 30000). */
  captchaTimeout?: number;
  /** Enable ad blocking before navigation (default false). */
  blockAds?: boolean;
  /** Reuse a sticky proxy peer across sessions. */
  sessionId?: string;
  /** Device to emulate, e.g. "iPhone 15 Pro". */
  device?: string;
  /** Capture a full-page PNG screenshot and return it (default false). */
  screenshot?: boolean;
  /** Return the rendered page HTML (default true). */
  returnHtml?: boolean;
  /** Return page.evaluate(() => document.body.innerText) instead of/with HTML. */
  returnText?: boolean;
  /** Navigation timeout in ms (default 120000). */
  navTimeout?: number;
  /** Puppeteer waitUntil for navigation. */
  waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
}

export interface BrowserTaskResult {
  finalUrl: string;
  title: string;
  html?: string;
  text?: string;
  /** base64-encoded PNG, present when screenshot was requested. */
  screenshotBase64?: string;
  captchaStatus?: string;
  sessionId?: string;
  /** Collected results from `evaluate` actions, in order. */
  evaluations: unknown[];
  log: string[];
}

function wsEndpoint(auth: string, host: string): string {
  return `wss://${auth}@${host}`;
}

/** Best-effort CDP send that never throws (used for optional features). */
async function trySend(
  client: CDPSession,
  method: string,
  params?: Record<string, unknown>,
  log?: string[]
): Promise<unknown> {
  try {
    // Custom Bright Data CDP commands are not in puppeteer's typed surface,
    // so we cast to the generic string-keyed signature.
    return await (client.send as unknown as (
      m: string,
      p?: Record<string, unknown>
    ) => Promise<unknown>)(method, params);
  } catch (e) {
    log?.push(`CDP ${method} failed: ${(e as Error).message}`);
    return undefined;
  }
}

export async function runBrowserTask(
  input: BrowserTaskInput
): Promise<BrowserTaskResult> {
  const log: string[] = [];
  const evaluations: unknown[] = [];
  const navTimeout = input.navTimeout ?? 120_000;

  log.push("Connecting to Bright Data cloud browser…");
  const browser: Browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint(input.auth, input.host),
  });

  try {
    const page: Page = await browser.newPage();
    const client = await page.createCDPSession();

    // Diagnostics: session id (useful for Session Logs API).
    let sessionId: string | undefined;
    const sid = (await trySend(client, "Browser.getSessionId", undefined, log)) as
      | { sessionId?: string }
      | undefined;
    if (sid?.sessionId) {
      sessionId = sid.sessionId;
      log.push(`Browser session id: ${sessionId}`);
    }

    // Optional: sticky proxy peer.
    if (input.sessionId) {
      await trySend(client, "Proxy.useSession", { sessionId: input.sessionId }, log);
      log.push(`Using sticky proxy session: ${input.sessionId}`);
    }

    // Optional: ad blocking (before navigation, as recommended).
    if (input.blockAds) {
      await trySend(client, "Unblocker.enableAdBlock", undefined, log);
      log.push("Ad blocking enabled.");
    }

    // Optional: device emulation.
    if (input.device) {
      await trySend(client, "Emulation.setDevice", { device: input.device }, log);
      log.push(`Emulating device: ${input.device}`);
    }

    // Initial navigation.
    log.push(`Navigating to ${input.url}…`);
    await page.goto(input.url, {
      timeout: navTimeout,
      waitUntil: input.waitUntil ?? "load",
    });

    // Automatic CAPTCHA solve (on by default; Browser API also auto-solves
    // server-side, this surfaces the status to the caller).
    let captchaStatus: string | undefined;
    if (input.solveCaptcha !== false) {
      const solve = (await trySend(
        client,
        "Captcha.solve",
        { detectTimeout: input.captchaTimeout ?? 30_000 },
        log
      )) as { status?: string } | undefined;
      captchaStatus = solve?.status;
      if (captchaStatus) log.push(`Captcha.solve status: ${captchaStatus}`);
    }

    // Ordered user-defined actions.
    for (const action of input.actions ?? []) {
      switch (action.type) {
        case "goto":
          if (action.url) {
            await page.goto(action.url, {
              timeout: action.timeout ?? navTimeout,
              waitUntil: input.waitUntil ?? "load",
            });
            log.push(`goto ${action.url}`);
          }
          break;
        case "wait_for_selector":
          if (action.selector) {
            await page.waitForSelector(action.selector, {
              timeout: action.timeout ?? 30_000,
            });
            log.push(`wait_for_selector ${action.selector}`);
          }
          break;
        case "wait":
          await new Promise((r) => setTimeout(r, action.timeout ?? 1000));
          log.push(`wait ${action.timeout ?? 1000}ms`);
          break;
        case "click":
          if (action.selector) {
            await page.click(action.selector);
            log.push(`click ${action.selector}`);
          }
          break;
        case "type":
          if (action.selector && action.text !== undefined) {
            await page.type(action.selector, action.text);
            log.push(`type into ${action.selector}`);
          }
          break;
        case "scroll":
          await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
          log.push("scroll to bottom");
          break;
        case "solve_captcha": {
          const solve = (await trySend(
            client,
            "Captcha.solve",
            { detectTimeout: action.timeout ?? 30_000 },
            log
          )) as { status?: string } | undefined;
          captchaStatus = solve?.status ?? captchaStatus;
          log.push(`solve_captcha status: ${solve?.status ?? "unknown"}`);
          break;
        }
        case "evaluate":
          if (action.expression) {
            // Evaluate a string expression in page context.
            const result = await page.evaluate(
              (expr) => {
                // eslint-disable-next-line no-eval
                return eval(expr);
              },
              action.expression
            );
            evaluations.push(result);
            log.push("evaluate expression");
          }
          break;
      }
    }

    const result: BrowserTaskResult = {
      finalUrl: page.url(),
      title: await page.title(),
      evaluations,
      log,
      captchaStatus,
      sessionId,
    };

    if (input.returnHtml !== false) {
      result.html = await page.content();
    }
    if (input.returnText) {
      result.text = await page.evaluate("document.body?.innerText ?? ''") as string;
    }
    if (input.screenshot) {
      const buf = (await page.screenshot({
        fullPage: true,
        type: "png",
      })) as Buffer;
      result.screenshotBase64 = buf.toString("base64");
    }

    return result;
  } finally {
    await browser.close();
    log.push("Browser session closed.");
  }
}
