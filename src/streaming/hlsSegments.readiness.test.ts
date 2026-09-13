/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hlsSegments.readiness.test.ts: Unit tests for the playlist + init-segment readiness signals exposed by hlsSegments.ts - waitForPlaylist and waitForInitSegment.
 * Storage primitives (storeSegment, getSegment, audio/playlist/init variants) live in hlsSegments.test.ts.
 */
import { TestClock, settle } from "homebridge-plugin-utils/testing";
import { afterEach, beforeEach, describe, test } from "node:test";
import { registerStream, unregisterStream } from "./registry.ts";
import { storeInitSegment, storeNamedInitSegment, updatePlaylist, waitForInitSegment, waitForPlaylist } from "./hlsSegments.ts";
import assert from "node:assert/strict";
import { makeRegistryEntry } from "./registry.helpers.ts";

/* makeAndRegisterStream wraps the canonical makeRegistryEntry factory with registerStream so the test setup pattern is one line.
 */
function makeAndRegisterStream(): { streamId: number } {

  const entry = makeRegistryEntry();

  registerStream(entry);

  return { streamId: entry.id };
}

describe("waitForPlaylist", () => {

  let streamId: number;

  beforeEach(() => {

    ({ streamId } = makeAndRegisterStream());
  });

  afterEach(() => {

    unregisterStream(streamId);
  });

  test("returns true when the playlist becomes ready before the timeout", async () => {

    // Resolve the playlist before the wait so the inner promise wins the race. The virtual clock is never advanced, so the bound cannot fire and the result is
    // driven by the inner promise's resolution alone.
    updatePlaylist(streamId, "#EXTM3U");

    const clock = new TestClock();
    const ready = await waitForPlaylist(streamId, 1000, clock);

    assert.equal(ready, true);

    await settle();

    assert.equal(clock.pending, 0, "the bound was cancelled once the readiness arm won");
  });

  test("returns false when the timeout fires before any playlist arrives", async () => {

    // Advancing to the bound is what lets the timer win, and waitForReady's .catch maps the rejection to false. Locks the contract without depending on
    // real-time delay budgets.
    const clock = new TestClock();
    const pending = waitForPlaylist(streamId, 5, clock);

    await settle();

    assert.equal(clock.nextDeadline, 5, "the bound is armed at the timeout the caller asked for");

    clock.advance(5);

    assert.equal(await pending, false);
    assert.equal(clock.pending, 0, "nothing stays registered once the bound has fired");
  });

  test("returns false for an unknown stream", async () => {

    // The early-return path never reaches the clock, so default-arg is fine; locks the early-return contract independently of clock injection.
    assert.equal(await waitForPlaylist(999999, 5), false);
  });
});

describe("waitForInitSegment", () => {

  let streamId: number;

  beforeEach(() => {

    ({ streamId } = makeAndRegisterStream());
  });

  afterEach(() => {

    unregisterStream(streamId);
  });

  test("returns true when the init segment becomes ready before the timeout", async () => {

    // Resolve the init segment before the wait so the inner promise wins the race; the virtual clock is never advanced, so its bound cannot fire.
    storeInitSegment(streamId, Buffer.from("init"));

    const clock = new TestClock();
    const ready = await waitForInitSegment(streamId, 1000, clock);

    assert.equal(ready, true);

    await settle();

    assert.equal(clock.pending, 0, "the bound was cancelled once the readiness arm won");
  });

  test("returns false when the timeout fires before any init segment arrives", async () => {

    const clock = new TestClock();
    const pending = waitForInitSegment(streamId, 5, clock);

    await settle();

    assert.equal(clock.nextDeadline, 5, "the bound is armed at the timeout the caller asked for");

    clock.advance(5);

    assert.equal(await pending, false);
    assert.equal(clock.pending, 0, "nothing stays registered once the bound has fired");
  });

  test("returns false for an unknown stream", async () => {

    assert.equal(await waitForInitSegment(999999, 5), false);
  });
});

describe("readiness waits resolve on stream termination", () => {

  test("waitForPlaylist resolves false promptly when the stream terminates, without resolving playlistReady", async () => {

    const entry = makeRegistryEntry();

    registerStream(entry);

    // Probe the readiness promise itself: termination must settle the WAIT via the third race arm without resolving playlistReady, whose contract stays pure. We
    // attach the probe before the emit and flush microtasks after, so an implementation that resolved the promise on termination would flip the flag and be caught.
    let readinessSettled = false;

    void entry.hls.playlistReady.then(() => {

      readinessSettled = true;
    });

    // The virtual clock is never advanced, so its bound cannot fire and only the readiness or terminated arm can settle the race.
    const clock = new TestClock();
    const pending = waitForPlaylist(entry.id, 30000, clock);

    // Emit terminated directly on the entry's emitter. The real terminateStream additionally strips every listener, which would mask the hygiene assertions below, so
    // these tests drive the emitter directly to isolate the race behavior.
    entry.hls.segmentEmitter.emit("terminated");

    const ready = await pending;

    await Promise.resolve();

    assert.equal(ready, false, "the terminated arm resolves the wait false");
    assert.equal(readinessSettled, false, "playlistReady itself is never resolved by termination");

    unregisterStream(entry.id);
  });

  test("waitForInitSegment resolves false promptly when the stream terminates, without resolving initSegmentReady", async () => {

    const entry = makeRegistryEntry();

    registerStream(entry);

    let readinessSettled = false;

    void entry.hls.initSegmentReady.then(() => {

      readinessSettled = true;
    });

    const clock = new TestClock();
    const pending = waitForInitSegment(entry.id, 30000, clock);

    entry.hls.segmentEmitter.emit("terminated");

    const ready = await pending;

    await Promise.resolve();

    assert.equal(ready, false, "the terminated arm resolves the wait false");
    assert.equal(readinessSettled, false, "initSegmentReady itself is never resolved by termination");

    unregisterStream(entry.id);
  });

  test("removes the terminated listener after both the terminated-wins and readiness-wins outcomes", async () => {

    // Terminated-wins: baseline is zero, the wait attaches one, and settling via the terminated arm returns it to zero.
    const terminatedEntry = makeRegistryEntry();

    registerStream(terminatedEntry);

    assert.equal(terminatedEntry.hls.segmentEmitter.listenerCount("terminated"), 0, "no terminated listeners before the wait");

    const terminatedClock = new TestClock();
    const terminatedPending = waitForPlaylist(terminatedEntry.id, 30000, terminatedClock);

    assert.equal(terminatedEntry.hls.segmentEmitter.listenerCount("terminated"), 1, "the wait attaches exactly one terminated listener");

    terminatedEntry.hls.segmentEmitter.emit("terminated");

    await terminatedPending;

    assert.equal(terminatedEntry.hls.segmentEmitter.listenerCount("terminated"), 0, "the terminated listener is removed after the terminated arm wins");

    unregisterStream(terminatedEntry.id);

    // Readiness-wins: the same lifecycle, settled by the playlist becoming ready instead of by termination.
    const readyEntry = makeRegistryEntry();

    registerStream(readyEntry);

    const readyClock = new TestClock();
    const readyPending = waitForPlaylist(readyEntry.id, 30000, readyClock);

    assert.equal(readyEntry.hls.segmentEmitter.listenerCount("terminated"), 1, "the wait attaches exactly one terminated listener");

    updatePlaylist(readyEntry.id, "#EXTM3U");

    await readyPending;

    assert.equal(readyEntry.hls.segmentEmitter.listenerCount("terminated"), 0, "the terminated listener is removed after the readiness arm wins");

    unregisterStream(readyEntry.id);
  });
});

describe("named init readiness is keyed on the video track (T13)", () => {

  test("an audio-first init does not resolve readiness, and the video init then does", async () => {

    /* A split-track fMP4 relay can land its audio initialization before its video one. Readiness must not fire on the audio arrival: the consumer waiting on this
     * signal is the MPEG-TS remux path, which resolves the VIDEO initialization, so releasing a client on audio would hand it a guard with nothing to validate.
     *
     * The pending-versus-resolved distinction is only real after a microtask flush - without it, an already-resolved promise and a pending one are
     * indistinguishable because neither has run its continuation yet. So the flag is registered before the store call and the flush happens before the assertion.
     */
    const entry = makeRegistryEntry();

    registerStream(entry);

    let readinessSettled = false;

    void entry.hls.initSegmentReady.then(() => {

      readinessSettled = true;
    });

    storeNamedInitSegment(entry.id, "audio", "init-a0.mp4", Buffer.from("audio-init"));

    await Promise.resolve();

    assert.equal(readinessSettled, false, "the audio track's first init does not signal readiness");

    storeNamedInitSegment(entry.id, "video", "init-v0.mp4", Buffer.from("video-init"));

    await entry.hls.initSegmentReady;

    assert.equal(readinessSettled, true, "the video track's first init signals readiness");

    unregisterStream(entry.id);
  });

  test("waitForInitSegment resolves true once the video track's first named init is stored", async () => {

    // The route the MPEG-TS path actually takes: a relay whose video initialization arrives while a client is already waiting.
    const entry = makeRegistryEntry();

    registerStream(entry);

    const clock = new TestClock();
    const pending = waitForInitSegment(entry.id, 30000, clock);

    storeNamedInitSegment(entry.id, "video", "init-v0.mp4", Buffer.from("video-init"));

    assert.equal(await pending, true, "the video init releases the wait");

    unregisterStream(entry.id);
  });
});
