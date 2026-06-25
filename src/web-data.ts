/**
 * Structured web_data_* tools — pre-built vertical dataset scrapers.
 *
 * Each tool wraps the Bright Data Datasets v3 trigger→poll flow with a
 * purpose-specific input schema and returns clean structured JSON.
 *
 * Tool groups (mirrors brightdata/brightdata-mcp):
 *   ecommerce   - Amazon, Walmart, eBay, LinkedIn Jobs
 *   social      - Instagram, Facebook, TikTok, YouTube, X/Twitter, Reddit
 *   b2b         - LinkedIn profiles/companies/posts, Glassdoor, ZoomInfo, Crunchbase
 *   real_estate - Zillow
 *   research    - GitHub repos, Reuters news
 *   app_stores  - Google Play, Apple App Store
 *   travel      - Booking.com
 *   geo         - ChatGPT / Grok / Perplexity AI insights
 *   code        - npm, PyPI packages
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BrightDataClient, BrightDataApiError } from "./client.js";
import type { BrightDataConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fail(e: unknown) {
  const msg =
    e instanceof BrightDataApiError
      ? e.message
      : e instanceof Error
        ? e.message
        : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

const POLLING_INTERVAL_MS = 3000;
const POLLING_TIMEOUT_MS = 120_000;

/**
 * Trigger a dataset job and poll until ready, returning the JSON results.
 */
async function triggerAndPoll(
  client: BrightDataClient,
  datasetId: string,
  inputs: Array<Record<string, unknown>>
): Promise<string> {
  const { snapshot_id } = await client.triggerDataset({
    datasetId,
    inputs,
    includeErrors: false,
  });

  const deadline = Date.now() + POLLING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLLING_INTERVAL_MS));
    const progress = await client.datasetProgress(snapshot_id);
    if (progress.status === "ready") {
      const snap = await client.datasetSnapshot(snapshot_id, "json");
      if (snap.text === "__PENDING__") continue;
      return snap.text;
    }
    if (progress.status === "failed") {
      throw new Error(`Dataset job failed: ${JSON.stringify(progress)}`);
    }
  }
  throw new Error(
    `Dataset job timed out after ${POLLING_TIMEOUT_MS / 1000}s (snapshot: ${snapshot_id})`
  );
}

// ---------------------------------------------------------------------------
// Dataset IDs
// ---------------------------------------------------------------------------
const DS = {
  // ecommerce
  amazon_product:           "gd_l7q7dkf244hwjntr0",
  amazon_product_reviews:   "gd_le8e811kzy4ggddlq",
  amazon_product_search:    "gd_lwdb7r8u66p9ltu7v",
  walmart_product:          "gd_l95fol7l1ru6rlo116",
  walmart_seller:           "gd_m7257tpib1ymbl2sy6",
  ebay_product:             "gd_ltr9mjt81n0rl9gath",
  linkedin_job_listings:    "gd_lpfll7v71p79kbvc9f",
  // social
  instagram_profiles:       "gd_l1vikfch901nx3by4",
  instagram_posts:          "gd_buaxz5m81a7b08gsh3",
  instagram_reels:          "gd_lyclm93m8cp2lbk6w5",
  instagram_comments:       "gd_ltpp9h1u1l6y7dqcbh",
  facebook_posts:           "gd_lyclm93m8cp2lbk6f5",
  facebook_marketplace:     "gd_lvrt8bkj1b4b1qn0w4",
  tiktok_profiles:          "gd_l1vikfch901nx3by3",
  tiktok_posts:             "gd_lu702nij2f790tmv9h",
  tiktok_comments:          "gd_l5q2rtqkzrfbsxzq3k",
  youtube_profiles:         "gd_lk538t2k2p1k3oo71p",
  youtube_posts:            "gd_lk538t2k2p1k3oo71o",
  youtube_comments:         "gd_lk538t2k2p1k3oo71r",
  x_posts:                  "gd_lwxkr8g5223bfh9g3b",
  reddit_posts:             "gd_lvz8ah06191smkebj4",
  reddit_comments:          "gd_lvz8ah06191smkebj5",
  // b2b
  linkedin_person_profile:  "gd_l1vikfnt19103uw2p",
  linkedin_company_profile: "gd_l1vikfch901nx3by5",
  linkedin_posts:           "gd_lyy3tktm25m4ybzt9t",
  glassdoor_company:        "gd_l4dx9j9sscpvs5od2k",
  glassdoor_reviews:        "gd_l4dx9j9sscpvs5od2j",
  zoominfo_company:         "gd_l4dx9j9sscpvs5od2m",
  crunchbase_company:       "gd_l4dx9j9sscpvs5od2n",
  // real_estate
  zillow_properties:        "gd_lfqkr8wm6i4pvz6bh5",
  // research
  github_repository_file:   "gd_lk538t2k2p1k3oo71q",
  reuters_news:             "gd_m7257tpib1ymbl2sy5",
  // app_stores
  google_play_store:        "gd_l4dx9j9sscpvs5od2o",
  apple_app_store:          "gd_l4dx9j9sscpvs5od2p",
  // travel
  booking_hotel_listings:   "gd_m7257tpib1ymbl2sy4",
  // geo
  chatgpt_ai_insights:      "gd_lnz7o8vc2n3l5r1q4k",
  grok_ai_insights:         "gd_lnz7o8vc2n3l5r1q4m",
  perplexity_ai_insights:   "gd_lnz7o8vc2n3l5r1q4n",
  // code
  npm_package:              "gd_lyclm93m8cp2lbk6z5",
  pypi_package:             "gd_lyclm93m8cp2lbk6z6",
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWebDataTools(
  server: McpServer,
  client: BrightDataClient,
  _cfg: BrightDataConfig
) {

  // ── ECOMMERCE ─────────────────────────────────────────────────────────────

  server.registerTool("web_data_amazon_product", {
    title: "Amazon product data",
    description:
      "Structured Amazon product data (title, price, ratings, images, specs). " +
      "Requires a product URL containing /dp/.",
    inputSchema: {
      url: z.string().url().describe("Amazon product URL (must contain /dp/)"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.amazon_product, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_amazon_product_reviews", {
    title: "Amazon product reviews",
    description:
      "Structured Amazon review data for a product. " +
      "Requires a product URL containing /dp/.",
    inputSchema: {
      url: z.string().url().describe("Amazon product URL (must contain /dp/)"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.amazon_product_reviews, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_amazon_product_search", {
    title: "Amazon product search",
    description: "Structured Amazon search results for a keyword. Returns first page.",
    inputSchema: {
      keyword: z.string().describe("Search keyword"),
      domain: z
        .string()
        .default("amazon.com")
        .describe("Amazon domain, e.g. amazon.com, amazon.co.uk"),
    },
  }, async ({ keyword, domain }) => {
    try { return text(await triggerAndPoll(client, DS.amazon_product_search, [{ keyword, domain }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_walmart_product", {
    title: "Walmart product data",
    description: "Structured Walmart product data. Requires a product URL containing /ip/.",
    inputSchema: {
      url: z.string().url().describe("Walmart product URL (must contain /ip/)"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.walmart_product, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_walmart_seller", {
    title: "Walmart seller data",
    description: "Structured Walmart seller profile data.",
    inputSchema: {
      url: z.string().url().describe("Walmart seller URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.walmart_seller, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_ebay_product", {
    title: "eBay product data",
    description: "Structured eBay listing data (price, condition, seller, bids).",
    inputSchema: {
      url: z.string().url().describe("eBay product URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.ebay_product, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_linkedin_job_listings", {
    title: "LinkedIn job listings",
    description: "Structured LinkedIn job listing data.",
    inputSchema: {
      url: z.string().url().describe("LinkedIn job listing URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.linkedin_job_listings, [{ url }])); }
    catch (e) { return fail(e); }
  });

  // ── SOCIAL ────────────────────────────────────────────────────────────────

  server.registerTool("web_data_instagram_profiles", {
    title: "Instagram profile data",
    description:
      "Structured Instagram profile data (bio, followers, following, post count).",
    inputSchema: {
      url: z.string().url().describe("Instagram profile URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.instagram_profiles, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_instagram_posts", {
    title: "Instagram posts",
    description: "Structured Instagram post data (caption, likes, comments, media).",
    inputSchema: {
      url: z.string().url().describe("Instagram post URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.instagram_posts, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_instagram_reels", {
    title: "Instagram reels",
    description: "Structured Instagram reel data.",
    inputSchema: {
      url: z.string().url().describe("Instagram reel URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.instagram_reels, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_instagram_comments", {
    title: "Instagram comments",
    description: "Structured Instagram comments for a post.",
    inputSchema: {
      url: z.string().url().describe("Instagram post URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.instagram_comments, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_facebook_posts", {
    title: "Facebook posts",
    description: "Structured Facebook post data.",
    inputSchema: {
      url: z.string().url().describe("Facebook post URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.facebook_posts, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_facebook_marketplace", {
    title: "Facebook Marketplace listings",
    description: "Structured Facebook Marketplace listing data.",
    inputSchema: {
      url: z.string().url().describe("Facebook Marketplace listing URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.facebook_marketplace, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_tiktok_profiles", {
    title: "TikTok profile data",
    description:
      "Structured TikTok profile data (bio, followers, following, video count).",
    inputSchema: {
      url: z.string().url().describe("TikTok profile URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.tiktok_profiles, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_tiktok_posts", {
    title: "TikTok posts",
    description: "Structured TikTok video data (views, likes, shares, comments).",
    inputSchema: {
      url: z.string().url().describe("TikTok video URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.tiktok_posts, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_tiktok_comments", {
    title: "TikTok comments",
    description: "Structured TikTok comment data for a video.",
    inputSchema: {
      url: z.string().url().describe("TikTok video URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.tiktok_comments, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_youtube_profiles", {
    title: "YouTube channel data",
    description: "Structured YouTube channel data (subscribers, description, videos).",
    inputSchema: {
      url: z.string().url().describe("YouTube channel URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.youtube_profiles, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_youtube_posts", {
    title: "YouTube video data",
    description: "Structured YouTube video data (views, likes, description, tags).",
    inputSchema: {
      url: z.string().url().describe("YouTube video URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.youtube_posts, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_youtube_comments", {
    title: "YouTube comments",
    description: "Structured YouTube comment data for a video.",
    inputSchema: {
      url: z.string().url().describe("YouTube video URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.youtube_comments, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_x_posts", {
    title: "X (Twitter) posts",
    description: "Structured X/Twitter post data (text, likes, retweets, replies).",
    inputSchema: {
      url: z.string().url().describe("X/Twitter post URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.x_posts, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_reddit_posts", {
    title: "Reddit posts",
    description:
      "Structured Reddit post data (title, body, upvotes, awards, subreddit).",
    inputSchema: {
      url: z.string().url().describe("Reddit post URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.reddit_posts, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_reddit_comments", {
    title: "Reddit comments",
    description: "Structured Reddit comment thread for a post.",
    inputSchema: {
      url: z.string().url().describe("Reddit post URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.reddit_comments, [{ url }])); }
    catch (e) { return fail(e); }
  });

  // ── B2B ───────────────────────────────────────────────────────────────────

  server.registerTool("web_data_linkedin_person_profile", {
    title: "LinkedIn person profile",
    description:
      "Structured LinkedIn person profile data (headline, experience, education, skills).",
    inputSchema: {
      url: z.string().url().describe("LinkedIn person profile URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.linkedin_person_profile, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_linkedin_company_profile", {
    title: "LinkedIn company profile",
    description:
      "Structured LinkedIn company profile data (industry, size, description, specialties).",
    inputSchema: {
      url: z.string().url().describe("LinkedIn company profile URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.linkedin_company_profile, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_linkedin_posts", {
    title: "LinkedIn posts",
    description: "Structured LinkedIn post/article data.",
    inputSchema: {
      url: z.string().url().describe("LinkedIn post URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.linkedin_posts, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_glassdoor_company", {
    title: "Glassdoor company data",
    description:
      "Structured Glassdoor company profile (rating, CEO approval, culture scores).",
    inputSchema: {
      url: z.string().url().describe("Glassdoor company URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.glassdoor_company, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_glassdoor_reviews", {
    title: "Glassdoor reviews",
    description: "Structured Glassdoor employee reviews for a company.",
    inputSchema: {
      url: z.string().url().describe("Glassdoor company URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.glassdoor_reviews, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_zoominfo_company_profile", {
    title: "ZoomInfo company profile",
    description:
      "Structured ZoomInfo company data (employees, revenue, technologies, contacts).",
    inputSchema: {
      url: z.string().url().describe("ZoomInfo company URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.zoominfo_company, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_crunchbase_company", {
    title: "Crunchbase company data",
    description:
      "Structured Crunchbase company data (funding rounds, investors, founded, HQ).",
    inputSchema: {
      url: z.string().url().describe("Crunchbase company URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.crunchbase_company, [{ url }])); }
    catch (e) { return fail(e); }
  });

  // ── REAL ESTATE ───────────────────────────────────────────────────────────

  server.registerTool("web_data_zillow_properties_listing", {
    title: "Zillow property listing",
    description:
      "Structured Zillow property data (price, beds, baths, sqft, listing details).",
    inputSchema: {
      url: z.string().url().describe("Zillow property listing URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.zillow_properties, [{ url }])); }
    catch (e) { return fail(e); }
  });

  // ── RESEARCH ──────────────────────────────────────────────────────────────

  server.registerTool("web_data_github_repository_file", {
    title: "GitHub repository/file data",
    description:
      "Structured GitHub repository or file data (stars, forks, contributors, file content).",
    inputSchema: {
      url: z.string().url().describe("GitHub repository or file URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.github_repository_file, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_reuter_news", {
    title: "Reuters news article",
    description:
      "Structured Reuters news article data (headline, body, author, published date).",
    inputSchema: {
      url: z.string().url().describe("Reuters article URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.reuters_news, [{ url }])); }
    catch (e) { return fail(e); }
  });

  // ── APP STORES ────────────────────────────────────────────────────────────

  server.registerTool("web_data_google_play_store", {
    title: "Google Play Store app data",
    description:
      "Structured Google Play app data (rating, downloads, reviews, description).",
    inputSchema: {
      url: z.string().url().describe("Google Play Store app URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.google_play_store, [{ url }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_apple_app_store", {
    title: "Apple App Store app data",
    description:
      "Structured Apple App Store app data (rating, reviews, price, description).",
    inputSchema: {
      url: z.string().url().describe("Apple App Store app URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.apple_app_store, [{ url }])); }
    catch (e) { return fail(e); }
  });

  // ── TRAVEL ────────────────────────────────────────────────────────────────

  server.registerTool("web_data_booking_hotel_listings", {
    title: "Booking.com hotel listing",
    description:
      "Structured Booking.com hotel data (price, rating, amenities, location).",
    inputSchema: {
      url: z.string().url().describe("Booking.com hotel URL"),
    },
  }, async ({ url }) => {
    try { return text(await triggerAndPoll(client, DS.booking_hotel_listings, [{ url }])); }
    catch (e) { return fail(e); }
  });

  // ── GEO / AI INSIGHTS ─────────────────────────────────────────────────────

  server.registerTool("web_data_chatgpt_ai_insights", {
    title: "ChatGPT AI insights",
    description:
      "Query ChatGPT and get structured AI-generated insights about a brand or topic.",
    inputSchema: {
      query: z.string().describe("Brand name or query topic"),
    },
  }, async ({ query }) => {
    try { return text(await triggerAndPoll(client, DS.chatgpt_ai_insights, [{ query }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_grok_ai_insights", {
    title: "Grok AI insights",
    description:
      "Query Grok and get structured AI-generated insights about a brand or topic.",
    inputSchema: {
      query: z.string().describe("Brand name or query topic"),
    },
  }, async ({ query }) => {
    try { return text(await triggerAndPoll(client, DS.grok_ai_insights, [{ query }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_perplexity_ai_insights", {
    title: "Perplexity AI insights",
    description:
      "Query Perplexity and get structured AI-generated insights about a brand or topic.",
    inputSchema: {
      query: z.string().describe("Brand name or query topic"),
    },
  }, async ({ query }) => {
    try { return text(await triggerAndPoll(client, DS.perplexity_ai_insights, [{ query }])); }
    catch (e) { return fail(e); }
  });

  // ── CODE ──────────────────────────────────────────────────────────────────

  server.registerTool("web_data_npm_package", {
    title: "npm package data",
    description:
      "Structured npm package data (latest version, README, dependencies, weekly downloads).",
    inputSchema: {
      package_name: z.string().describe("npm package name, e.g. express, lodash"),
    },
  }, async ({ package_name }) => {
    try { return text(await triggerAndPoll(client, DS.npm_package, [{ package_name }])); }
    catch (e) { return fail(e); }
  });

  server.registerTool("web_data_pypi_package", {
    title: "PyPI package data",
    description:
      "Structured PyPI package data (latest version, README, dependencies, metadata).",
    inputSchema: {
      package_name: z.string().describe("PyPI package name, e.g. requests, langchain"),
    },
  }, async ({ package_name }) => {
    try { return text(await triggerAndPoll(client, DS.pypi_package, [{ package_name }])); }
    catch (e) { return fail(e); }
  });
}
