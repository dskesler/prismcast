/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * page.helpers.test.ts: Unit tests for the general Page double. The double's whole value is that calls stay open until the test settles them and that every
 * call is recorded with the clock value it was issued at, so those two properties plus the per-member handler contract are what these tests assert.
 */
import { describe, test } from "node:test";
import { makeDocumentResponse, makeFakePage } from "./page.helpers.ts";
import assert from "node:assert/strict";
import { flushMicrotasks } from "./fn.helpers.ts";

describe("makeFakePage", () => {

  test("holds an evaluate open until the test settles it, and records the call", async () => {

    const fake = makeFakePage();

    let settled = "pending";

    const call = fake.page.evaluate(() => 1).then((value) => { settled = "resolved:" + String(value); });

    await flushMicrotasks(5);

    assert.equal(settled, "pending", "an unanswered evaluate stays outstanding");
    assert.equal(fake.evaluations.length, 1, "the call was recorded");

    fake.evaluations[0]?.resolve(42);

    await call;

    assert.equal(settled, "resolved:42", "the recorded handle answers the outstanding call");
  });

  test("rejects an evaluate through the recorded handle", async () => {

    const fake = makeFakePage();

    const call = fake.page.evaluate(() => 1);

    fake.evaluations[0]?.reject(new Error("context gone"));

    await assert.rejects(call, /context gone/, "the rejection reaches the caller");
  });

  test("answers through a per-call handler, with the call's index", async () => {

    // The handler form is what a test uses when every call takes the same canned answer: it settles the call as it arrives, so production code never blocks.
    const fake = makeFakePage({ onEvaluate: (evaluation, index) => { evaluation.resolve(index); } });

    assert.equal(await fake.page.evaluate(() => 1), 0, "first call answered with its index");
    assert.equal(await fake.page.evaluate(() => 1), 1, "second call answered with its index");
    assert.equal(fake.evaluations.length, 2, "both calls recorded in issue order");
  });

  test("records the clock value each call was issued at", async (t) => {

    // The timestamp is what lets a test assert when production code chose to make a call rather than only how many it made.
    t.mock.timers.enable({ apis: [ "setTimeout", "Date" ] });

    const fake = makeFakePage();

    void fake.page.evaluate(() => 1);

    t.mock.timers.tick(5000);

    void fake.page.evaluate(() => 1);

    assert.equal(fake.evaluations[0]?.at, 0, "first call stamped at the starting clock value");
    assert.equal(fake.evaluations[1]?.at, 5000, "second call stamped after the advance");
  });

  test("holds goto and waitForSelector open the same way", async () => {

    const fake = makeFakePage();

    const navigation = fake.page.goto("https://example.test/");
    const wait = fake.page.waitForSelector("video");

    assert.equal(fake.navigations.length, 1, "the navigation was recorded");
    assert.equal(fake.selectorWaits.length, 1, "the selector wait was recorded");

    fake.navigations[0]?.reject(new Error("navigation refused"));
    fake.selectorWaits[0]?.reject(new Error("no video"));

    await assert.rejects(navigation, /navigation refused/);
    await assert.rejects(wait, /no video/);
  });

  test("reports the configured url, frames, and browser pages, and follows setUrl and setClosed", async () => {

    const frame = { name: "child" };
    const other = { id: "other-page" };
    const fake = makeFakePage({ frames: [frame], pages: [other], url: "https://start.test/" });

    assert.equal(fake.page.url(), "https://start.test/", "the configured url is reported");
    assert.deepEqual(fake.page.frames(), [frame], "the configured frames are reported");
    assert.equal(fake.page.isClosed(), false, "a fresh double reports open");

    assert.deepEqual(await fake.page.browser().pages(), [other], "browser().pages() resolves with the configured list");

    fake.setUrl("https://moved.test/");
    fake.setClosed(true);

    assert.equal(fake.page.url(), "https://moved.test/", "setUrl takes effect");
    assert.equal(fake.page.isClosed(), true, "setClosed takes effect");
  });

  test("defaults frames and browser pages to empty", async () => {

    // Boundary: the defaults must be safe for code that counts pages before and after a navigation, which is the shape recovery code uses.
    const fake = makeFakePage();

    assert.deepEqual(fake.page.frames(), [], "no frames by default");
    assert.deepEqual(await fake.page.browser().pages(), [], "no pages by default");
  });

  test("holds $eval, reload, and waitForFunction open the same way", async () => {

    // The three members a provider's own route into its site drives: clicking an element in page, reloading, and waiting on a condition the page has to reach.
    const fake = makeFakePage();

    const elementEvaluation = fake.page.$eval("a[href=\"/live\"]", (el: Element) => el.tagName);
    const reload = fake.page.reload();
    const functionWait = fake.page.waitForFunction(() => true);

    assert.equal(fake.elementEvaluations.length, 1, "the element evaluation was recorded");
    assert.equal(fake.reloads.length, 1, "the reload was recorded");
    assert.equal(fake.functionWaits.length, 1, "the function wait was recorded");

    fake.elementEvaluations[0]?.reject(new Error("no such element"));
    fake.reloads[0]?.reject(new Error("reload refused"));
    fake.functionWaits[0]?.reject(new Error("condition never met"));

    await assert.rejects(elementEvaluation, /no such element/);
    await assert.rejects(reload, /reload refused/);
    await assert.rejects(functionWait, /condition never met/);
  });

  test("holds a mouse click open the same way, and records the coordinates it was issued with", async () => {

    // The member a coordinate-click path drives: production code resolves an element's center and then clicks that point, so where the click landed is as much
    // of the observation as that one happened at all.
    const fake = makeFakePage();

    let settled = "pending";

    const click = fake.page.mouse.click(640, 40).then(() => { settled = "resolved"; });

    await flushMicrotasks(5);

    assert.equal(fake.mouseClicks.length, 1, "the click was recorded");
    assert.deepEqual(fake.mouseClicks[0]?.args, [ 640, 40 ], "carrying the coordinates it was issued with");
    assert.equal(settled, "pending", "an unanswered click stays outstanding");

    fake.mouseClicks[0].resolve(undefined);

    await click;

    assert.equal(settled, "resolved", "the recorded handle answers the outstanding call");
  });

  test("reports one main frame whose url follows setUrl, and holds waitForFrame open the same way", async () => {

    /* A frame wait's predicate is handed frames and answers on their identity and their URL, so the double has to report one main frame rather than a fresh
     * object per call, and that frame has to carry whatever URL the page reports at the moment it is asked.
     */
    const fake = makeFakePage({ url: "https://hub.test/" });

    const frame = fake.page.mainFrame();

    assert.equal(fake.page.mainFrame(), frame, "the same main frame comes back every time it is asked for");
    assert.equal(frame.url(), "https://hub.test/", "the main frame carries the URL the page reports");

    fake.setUrl("https://hub.test/live");

    assert.equal(frame.url(), "https://hub.test/live", "and follows the page when it moves");

    let settled = "pending";

    const frameWait = fake.page.waitForFrame(() => true).catch((error: unknown) => { settled = "rejected:" + (error as Error).message; });

    await flushMicrotasks(5);

    assert.equal(fake.frameWaits.length, 1, "the frame wait was recorded");
    assert.equal(settled, "pending", "an unanswered frame wait stays outstanding");

    fake.frameWaits[0]?.reject(new Error("no frame reached the path"));

    await frameWait;

    assert.equal(settled, "rejected:no frame reached the path", "the recorded handle answers the outstanding call");
  });

  test("stamps each recorded call with the arguments it was issued with", async () => {

    // What a call asked for is as much of the observation as that it happened: a test asserting which URL was navigated to, or which selector was waited on,
    // reads it from here.
    const fake = makeFakePage();

    void fake.page.goto("https://stamped.test/live", { waitUntil: "networkidle2" });
    void fake.page.waitForSelector("#CHANNELS", { visible: true });

    assert.equal(fake.navigations[0]?.args[0], "https://stamped.test/live", "the navigation carries the URL it was issued with");
    assert.deepEqual(fake.navigations[0].args[1], { waitUntil: "networkidle2" }, "and the options object alongside it");
    assert.equal(fake.selectorWaits[0]?.args[0], "#CHANNELS", "the selector wait carries the selector it was issued with");
  });

  test("records an event listener registration and answers with the page", async () => {

    // Registration is synchronous and chainable on a real Page, so the double returns the page rather than a promise; production code that registers response
    // listeners before navigating depends on both halves.
    const fake = makeFakePage();

    const listener = (): void => { /* The listener is recorded, never invoked by the double. */ };
    const returned = fake.page.on("console", listener);

    assert.equal(fake.listeners.length, 1, "the registration was recorded");
    assert.equal(fake.listeners[0]?.event, "console", "under the event it was registered for");
    assert.equal(fake.listeners[0].listener, listener, "carrying the listener itself");
    assert.equal(returned, fake.page, "and the page comes back for chaining");
  });

  test("builds a document response whose ok() follows the HTTP success range", async () => {

    // Both edges of the range, because code that branches on ok() is deciding whether a site answered at all - and a polarity that is wrong at 299 or at 300
    // sends every one of those decisions the wrong way.
    assert.equal(makeDocumentResponse(199).ok(), false, "a status below the success range is not ok");
    assert.equal(makeDocumentResponse(200).ok(), true, "the bottom of the success range is ok");
    assert.equal(makeDocumentResponse(299).ok(), true, "the top of the success range is ok");
    assert.equal(makeDocumentResponse(300).ok(), false, "a status above the success range is not ok");
    assert.equal(makeDocumentResponse(500).ok(), false, "a server error is not ok");
    assert.equal(makeDocumentResponse(500).status(), 500, "and the status is reported verbatim");
  });
});
