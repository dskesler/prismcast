/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * video.guideRetry.test.ts: Unit tests for the single in-tune selection retry in initializePlayback. A channel selection that failed because the guide surface
 * never rendered gets one reload and one more attempt; a selection that failed on a guide that did render gets none, because re-reading the same rendered guide
 * would fail the same way and spend the tune's budget doing it.
 *
 * The rows drive initializePlayback through its VideoTuneDeps injection point, exactly as video.diagnosis.test.ts does, with a page stub that records what it was
 * asked to do. Two bounds are deliberate. Every profile here names a NON-guideGrid strategy except the narrowing row, which keeps these tests sensitive to the
 * typed signal rather than to any particular strategy name. And no row runs the tune to completion: the playback tail drives fullscreen sequencing and real
 * delays, so a row that needs the retry's success to be accepted asserts it through the step AFTER selection - a tune that reaches the video wait is a tune whose
 * selection was taken as successful, and a tune whose selection ultimately failed never gets there.
 */
import type { ChannelSelectionStrategy, ChannelSelectorResult, ResolvedSiteProfile } from "../types/index.ts";
import { TestClock, drainClock, settle } from "homebridge-plugin-utils/testing";
import { afterEach, beforeEach, describe, test } from "node:test";
import { CONFIG } from "../config/index.ts";
import { LOG } from "../utils/index.ts";
import type { Page } from "puppeteer-core";
import type { VideoTuneDeps } from "./video.ts";
import assert from "node:assert/strict";
import { initializePlayback } from "./video.ts";
import { makeProfile } from "../config/profiles.helpers.ts";
import { systemClock } from "homebridge-plugin-utils";
import { useHealthStoreOnClock } from "../config/health.helpers.ts";

// The teardown for the health store establishment each describe below holds, assigned by that describe's setup.
let disposeHealthStore: () => Promise<void>;

// The selection results each successive selectChannel call returns, and the page operations the stub recorded. Reset per row.
let selectResults: ChannelSelectorResult[] = [];
let selectCalls = 0;
let pageEvents: string[] = [];

// The failure the video wait raises once selection has been accepted. Reaching it is the signal that the tune got past selection.
const VIDEO_WAIT_FAILURE = "the video wait is where this row stops";

/* The injected tune collaborators. Only selection and the overlay poll are reached: with no requested URL supplied, every failure path rethrows its own error
 * rather than routing through the blocked-page diagnosis, so the classifier and provider lookup stay unused.
 */
const deps: VideoTuneDeps = {

  classifyBlockedPage: async (): Promise<never> => { throw new Error("The classifier is not reached without a requested URL."); },
  clock: systemClock,
  getProvidersForDomain: (): never[] => [],
  selectChannel: async (): Promise<ChannelSelectorResult> => {

    const result = selectResults[selectCalls] ?? { reason: "no scripted result", success: false };

    selectCalls++;
    pageEvents.push("select");

    return result;
  },
  startOverlayHandling: async (): Promise<void> => { /* The poll is not under test here. */ }
};

/**
 * Builds the page stub the rows run against. The mute is an evaluate, the reload is its own call, and the video wait rejects so the tune stops at a step the rows
 * can name - each recorded in order, which is what makes "reloaded once, then muted, then selected again" an observed sequence rather than three separate counts.
 * @returns A stub page.
 */
function makeStubPage(): Page {

  return {

    evaluate: async (): Promise<unknown> => {

      pageEvents.push("mute");

      return undefined;
    },
    isClosed: (): boolean => false,
    reload: async (): Promise<unknown> => {

      pageEvents.push("reload");

      return null;
    },
    url: (): string => "https://www.stub-guide-retry.test/guide",
    waitForSelector: async (): Promise<never> => { throw new Error(VIDEO_WAIT_FAILURE); }
  } as unknown as Page;
}

/**
 * Builds a profile naming a provider strategy. Spectrum's is the default because the retry decision must not depend on which strategy a profile names, and a row
 * driving a strategy other than guideGrid can only pass on the strength of the typed signal.
 * @param strategy - The channel-selection strategy name to declare.
 * @returns The resolved profile.
 */
function makeGuideProfile(strategy: ChannelSelectionStrategy = "spectrumGrid"): ResolvedSiteProfile {

  return makeProfile({ channelSelection: { strategy }, channelSelector: "ESPN" });
}

describe("initializePlayback - the guide-unavailable retry", () => {

  beforeEach(async () => {

    pageEvents = [];
    selectCalls = 0;
    selectResults = [];

    // Establish the health store on a clock of its own, so any debounced health timer these paths schedule arms on virtual time rather than against a real data
    // directory after a row ends.
    disposeHealthStore = await useHealthStoreOnClock(new TestClock());
  });

  afterEach(async () => {

    await disposeHealthStore();
  });

  test("reloads, re-mutes, and re-runs selection once when the guide never rendered", async () => {

    /* The incident this slot answers, at tune time: the rail or grid simply was not there. One reload, one re-mute, one more selection - and the retry's success
     * is accepted, which the tune reaching the video wait is what proves.
     */
    selectResults = [ { guideUnavailable: true, reason: "Spectrum guide grid did not load.", success: false }, { success: true } ];

    await assert.rejects(initializePlayback(makeStubPage(), makeGuideProfile(), {}, deps), (error: unknown) => (error as Error).message === VIDEO_WAIT_FAILURE,
      "the tune moved past selection and stopped at the video wait");

    assert.equal(selectCalls, 2, "selection ran exactly twice");
    assert.deepEqual(pageEvents, [ "mute", "select", "reload", "mute", "select" ],
      "the tune muted, selected, reloaded, re-muted the reloaded page's autoplay, and selected again");
  });

  test("fails the tune when the retry finds no guide either", async () => {

    // One retry, not a loop. A guide that is still absent after a reload is a standing problem, and a second reload would only spend more of the establishment
    // budget arriving at the same answer.
    selectResults = [

      { guideUnavailable: true, reason: "Spectrum guide grid did not load.", success: false },
      { guideUnavailable: true, reason: "Spectrum guide grid did not load again.", success: false }
    ];

    await assert.rejects(initializePlayback(makeStubPage(), makeGuideProfile(), {}, deps),
      (error: unknown) => (error as Error).message === "Channel selection failed: Spectrum guide grid did not load again.",
      "the tune fails carrying the retry's own reason");

    assert.equal(selectCalls, 2, "selection ran exactly twice");
    assert.equal(pageEvents.filter((event) => event === "reload").length, 1, "the page was reloaded exactly once");
  });

  test("never reloads for a failure on a guide that did render", async () => {

    /* The negative half, and the reason the flag exists at all. A channel name that is not in a rendered lineup will not be there after a reload either, and the
     * reload plus a second selection is time the tune does not have. This row can only pass on the absence of the typed signal, because the strategy it names is
     * not one a strategy-keyed retry would have covered anyway.
     */
    selectResults = [{ reason: "Channel \"ESPN\" not found in Spectrum guide.", success: false }];

    await assert.rejects(initializePlayback(makeStubPage(), makeGuideProfile(), {}, deps),
      (error: unknown) => (error as Error).message === "Channel selection failed: Channel \"ESPN\" not found in Spectrum guide.",
      "the tune fails on the first attempt's reason");

    assert.equal(selectCalls, 1, "selection ran once");
    assert.deepEqual(pageEvents, [ "mute", "select" ], "nothing was reloaded");
  });

  test("declines a guide-grid failure that carries no guide-unavailable signal", async () => {

    /* The narrowing, asserted at the coordinator rather than by the absence of a provider's own wrapper. A guideGrid provider whose channel is simply not in the
     * rendered lineup gets no second attempt from this slot: it is the typed signal that decides, not the strategy the profile names. A blanket retry keyed on the
     * strategy would spend a full second selection here to fail at the same missing name.
     */
    selectResults = [{ reason: "Channel \"ESPN\" not found in the Hulu guide.", success: false }];

    await assert.rejects(initializePlayback(makeStubPage(), makeGuideProfile("guideGrid"), {}, deps),
      (error: unknown) => (error as Error).message === "Channel selection failed: Channel \"ESPN\" not found in the Hulu guide.",
      "a rendered-guide failure fails on its first attempt");

    assert.equal(selectCalls, 1, "the coordinator declined to re-run selection");
    assert.deepEqual(pageEvents, [ "mute", "select" ], "nothing was reloaded");
  });
});

describe("initializePlayback - the tune's clock reaches the video-context search", () => {

  beforeEach(async () => {

    pageEvents = [];
    selectCalls = 0;
    selectResults = [];

    // Establish the health store on a clock of its own, so any debounced health timer these paths schedule arms on virtual time rather than against a real data
    // directory after a row ends.
    disposeHealthStore = await useHealthStoreOnClock(new TestClock());
  });

  afterEach(async () => {

    await disposeHealthStore();
  });

  test("parks the search's cadence on the clock the deps carry and falls back to the main page at the ceiling", async (t) => {

    /* The search is the one tune step whose pacing a row can observe end to end: an iframe-handling profile sends it scanning, a frame list holding only the main
     * frame makes every scan a miss, and the ceiling is the configured iframe delay. Driving it through a TestClock in the deps is what proves the orchestrator's
     * clock reaches the search rather than the search reaching for the system clock - a global timer would leave this clock empty and the drain would step nothing.
     */
    const debug = t.mock.method(LOG, "debug", () => { /* Captured via the mock. */ });
    const clock = new TestClock();

    // A sentinel main frame: page.frames() answers only this, and page.mainFrame() answers the same object, so every scan skips it and finds no video anywhere.
    const mainFrame = {};

    const page = {

      evaluate: async (): Promise<unknown> => undefined,
      frames: (): unknown[] => [mainFrame],
      isClosed: (): boolean => false,
      mainFrame: (): unknown => mainFrame,
      url: (): string => "https://www.stub-guide-retry.test/embedded",
      waitForSelector: async (selector: string): Promise<unknown> => {

        // The iframe wait ahead of the search resolves; the readiness wait that follows the fallback is where this row stops.
        if(selector === "video") {

          throw new Error(VIDEO_WAIT_FAILURE);
        }

        return {};
      }
    } as unknown as Page;

    const running = initializePlayback(page, makeProfile({ needsIframeHandling: true }), { skipChannelSelection: true }, { ...deps, clock });
    const rejection = assert.rejects(running, (error: unknown) => (error as Error).message === VIDEO_WAIT_FAILURE,
      "the tune moved past the search and stopped at the video wait");

    await settle();
    assert.equal(clock.pending, 1, "the first cadence is parked on the injected clock, not on a global timer");

    await drainClock(clock);
    await rejection;

    /* The window affords one scan plus one per cadence: the ceiling is checked only after a scan, so the search keeps asking until a scan lands at or past
     * iframeInitDelay. That is Math.ceil(iframeInitDelay / 200) cadences of 200 ms each, and one more scan than that.
     */
    const cadences = Math.ceil(CONFIG.playback.iframeInitDelay / 200);

    assert.deepEqual(clock.requested, Array.from({ length: cadences }, () => 200), "every cadence the iframe window afforded was registered on the injected clock");
    assert.equal(clock.pending, 0, "nothing stayed registered on the clock once the search ended");

    const messages = debug.mock.calls.map((call) => String(call.arguments[1]));

    assert.ok(messages.some((m) => m.includes("falling back to the main page context")), "the search reported its fallback to the main page");
  });
});
