/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * navigation.ts: Document-load primitives for PrismCast's page navigation.
 */
import type { HTTPResponse, Page } from "puppeteer-core";
import { CONFIG } from "../config/index.ts";
import { LOG } from "../utils/index.ts";
import type { Nullable } from "../types/index.ts";

/* Every page navigation in the system runs on the two functions below: putting a page on a URL, and reloading the page it is on. They live in a leaf module so
 * that the strategy-aware navigation in video.ts and a provider's own route into its guide share one implementation of the wait strategy, the timeout tolerance,
 * and the warning text, rather than each growing its own copy.
 *
 * The module holds mechanism only. Which route a page takes - the plain document load or a provider's own entry - is video.ts's decision, and what a provider
 * does inside its route is the provider's. Nothing here reads a profile or knows a strategy.
 */

/**
 * How a document load waits. The profile's own preference on the generic path; a provider that owns its route states the preference for its site.
 */
export interface DocumentLoadOptions {

  // Whether to wait for network activity to settle (up to two concurrent requests for 500 ms) rather than returning at the load event. Complex players with heavy
  // asynchronous initialization need the settle; sites with persistent connections or continuous polling would never reach it and return at load instead.
  readonly waitForNetworkIdle: boolean;
}

/**
 * Puts the page on the given URL and waits for it the way the options ask. Under the network-idle wait, the load returns once network activity settles, allowing
 * up to two concurrent connections for 500 ms, which is what gives a complex JavaScript player time to finish initializing; the wait also carries the navigation
 * timeout, and a timeout under it is tolerated rather than thrown, because the video frequently has loaded even when some background request never completed.
 * Without the network-idle wait the load returns as soon as the page fires its load event, which is the only workable answer for a site whose persistent
 * connections or continuous polling would keep it from ever reaching idle, and a failure there propagates.
 * @param page - The Puppeteer page object.
 * @param url - The URL to load.
 * @param options - The wait preference for this load.
 * @returns The document response, or null when the network-idle wait timed out and the page was left as it loaded.
 */
export async function loadDocument(page: Page, url: string, options: DocumentLoadOptions): Promise<Nullable<HTTPResponse>> {

  if(options.waitForNetworkIdle) {

    try {

      // Wait for network activity to settle. This ensures complex JavaScript players have fully initialized. The networkidle2 strategy allows up to 2
      // concurrent requests, which handles sites with persistent connections for analytics.
      return await page.goto(url, { timeout: CONFIG.streaming.navigationTimeout, waitUntil: "networkidle2" });
    } catch(error) {

      // Timeout errors during navigation are common and often non-fatal - the video may have loaded successfully even if some background requests never
      // completed. We log a warning and continue rather than throwing.
      if(error && ((error as Error).name === "TimeoutError")) {

        LOG.warn("Page navigation timed out after %sms for %s.", CONFIG.streaming.navigationTimeout, url);

        return null;
      }

      // Non-timeout errors (network failure, invalid URL, etc.) should be propagated for retry handling.
      throw error;
    }
  }

  // Simple navigation without waiting for network idle. Returns after the load event fires. Used for sites that would never reach networkidle due to
  // persistent connections, streaming data, or continuous polling.
  return page.goto(url);
}

/**
 * Reloads the page it is handed, mirroring loadDocument's wait strategy and its timeout tolerance so a reload and a fresh load of the same site behave the same
 * way. A reload timeout is often non-fatal - the player may already be present even if some background requests never settled - so it warns and continues, and
 * every other error propagates.
 * @param page - The Puppeteer page object.
 * @param options - The wait preference for this reload.
 */
export async function reloadDocument(page: Page, options: DocumentLoadOptions): Promise<void> {

  const waitUntil = options.waitForNetworkIdle ? "networkidle2" : "load";

  try {

    await page.reload({ timeout: CONFIG.streaming.navigationTimeout, waitUntil });
  } catch(error) {

    if(error && ((error as Error).name === "TimeoutError")) {

      LOG.warn("Page reload timed out after %sms.", CONFIG.streaming.navigationTimeout);
    } else {

      throw error;
    }
  }
}
