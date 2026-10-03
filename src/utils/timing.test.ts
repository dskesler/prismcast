/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timing.test.ts: Unit tests for the startTimer closure in timing.ts. Time is read through the library's injected Clock, so every row drives a TestClock and
 * advances it explicitly - no real-time delays, no busy-waits, no slack budgets. The default-arg wiring to systemClock is locked in a separate row that
 * exercises the production path without asserting any specific elapsed value.
 */
import { describe, test } from "node:test";
import { TestClock } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { startTimer } from "./timing.ts";

describe("startTimer", () => {

  test("returns 0 when read at the same time it was created", () => {

    // Boundary: the smallest possible interval. With the clock never advanced, the closure returns 0 deterministically (no slack needed).
    const clock = new TestClock();

    const elapsed = startTimer(clock);

    assert.equal(elapsed(), 0);
  });

  test("returns a non-negative integer rounded from the elapsed delta", () => {

    // The closure rounds the delta. Seeded at 4.6 and advanced by 4.7, the delta is 4.7 and the rounded value is 5.
    const clock = new TestClock(4.6);

    const elapsed = startTimer(clock);

    clock.advance(4.7);

    const value = elapsed();

    assert.equal(value, 5, "Math.round(9.3 - 4.6) = 5");
    assert.equal(typeof value, "number");
    assert.equal(value, Math.round(value), "result is an integer");
  });

  test("captures the start time at creation, not at first read", () => {

    // Locks the closure semantic: the start value is fixed when startTimer() returns; subsequent advances of the clock change the elapsed read but not the start.
    const clock = new TestClock(100);

    const elapsed = startTimer(clock);

    clock.advance(150);
    assert.equal(elapsed(), 150, "first read sees the delta from the captured start");

    clock.advance(750);
    assert.equal(elapsed(), 900, "second read still measures from the original start, not the previous read");
  });

  test("reports a non-decreasing value across multiple reads when the clock is monotonic", () => {

    // Advancing virtual time forward and never back gives a monotonic clock, and the closure's reads must reflect that.
    const clock = new TestClock();

    const elapsed = startTimer(clock);

    clock.advance(10);
    const a = elapsed();

    clock.advance(0);
    const b = elapsed();

    clock.advance(15);
    const c = elapsed();

    assert.ok(b >= a, "second read >= first when the clock did not advance");
    assert.ok(c >= b, "third read >= second after the clock advanced");
    assert.equal(a, 10);
    assert.equal(b, 10);
    assert.equal(c, 25);
  });

  test("reflects a clock advance of N ms as an elapsed value of N", () => {

    // The deterministic equivalent of "real-time delay" - we advance the virtual clock by 30 and verify the closure reports exactly 30. No slack, no flake.
    const clock = new TestClock(1000);

    const elapsed = startTimer(clock);

    clock.advance(30);

    assert.equal(elapsed(), 30);
  });

  test("each call to startTimer creates an independent closure with its own captured start", () => {

    // Negative test: two timers must not share state. We start the second after advancing the clock; reading both should show different elapsed values measured
    // from each one's own start.
    const clock = new TestClock();

    const a = startTimer(clock);

    clock.advance(5);

    const b = startTimer(clock);

    clock.advance(7);

    assert.equal(a(), 12, "timer A measures from start=0, reads at now=12");
    assert.equal(b(), 7, "timer B measures from start=5, reads at now=12");
  });

  test("default-arg wires through to the system clock when no clock is supplied", () => {

    // Locks the default-argument behavior so a future refactor that breaks the optional doesn't pass unnoticed. We verify the value-shape contract (number,
    // non-negative, integer) without asserting any specific elapsed value, since systemClock reads the host's wall clock and the test runtime's elapsed time is
    // not part of the contract.
    const elapsed = startTimer();
    const value = elapsed();

    assert.equal(typeof value, "number");
    assert.ok(value >= 0, "elapsed is non-negative");
    assert.equal(value, Math.round(value), "elapsed is an integer (the implementation rounds)");
  });
});
