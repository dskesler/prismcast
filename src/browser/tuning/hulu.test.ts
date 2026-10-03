/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hulu.test.ts: Unit tests for the Hulu Live TV provider module. The guide is virtualized, so the strategy drives a scroll-and-read loop rather than one big
 * read - which is what makes a page stub worth building here: it serves each evaluate by the source of the function handed to it, and every scroll the strategy
 * asks for is recorded. Those scroll counts are the instrument. A warm tune that scrolls once went straight to the row it remembered; a warm tune that scrolls
 * more than once fell back to searching for it.
 *
 * The describes split by behavior surface rather than by export, following the module's single provider object: the warm-cache shortcut, and the fast-path
 * resolution that can end a cold tune before it ever reaches the click.
 *
 * What the shortcut has to get right is row recognition. It scrolls to a row number it cached, reads what rendered there, and has to decide whether the channel
 * it wants is on screen - and the name it asked for is frequently not the name that row displays. A local affiliate is filed under its network name and renders
 * as its call sign; a channel whose guide name differs from the user's channelSelector by punctuation is filed under the guide's spelling and found through a
 * fuzzy key. Both cases are one cache entry reachable by two names, so entry identity is what recognizes the row, and both are asserted below.
 */
import type { ChannelSelectionProfile, Nullable } from "../../types/index.ts";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { findCurrentEabFromPrograms, huluProvider } from "./hulu.ts";
import { initDebugFilter, subscribeToLogs } from "../../utils/index.ts";
import { makeDocumentResponse, makeFakePage } from "../../testing.helpers.ts";
import { CONFIG } from "../../config/index.ts";
import type { FakePage } from "../../testing.helpers.ts";
import type { HuluListingProgram } from "./hulu.ts";
import type { Page } from "puppeteer-core";
import assert from "node:assert/strict";
import { makeProfile } from "../../config/profiles.helpers.ts";

// One guide row as readRenderedChannels reads it out of the DOM: the lowercased data-testid name it matches on, the original-cased display name, and the
// zero-based row number recovered from the row's screen-reader text.
interface RenderedRow {

  readonly displayName: string;
  readonly name: string;
  readonly rowNumber: number;
}

interface GuidePage {

  // Every coordinate pair clicked, in order.
  readonly clicks: { x: number; y: number }[];

  // Every channel name the strategy asked to locate an on-now cell for, in order. The last one is the row it actually clicked.
  readonly locates: string[];

  // How many times the held playlist was released, which the click path does and a resolved fast path does not.
  readonly releases: () => number;

  // How many times the strategy asked the in-page interceptor whether it had already resolved the tune itself.
  readonly resolveChecks: () => number;

  // Every scroll offset the strategy asked for, in order. Its length is the probe count that separates a shortcut from a search.
  readonly scrolls: number[];

  // Swaps the rows the guide renders, standing in for a different market's lineup.
  readonly setLineup: (rows: RenderedRow[]) => void;

  // Makes the in-page interceptor report that it resolved the tune on its own, which is the fast path a cold tune can end on.
  readonly setSelfResolved: (resolved: boolean) => void;

  // The Page-shaped stub to hand the provider.
  readonly stub: Page;
}

// A guide tall enough to search but short enough to read: the first probe lands on row 9 and the whole lineup renders in one window there.
const TOTAL_ROWS = 20;

// Where the Channels tab sits in the guide fixture's viewport. The strategy resolves the tab's own center before clicking it, so this is the point the click
// lands on and the point a row reads back.
const TAB_CENTER = { x: 120, y: 60 };

/* An affiliate market. The call sign occupies the DOM position where its network name would sort, which is exactly what position inference reads: "abc" sorts
 * after "aaa" and before "zulu", and the only call-sign-shaped row between those two anchors is the affiliate.
 */
const AFFILIATE_LINEUP: RenderedRow[] = [

  { displayName: "AAA Network", name: "aaa", rowNumber: 4 },
  { displayName: "WABC", name: "wabc", rowNumber: 5 },
  { displayName: "Zulu", name: "zulu", rowNumber: 6 }
];

// A lineup carrying a channel whose guide spelling differs from the channelSelector a user would write for it only by punctuation and spacing.
const PUNCTUATED_LINEUP: RenderedRow[] = [

  { displayName: "AAA Network", name: "aaa", rowNumber: 4 },
  { displayName: "C-SPAN 3", name: "c-span 3", rowNumber: 5 },
  { displayName: "Zulu", name: "zulu", rowNumber: 6 }
];

/* makeGuidePage returns a Page-shaped stub for the surfaces guideGridStrategy touches. Every evaluate is dispatched by the source of the page function it was
 * handed, because the strategy's reads are distinguished by what they look for in the DOM rather than by any argument: a marker unique to each read picks the
 * canned answer for it. An evaluate whose source matches nothing throws rather than returning undefined, so a read this stub does not know about surfaces as a
 * failure naming itself instead of as a mystery further down the strategy.
 */
function makeGuidePage(rows: RenderedRow[] = []): GuidePage {

  const clicks: { x: number; y: number }[] = [];
  const locates: string[] = [];
  const scrolls: number[] = [];

  let lineup = rows;
  let releases = 0;
  let resolveChecks = 0;
  let selfResolved = false;

  const evaluate = async (pageFunction: unknown, ...args: unknown[]): Promise<unknown> => {

    const source = String(pageFunction);

    await Promise.resolve();

    // The profile-selector probe, answered as an account that was never prompted.
    if(source.includes("ProfileSelectorModal")) {

      return { present: false };
    }

    // The coordinate resolver behind every pointer click, recognized by the rectangle it re-reads once the element has been scrolled into view.
    if(source.includes("scrolled")) {

      return TAB_CENTER;
    }

    // The hit test the pointer click runs at those coordinates, recognized by its point lookup. The tab is always what paints there in this fixture.
    if(source.includes("elementFromPoint")) {

      return true;
    }

    // The grid metadata read. A 100px row height makes every scroll offset the row index times a round number.
    if(source.includes("spacerHeight")) {

      return { gridDocTop: 0, rowHeight: 100, totalRows: TOTAL_ROWS };
    }

    // The scroll that brings a row range into the render window.
    if(source.includes("documentElement.scrollTop")) {

      scrolls.push(args[0] as number);

      return undefined;
    }

    // The rendered-row read. Its screen-reader lookup is what distinguishes it from the other reads over the same containers.
    if(source.includes("sr-only")) {

      return lineup;
    }

    // The fast path's two mechanisms: injecting a captured channel into the held playlist request, and asking whether the interceptor got there first.
    if(source.includes("__prismcastResolveDirectTune")) {

      return false;
    }

    if(source.includes("__prismcastIsDirectTuneResolved")) {

      resolveChecks++;

      return selfResolved;
    }

    if(source.includes("__prismcastReleasePlaylist")) {

      releases++;

      return undefined;
    }

    // The post-failure click diagnostics, which only run once every click attempt has been spent.
    if(source.includes("elementsFromPoint")) {

      return { elementStack: [], hydrated: true, onNowFound: true, pageAge: 0 };
    }

    // The on-now cell lookup, keyed by the name the strategy decided to click.
    if(source.includes("LiveGuideProgram--first")) {

      locates.push(String(args[0]));

      return { x: 10, y: 20 };
    }

    throw new Error("Unserved evaluate shape: " + source.slice(0, 160));
  };

  const stub = {

    $eval: async (): Promise<undefined> => {

      await Promise.resolve();

      return undefined;
    },
    evaluate,
    keyboard: {

      press: async (): Promise<undefined> => {

        await Promise.resolve();

        return undefined;
      }
    },
    mouse: {

      click: async (x: number, y: number): Promise<undefined> => {

        clicks.push({ x, y });

        await Promise.resolve();

        return undefined;
      }
    },
    waitForSelector: async (): Promise<null> => {

      await Promise.resolve();

      return null;
    }
  } as unknown as Page;

  return {

    clicks,
    locates,
    releases: (): number => releases,
    resolveChecks: (): number => resolveChecks,
    scrolls,
    setLineup: (next: RenderedRow[]): void => {

      lineup = next;
    },
    setSelfResolved: (resolved: boolean): void => {

      selfResolved = resolved;
    },
    stub
  };
}

// makeHuluProfile narrows a neutral profile to what the strategy requires. It carries no play selector, so the tune completes on the on-now cell click rather
// than waiting for a play button that this fixture's page would never render.
function makeHuluProfile(channelSelector: string): ChannelSelectionProfile {

  return makeProfile({ channelSelection: { listSelector: "#CHANNELS", strategy: "guideGrid" }, channelSelector }) as ChannelSelectionProfile;
}

// Every log line emitted during a test, captured off the same emitter the web UI's log stream reads.
let captured: string[] = [];
let unsubscribe: Nullable<() => void> = null;

before(() => {

  // The shortcut announces itself only at debug level, so the category has to be on for the branch to be observable at all.
  initDebugFilter("tuning:hulu");
});

after(() => {

  initDebugFilter("");
});

beforeEach(() => {

  captured = [];
  unsubscribe = subscribeToLogs((entry) => { captured.push(entry.message); });
});

afterEach(() => {

  unsubscribe?.();
  unsubscribe = null;

  // The channel cache is module state, so every test starts from the empty cache a browser restart produces.
  huluProvider.strategy.clearCache?.();
});

describe("warm guide cache shortcut", () => {

  test("scrolls straight to a local affiliate's row and clicks its call sign", async () => {

    /* The first tune has to find the affiliate the hard way: the search converges on the window where "abc" would sort, position inference names the call sign
     * sitting there, and the cross-reference files the network name against the affiliate's own cache entry. That alias is what the second tune resolves, and
     * the row it lands on renders as "WABC" rather than as anything named "abc" - so recognizing it is a question about which entry the row belongs to.
     */
    const guide = makeGuidePage(AFFILIATE_LINEUP);

    const cold = await huluProvider.strategy.execute(guide.stub, makeHuluProfile("abc"));

    assert.equal(cold.success, true, "the cold tune finds the affiliate through position inference");
    assert.equal(guide.scrolls.length, 1, "the first tune converges on the affiliate's window in a single probe");

    const coldScrolls = guide.scrolls.length;

    const warm = await huluProvider.strategy.execute(guide.stub, makeHuluProfile("abc"));

    assert.ok(captured.some((message) => message.includes("Guide cache hit")), "the second tune enters the shortcut rather than searching from cold");
    assert.equal(guide.scrolls.length - coldScrolls, 1, "the shortcut scrolls once to the remembered row and stops there");
    assert.equal(warm.success, true, "the warm tune succeeds");
    assert.equal(guide.locates.at(-1), "wabc", "the row that was clicked is the affiliate's call sign, which is what the guide actually renders");
  });

  test("scrolls straight to a row whose guide spelling differs from the channel selector", async () => {

    /* The other way one entry answers to two names: a channelSelector written without the guide's spacing resolves through the fuzzy key lookup. The entry the
     * shortcut trusted is filed under the guide's spelling, so the rendered row never carries the name that was asked for.
     */
    const guide = makeGuidePage(PUNCTUATED_LINEUP);

    const seed = await huluProvider.strategy.execute(guide.stub, makeHuluProfile("C-SPAN 3"));

    assert.equal(seed.success, true, "tuning by the guide's own spelling caches the row");

    const seedScrolls = guide.scrolls.length;

    const warm = await huluProvider.strategy.execute(guide.stub, makeHuluProfile("C-SPAN3"));

    assert.ok(captured.some((message) => message.includes("Guide cache hit")), "the fuzzy key resolves to the cached entry and enters the shortcut");
    assert.equal(guide.scrolls.length - seedScrolls, 1, "the shortcut scrolls once to the remembered row and stops there");
    assert.equal(warm.success, true, "the warm tune succeeds");
    assert.equal(guide.locates.at(-1), "c-span 3", "the row that was clicked is the one the guide renders, not the spelling the request used");
  });

  test("opens the Channels tab with a pointer click at the tab's own coordinates", async () => {

    /* The guide populates its rows for a page that has seen a pointer, so the tab that opens it is clicked the way the on-now cell is: at a point the page
     * resolved, through the full pointer chain. The order is the other half of the assertion, because the tab click is what makes the rows the on-now click
     * needs exist at all.
     */
    const guide = makeGuidePage(AFFILIATE_LINEUP);

    const result = await huluProvider.strategy.execute(guide.stub, makeHuluProfile("zulu"));

    assert.equal(result.success, true, "the tune succeeds");
    assert.equal(guide.clicks.length, 2, "the tab and the on-now cell, each clicked once");
    assert.deepEqual(guide.clicks[0], TAB_CENTER, "the tab first, at the point it was located at");
  });

  test("clicks the requested name when the row renders under it", async () => {

    // The ordinary case, where the cached entry's key and the rendered row's name are the same string. Nothing about recognizing an aliased row may change what
    // this one does.
    const guide = makeGuidePage(AFFILIATE_LINEUP);

    await huluProvider.strategy.execute(guide.stub, makeHuluProfile("zulu"));

    const coldScrolls = guide.scrolls.length;

    const warm = await huluProvider.strategy.execute(guide.stub, makeHuluProfile("zulu"));

    assert.equal(warm.success, true, "the warm tune succeeds");
    assert.equal(guide.scrolls.length - coldScrolls, 1, "the shortcut scrolls once to the remembered row");
    assert.equal(guide.locates.at(-1), "zulu", "the row clicked is the one that was asked for");
  });
});

describe("cold tune fast path", () => {

  test("returns as soon as the interceptor resolves the tune, skipping the release and the click", async () => {

    /* When the in-page interceptor has already swapped the playlist request for the inferred affiliate, the tune is done: there is nothing left to release, no
     * second resolution to attempt, and no cell to click. Each of those three is asserted by its absence, because a resolution that fell through to them would
     * still report success while doing the work twice.
     */
    const guide = makeGuidePage(AFFILIATE_LINEUP);

    guide.setSelfResolved(true);

    const result = await huluProvider.strategy.execute(guide.stub, makeHuluProfile("abc"));

    assert.equal(result.success, true, "the resolved fast path is the tune's result");
    assert.equal(guide.resolveChecks(), 1, "the tune stops at the resolution rather than asking again after the search");
    assert.equal(guide.releases(), 0, "a resolved playlist is never released back to the click flow");
    assert.deepEqual(guide.locates, [], "no on-now cell is looked up once the tune is resolved");
    assert.deepEqual(guide.clicks, [TAB_CENTER], "the tab that opened the guide is the only click; no cell click follows the resolution");
  });
});

describe("findCurrentEabFromPrograms", () => {

  /* Two back-to-back airings, so the row set covers the inside of a window, the boundary where one hands off to the next, and the gap past both. The windows are
   * built as ISO strings because that is what the listing API returns and what the lookup parses, and the instants are handed in rather than read from the wall
   * clock, so the comparison is exact instead of dependent on when the row runs.
   */
  const programs: HuluListingProgram[] = [

    { airingEnd: new Date(2000).toISOString(), airingStart: new Date(1000).toISOString(), eab: "first" },
    { airingEnd: new Date(3000).toISOString(), airingStart: new Date(2000).toISOString(), eab: "second" }
  ];

  test("answers the program whose window brackets the instant", () => {

    assert.equal(findCurrentEabFromPrograms(programs, 1500), "first", "an instant inside the first window answers the first program");
  });

  test("treats a window's start as inclusive and its end as exclusive", () => {

    // The handoff instant belongs to the airing that starts there, not to the one that ends there, so a boundary read never reports the program just finished.
    assert.equal(findCurrentEabFromPrograms(programs, 2000), "second", "the boundary instant answers the program whose window starts on it");
  });

  test("answers null when nothing is airing", () => {

    assert.equal(findCurrentEabFromPrograms(programs, 3000), null, "an instant past both windows answers null");
    assert.equal(findCurrentEabFromPrograms([], 1500), null, "an empty schedule answers null");
  });
});

/* The guide-entry describe drives the module's own route into the live guide, which is the one part of this file that observes Hulu's server rather than Hulu's
 * DOM. A direct request for the guide's URL has answered an error status since early September 2026, and the route the module takes in its place - load the home
 * hub, click the header's Live link, wait for the route to land - is what these rows follow.
 *
 * Two instruments carry the rows. The ordered event log records every page call in issue order, so "the hub was loaded before the profile probe ran" is an
 * observation rather than two separate counts; and the INFO lines are captured off the log emitter, because the memo that remembers a failing direct load
 * announces only its transitions and a row asserting "once" has to see all of them.
 *
 * The memo is module state that deliberately survives the cache clear, so every row starts from a restored direct entry and the restore is asserted rather than
 * assumed.
 */

// The hub the module enters the guide through. It is declared here rather than imported because the module keeps it private: the rows observe which URL was
// requested, which is the behavior, not which constant produced it.
const HULU_HUB_URL = "https://www.hulu.com/hub/home";

// The live guide's own URL, which is what a tune and a discovery walk both ask to be put on.
const HULU_LIVE_URL = "https://www.hulu.com/live";

// The header's Live link, identified by its route because it carries no test id.
const HULU_LIVE_NAV_SELECTOR = "a[href=\"/live\"]";

// Where the Live link sits in the entry fixture's viewport. The route resolves the link's own center and clicks that point, so this is what a row reads back
// off the recorded click.
const LIVE_LINK_CENTER = { x: 640, y: 40 };

// What a scripted document load answers: an HTTP status, or the tolerated navigation timeout.
type ScriptedLoad = number | "timeout";

// The page double plus the ordered log of what the module asked it to do.
interface EntryPage {

  // Every page call the entry made, in issue order, each naming what it asked for.
  readonly events: string[];

  // The underlying double, for the rows that read a call's recorded arguments directly.
  readonly fake: FakePage;
}

/**
 * Builds the page double the guide-entry rows run against. Every asynchronous member is answered as it is issued, so the entry runs to completion without the row
 * driving it, and each answer is logged in issue order first.
 * @param options - The statuses successive document loads answer with, the selectors whose waits never resolve, and the error the frame wait rejects with when
 * a row wants a route that never lands.
 * @returns The double and its event log.
 */
function makeEntryPage(options: { rejectSelectors?: readonly string[]; routeWaitError?: Error; statuses?: readonly ScriptedLoad[] } = {}): EntryPage {

  const events: string[] = [];
  const rejectSelectors = options.rejectSelectors ?? [];
  const statuses = options.statuses ?? [];

  const fake = makeFakePage({

    onElementEvaluate: (call) => {

      events.push("$eval:" + String(call.args[0]));
      call.resolve(undefined);
    },
    onEvaluate: (call) => {

      // The entry's evaluates are told apart by which page function was handed over, so each is answered by that function's own name.
      const pageFunction = call.args[0] as { name?: string };

      switch(pageFunction.name) {

        case "locateSelectorCoordinate": {

          events.push("locate:" + String(call.args[1]));
          call.resolve(LIVE_LINK_CENTER);

          break;
        }

        case "isSelectorAtPoint": {

          // The hit test is handed the selector and the point together, and the link is always what paints there in this fixture.
          const input = call.args[1] as { selector: string };

          events.push("hit:" + input.selector);
          call.resolve(true);

          break;
        }

        default: {

          // Every other evaluate the entry makes is the profile-selector probe, answered as an account that was never prompted.
          events.push("evaluate");
          call.resolve({ present: false });

          break;
        }
      }
    },
    onGoto: (call, index) => {

      events.push("goto:" + String(call.args[0]));

      /* A load past the end of the script answers 200. That is what a row scripting only the direct load's failure wants for the hub load that follows it: the
       * hub is the route that works, and scripting it every time would say nothing.
       */
      const scripted = statuses[index] ?? 200;

      if(scripted === "timeout") {

        call.reject(Object.assign(new Error("Navigation timeout of 30000 ms exceeded"), { name: "TimeoutError" }));

        return;
      }

      call.resolve(makeDocumentResponse(scripted));
    },
    onMouseClick: (call) => {

      events.push("click");
      call.resolve(undefined);
    },
    onWaitForFrame: (call) => {

      events.push("waitForFrame");

      if(options.routeWaitError) {

        call.reject(options.routeWaitError);

        return;
      }

      // The route reads nothing from the frame it waited for, so what the wait answers with is never observed.
      call.resolve(undefined);
    },
    onWaitForSelector: (call) => {

      const selector = String(call.args[0]);

      events.push("wait:" + selector);

      if(rejectSelectors.includes(selector)) {

        call.reject(new Error("Waiting failed for " + selector + "."));

        return;
      }

      call.resolve({});
    }
  });

  return { events, fake };
}

/**
 * Puts a page on a URL through the Hulu strategy's own navigator, asserting on the way that the strategy registers one at all. Every row drives the entry through
 * this hook rather than through a module-private function, because the hook is what the navigation and reload paths in video.ts reach for.
 * @param page - The page double to navigate.
 * @param url - The URL to enter.
 */
async function navigateHulu(page: Page, url: string): Promise<void> {

  const navigate = huluProvider.strategy.navigate;

  assert.ok(navigate, "the Hulu strategy registers its own navigator");

  await navigate(page, url);
}

/**
 * Reads back the URL of every document load a page double received.
 * @param page - The page double to read.
 * @returns The URLs, in issue order.
 */
function loadedUrls(page: EntryPage): string[] {

  return page.fake.navigations.map((call) => String(call.args[0]));
}

describe("live guide entry", () => {

  // The INFO lines emitted during a row. The memo announces only its transitions, so these are what a row counts.
  let infoLines: string[] = [];
  let unsubscribeInfo: Nullable<() => void> = null;

  beforeEach(async () => {

    infoLines = [];
    unsubscribeInfo = subscribeToLogs((entry) => {

      if(entry.level === "info") {

        infoLines.push(entry.message);
      }
    });

    /* Restore the direct entry the way a running session does: a discovery walk re-tests the direct load regardless of what the last attempt found, so a healthy
     * answer here returns the module to the direct route no matter which row ran before this one.
     */
    await huluProvider.discoverChannels(makeEntryPage({ rejectSelectors: ["#CHANNELS"] }).fake.page);

    const probe = makeEntryPage();

    await navigateHulu(probe.fake.page, HULU_LIVE_URL);

    assert.deepEqual(loadedUrls(probe), [HULU_LIVE_URL], "the restore took: a fresh entry loads the guide's own URL and stops there");

    huluProvider.strategy.clearCache?.();
    infoLines = [];
  });

  afterEach(() => {

    unsubscribeInfo?.();
    unsubscribeInfo = null;
  });

  test("loads the guide directly and stops there when Hulu answers it", async () => {

    // The unchanged path, and the one every row below is measured against: one document load, no hub, and nothing to announce.
    const hulu = makeEntryPage();

    await navigateHulu(hulu.fake.page, HULU_LIVE_URL);

    assert.deepEqual(hulu.events, ["goto:" + HULU_LIVE_URL], "the direct load is the whole entry");
    assert.equal(hulu.fake.elementEvaluations.length, 0, "nothing was clicked");
    assert.deepEqual(infoLines, [], "a working direct load has nothing to announce");
  });

  test("enters through the hub inside the same attempt when the direct load answers a failed status, and remembers it", async () => {

    /* The incident this route answers. The failed status is definitive and arrives in a second or two, so the entry that discovered it still tunes - it just
     * takes the route a viewer takes. What it remembers is what spares the next tune the attempt.
     */
    const hulu = makeEntryPage({ statuses: [500] });

    await navigateHulu(hulu.fake.page, HULU_LIVE_URL);

    assert.deepEqual(hulu.events, [ "goto:" + HULU_LIVE_URL, "goto:" + HULU_HUB_URL, "evaluate", "wait:" + HULU_LIVE_NAV_SELECTOR,
      "waitForFrame", "locate:" + HULU_LIVE_NAV_SELECTOR, "hit:" + HULU_LIVE_NAV_SELECTOR, "click" ],
    "the entry fell back to the hub, cleared the profile picker, armed the frame wait, then clicked the Live link where it sits");

    assert.equal(infoLines.length, 1, "the fallback announced itself exactly once");
    assert.ok(infoLines[0]?.includes("unavailable by direct navigation"), "naming what it fell back from");
    assert.ok(infoLines[0]?.includes("HTTP 500"), "and the status that said so");

    const second = makeEntryPage();

    await navigateHulu(second.fake.page, HULU_LIVE_URL);

    assert.deepEqual(loadedUrls(second), [HULU_HUB_URL], "the next entry spends nothing on a direct load it has just seen fail");
    assert.equal(infoLines.length, 1, "and a fallback already in force says nothing further");
  });

  test("clicks the Live link with the pointer, at the coordinates the link was located at", async () => {

    /* What a bare DOM click withholds is the pointer's arrival at the link. Hulu's live page reveals its guide on pointer activity, so the route clicks the way
     * a viewer's mouse does: resolve where the link sits, confirm the link is what paints there, and click that point. A click dispatched at the element
     * instead routes the application and leaves the guide empty.
     */
    const hulu = makeEntryPage({ statuses: [500] });

    await navigateHulu(hulu.fake.page, HULU_LIVE_URL);

    assert.equal(hulu.fake.mouseClicks.length, 1, "the Live link was clicked once, with the mouse");
    assert.deepEqual(hulu.fake.mouseClicks[0]?.args, [ LIVE_LINK_CENTER.x, LIVE_LINK_CENTER.y ], "at the coordinates the link was located at");
    assert.equal(hulu.fake.elementEvaluations.length, 0, "and nothing was clicked inside the page");
  });

  test("asks the frame wait for the main frame on the guide's path and nothing else", async () => {

    /* The predicate is what the whole route turns on, so it is read back off the recorded call and exercised directly rather than inferred from the wait having
     * been made at all. The frame of another identity carries an empty URL, which is what a just-attached child frame reports: the predicate has to answer on
     * identity before it parses anything, because parsing an empty URL throws inside Puppeteer's own filter.
     */
    const hulu = makeEntryPage({ statuses: [500] });

    await navigateHulu(hulu.fake.page, HULU_LIVE_URL);

    const routeWait = hulu.fake.frameWaits[0];

    assert.ok(routeWait, "the route waited on a frame");

    const options = routeWait.args[1] as { timeout?: number };
    const predicate = routeWait.args[0] as (frame: unknown) => boolean;

    assert.equal(options.timeout, CONFIG.streaming.navigationTimeout, "the wait is bounded by the navigation timeout");

    hulu.fake.setUrl(HULU_HUB_URL);

    assert.equal(predicate(hulu.fake.page.mainFrame()), false, "the main frame still on the hub has not routed");

    hulu.fake.setUrl(HULU_LIVE_URL);

    assert.equal(predicate(hulu.fake.page.mainFrame()), true, "the main frame on the guide's path is what the wait is for");
    assert.equal(predicate({ url: (): string => "" }), false, "and a frame of another identity is answered without its URL being read");
  });

  test("leaves the memo alone when the direct load times out rather than answering", async () => {

    /* A tolerated navigation timeout is evidence about this page load, not about Hulu's edge - the request may well have been answered and only a background
     * call left the page short of idle. So the page is handed back as it loaded and the next entry still tries the direct URL. The timeout's own warning belongs
     * to the document load and is asserted there; what this row watches is that the memo did not move.
     */
    const hulu = makeEntryPage({ statuses: ["timeout"] });

    await navigateHulu(hulu.fake.page, HULU_LIVE_URL);

    assert.deepEqual(hulu.events, ["goto:" + HULU_LIVE_URL], "the entry stopped at the loaded page rather than routing through the hub");
    assert.deepEqual(infoLines, [], "and announced nothing, because nothing changed");

    const next = makeEntryPage();

    await navigateHulu(next.fake.page, HULU_LIVE_URL);

    assert.deepEqual(loadedUrls(next), [HULU_LIVE_URL], "the following entry attempts the direct load again");
  });

  test("returns to the direct route when a discovery walk finds it healthy again", async () => {

    // The recovery half of the design. Discovery re-tests the direct load on every walk, which is what returns a session to the direct route the moment Hulu
    // fixes their side, without anyone restarting anything.
    await navigateHulu(makeEntryPage({ statuses: [500] }).fake.page, HULU_LIVE_URL);

    assert.equal(infoLines.length, 1, "the session is on the fallback");

    const walk = makeEntryPage({ rejectSelectors: ["#CHANNELS"] });
    const discovered = await huluProvider.discoverChannels(walk.fake.page);

    assert.deepEqual(discovered, [], "the walk stops where this row withholds the Channels tab");
    assert.ok(walk.events.includes("wait:#CHANNELS"), "having actually entered the guide and reached the Channels tab wait");
    assert.equal(infoLines.length, 2, "exactly one further line");
    assert.ok(infoLines[1]?.includes("reachable by direct navigation again"), "announcing the recovery");

    const after = makeEntryPage();

    await navigateHulu(after.fake.page, HULU_LIVE_URL);

    assert.deepEqual(loadedUrls(after), [HULU_LIVE_URL], "and the next tune goes straight at the guide's own URL again");
  });

  test("keeps the memo across a cache clear, because it describes Hulu's server rather than this session", async () => {

    /* The channel caches are emptied on a browser restart and before every precache walk, since they hold what this browser session read. What a direct load of
     * the guide answered is not that: a new browser gets the same status from the same edge, and forgetting it would spend an attempt rediscovering it.
     */
    await navigateHulu(makeEntryPage({ statuses: [500] }).fake.page, HULU_LIVE_URL);

    huluProvider.strategy.clearCache?.();

    const after = makeEntryPage();

    await navigateHulu(after.fake.page, HULU_LIVE_URL);

    assert.deepEqual(loadedUrls(after), [HULU_HUB_URL], "the entry after the clear still goes straight to the hub");
  });

  test("fails the navigation when the hub will not route to the guide", async () => {

    // A hub that renders without its Live link is a failed navigation, not a quiet success: the callers' own retry and failure handling decide what happens next,
    // and a page handed back as tuned would send a broken surface into channel selection instead.
    const hulu = makeEntryPage({ rejectSelectors: [HULU_LIVE_NAV_SELECTOR], statuses: [500] });

    await assert.rejects(navigateHulu(hulu.fake.page, HULU_LIVE_URL), /Waiting failed for a\[href="\/live"\]/,
      "the Live link's wait rejects the whole entry");
  });

  test("fails the navigation in the route's own words when the route never lands", async () => {

    /* The wait's own timeout says only that some wait lapsed, and the capture-fault classifier reads a "timed out" substring off this failure path, answers the
     * client a 503 and notes the browser impaired. So the route names what did not happen, in words no classifier matches, and carries the wait's own error as
     * the cause for anyone reading the chain.
     */
    const routeWaitError = Object.assign(new Error("Timed out after waiting 10000ms"), { name: "TimeoutError" });
    const hulu = makeEntryPage({ routeWaitError, statuses: [500] });

    await assert.rejects(navigateHulu(hulu.fake.page, HULU_LIVE_URL), (error: unknown) => {

      assert.ok(error instanceof Error, "the failure is an Error");
      assert.match(error.message, /did not route to the live guide within/, "the route names what did not happen");
      assert.doesNotMatch(error.message, /timed out/i, "in words the capture-fault classifier does not read as an infrastructure failure");
      assert.equal(error.cause, routeWaitError, "and carries the wait's own error as the cause");

      return true;
    });

    assert.ok(hulu.events.includes("locate:" + HULU_LIVE_NAV_SELECTOR), "the click was issued before the wait was given up on");
  });

  test("propagates a frame-wait rejection that is not a timeout unchanged", async () => {

    // Only the wait's own timeout is reworded. A page closed under the wait - an aborted walk, or a browser that went away - is the caller's to read as it
    // stands, so it travels back by reference rather than being described as a route that did not land.
    const routeWaitError = Object.assign(new Error("Page closed."), { name: "TargetCloseError" });
    const hulu = makeEntryPage({ routeWaitError, statuses: [500] });

    await assert.rejects(navigateHulu(hulu.fake.page, HULU_LIVE_URL), (error: unknown) => {

      assert.equal(error, routeWaitError, "the rejection the frame wait raised is the one that propagates");

      return true;
    });
  });
});
