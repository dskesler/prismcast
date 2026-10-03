/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * setup.captureVerdict.test.ts: Unit tests for the mid-life capture verdict - the one shared promise a refused tune waits on to learn whether the browser it was
 * refused by is still worth retrying against.
 *
 * Two properties carry the whole heal and neither is visible from the establishment above it. The first is single-flight by identity: every caller that asks
 * while a verdict is unsettled has to receive the SAME promise, because a burst of tunes refused in one second must cost one probe, one mark, and one relaunch
 * rather than a dozen of each. The second is the settlement point: a failed verdict starts a browser restart, and the restart holds the supervisor in its draining
 * state where acquire() rejects rather than joins - so a verdict that settled ahead of its own restart would send every waiting tune into that drain. Both are
 * asserted here, against the real single-flight slot, with the collaborators injected so no capture lock, browser, or Chrome is involved.
 */
import type { CaptureProbeOutcome, CaptureVerdictDeps } from "./setup.ts";
import { beforeEach, describe, test } from "node:test";
import type { Browser } from "puppeteer-core";
import type { CaptureImpairment } from "../browser/index.ts";
import type { Nullable } from "../types/index.ts";
import assert from "node:assert/strict";
import { closePuppeteerStreamWssOnIdle } from "../testing.helpers.ts";
import { setImmediate as immediate } from "node:timers/promises";
import { noteCaptureInfrastructureFailure } from "./setup.ts";

// This file imports the module that imports puppeteer-stream, which spawns a WebSocketServer at load and would otherwise hold the runner open.
closePuppeteerStreamWssOnIdle();

// The instance every case probes. Its only job is to be recognisable when the mark reports which browser it was handed.
const BROWSER = { connected: true } as unknown as Browser;

// The reason a failed probe reports, read back off both the mark's arguments and the verdict itself.
const PROBE_REASON = "The capture probe could not start a capture.";

/* The answer a race gives when the promise it was raced against has not settled. A symbol rather than a string or null, because every other value in play here is
 * a legitimate verdict and a sentinel that could be mistaken for one would make the pendingness assertion meaningless.
 */
const STILL_PENDING = Symbol("still pending");

// What the current case's probe answers, how many times it was asked, and the browser it was handed.
let probeAnswer: () => Promise<CaptureProbeOutcome> = async (): Promise<CaptureProbeOutcome> => ({ kind: "captured" });
let probeCalls = 0;
let probedBrowsers: Browser[] = [];

// What the mark does and what it was told. The deferred is what a case holds open to keep a restart running while it reads the verdict's pendingness.
let markAnswer: () => Promise<void> = async (): Promise<void> => undefined;
let markCalls: { browser: Browser; reason: string }[] = [];

// What the two reads answer for the current case: the published browser, and any mark already recorded against it.
let publishedBrowser: Nullable<Browser> = BROWSER;
let recordedImpairment: Nullable<CaptureImpairment> = null;

const deps: CaptureVerdictDeps = {

  getBrowserInstance: (): Nullable<Browser> => publishedBrowser,
  getCaptureImpairment: (): Nullable<CaptureImpairment> => recordedImpairment,
  noteBrowserCaptureImpaired: async (browser: Browser, reason: string): Promise<void> => {

    markCalls.push({ browser, reason });

    await markAnswer();
  },
  probe: async (browser: Browser): Promise<CaptureProbeOutcome> => {

    probeCalls++;
    probedBrowsers.push(browser);

    return await probeAnswer();
  }
};

beforeEach(() => {

  markAnswer = async (): Promise<void> => undefined;
  markCalls = [];
  probeAnswer = async (): Promise<CaptureProbeOutcome> => ({ kind: "captured" });
  probeCalls = 0;
  probedBrowsers = [];
  publishedBrowser = BROWSER;
  recordedImpairment = null;
});

describe("noteCaptureInfrastructureFailure", () => {

  test("hands every caller in a burst the identical promise, and probes once", async () => {

    /* The identity is the assertion, not merely the count. What a refused tune waits on is the browser's one verdict rather than its own call's, so two callers
     * that received distinct promises would be two callers the slot failed to join - and the second probe that follows would spend the capture lock a second time
     * on a question already being answered.
     */
    const held = Promise.withResolvers<CaptureProbeOutcome>();

    probeAnswer = (): Promise<CaptureProbeOutcome> => held.promise;

    const first = noteCaptureInfrastructureFailure(deps);
    const second = noteCaptureInfrastructureFailure(deps);

    assert.equal(first, second, "both callers hold the same verdict, not one each");

    held.resolve({ kind: "captured" });

    assert.deepEqual(await first, { kind: "captured" }, "and they settle on it together");
    assert.equal(probeCalls, 1, "one probe answered the burst");
  });

  test("answers with no verdict at all when no browser is published", async () => {

    // A disconnect already handled the readiness loss, so there is no instance to reach a verdict about and nothing a retry would start from.
    publishedBrowser = null;

    assert.equal(await noteCaptureInfrastructureFailure(deps), null, "the absence of a verdict is a null rather than a throw");
    assert.equal(probeCalls, 0, "and no probe was spent on it");
  });

  test("reports the recorded reason for a browser that already carries a mark, without probing", async () => {

    // The refusal belongs to a tune that acquired the browser an instant before the mark landed. The verdict is already on record and the relaunch already
    // scheduled, so re-establishing it would spend the capture lock on a settled question.
    recordedImpairment = { reason: PROBE_REASON, since: 0 };

    assert.deepEqual(await noteCaptureInfrastructureFailure(deps), { kind: "failed", reason: PROBE_REASON }, "the recorded reason is the verdict");
    assert.equal(probeCalls, 0, "no second probe runs against a browser whose fate is decided");
  });

  test("stays unsettled until the restart the mark triggered has settled", async () => {

    /* The ordering the whole heal rests on. The mark starts a browser restart, and while that restart runs the supervisor is draining, where acquire() rejects
     * rather than joins - so a tune released at the mark instead of at the restart would re-acquire straight into the drain and fail on a browser that was about
     * to serve it. The row holds the restart open and reads that the verdict has not settled, then releases it and reads that it has.
     */
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Standard pattern for signal promises.
    const restart = Promise.withResolvers<void>();

    markAnswer = (): Promise<void> => restart.promise;
    probeAnswer = async (): Promise<CaptureProbeOutcome> => ({ kind: "failed", reason: PROBE_REASON });

    const verdict = noteCaptureInfrastructureFailure(deps);

    // Drain every microtask the probe and the mark queue, so the pendingness below is the awaited restart rather than a verdict that simply has not caught up.
    await immediate();

    assert.deepEqual(markCalls, [{ browser: BROWSER, reason: PROBE_REASON }], "the mark names the exact instance that was probed, and why");
    assert.equal(await Promise.race([ verdict, Promise.resolve(STILL_PENDING) ]), STILL_PENDING, "the verdict is unsettled while the restart is running");

    restart.resolve();

    assert.deepEqual(await verdict, { kind: "failed", reason: PROBE_REASON }, "and it settles on the failure once the restart has");
  });

  test("answers captured without marking anything when the browser can still capture", async () => {

    // The complementary control. A browser that started a capture for the probe is healthy, so the setup failure that brought the caller here belonged to the
    // stream rather than to the browser, and marking it would relaunch a working instance out from under its running captures.
    probeAnswer = async (): Promise<CaptureProbeOutcome> => ({ kind: "captured" });

    assert.deepEqual(await noteCaptureInfrastructureFailure(deps), { kind: "captured" }, "the browser proved itself");
    assert.deepEqual(markCalls, [], "and nothing was marked");
    assert.deepEqual(probedBrowsers, [BROWSER], "the probe ran against the published instance");
  });

  test("asks the browser afresh once the previous verdict has settled", async () => {

    // The slot holds a verdict only while it is unsettled. A failure arriving later is a new question about a browser whose state has moved on, so it earns its
    // own probe rather than an answer about a moment that has passed.
    await noteCaptureInfrastructureFailure(deps);
    await noteCaptureInfrastructureFailure(deps);

    assert.equal(probeCalls, 2, "the second failure started a probe of its own");
  });
});
