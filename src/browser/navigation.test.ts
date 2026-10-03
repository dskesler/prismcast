/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * navigation.test.ts: Unit tests for the document-load primitives. Two things decide every row here: which wait a load was issued under, and what a failure
 * under that wait does. The network-idle wait carries the navigation timeout and tolerates it, because a site whose background requests never settle has very
 * often rendered its video anyway; the plain wait carries neither, because a load that fires its load event has nothing left to tolerate.
 *
 * The tolerance is what the rows guard most closely. The retry wrapper the tune path runs these loads under reads a return as success and a throw as a failure
 * worth retrying, so a tolerated timeout that started throwing would turn a working tune into a retried one, and a genuine failure that stopped throwing would
 * hand channel selection a page that never loaded.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import { loadDocument, reloadDocument } from "./navigation.ts";
import { makeDocumentResponse, makeFakePage } from "../testing.helpers.ts";
import type { Nullable } from "../types/index.ts";
import assert from "node:assert/strict";
import { subscribeToLogs } from "../utils/index.ts";

// The wait preferences the rows drive, named once so a row reads as the preference it is testing rather than as an object literal.
const IDLE_WAIT = { waitForNetworkIdle: true };
const LOAD_WAIT = { waitForNetworkIdle: false };

// A Puppeteer timeout carries its identity in the error's name rather than in its message, which is what the tolerance branches on.
const TIMEOUT_ERROR = Object.assign(new Error("Navigation timeout of 30000 ms exceeded"), { name: "TimeoutError" });

// Every warn line emitted during a row, captured off the same emitter the web UI's log stream reads.
let warnings: string[] = [];
let unsubscribe: Nullable<() => void> = null;

beforeEach(() => {

  warnings = [];
  unsubscribe = subscribeToLogs((entry) => {

    if(entry.level === "warn") {

      warnings.push(entry.message);
    }
  });
});

afterEach(() => {

  unsubscribe?.();
  unsubscribe = null;
});

describe("loadDocument", () => {

  test("issues the navigation under the network-idle wait and answers with the document response", async () => {

    const response = makeDocumentResponse(200);
    const fake = makeFakePage({ onGoto: (call) => { call.resolve(response); } });

    const loaded = await loadDocument(fake.page, "https://idle.test/live", IDLE_WAIT);

    assert.equal(fake.navigations.length, 1, "one navigation was issued");
    assert.equal(fake.navigations[0]?.args[0], "https://idle.test/live", "to the URL it was handed");

    const options = fake.navigations[0].args[1] as { timeout: number; waitUntil: string };

    assert.equal(options.waitUntil, "networkidle2", "under the network-idle wait");
    assert.ok(options.timeout > 0, "carrying the navigation timeout");
    assert.equal(loaded, response, "and the document response comes back to the caller");
    assert.deepEqual(warnings, [], "a clean load says nothing");
  });

  test("tolerates a navigation timeout under the network-idle wait, answering null with one warning", async () => {

    // The tolerance the whole tune path depends on: the player is frequently up even when a background request kept the page from settling, so this returns to
    // the retry wrapper as a success rather than spending an attempt.
    const fake = makeFakePage({ onGoto: (call) => { call.reject(TIMEOUT_ERROR); } });

    const loaded = await loadDocument(fake.page, "https://slow.test/live", IDLE_WAIT);

    assert.equal(loaded, null, "the timeout answers null rather than a response");
    assert.equal(warnings.length, 1, "exactly one warning was emitted");
    assert.ok(warnings[0]?.includes("Page navigation timed out"), "naming the navigation timeout");
  });

  test("propagates any other navigation failure under the network-idle wait", async () => {

    // The other half of the same decision. A network failure or a bad URL is a real failure, and the retry wrapper has to see it as one.
    const fake = makeFakePage({ onGoto: (call) => { call.reject(new Error("net::ERR_NAME_NOT_RESOLVED")); } });

    await assert.rejects(loadDocument(fake.page, "https://missing.test/live", IDLE_WAIT), /ERR_NAME_NOT_RESOLVED/,
      "the failure reaches the caller unchanged");

    assert.deepEqual(warnings, [], "a propagated failure is the caller's to report, not this one's");
  });

  test("issues the navigation with the URL alone when the profile does not wait for network idle", async () => {

    // A site with persistent connections would never reach idle, so its load carries no wait options at all and returns at the load event.
    const response = makeDocumentResponse(200);
    const fake = makeFakePage({ onGoto: (call) => { call.resolve(response); } });

    const loaded = await loadDocument(fake.page, "https://plain.test/watch", LOAD_WAIT);

    assert.equal(fake.navigations.length, 1, "one navigation was issued");
    assert.deepEqual(fake.navigations[0]?.args, ["https://plain.test/watch"], "with the URL as its only argument");
    assert.equal(loaded, response, "and the document response comes back to the caller");
  });

  test("propagates a failure on the plain wait, which has no timeout to tolerate", async () => {

    // Without the navigation timeout there is no tolerated class here at all, so even a timeout-named error is a failure on this path.
    const fake = makeFakePage({ onGoto: (call) => { call.reject(TIMEOUT_ERROR); } });

    await assert.rejects(loadDocument(fake.page, "https://plain.test/watch", LOAD_WAIT), /Navigation timeout/, "the failure reaches the caller unchanged");

    assert.deepEqual(warnings, [], "and nothing is warned about");
  });
});

describe("reloadDocument", () => {

  test("reloads under the wait the options ask for", async () => {

    const idle = makeFakePage({ onReload: (call) => { call.resolve(null); } });
    const plain = makeFakePage({ onReload: (call) => { call.resolve(null); } });

    await reloadDocument(idle.page, IDLE_WAIT);
    await reloadDocument(plain.page, LOAD_WAIT);

    assert.equal((idle.reloads[0]?.args[0] as { waitUntil: string }).waitUntil, "networkidle2", "the idle preference reloads for network idle");
    assert.equal((plain.reloads[0]?.args[0] as { waitUntil: string }).waitUntil, "load", "and the plain preference reloads for the load event");
  });

  test("tolerates a reload timeout with one warning and propagates any other failure", async () => {

    // A reload mirrors a load: the player may already be present even if some background request never settled, so the timeout is a warning and everything else
    // is a failure the caller has to see.
    const tolerated = makeFakePage({ onReload: (call) => { call.reject(TIMEOUT_ERROR); } });

    await reloadDocument(tolerated.page, IDLE_WAIT);

    assert.equal(warnings.length, 1, "exactly one warning was emitted");
    assert.ok(warnings[0]?.includes("Page reload timed out"), "naming the reload timeout");

    const failing = makeFakePage({ onReload: (call) => { call.reject(new Error("net::ERR_ABORTED")); } });

    await assert.rejects(reloadDocument(failing.page, IDLE_WAIT), /ERR_ABORTED/, "the failure reaches the caller unchanged");
    assert.equal(warnings.length, 1, "and a propagated failure adds no warning of its own");
  });
});
