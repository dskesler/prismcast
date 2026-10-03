/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * pretuneTimers.test.ts: Unit tests for the pretune safety-timer registry. This is the leaf module that owns the per-stream reaper timers; it has no browser or CDP
 * dependency, so the cancel-a-pending-reaper property - dropping a claimed pretuned stream's safety timer so it does not linger and fire against an already-gone
 * stream - is asserted directly here on a virtual clock. A regression that removed the cancellation from clearPretuneSafetyTimer (reintroducing that exact leak)
 * would fail the first test below. Each row reads the clock's pending count before it advances, so a row can tell a drained registry from one whose timers were
 * simply never armed.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import { clearAllPretuneSafetyTimers, clearPretuneSafetyTimer, setPretuneSafetyTimer, startPretuneSafetyTimers } from "./pretuneTimers.ts";
import { TestClock } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";

describe("pretuneTimers", () => {

  let clock: TestClock;

  beforeEach(() => {

    clock = new TestClock();

    startPretuneSafetyTimers(clock);
  });

  afterEach(() => {

    // Drain any reapers the test registered so none survives into the next test.
    clearAllPretuneSafetyTimers();
  });

  test("clearPretuneSafetyTimer cancels a registered timer so its reaper never fires", () => {

    let fired = false;

    setPretuneSafetyTimer(7, () => { fired = true; }, 90000);

    assert.equal(clock.pending, 1, "the arm registered one reaper on the clock");

    clearPretuneSafetyTimer(7);

    assert.equal(clock.pending, 0, "the clear removed it from the timeline");

    // Advance well past the original delay; the cancelled reaper must not run.
    clock.advance(120000);

    assert.equal(fired, false, "the cancelled reaper does not fire after its delay elapses");

    // A second clear for the same stream is a harmless no-op.
    assert.doesNotThrow(() => { clearPretuneSafetyTimer(7); });
  });

  test("clearPretuneSafetyTimer is a no-op for a stream that never registered a timer", () => {

    assert.doesNotThrow(() => { clearPretuneSafetyTimer(999999); });
  });

  test("a reaper fires exactly once at its delay and leaves nothing armed behind it", () => {

    let fireCount = 0;

    setPretuneSafetyTimer(4, () => { fireCount++; }, 30000);

    clock.advance(29999);

    assert.equal(fireCount, 0, "the reaper has not fired one millisecond before its delay");

    clock.advance(1);

    assert.equal(fireCount, 1, "the reaper fired at its delay");
    assert.equal(clock.pending, 0, "a fired one-shot leaves nothing armed");

    clock.advance(120000);

    assert.equal(fireCount, 1, "a further advance does not fire it again");

    // The fired reaper already dropped its own entry; a defensive clear afterward must not double-cancel or throw.
    assert.doesNotThrow(() => { clearPretuneSafetyTimer(4); });
  });

  test("clearAllPretuneSafetyTimers drains every reaper and leaves the registry armed for the arms that follow", () => {

    let firedA = false;
    let firedB = false;
    let firedAfter = false;

    setPretuneSafetyTimer(1, () => { firedA = true; }, 50000);
    setPretuneSafetyTimer(2, () => { firedB = true; }, 60000);

    assert.equal(clock.pending, 2, "both reapers are armed");

    clearAllPretuneSafetyTimers();

    assert.equal(clock.pending, 0, "the drain removed both");

    clock.advance(120000);

    assert.equal(firedA, false, "the first reaper was cancelled");
    assert.equal(firedB, false, "the second reaper was cancelled");

    // The drain leaves the registry itself armed, so a pretune whose attempt completes after a stop still gets a working reaper.
    setPretuneSafetyTimer(3, () => { firedAfter = true; }, 10000);

    assert.equal(clock.pending, 1, "an arm after the drain registers");

    clock.advance(10000);

    assert.equal(firedAfter, true, "an arm after the drain fires at its delay");
  });

  test("re-registering a stream's safety timer replaces the prior reaper so the registry holds at most one live timer", () => {

    let firedOld = false;
    let firedNew = false;

    setPretuneSafetyTimer(5, () => { firedOld = true; }, 30000);

    // Re-registering for the same stream replaces the prior reaper, so no stale handle survives in the registry.
    setPretuneSafetyTimer(5, () => { firedNew = true; }, 45000);

    assert.equal(clock.pending, 1, "the key holds exactly one live reaper after the replacement");

    clock.advance(120000);

    assert.equal(firedOld, false, "the prior reaper never ran once it was replaced");
    assert.equal(firedNew, true, "the current reaper ran exactly at its own delay");
  });

  test("a start on a second clock retires the prior registry, so a reaper armed before it can never fire", () => {

    let firedBefore = false;
    let firedAfter = false;
    const other = new TestClock();

    setPretuneSafetyTimer(9, () => { firedBefore = true; }, 90000);

    assert.equal(clock.pending, 1, "the reaper is armed on the first clock");

    startPretuneSafetyTimers(other);

    assert.equal(clock.pending, 0, "the restart drained the first clock's timeline");

    clock.advance(120000);

    assert.equal(firedBefore, false, "a reaper armed before the restart never fires");

    // Every arm that follows lands on the replacement registry, on the restart's clock.
    setPretuneSafetyTimer(9, () => { firedAfter = true; }, 20000);

    assert.equal(other.pending, 1, "the arm after the restart registered on the replacement clock");
    assert.equal(clock.pending, 0, "and nothing landed back on the retired one");

    other.advance(20000);

    assert.equal(firedAfter, true, "the reaper armed after the restart fires on the replacement clock");
  });
});
