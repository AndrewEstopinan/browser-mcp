#!/usr/bin/env node
/**
 * live-session.mjs — open an INTERACTIVE Bright Data Browser API session.
 *
 * Opens a real cloud browser, prints a LIVE inspect URL you can open in any
 * browser to watch/control it, prints diagnostics proving what the remote
 * browser actually rendered, saves a screenshot you can open as an image, and
 * keeps the session alive.
 *
 * Usage:
 *   $env:BRIGHTDATA_BROWSER_AUTH = 'brd-customer-XXXX-zone-YYYY:zzzz'   # PowerShell
 *   node scripts/live-session.mjs "https://example.com" 15
 *
 *   arg 1 (optional): start URL          (default: https://example.com)
 *   arg 2 (optional): keep-alive minutes (default: 10; 0 = until Ctrl+C)
 *
 * Env:
 *   BRIGHTDATA_BROWSER_AUTH   "USER:PASS" from the Browser API zone Overview tab (required)
 *   BRIGHTDATA_BROWSER_HOST   default "brd.superproxy.io:9222"
 */

import puppeteer from "puppeteer-core";

const AUTH = (process.env.BRIGHTDATA_BROWSER_AUTH || "").trim();
const HOST = (process.env.BRIGHTDATA_BROWSER_HOST || "brd.superproxy.io:9222").trim();
const START_URL = process.argv[2] || "https://example.com";
const KEEP_MINUTES = process.argv[3] !== undefined ? Number(process.argv[3]) : 10;

if (!AUTH) {
  console.error(
    "ERROR: set BRIGHTDATA_BROWSER_AUTH to your Browser API zone credentials " +
      "('USER:PASS' from the zone's Overview tab)."
  );
  process.exit(1);
}

const wsEndpoint = `wss://${AUTH}@${HOST}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;

async function main() {
  console.log("Connecting to Bright Data cloud browser…");
  browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });

  const page = await browser.newPage();
  const client = await page.createCDPSession();

  let sessionId;
  try {
    const r = await client.send("Browser.getSessionId");
    sessionId = r?.sessionId;
  } catch {}

  console.log(`Navigating to ${START_URL} …`);
  await page.goto(START_URL, { waitUntil: "load", timeout: 120000 });

  // --- Proof of what the REMOTE browser actually rendered ---
  try {
    const title = await page.title();
    const textLen = await page.evaluate(() => (document.body?.innerText || "").length);
    const snippet = await page.evaluate(() =>
      (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200)
    );
    console.log("\n--- Page diagnostics ---");
    console.log("Title       :", title || "(empty)");
    console.log("Text length :", textLen, "chars");
    console.log("Text snippet:", snippet || "(no visible text)");
    const shot = "session-screenshot.png";
    await page.screenshot({ path: shot, fullPage: true });
    console.log("Screenshot  : saved to " + shot + " (open it to see the page)");
    console.log("------------------------\n");
  } catch (e) {
    console.error("Diagnostics failed:", e.message);
  }

  // Ask the remote browser for a live, interactive DevTools inspect URL.
  let inspectUrl;
  try {
    const { frameTree } = await client.send("Page.getFrameTree");
    const frameId = frameTree.frame.id;
    const res = await client.send("Page.inspect", { frameId });
    inspectUrl = res?.url;
  } catch (e) {
    console.error("Could not obtain inspect URL via Page.inspect:", e.message);
  }

  console.log("========================================================");
  console.log("LIVE BROWSER SESSION IS OPEN");
  if (sessionId) console.log("Session id   :", sessionId);
  console.log("Current page :", page.url());
  if (inspectUrl) {
    console.log("\n>> Open this URL in any browser to watch & control the session:");
    console.log("   " + inspectUrl);
  } else {
    console.log(
      "\n(No inspect URL returned. You can also use the Browser API 'Playground'\n" +
        " in the Bright Data control panel for an interactive session.)"
    );
  }
  console.log("========================================================\n");

  if (KEEP_MINUTES === 0) {
    console.log("Keeping the session open until you press Ctrl+C…");
    await new Promise(() => {});
  } else {
    console.log(`Keeping the session open for ${KEEP_MINUTES} minute(s)…`);
    const endAt = Date.now() + KEEP_MINUTES * 60_000;
    while (Date.now() < endAt) {
      await sleep(15_000);
      const left = Math.max(Math.ceil((endAt - Date.now()) / 60_000), 0);
      console.log(`  …still alive (~${left} min left). Page: ${page.url()}`);
    }
    console.log("Time's up — closing the session.");
  }
}

async function shutdown() {
  try {
    if (browser) await browser.close();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", () => {
  console.log("\nClosing session (Ctrl+C)…");
  shutdown();
});

main()
  .then(shutdown)
  .catch(async (e) => {
    console.error("Fatal:", e.message || e);
    await shutdown();
  });
