/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * video.navigation.test.ts: Unit tests for the route navigateToPage picks. Every navigation on the tune path, the re-establishment path, and the recovery route
 * comes through that one function, and what it decides is whether the profile's strategy enters its site for itself or whether the page is simply loaded at the
 * URL it was handed.
 *
 * The rows read the decision off the page double rather than off the function's return, because the function returns nothing either way. A plain load carries the
 * URL alone under a profile that does not wait for network idle; a strategy that owns its route supplies its own site's wait and, when its site needs it, a second
 * document load somewhere else entirely. Those two shapes cannot be confused for each other, which is what makes them the observation.
 *
 * The guideGrid rows drive the real Hulu provider through the registry rather than a stand-in, because the registry lookup is half of what is under test: a
 * dispatch that found nothing would look exactly like a profile with no navigator.
 */
import { describe, test } from "node:test";
import { makeDocumentResponse, makeFakePage } from "../testing.helpers.ts";
import type { FakePage } from "../testing.helpers.ts";
import assert from "node:assert/strict";
import { huluProvider } from "./tuning/hulu.ts";
import { makeProfile } from "../config/profiles.helpers.ts";
import { navigateToPage } from "./video.ts";

// The Hulu hub, declared here because the module keeps it private: the rows observe which URL was requested rather than which constant produced it.
const HULU_HUB_URL = "https://www.hulu.com/hub/home";

// The guide URL a Hulu tune asks to be put on.
const HULU_LIVE_URL = "https://www.hulu.com/live";

/**
 * Builds a page double that answers every call the Hulu route makes, with successive document loads answering the statuses the row scripts and anything past the
 * end of that script answering success.
 * @param statuses - The HTTP statuses successive document loads answer with.
 * @returns The double.
 */
function makeRoutedPage(...statuses: number[]): FakePage {

  return makeFakePage({

    onElementEvaluate: (call) => call.resolve(undefined),
    onEvaluate: (call) => {

      /* The Hulu route clicks through the pointer chain, which asks the page where its target sits and whether that target is what paints there. Both are
       * answered by the page function's own name, so the click completes and the route runs on; every other evaluate is the profile-selector probe.
       */
      const pageFunction = call.args[0] as { name?: string };

      switch(pageFunction.name) {

        case "locateSelectorCoordinate":

          call.resolve({ x: 640, y: 40 });

          break;

        case "isSelectorAtPoint":

          call.resolve(true);

          break;

        default:

          call.resolve({ present: false });

          break;
      }
    },
    onGoto: (call, index) => call.resolve(makeDocumentResponse(statuses[index] ?? 200)),
    onMouseClick: (call) => call.resolve(undefined),
    onWaitForFrame: (call) => call.resolve(undefined),
    onWaitForFunction: (call) => call.resolve(true),
    onWaitForSelector: (call) => call.resolve({})
  });
}

/**
 * Reads back the URL of every document load a page double received.
 * @param fake - The page double to read.
 * @returns The URLs, in issue order.
 */
function loadedUrls(fake: FakePage): string[] {

  return fake.navigations.map((call) => String(call.args[0]));
}

describe("navigateToPage - the route a profile takes", () => {

  test("loads the URL plainly for a profile whose strategy declares no navigator", async () => {

    // The generic path, unchanged: a profile that does not wait for network idle gets a bare load, with no options object to carry a wait or a timeout.
    const fake = makeRoutedPage();
    const profile = makeProfile({ channelSelection: { strategy: "thumbnailRow" }, waitForNetworkIdle: false });

    await navigateToPage(fake.page, "https://plain.test/watch", profile);

    assert.equal(fake.navigations.length, 1, "one document load");
    assert.deepEqual(fake.navigations[0]?.args, ["https://plain.test/watch"], "carrying the URL and nothing else");
  });

  test("hands a guideGrid profile to the provider's own route, which supplies its site's wait", async () => {

    /* The dispatch itself. This profile does not wait for network idle, so the generic path would issue a bare load - the wait options on the call are therefore
     * proof that the provider's route took over and stated the preference for its own site.
     */
    const fake = makeRoutedPage();
    const profile = makeProfile({ channelSelection: { strategy: "guideGrid" }, waitForNetworkIdle: false });

    await navigateToPage(fake.page, HULU_LIVE_URL, profile);

    assert.deepEqual(loadedUrls(fake), [HULU_LIVE_URL], "one document load, at the URL it was handed");
    assert.equal((fake.navigations[0]?.args[1] as { waitUntil: string }).waitUntil, "networkidle2", "under the provider's own wait rather than the profile's");
  });

  test("reaches the provider's fallback route when the guide's own URL answers a failed status", async () => {

    /* The dispatch carried all the way through: a failed status on the direct load is the provider's signal, and the second document load going somewhere the
     * caller never named is what proves navigateToPage handed the route over rather than interpreting the status itself.
     */
    const fake = makeRoutedPage(500);
    const profile = makeProfile({ channelSelection: { strategy: "guideGrid" }, waitForNetworkIdle: false });

    await navigateToPage(fake.page, HULU_LIVE_URL, profile);

    assert.deepEqual(loadedUrls(fake), [ HULU_LIVE_URL, HULU_HUB_URL ], "the route fell back to the hub inside the same navigation");

    /* The provider remembers a failing direct load in module state that a cache clear deliberately does not touch, so this row puts it back the way a running
     * session does - through a discovery walk, which re-tests the direct load on every walk - and leaves the file safe for any row added after it. The restore
     * is asserted rather than assumed, because a cleanup that quietly stopped working would leave the next row inheriting a route it never asked for.
     */
    await huluProvider.discoverChannels(makeRoutedPage().page);

    const restored = makeRoutedPage();

    await navigateToPage(restored.page, HULU_LIVE_URL, profile);

    assert.deepEqual(loadedUrls(restored), [HULU_LIVE_URL], "the walk put the provider back on the direct route");
  });
});
