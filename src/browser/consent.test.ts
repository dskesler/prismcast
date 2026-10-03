/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * consent.test.ts: Unit tests for the Node-side orchestration in consent.ts - the unified auto-dismiss logging (logAutoDismiss), the phase-scoped overlay-handling
 * poll (startOverlayHandling), and the detect-and-guide probe (consentOverlayPresent). The in-page heuristics themselves (the embed-gate selector/keyword matching
 * and the coordinate resolution inside page.evaluate) are asserted against a synthetic happy-dom document in the co-located consent.heuristics.test.ts; here a page
 * stub returns scripted page.evaluate results so the poll's decision flow - phase masking, reject-then-accept ordering, the embed-gate signal, the probe/act split,
 * malformed-selector fault isolation, the tick-error taxonomy, and abort handling - is locked without spinning up Chrome. Time is driven by an injected TestClock,
 * so a multi-tick row parks on the poll's cadence until it advances and its tick count is exact rather than merely eventual; the rows whose poll ends inside its
 * first tick supply no clock at all and run on the system clock. LOG is spied via the test-context mock so the logging contract is asserted directly on the
 * production LOG object.
 */
import { TestClock, drainClock, settle } from "homebridge-plugin-utils/testing";
import { clickSelectorInPage, consentOverlayPresent, isSelectorAtPoint, logAutoDismiss, startOverlayHandling } from "./consent.ts";
import { describe, test } from "node:test";
import { LOG } from "../utils/index.ts";
import type { Page } from "puppeteer-core";
import assert from "node:assert/strict";
import { makeProfile } from "../config/profiles.helpers.ts";

// The Didomi reject selector seeded in the CMP registry. The poll passes it to page.evaluate when probing for a cookie banner, so the stub routes on it to simulate
// "banner present" vs "absent". Kept here as the single literal the test depends on, matching the one seeded entry in consent.ts.
const DIDOMI_REJECT = "#didomi-notice-disagree-button";

// A per-site dismissSelector value used to exercise the modal path through the poll. Any string works; the stub routes on it by value.
const DISMISS_SELECTOR = ".watch-live";

/* PageStub records the coordinate clicks dispatched and the page.evaluate arguments seen, so a test can assert what the poll did. The evaluate router maps each
 * call's argument to a scripted result: the embed-gate probe passes an object carrying a `gate` key (and an `act` flag), the CMP reject probe passes the reject
 * selector string, the CMP-detect probe passes an array of detect selectors, and the per-site modal passes the configured dismissSelector string (whose scripted
 * result is one of "absent" | "clicked" | "invalid-selector"). Routing on the argument shape lets one stub serve every page.evaluate the consent module performs.
 */
interface PageStub {

  clicks: { x: number; y: number }[];
  evaluateArgs: unknown[];
}

/**
 * Options for makePageStub: the browser-connected state, the isClosed result the tick-error taxonomy reads when an evaluate rejects, and the answer the stub gives
 * to the coordinate click's hit test.
 */
interface PageStubOptions {

  connected?: boolean;
  isClosed?: () => boolean;
  onTop?: boolean;
}

function makePageStub(router: (arg: unknown, fn: unknown) => unknown, options: PageStubOptions = {}): { page: Page; stub: PageStub } {

  const { connected = true, isClosed = (): boolean => false, onTop = true } = options;
  const stub: PageStub = { clicks: [], evaluateArgs: [] };

  const page = {

    browser: (): { connected: boolean } => ({ connected }),
    evaluate: async (fn: unknown, arg?: unknown): Promise<unknown> => {

      stub.evaluateArgs.push(arg);

      // The coordinate click's hit test is answered by the stub rather than by each router, so every routing table stays a map from a probe's argument to its
      // scripted result. The default reports the target as what paints at its own coordinates, which is what every row asserting a dispatched pointer click needs.
      if(fn === isSelectorAtPoint) {

        return onTop;
      }

      return router(arg, fn);
    },
    isClosed,
    mouse: {

      click: async (x: number, y: number): Promise<void> => {

        stub.clicks.push({ x, y });
      }
    }
  } as unknown as Page;

  return { page, stub };
}

// True when the argument is the embed-gate probe payload (locateEmbedGate passes { accept, act, exclude, gate }).
function isGateProbe(arg: unknown): boolean {

  return (typeof arg === "object") && (arg !== null) && ("gate" in arg);
}

// Reads the `act` flag recorded on an embed-gate probe argument. The flag is the Node-observable proxy for the in-page scrollIntoView: the acting path passes act
// true (scroll + coordinates), the read-only detection probe passes act false (presence only).
function gateProbeAct(arg: unknown): boolean {

  return (arg as { act: boolean }).act;
}

// Returns the arguments recorded for a mock call at the given index, asserting the call exists so the indexed access satisfies noUncheckedIndexedAccess without
// scattering non-null assertions through the test bodies.
function callArgs(calls: readonly { arguments: readonly unknown[] }[], index: number): readonly unknown[] {

  const call = calls[index];

  assert.ok(call, "expected a recorded call at index " + String(index));

  return call.arguments;
}

describe("logAutoDismiss", () => {

  test("cookie-consent emits a vendor-named INFO line plus a browser:consent debug companion", (t) => {

    const info = t.mock.method(LOG, "info", () => { /* Captured via the mock. */ });
    const debug = t.mock.method(LOG, "debug", () => { /* Captured via the mock. */ });

    logAutoDismiss("cookie-consent", { selector: DIDOMI_REJECT, vendor: "Didomi" });

    assert.equal(info.mock.calls.length, 1, "exactly one INFO line");
    assert.match(String(callArgs(info.mock.calls, 0)[0]), /rejected the %s cookie-consent prompt/);
    assert.equal(callArgs(info.mock.calls, 0)[1], "Didomi", "vendor is interpolated");
    assert.equal(debug.mock.calls.length, 1, "exactly one DEBUG companion");
    assert.equal(callArgs(debug.mock.calls, 0)[0], "browser:consent", "debug is tagged with the consent category");
  });

  test("embed-gate emits a fixed accept INFO line plus a browser:consent debug companion", (t) => {

    const info = t.mock.method(LOG, "info", () => { /* Captured via the mock. */ });
    const debug = t.mock.method(LOG, "debug", () => { /* Captured via the mock. */ });

    logAutoDismiss("embed-gate", { label: "Accept" });

    assert.equal(info.mock.calls.length, 1);
    assert.match(String(callArgs(info.mock.calls, 0)[0]), /accepted an embedded-player consent prompt/);
    assert.equal(callArgs(info.mock.calls, 0).length, 1, "no positional interpolation arg on the fixed message");
    assert.equal(callArgs(debug.mock.calls, 0)[0], "browser:consent", "every kind emits the consent-tagged debug companion");
  });

  test("modal emits the interstitial-dismiss INFO line plus a browser:consent debug companion", (t) => {

    const info = t.mock.method(LOG, "info", () => { /* Captured via the mock. */ });
    const debug = t.mock.method(LOG, "debug", () => { /* Captured via the mock. */ });

    logAutoDismiss("modal", { selector: DISMISS_SELECTOR });

    assert.equal(info.mock.calls.length, 1);
    assert.match(String(callArgs(info.mock.calls, 0)[0]), /dismissed an interstitial modal/);
    assert.equal(callArgs(info.mock.calls, 0).length, 1, "no positional interpolation arg on the fixed message");
    assert.equal(callArgs(debug.mock.calls, 0)[0], "browser:consent", "every kind emits the consent-tagged debug companion");
  });

  test("the vendor placeholder falls back to \"site\" when no vendor is supplied", (t) => {

    const info = t.mock.method(LOG, "info", () => { /* Captured via the mock. */ });

    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    logAutoDismiss("cookie-consent");

    assert.equal(callArgs(info.mock.calls, 0)[1], "site");
  });
});

describe("startOverlayHandling", () => {

  test("accepts an embed gate: coordinate-clicks it, signals, and stops the poll", async (t) => {

    t.mock.method(LOG, "info", () => { /* Silenced. */ });
    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    // No cookie banner present (CMP reject probe returns null); an embed gate is located at (10, 20).
    const { page, stub } = makePageStub((arg) => {

      if(isGateProbe(arg)) {

        return { label: "Accept", x: 10, y: 20 };
      }

      return null;
    });

    let gateSignals = 0;

    await startOverlayHandling(page, makeProfile(), { onEmbedGateAccepted: () => { gateSignals++; }, phase: "videoWait" });

    assert.equal(gateSignals, 1, "the embed-gate callback fired exactly once");
    assert.deepEqual(stub.clicks, [{ x: 10, y: 20 }], "the gate's accept control was coordinate-clicked");
  });

  test("rejects a cookie banner before accepting an embed gate in the same tick", async (t) => {

    const info = t.mock.method(LOG, "info", () => { /* Captured via the mock. */ });

    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    // Cookie banner present (reject at (5, 6)) and an embed gate present (accept at (10, 20)).
    const { page, stub } = makePageStub((arg) => {

      if(isGateProbe(arg)) {

        return { label: "Accept", x: 10, y: 20 };
      }

      if(arg === DIDOMI_REJECT) {

        return { x: 5, y: 6 };
      }

      return null;
    });

    let gateSignals = 0;

    await startOverlayHandling(page, makeProfile(), { onEmbedGateAccepted: () => { gateSignals++; }, phase: "videoWait" });

    assert.deepEqual(stub.clicks, [ { x: 5, y: 6 }, { x: 10, y: 20 } ], "the cookie reject is clicked before the gate accept");
    assert.equal(gateSignals, 1);

    const messages = info.mock.calls.map((call) => String(call.arguments[0]));

    assert.ok(messages.some((m) => m.includes("cookie-consent prompt")), "the cookie reject was logged");
    assert.ok(messages.some((m) => m.includes("embedded-player consent prompt")), "the gate accept was logged");
  });

  test("returns immediately without touching the page when the signal is already aborted", async (t) => {

    t.mock.method(LOG, "info", () => { /* Silenced. */ });

    const { page, stub } = makePageStub(() => null);
    const controller = new AbortController();

    controller.abort();

    let gateSignals = 0;

    await startOverlayHandling(page, makeProfile(), { onEmbedGateAccepted: () => { gateSignals++; }, phase: "videoWait", signal: controller.signal });

    assert.equal(stub.evaluateArgs.length, 0, "no page evaluation occurred");
    assert.equal(stub.clicks.length, 0, "no click occurred");
    assert.equal(gateSignals, 0, "the gate callback never fired");
  });

  test("aborting inside the CMP reject halts the tick before the embed-gate probe and the modal dismiss run", async (t) => {

    t.mock.method(LOG, "info", () => { /* Silenced. */ });
    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    const controller = new AbortController();

    // The Didomi banner is present, and clicking its reject aborts the signal mid-tick. The abort check placed right after the CMP-reject group must then return
    // "stop" before the same tick's embed-gate probe and per-site modal dismiss, so neither is ever issued within that tick. This distinguishes the mid-tick check
    // from the between-tick checks in the poll loop: a between-tick check cannot suppress the later action groups of the tick that is already running.
    const { page, stub } = makePageStub((arg) => {

      if(arg === DIDOMI_REJECT) {

        controller.abort();

        return { x: 5, y: 6 };
      }

      return null;
    });

    const clock = new TestClock();

    const running = startOverlayHandling(page, makeProfile({ dismissSelector: DISMISS_SELECTOR }),
      { clock, onEmbedGateAccepted: () => { /* The gate never fires; the videoWait arm of the union requires the callback. */ }, phase: "videoWait",
        signal: controller.signal });

    await drainClock(clock);
    await running;

    // One 200 for the settle the located reject control pays, and no 500 at all: the abort landed inside the first tick, so no cadence ever followed it.
    assert.deepEqual(clock.requested, [200], "the tick's own settle was the only wait registered; the abort ended the poll before any cadence");
    assert.equal(clock.pending, 0, "nothing stayed registered on the clock after the poll ended");
    assert.deepEqual(stub.clicks, [{ x: 5, y: 6 }], "only the CMP reject dispatched before the abort halted the tick");
    assert.equal(stub.evaluateArgs.filter(isGateProbe).length, 0, "the post-reject abort check skipped the embed-gate probe");
    assert.ok(!stub.evaluateArgs.includes(DISMISS_SELECTOR), "the post-reject abort check skipped the per-site modal dismiss");
  });

  test("dismisses a per-site modal through the poll, then dedups it on later ticks", async (t) => {

    const info = t.mock.method(LOG, "info", () => { /* Captured via the mock. */ });

    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    // No cookie banner; the per-site modal is present; an embed gate appears on the second tick only, to terminate the poll.
    let gateProbes = 0;

    const { page, stub } = makePageStub((arg) => {

      if(isGateProbe(arg)) {

        gateProbes++;

        return (gateProbes >= 2) ? { label: "Accept", x: 9, y: 9 } : null;
      }

      return (arg === DISMISS_SELECTOR) ? "clicked" : null;
    });

    const clock = new TestClock();

    const running = startOverlayHandling(page, makeProfile({ dismissSelector: DISMISS_SELECTOR }),
      { clock, onEmbedGateAccepted: () => { /* Terminates the poll. */ }, phase: "videoWait" });

    await settle();
    assert.equal(clock.pending, 1, "the first tick found no gate, so its cadence is parked on the clock");

    await drainClock(clock);
    await running;

    const modalProbes = stub.evaluateArgs.filter((arg) => arg === DISMISS_SELECTOR);

    assert.equal(modalProbes.length, 1, "the dismissSelector is probed once on tick one and deduped thereafter");
    assert.ok(info.mock.calls.some((call) => String(call.arguments[0]).includes("interstitial modal")), "the modal dismissal was logged");
  });

  test("an armed dismissSelector whose valid selector matches nothing stays armed and is re-probed on the next tick", async (t) => {

    t.mock.method(LOG, "info", () => { /* Silenced. */ });
    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    const controller = new AbortController();
    let dismissProbes = 0;

    // No cookie banner and no embed gate; the configured per-site modal is probed but its valid selector matches nothing ("absent"). The absent result must leave
    // the action armed - not mark it done or disabled - so the modal is probed again on the next tick. The abort is tied to the second modal probe, so the poll ends
    // deterministically on the injected clock once two ticks have each run the dismiss action.
    const { page, stub } = makePageStub((arg) => {

      if(isGateProbe(arg)) {

        return null;
      }

      if(arg === DISMISS_SELECTOR) {

        dismissProbes++;

        if(dismissProbes >= 2) {

          controller.abort();
        }

        return "absent";
      }

      return null;
    });

    const clock = new TestClock();

    const running = startOverlayHandling(page, makeProfile({ dismissSelector: DISMISS_SELECTOR }),
      { clock, onEmbedGateAccepted: () => { /* The gate never fires in this test. */ }, phase: "videoWait", signal: controller.signal });

    await settle();
    assert.equal(clock.pending, 1, "the first tick's cadence is parked on the clock");

    await drainClock(clock);
    await running;

    const modalProbes = stub.evaluateArgs.filter((arg) => arg === DISMISS_SELECTOR);

    assert.ok(modalProbes.length >= 2, "an absent modal leaves the action armed, so it is re-probed on a subsequent tick");
    assert.equal(stub.clicks.length, 0, "an absent modal never dispatches a click");
  });

  test("rejects a cookie banner once and does not re-probe that vendor on later ticks", async (t) => {

    t.mock.method(LOG, "info", () => { /* Silenced. */ });
    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    // The Didomi banner is present; an embed gate appears on the second tick to terminate the poll.
    let gateProbes = 0;

    const { page, stub } = makePageStub((arg) => {

      if(isGateProbe(arg)) {

        gateProbes++;

        return (gateProbes >= 2) ? { label: "Accept", x: 1, y: 1 } : null;
      }

      return (arg === DIDOMI_REJECT) ? { x: 2, y: 2 } : null;
    });

    const clock = new TestClock();

    const running = startOverlayHandling(page, makeProfile(), { clock, onEmbedGateAccepted: () => { /* Terminates the poll. */ }, phase: "videoWait" });

    await drainClock(clock);
    await running;

    // One 200 per tick that located a coordinate target - the reject's settle on tick one, the gate accept's on tick two - and one 500 for the single cadence
    // between them.
    assert.deepEqual(clock.requested, [ 200, 500, 200 ], "the reject's settle, one cadence, then the gate's settle");
    assert.equal(clock.pending, 0, "nothing stayed registered on the clock after the poll ended");

    const rejectProbes = stub.evaluateArgs.filter((arg) => arg === DIDOMI_REJECT);

    assert.equal(rejectProbes.length, 1, "the CMP vendor is rejected once and not re-probed once handled");
  });

  test("falls back to the in-page click when the reject control is covered, and marks the vendor handled", async (t) => {

    const info = t.mock.method(LOG, "info", () => { /* Captured via the mock. */ });

    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    /* The Didomi banner resolves to coordinates, but the hit test reports that another element paints there - the state a page reaches when the capture's video is
     * lifted above a banner that arrives afterwards. The poll has to reach the control with the in-page synthetic click instead, dispatch no pointer click at all,
     * and treat that click's "clicked" result exactly as it treats a landed coordinate click: the vendor is marked handled, so neither the click nor the log line
     * repeats on the ticks that follow.
     */
    let syntheticClicks = 0;

    const { page, stub } = makePageStub((arg, fn) => {

      if(arg !== DIDOMI_REJECT) {

        return null;
      }

      if(fn === clickSelectorInPage) {

        syntheticClicks++;

        return "clicked";
      }

      return { x: 2, y: 2 };
    }, { onTop: false });

    const clock = new TestClock();

    const running = startOverlayHandling(page, makeProfile({ videoTimeout: 1000 }),
      { clock, onEmbedGateAccepted: () => { /* No gate is ever located in this row. */ }, phase: "videoWait" });

    await drainClock(clock);
    await running;

    const messages = info.mock.calls.map((call) => String(call.arguments[0]));

    // The settle runs whenever the reject control is located, before the on-top test decides between the pointer click and the in-page click, so the covered
    // control's one located tick registers a 200. The vendor is handled from there on, so the two later ticks locate nothing and only their cadences remain.
    assert.deepEqual(clock.requested, [ 200, 500, 500 ], "the located tick's settle, then the two cadences the 1000 ms window afforded");
    assert.equal(clock.pending, 0, "nothing stayed registered on the clock after the poll ended");
    assert.equal(stub.clicks.length, 0, "a covered control is never pointer-clicked");
    assert.equal(syntheticClicks, 1, "the in-page click ran once, on the same selector the coordinate click resolved");
    assert.equal(messages.filter((m) => m.includes("cookie-consent prompt")).length, 1, "the fallback dismissal is logged once and the vendor is handled");
  });

  test("leaves a covered reject control unhandled when the in-page click finds nothing", async (t) => {

    const info = t.mock.method(LOG, "info", () => { /* Captured via the mock. */ });

    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    /* The same covered control, except the element is gone by the time the in-page click runs, so it reports "absent". Nothing was dismissed, so the vendor stays
     * unhandled and the poll resolves its coordinates again on a later tick - the behavior that keeps a banner recoverable rather than silently written off.
     */
    let locateProbes = 0;

    const { page, stub } = makePageStub((arg, fn) => {

      if(arg !== DIDOMI_REJECT) {

        return null;
      }

      if(fn === clickSelectorInPage) {

        return "absent";
      }

      locateProbes++;

      return { x: 2, y: 2 };
    }, { onTop: false });

    const clock = new TestClock();

    const running = startOverlayHandling(page, makeProfile({ videoTimeout: 1000 }),
      { clock, onEmbedGateAccepted: () => { /* No gate is ever located in this row. */ }, phase: "videoWait" });

    await drainClock(clock);
    await running;

    const messages = info.mock.calls.map((call) => String(call.arguments[0]));

    // The vendor is never marked handled, so all three ticks locate the control and each registers its own 200 settle; the 1000 ms window affords two cadences
    // between them.
    assert.deepEqual(clock.requested, [ 200, 500, 200, 500, 200 ], "a settle on every tick that located the control, with two cadences between the three ticks");
    assert.equal(clock.pending, 0, "nothing stayed registered on the clock after the poll ended");
    assert.equal(stub.clicks.length, 0, "a covered control is never pointer-clicked");
    assert.ok(locateProbes >= 2, "an unhandled vendor is resolved again on a later tick");
    assert.ok(!messages.some((m) => m.includes("cookie-consent prompt")), "nothing was dismissed, so no dismissal is logged");
  });

  // Every non-videoWait phase masks the embed-gate accept: its policy forbids the gate, so the acting gate probe never runs, while cookie rejection and per-site
  // modal dismissal stay live. The assertion that would fail against an unmasked implementation is the zero gate-probe count.
  for(const phase of [ "discovery", "postGateReload", "staticCapture", "tuneSetup" ] as const) {

    test("the " + phase + " phase rejects a CMP banner and dismisses a modal but never runs the embed-gate probe", async (t) => {

      t.mock.method(LOG, "info", () => { /* Silenced. */ });
      t.mock.method(LOG, "debug", () => { /* Silenced. */ });

      const controller = new AbortController();

      // The CMP banner and the per-site modal are both present. Aborting the instant the modal is dismissed ends the poll after a single tick.
      const { page, stub } = makePageStub((arg) => {

        if(isGateProbe(arg)) {

          return { label: "Accept", x: 9, y: 9 };
        }

        if(arg === DIDOMI_REJECT) {

          return { x: 5, y: 6 };
        }

        if(arg === DISMISS_SELECTOR) {

          controller.abort();

          return "clicked";
        }

        return null;
      });

      const clock = new TestClock();

      const running = startOverlayHandling(page, makeProfile({ dismissSelector: DISMISS_SELECTOR }), { clock, phase, signal: controller.signal });

      await drainClock(clock);
      await running;

      // One 200 for the reject's settle on the single tick the abort allowed, and no 500 at all: the abort landed inside that tick, so no cadence ever followed it.
      assert.deepEqual(clock.requested, [200], "the tick's own settle was the only wait registered; the abort ended the poll before any cadence");
      assert.equal(clock.pending, 0, "nothing stayed registered on the clock after the poll ended");
      assert.equal(stub.evaluateArgs.filter(isGateProbe).length, 0, "a masked phase never issues the embed-gate probe");
      assert.ok(stub.clicks.some((click) => (click.x === 5) && (click.y === 6)), "the CMP banner is still rejected");
      assert.ok(stub.evaluateArgs.includes(DISMISS_SELECTOR), "the per-site modal is still dismissed");
    });
  }

  test("consentOverlayPresent probes the embed gate read-only while the videoWait tick scrolls and clicks it", async (t) => {

    t.mock.method(LOG, "info", () => { /* Silenced. */ });
    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    // Detection probe: no CMP banner, an embed gate present. The recorded gate-probe argument must carry act false (presence only, no scrollIntoView).
    const probe = makePageStub((arg) => {

      if(Array.isArray(arg)) {

        return false;
      }

      return isGateProbe(arg) ? { label: "Accept" } : null;
    });

    assert.equal(await consentOverlayPresent(probe.page), true);

    const probeGateArg = probe.stub.evaluateArgs.find(isGateProbe);

    assert.ok(probeGateArg, "the detection probe issued an embed-gate probe");
    assert.equal(gateProbeAct(probeGateArg), false, "the detection probe runs in read-only mode - no scrollIntoView");

    // Acting path: the videoWait tick locates and coordinate-clicks the same gate. Its recorded gate-probe argument must carry act true.
    const act = makePageStub((arg) => (isGateProbe(arg) ? { label: "Accept", x: 3, y: 4 } : null));

    await startOverlayHandling(act.page, makeProfile(), { onEmbedGateAccepted: () => { /* Terminates the poll. */ }, phase: "videoWait" });

    const actGateArg = act.stub.evaluateArgs.find(isGateProbe);

    assert.ok(actGateArg, "the videoWait tick issued an embed-gate probe");
    assert.equal(gateProbeAct(actGateArg), true, "the acting path scrolls the matched control into view");
    assert.deepEqual(act.stub.clicks, [{ x: 3, y: 4 }], "the acting path coordinate-clicks the gate");
  });

  test("a malformed dismissSelector disables only itself, warns once per selector per process, and the poll survives", async (t) => {

    const warn = t.mock.method(LOG, "warn", () => { /* Captured via the mock. */ });

    t.mock.method(LOG, "info", () => { /* Silenced. */ });
    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    // A selector unique to this test, so the process-wide warned-selectors set is not pre-poisoned by another test using the same value.
    const badSelector = ":::malformed-" + String(Date.now());

    // Builds a router where the CMP banner is present, the gate is absent, and the bad dismissSelector reports "invalid-selector". A gate-probe counter drives the
    // abort so each poll runs a deterministic two ticks - long enough to prove the dismiss action is not re-probed after being disabled.
    const makeRouter = (controller: AbortController): ((arg: unknown) => unknown) => {

      let gateProbes = 0;

      return (arg): unknown => {

        if(isGateProbe(arg)) {

          gateProbes++;

          if(gateProbes >= 2) {

            controller.abort();
          }

          return null;
        }

        if(arg === DIDOMI_REJECT) {

          return { x: 5, y: 6 };
        }

        return (arg === badSelector) ? "invalid-selector" : null;
      };
    };

    const firstController = new AbortController();
    const first = makePageStub(makeRouter(firstController));
    const firstClock = new TestClock();

    const firstPoll = startOverlayHandling(first.page, makeProfile({ dismissSelector: badSelector }),
      { clock: firstClock, onEmbedGateAccepted: () => { /* The gate never fires in this test; the videoWait arm of the union requires the callback. */ },
        phase: "videoWait", signal: firstController.signal });

    await drainClock(firstClock);
    await firstPoll;

    // The ledger reads one 200 for the reject's settle on the first tick and one 500 for the cadence between the two ticks the abort allowed. The second tick
    // locates nothing - its vendor is already handled - and the malformed selector is dispatched in-page, so neither registers a settle of its own.
    assert.deepEqual(firstClock.requested, [ 200, 500 ], "the reject's settle, then the one cadence between the two ticks");
    assert.equal(firstClock.pending, 0, "nothing stayed registered on the first poll's clock");

    const firstDismissProbes = first.stub.evaluateArgs.filter((arg) => arg === badSelector);

    assert.equal(firstDismissProbes.length, 1, "the malformed selector is probed once, then disabled - not re-probed on the second tick");
    assert.ok(first.stub.evaluateArgs.filter(isGateProbe).length >= 2, "the poll survived the malformed selector and ran a subsequent tick");
    assert.equal(warn.mock.calls.length, 1, "the malformed selector warns exactly once");
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /not a valid CSS selector/);

    // A second poll instance with the SAME selector re-disables silently: the process-wide warned set already holds it, so no second warning is emitted.
    const secondController = new AbortController();
    const second = makePageStub(makeRouter(secondController));
    const secondClock = new TestClock();

    const secondPoll = startOverlayHandling(second.page, makeProfile({ dismissSelector: badSelector }),
      { clock: secondClock, onEmbedGateAccepted: () => { /* The gate never fires in this test; the videoWait arm of the union requires the callback. */ },
        phase: "videoWait", signal: secondController.signal });

    await drainClock(secondClock);
    await secondPoll;

    assert.deepEqual(secondClock.requested, [ 200, 500 ], "the second poll ran the same two ticks on its own clock, with the same settle and cadence");
    assert.equal(secondClock.pending, 0, "nothing stayed registered on the second poll's clock");

    assert.equal(second.stub.evaluateArgs.filter((arg) => arg === badSelector).length, 1, "the second poll still probes and disables the selector");
    assert.equal(warn.mock.calls.length, 1, "the second poll re-disables silently - still exactly one warning across both polls");
  });

  test("a tick error continues the poll on a live page but stops it on a closed page or disconnected browser", async (t) => {

    t.mock.method(LOG, "info", () => { /* Silenced. */ });
    t.mock.method(LOG, "debug", () => { /* Silenced. */ });

    // Live page: the first evaluate throws (a transient in-walk navigation error), but isClosed is false and the browser is connected, so the tick continues and a
    // subsequent evaluate arrives. The gate-probe counter aborts after a couple of ticks so the poll ends deterministically.
    const liveController = new AbortController();
    let liveCalls = 0;

    const live = makePageStub((arg) => {

      liveCalls++;

      if(liveCalls === 1) {

        throw new Error("Execution context was destroyed, most likely because of a navigation.");
      }

      if(isGateProbe(arg) && (liveCalls >= 3)) {

        liveController.abort();
      }

      return null;
    });

    const liveClock = new TestClock();

    const livePoll = startOverlayHandling(live.page, makeProfile(), { clock: liveClock, onEmbedGateAccepted: () => { /* Unused. */ }, phase: "videoWait",
      signal: liveController.signal });

    await settle();
    assert.equal(liveClock.pending, 1, "the live page's first tick survived its error and parked the next cadence");

    await drainClock(liveClock);
    await livePoll;

    assert.ok(live.stub.evaluateArgs.length >= 2, "a transient tick error let the poll continue to a subsequent evaluate");

    // Closed page: the first evaluate throws and isClosed reports true, so the tick stops the poll with no further evaluate.
    const closed = makePageStub(() => { throw new Error("Target closed."); }, { isClosed: (): boolean => true });

    const closedClock = new TestClock();

    await startOverlayHandling(closed.page, makeProfile(), { clock: closedClock, onEmbedGateAccepted: () => { /* Unused. */ }, phase: "videoWait" });

    assert.deepEqual(closedClock.requested, [], "a closed page stops the poll inside its first tick, so no cadence is registered");
    assert.equal(closed.stub.evaluateArgs.length, 1, "a closed page stops the poll after the throwing evaluate, with no further probe");

    // Disconnected browser: the first evaluate throws and the browser reports not connected, so the tick stops the poll with no further evaluate.
    const disconnected = makePageStub(() => { throw new Error("Session closed."); }, { connected: false });

    const disconnectedClock = new TestClock();

    await startOverlayHandling(disconnected.page, makeProfile(), { clock: disconnectedClock, onEmbedGateAccepted: () => { /* Unused. */ }, phase: "videoWait" });

    assert.deepEqual(disconnectedClock.requested, [], "a disconnected browser stops the poll inside its first tick, so no cadence is registered");
    assert.equal(disconnected.stub.evaluateArgs.length, 1, "a disconnected browser stops the poll after the throwing evaluate, with no further probe");
  });

  test("polls repeatedly as a no-op and stops the instant the signal aborts, driven by the injected clock", async (t) => {

    t.mock.method(LOG, "info", () => { /* Silenced. */ });

    // Nothing actionable is ever present, so the poll is a pure no-op. The gate-probe counter aborts right after the second tick's gate probe; no real timer is used.
    const controller = new AbortController();
    let gateProbes = 0;

    const { page, stub } = makePageStub((arg) => {

      if(isGateProbe(arg)) {

        gateProbes++;

        if(gateProbes === 2) {

          controller.abort();
        }
      }

      return null;
    });

    const clock = new TestClock();

    let gateSignals = 0;

    const running = startOverlayHandling(page, makeProfile({ videoTimeout: 10000 }),
      { clock, onEmbedGateAccepted: () => { gateSignals++; }, phase: "videoWait", signal: controller.signal });

    await settle();
    assert.equal(clock.pending, 1, "the first no-op tick parked its cadence on the clock");

    await drainClock(clock);
    await running;

    assert.deepEqual(clock.requested, [500], "exactly one cadence separated the two ticks");
    assert.equal(stub.clicks.length, 0, "a no-overlay poll never clicks");
    assert.equal(gateSignals, 0, "a no-overlay poll never signals a gate");
    assert.equal(stub.evaluateArgs.length, 4, "exactly two no-op ticks (CMP + gate probe each) ran before the abort ended the poll");
  });

  test("an abort that lands while the poll is parked in its cadence ends it inside the sleep", async (t) => {

    t.mock.method(LOG, "info", () => { /* Silenced. */ });

    /* Every other abort row in this file fires its abort from inside a tick's evaluate, so none of them reaches the checkpoint the cadence sleep itself carries.
     * Here the first tick finds nothing and returns "continue", the poll parks its cadence, and the abort arrives while it is parked: the sleep ends on the abort
     * rather than at the cadence's end, the handler resolves, and no second tick ever runs.
     */
    const controller = new AbortController();
    const clock = new TestClock();

    let ticks = 0;

    const { page } = makePageStub((arg) => {

      if(isGateProbe(arg)) {

        ticks++;
      }

      return null;
    });

    const running = startOverlayHandling(page, makeProfile({ videoTimeout: 10000 }),
      { clock, onEmbedGateAccepted: () => { /* No gate is ever located in this row. */ }, phase: "videoWait", signal: controller.signal });

    await settle();
    assert.equal(ticks, 1, "the first tick ran and found nothing");
    assert.equal(clock.pending, 1, "the poll is parked in its cadence");
    assert.deepEqual(clock.requested, [500], "the one cadence the first tick registered");

    controller.abort();
    await settle();
    await running;

    assert.equal(ticks, 1, "no second tick ran: the abort ended the poll inside the sleep");
    assert.equal(clock.pending, 0, "the aborted sleep left the clock");
  });
  test("the tuneSetup phase keeps polling past any fixed budget and stops on the caller's abort", async (t) => {

    t.mock.method(LOG, "info", () => { /* Silenced. */ });

    /* The tuneSetup policy declares no clock window, so only the abort ends its poll. The router aborts on the 95th tick, which the fake clock places at 47000 ms -
     * past every fixed budget the table has ever carried. A budget of any size would end the poll earlier and leave the tick count short of 95, which is what makes
     * this row the detector for the window's removal rather than a restatement of the abort path.
     */
    const controller = new AbortController();
    const clock = new TestClock();

    let ticks = 0;

    const { page, stub } = makePageStub((arg) => {

      if(arg === DIDOMI_REJECT) {

        ticks++;

        if(ticks === 95) {

          controller.abort();
        }
      }

      return null;
    });

    const running = startOverlayHandling(page, makeProfile(), { clock, phase: "tuneSetup", signal: controller.signal });

    await settle();
    assert.equal(clock.pending, 1, "the first tick parked its cadence on the clock");

    await drainClock(clock);
    await running;

    assert.equal(stub.evaluateArgs.length, 95, "the poll ran 95 ticks - no fixed window cut it short - and the abort ended it");
    assert.equal(clock.now(), 47000, "the poll was still ticking at 47000 ms of poll time, past any budget the phase could have carried");
  });

  /* Every phase that declares a clock window still resolves it exactly as the table states: a no-op poll on the fake clock runs one CMP probe per tick and ends at
   * its deadline with no abort. Ticks are counted by CMP probes rather than by every page.evaluate, because the video wait runs a gate probe per tick as well and
   * the CMP probe is the one call every phase makes exactly once. The expected count is windowMs / 500 + 1, since the first tick is immediate and each later tick
   * follows a 500 ms sleep. The parity assertion is that dropping tuneSetup's window left every other phase's untouched.
   */
  for(const [ phase, windowMs, ticks ] of [ [ "discovery", 60000, 121 ], [ "postGateReload", 10000, 21 ], [ "staticCapture", 30000, 61 ],
    [ "videoWait", 10000, 21 ] ] as const) {

    test("the " + phase + " phase still runs its full " + String(windowMs) + " ms window and ends at the deadline", async (t) => {

      t.mock.method(LOG, "info", () => { /* Silenced. */ });

      const clock = new TestClock();
      const { page, stub } = makePageStub(() => null);

      // The two profile-derived phases read their window from videoTimeout, so the profile carries the same 10000 ms those rows expect; the fixed-window phases
      // ignore it. The video wait is the only phase whose union arm requires the gate callback, which never fires here because nothing is ever present.
      const running = (phase === "videoWait") ? startOverlayHandling(page, makeProfile({ videoTimeout: 10000 }),
        { clock, onEmbedGateAccepted: (): void => { /* No gate is ever located in a no-op poll. */ }, phase }) :
        startOverlayHandling(page, makeProfile({ videoTimeout: 10000 }), { clock, phase });

      await settle();
      assert.equal(clock.pending, 1, "the first tick parked its cadence on the clock");

      const steps = await drainClock(clock);

      await running;

      assert.equal(steps, ticks - 1, "the drain stepped one cadence between each pair of ticks");

      const cmpProbes = stub.evaluateArgs.filter((arg) => arg === DIDOMI_REJECT);

      assert.equal(cmpProbes.length, ticks, "the phase ran exactly the tick count its window allows");
      assert.equal(clock.now(), windowMs, "the poll ended at the phase's deadline");
    });
  }
});

describe("consentOverlayPresent", () => {

  test("returns true when a known CMP banner is detected", async () => {

    // The CMP-detect probe (array argument) reports a banner; the embed-gate probe is never consulted.
    const { page, stub } = makePageStub((arg) => Array.isArray(arg));

    assert.equal(await consentOverlayPresent(page), true);
    assert.equal(stub.evaluateArgs.length, 1, "short-circuits on the CMP-detect probe");
  });

  test("returns true when no CMP banner but an embed gate is located", async () => {

    const { page } = makePageStub((arg) => {

      if(Array.isArray(arg)) {

        return false;
      }

      return isGateProbe(arg) ? { label: "Accept" } : null;
    });

    assert.equal(await consentOverlayPresent(page), true);
  });

  test("returns false when neither a CMP banner nor an embed gate is present", async () => {

    const { page } = makePageStub((arg) => (Array.isArray(arg) ? false : null));

    assert.equal(await consentOverlayPresent(page), false);
  });

  test("returns false when probing throws (page navigated or closed)", async () => {

    const { page } = makePageStub(() => { throw new Error("Target closed."); });

    assert.equal(await consentOverlayPresent(page), false);
  });
});
