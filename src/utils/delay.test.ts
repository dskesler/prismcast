/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * delay.test.ts: Unit tests for the wait policies in delay.ts (timeoutSignal, waitWithTimeout, boundedWait, delay, pollUntil). Every policy takes its clock
 * through its options, so the rows that assert a schedule drive one TestClock and read what the policy registered on it - the bound's deadline, the cadences,
 * and the count still pending after settlement - rather than waiting real time out. Each policy also keeps a row that supplies no clock at all, so the
 * destructuring default reaching systemClock is proven rather than assumed.
 */
import type { PollOutcome, PollSettled } from "./delay.ts";
import { TestClock, advanceThroughSchedule, drainClock, settle } from "homebridge-plugin-utils/testing";
import { boundedWait, delay, pollUntil, timeoutSignal, waitWithTimeout } from "./delay.ts";
import { describe, test } from "node:test";
import type { Clock } from "homebridge-plugin-utils";
import assert from "node:assert/strict";

// Answers an AbortSignal-or-undefined without letting the compiler narrow it, so the overload row exercises the optional-signal shape rather than the
// signal-less one.
function maybeSignal(): AbortSignal | undefined {

  return undefined;
}

describe("timeoutSignal", () => {

  test("stays quiet until the clock reaches the duration, then aborts carrying the supplied error", () => {

    const clock = new TestClock();
    const reason = new Error("bespoke lapse");
    const timeout = timeoutSignal(1000, { clock, reason });

    assert.equal(clock.pending, 1, "the bound is registered on the injected clock");
    assert.equal(clock.nextDeadline, 1000, "the bound comes due at the duration it was given");

    clock.advance(999);

    assert.equal(timeout.signal.aborted, false, "one millisecond short of the duration the signal is still quiet");

    clock.advance(1);

    assert.equal(timeout.signal.aborted, true, "the signal aborts once the clock reaches the duration");
    assert.equal(timeout.signal.reason, reason, "the abort reason is the caller's own error object, by reference");
    assert.equal(clock.pending, 0, "the one-shot leaves the timeline when it fires");
  });

  test("aborts with a default error naming the duration when no reason is supplied", () => {

    const clock = new TestClock();
    const timeout = timeoutSignal(250, { clock });

    assert.equal(clock.pending, 1, "the bound is registered on the injected clock");

    clock.advance(250);

    assert.match((timeout.signal.reason as Error).message, /Operation timed out after 250ms\./, "the default reason names the duration");
  });

  test("a cancelled handle leaves nothing registered and never aborts, even well past its duration", () => {

    // Negative test: cancel() has to dispose the clock's one-shot outright, not merely leave nobody watching it.
    const clock = new TestClock();
    const timeout = timeoutSignal(1000, { clock });

    timeout.cancel();

    assert.equal(clock.pending, 0, "the cancelled bound is off the timeline");

    clock.advance(5000);

    assert.equal(timeout.signal.aborted, false, "a cancelled handle stays quiet past its own duration");
  });

  test("cancel() is safe to call more than once", () => {

    // Disposing an already-disposed handle finds nothing left to cancel, so a consumer that cancels defensively cannot break.
    const timeout = timeoutSignal(50000);

    assert.doesNotThrow(() => {

      timeout.cancel();
      timeout.cancel();
      timeout.cancel();
    });
  });

  test("runs on the system clock when no clock is supplied", async () => {

    // The default is the real thing, so a short bound with nothing injected actually fires on the platform timers - which is what proves the destructuring
    // default reaches systemClock rather than some inert stand-in.
    const timeout = timeoutSignal(5);

    await delay(30);

    assert.equal(timeout.signal.aborted, true, "the default bound fired on real time");
    assert.match((timeout.signal.reason as Error).message, /Operation timed out after 5ms\./, "the default reason names the duration");

    timeout.cancel();
  });

  test("returns a handle exposing both cancel and signal", () => {

    const timeout = timeoutSignal(50000);

    assert.equal(typeof timeout.cancel, "function", "cancel is callable");
    assert.ok(timeout.signal instanceof AbortSignal, "signal is an AbortSignal instance");

    timeout.cancel();
  });
});

describe("waitWithTimeout", () => {

  test("returns the resolved value when the promise settles inside the bound", async () => {

    const fast = Promise.resolve("fast-value");
    const result = await waitWithTimeout(fast, 100);

    assert.equal(result, "fast-value", "the resolved value should come from the inner promise");
  });

  test("returns the promise's value on an injected clock and leaves the bound cancelled", async () => {

    // The bound is registered on the injected clock and disposed in the finally, so a policy that leaked its handle would show here as a still-pending entry.
    const clock = new TestClock();
    const result = await waitWithTimeout(Promise.resolve("virtual-value"), 50000, { clock });

    assert.equal(result, "virtual-value", "the resolved value should come from the inner promise");

    await settle();

    assert.equal(clock.pending, 0, "the bound was disposed at settlement rather than left on the timeline");
  });

  test("rejects with the default timeout error when the bound lapses", async () => {

    // Negative test: a never-resolving promise must surface as a timeout rejection.
    const { promise: never } = Promise.withResolvers<string>();

    await assert.rejects(() => waitWithTimeout(never, 5), /Operation timed out after 5ms/, "default error message includes the timeout duration");
  });

  test("rejects with the caller's exact error object when the bound lapses", async () => {

    // Identity, not shape: call sites such as the discovery-settlement wait tell their own lapse apart from any other failure by comparing against the very
    // object they passed in, so the policy must deliver that object untouched rather than a copy or a wrapper.
    class CustomTimeoutError extends Error {

      constructor() {

        super("custom timeout");
        this.name = "CustomTimeoutError";
      }
    }

    const timeoutError = new CustomTimeoutError();
    const { promise: never } = Promise.withResolvers<string>();

    await assert.rejects(() => waitWithTimeout(never, 5, { reason: timeoutError }), (error: unknown) => error === timeoutError,
      "the supplied error object itself is thrown, by reference");
  });

  test("rejects with the exact reason object when the injected clock advances past the bound", async () => {

    const clock = new TestClock();
    const reason = new Error("virtual lapse");
    const { promise: never } = Promise.withResolvers<string>();
    const bounded = waitWithTimeout(never, 1000, { clock, reason });

    // The expectation is attached before the clock is driven, so the rejection the advance releases is observed rather than unhandled.
    const rejection = assert.rejects(bounded, (error: unknown) => error === reason, "the supplied error object itself is thrown, by reference");

    assert.equal(clock.nextDeadline, 1000, "the bound is armed at the duration the caller asked for");

    clock.advance(1000);

    await rejection;
    assert.equal(clock.pending, 0, "nothing stays registered once the lapse has settled");
  });

  test("propagates the promise's own rejection (not a timeout)", async () => {

    // Negative test: when the promise rejects inside the bound, the policy must not mask it with its own timeout error.
    const failing = Promise.reject(new Error("inner failure"));

    await assert.rejects(() => waitWithTimeout(failing, 100), /inner failure/, "inner rejection is preserved, not replaced by the timeout error");
  });

  test("cancels the timer it created once the promise wins", async () => {

    // The disposal cannot be observed through behavior: the library removes its own abort listener at settlement, so even a timer left running would abort into
    // nobody and the wait would look identical. Watching the timer functions for the duration of one call is the only way to see a dropped cancel.
    const realClearTimeout = globalThis.clearTimeout;
    const realSetTimeout = globalThis.setTimeout;
    const cleared: unknown[] = [];

    let created: ReturnType<typeof setTimeout> | undefined;

    globalThis.setTimeout = ((callback: (...callbackArgs: unknown[]) => void, ms?: number): ReturnType<typeof setTimeout> => {

      const handle = realSetTimeout(callback, ms);

      created ??= handle;

      return handle;
    }) as unknown as typeof globalThis.setTimeout;

    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>): void => {

      cleared.push(handle);
      realClearTimeout(handle);
    }) as unknown as typeof globalThis.clearTimeout;

    try {

      await waitWithTimeout(Promise.resolve("ok"), 50000);
    } finally {

      globalThis.clearTimeout = realClearTimeout;
      globalThis.setTimeout = realSetTimeout;
    }

    assert.notEqual(created, undefined, "the policy created a timer");
    assert.ok(cleared.includes(created), "the timer the policy created was cleared once the promise won");
  });

  test("settles cleanly when many bounded waits run back-to-back (no leaked handles)", async () => {

    // Running many waits back-to-back exercises the cancel path in bulk: a leaked handle would surface as the runner hanging at exit rather than as a failed
    // assertion, which the fast pass here plus the --test-force-exit safety net in the test scripts together rule out.
    const promises = Array.from({ length: 50 }, async (_, i) => waitWithTimeout(Promise.resolve(i), 10000));

    const results = await Promise.all(promises);

    assert.equal(results.length, 50, "every wait should settle");
    assert.equal(results[0], 0, "the first wait should carry its own value");
    assert.equal(results[49], 49, "the last wait should carry its own value");
  });

  test("respects a 0ms timeout (effectively yielding to the event loop)", async () => {

    // Boundary: a timeoutMs of 0 still schedules the timer; a never-resolving promise loses to the immediate fire.
    const { promise: never } = Promise.withResolvers<string>();

    await assert.rejects(() => waitWithTimeout(never, 0), /timed out after 0ms/, "0ms timeout still fires");
  });
});

describe("boundedWait", () => {

  test("returns the resolved value when the promise settles inside the bound", async () => {

    const result = await boundedWait(Promise.resolve("value"), 50000);

    assert.equal(result, "value", "the promise's value comes back unchanged");
  });

  test("returns the promise's value on an injected clock and leaves the bound cancelled", async () => {

    const clock = new TestClock();
    const result = await boundedWait(Promise.resolve("virtual-value"), 50000, { clock });

    assert.equal(result, "virtual-value", "the promise's value comes back unchanged");

    await settle();

    assert.equal(clock.pending, 0, "the bound was disposed at settlement rather than left on the timeline");
  });

  test("returns null when the injected clock advances past the bound", async () => {

    /* The lapse is what the value-shaped policy exists to express, and it binds on the clock the caller injected rather than on real time: a policy that reached
     * for the system clock instead would leave this row waiting out a full minute and failing on the runner's own timeout.
     */
    const clock = new TestClock();
    const { promise: never } = Promise.withResolvers<string>();
    const lapsing = boundedWait(never, 60000, { clock });

    assert.equal(clock.nextDeadline, 60000, "the bound is armed at the duration the caller asked for");

    clock.advance(60000);

    assert.equal(await lapsing, null, "the lapsed bound settles null rather than staying pending");
    assert.equal(clock.pending, 0, "nothing stays registered once the lapse has settled");
  });

  test("propagates a rejection that arrives inside the bound", async () => {

    // Negative test: a rejection is a failure, not a lapse, so it must travel to the caller rather than being flattened into the null branch.
    const failing = Promise.reject(new Error("inner failure"));

    await assert.rejects(() => boundedWait(failing, 50000), /inner failure/, "the promise's own rejection is not swallowed");
  });

  test("a rejection arriving after the bound lapsed surfaces nowhere", async () => {

    // By the time the promise rejects the wait has already settled null, so there is no caller left to throw into. The library observes the promise on every
    // path, which is what keeps that late rejection away from Node's unhandled-rejection tracker - and this runner fails the file if one is ever reported.
    const { promise: late, reject: rejectLate } = Promise.withResolvers<string>();
    const lapsed = await boundedWait(late, 5);

    assert.equal(lapsed, null, "the bound lapsed first");

    rejectLate(new Error("arrived after the bound lapsed"));

    // Give the rejection a full turn of the loop in which to be reported, if it were ever going to be.
    await delay(20);
  });

  test("cancels the timer it created once the promise wins", async () => {

    // Same reasoning as the throw-shaped policy's cleared-timer check: a dropped cancel is invisible through behavior, because the abort would land on a wait
    // that has already settled. Watching the timer functions across one call is what makes the disposal observable.
    const realClearTimeout = globalThis.clearTimeout;
    const realSetTimeout = globalThis.setTimeout;
    const cleared: unknown[] = [];

    let created: ReturnType<typeof setTimeout> | undefined;

    globalThis.setTimeout = ((callback: (...callbackArgs: unknown[]) => void, ms?: number): ReturnType<typeof setTimeout> => {

      const handle = realSetTimeout(callback, ms);

      created ??= handle;

      return handle;
    }) as unknown as typeof globalThis.setTimeout;

    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>): void => {

      cleared.push(handle);
      realClearTimeout(handle);
    }) as unknown as typeof globalThis.clearTimeout;

    try {

      await boundedWait(Promise.resolve("ok"), 50000);
    } finally {

      globalThis.clearTimeout = realClearTimeout;
      globalThis.setTimeout = realSetTimeout;
    }

    assert.notEqual(created, undefined, "the policy created a timer");
    assert.ok(cleared.includes(created), "the timer the policy created was cleared once the promise won");
  });
});

describe("delay", () => {

  test("returns a Promise that resolves to undefined", async () => {

    // We don't bind the awaited result to a const because its type is void and carries no useful value. Instead we assert that the promise itself resolves without
    // throwing and that the documented return type is honored at the type system level (Promise<void>).
    await assert.doesNotReject(() => delay(1), "delay resolves without rejection");
  });

  test("waits at least the requested duration in real time", async () => {

    // We pick a small value to stay under budget. Slack is one-sided: real wall time can run a touch slower than requested due to runner overhead, but it
    // cannot run faster than setTimeout's clock.
    const start = Date.now();

    await delay(10);

    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 8, "elapsed should be at least 8ms (one-sided slack): " + String(elapsed));
  });

  test("returns a Promise instance (not a sync return value)", async () => {

    const result = delay(0);

    assert.ok(result instanceof Promise, "delay always returns a Promise");

    await result;
  });

  test("handles a 0ms delay by yielding to the event loop", async () => {

    // Boundary: a 0ms delay still goes through the platform timer, which means at least one task-queue tick before resolution.
    let synchronouslySet = false;
    const promise = delay(0);

    // Set the flag synchronously after starting the delay - it should be true before the delay resolves.
    synchronouslySet = true;

    await promise;

    assert.equal(synchronouslySet, true, "synchronous code after delay(0) call ran before the resolution");
  });
});

describe("pollUntil", () => {

  test("reads once and sleeps never when the first read already satisfies", async () => {

    /* The whole reason this shape beats a fixed delay: a signal that is already true costs one round trip. A sleep scheduled ahead of the first read would show
     * up here as a registered wait.
     */
    const clock = new TestClock();

    let reads = 0;

    const outcome = await pollUntil({ cadenceMs: 25, ceilingMs: 1000, clock, read: async (): Promise<string> => {

      reads++;

      return "normal";
    }, until: (state: string): boolean => state === "normal" });

    assert.equal(outcome.status, "satisfied", "a satisfied read is not a lapse");
    assert.equal(outcome.reads, 1, "exactly one read");
    assert.equal(outcome.value, "normal", "the outcome carries the satisfying value");
    assert.equal(reads, 1, "the read ran exactly once");
    assert.deepEqual(clock.requested, [], "no sleep is registered before or after a first read that satisfies");
  });

  test("sleeps the cadence between reads until one satisfies", async () => {

    // The cadence is what separates consecutive reads, so a poll that satisfies on its third read has slept exactly twice, each time for the cadence.
    const clock = new TestClock();
    const answers = [ "minimized", "minimized", "normal" ];

    let reads = 0;

    const running = pollUntil({ cadenceMs: 25, ceilingMs: 1000, clock, read: async (): Promise<string> => {

      const answer = answers[reads] ?? "normal";

      reads++;

      return answer;
    }, until: (state: string): boolean => state === "normal" });

    await settle();
    assert.equal(clock.pending, 1, "the first cadence is parked on the clock");

    await advanceThroughSchedule(clock, [ 25, 25 ]);

    const outcome = await running;

    assert.equal(outcome.status, "satisfied", "the third read satisfied inside the ceiling");
    assert.equal(outcome.reads, 3, "three reads");
    assert.equal(outcome.value, "normal", "the outcome carries the satisfying value");
    assert.deepEqual(clock.requested, [ 25, 25 ], "one cadence sleep between each pair of reads, and none after the satisfying one");
    assert.equal(clock.pending, 0, "nothing stays registered after the satisfying read");
  });

  test("lapses at the ceiling and reports the last value read", async () => {

    /* The read count is derived from the same two numbers the poll is given rather than restated as a literal, so the row states the relationship - one read,
     * then one read per cadence the ceiling affords - instead of a number that would have to be recomputed by hand whenever either constant moved.
     */
    const cadenceMs = 25;
    const ceilingMs = 100;
    const clock = new TestClock();

    let reads = 0;

    const running = pollUntil({ cadenceMs, ceilingMs, clock, read: async (): Promise<string> => {

      reads++;

      return "minimized-" + String(reads);
    }, until: (state: string): boolean => state === "normal" });

    await settle();
    assert.equal(clock.pending, 1, "the first cadence is parked on the clock");

    const steps = await drainClock(clock);
    const outcome = await running;

    assert.equal(outcome.status, "lapsed", "no read satisfied before the ceiling elapsed");
    assert.equal(outcome.reads, Math.floor(ceilingMs / cadenceMs) + 1, "the ceiling affords one read plus one per cadence");
    assert.equal(reads, outcome.reads, "the read ran exactly that many times");
    assert.equal(outcome.value, "minimized-" + String(outcome.reads), "the outcome carries the last value read, not a satisfying one");
    assert.equal(clock.requested.length, outcome.reads - 1, "one cadence sleep between each pair of reads");
    assert.equal(steps, outcome.reads - 1, "the drain stepped exactly the cadences the poll registered");
    assert.equal(clock.now(), (outcome.reads - 1) * cadenceMs, "virtual time advanced by exactly the cadences the poll released");
  });

  test("propagates a read's rejection and stops polling there", async () => {

    // Negative test: what a failed read means belongs to the caller. Swallowing it would report a lapse where there was a fault, and would keep asking a source
    // that has already failed.
    const clock = new TestClock();
    const failure = new Error("the window state could not be read");

    let reads = 0;

    const running = pollUntil({ cadenceMs: 25, ceilingMs: 1000, clock, read: async (): Promise<string> => {

      reads++;

      if(reads === 2) {

        throw failure;
      }

      return "minimized";
    }, until: (state: string): boolean => state === "normal" });

    // The expectation is attached before the clock is driven, so the rejection the drive releases is observed rather than unhandled.
    const rejection = assert.rejects(running, (error: unknown) => error === failure, "the caller's own error object propagates by reference");

    await settle();
    assert.equal(clock.pending, 1, "the one cadence before the throwing read is parked on the clock");

    await drainClock(clock);
    await rejection;

    assert.equal(reads, 2, "the poll stopped at the throwing read");
    assert.deepEqual(clock.requested, [25], "only the one cadence sleep that preceded the throwing read");
  });

  test("a zero ceiling still performs exactly one read", async () => {

    // Boundary: the ceiling is checked after a read, never before one, so the cheapest possible poll is still a real question asked of the source.
    const clock = new TestClock();

    let reads = 0;

    const outcome = await pollUntil({ cadenceMs: 25, ceilingMs: 0, clock, read: async (): Promise<string> => {

      reads++;

      return "minimized";
    }, until: (state: string): boolean => state === "normal" });

    assert.equal(outcome.status, "lapsed", "an unsatisfied read under a zero ceiling lapses");
    assert.equal(outcome.reads, 1, "exactly one read");
    assert.equal(reads, 1, "the read ran exactly once");
    assert.deepEqual(clock.requested, [], "no cadence sleep is registered when the ceiling has already elapsed");
  });

  test("runs on the system clock when no clock is supplied", async () => {

    // The default reaches systemClock: a two-read poll on a short cadence settles on real time with no clock injected at all.
    let reads = 0;

    const outcome = await pollUntil({ cadenceMs: 5, ceilingMs: 1000, read: async (): Promise<number> => ++reads,
      until: (value: number): boolean => value >= 2 });

    assert.equal(outcome.status, "satisfied", "the second read satisfied inside the ceiling");
    assert.equal(outcome.reads, 2, "two reads, with one cadence between them");
  });

  test("an already-aborted signal ends the poll before any read", async () => {

    // The entry checkpoint runs before the first read, so a caller that has already stopped caring never reaches the source at all.
    const clock = new TestClock();
    const controller = new AbortController();

    let reads = 0;

    controller.abort();

    const outcome = await pollUntil({ cadenceMs: 25, ceilingMs: 1000, clock, read: async (): Promise<string> => {

      reads++;

      return "minimized";
    }, signal: controller.signal, until: (state: string): boolean => state === "normal" });

    assert.equal(outcome.status, "aborted", "the poll reports the abort");
    assert.equal(outcome.reads, 0, "no read ran");
    assert.equal(reads, 0, "the read function was never called");
    assert.deepEqual(clock.requested, [], "no sleep was registered");
  });

  test("an abort during the cadence sleep ends the poll inside the sleep", async () => {

    // The signal is carried into the sleep, so the abort ends the poll where it lands rather than after the cadence has run out.
    const clock = new TestClock();
    const controller = new AbortController();

    let reads = 0;

    const running = pollUntil({ cadenceMs: 25, ceilingMs: 1000, clock, read: async (): Promise<string> => {

      reads++;

      return "minimized";
    }, signal: controller.signal, until: (state: string): boolean => state === "normal" });

    await settle();
    assert.equal(clock.pending, 1, "the first cadence is parked on the clock");

    controller.abort();
    await settle();

    const outcome = await running;

    assert.equal(outcome.status, "aborted", "the abort ended the poll inside the sleep");
    assert.equal(outcome.reads, 1, "the one read before the sleep is counted");
    assert.equal(clock.pending, 0, "the aborted sleep left the clock");

    clock.advance(1000);
    await settle();
    assert.equal(reads, 1, "no read ran after the abort, however far the clock moves");
  });

  test("an abort that lands during the read is reported before any sleep is registered", async () => {

    // The checkpoint after the read is what keeps an abort from being swallowed into a cadence: the read aborts the controller from inside and then returns an
    // unsatisfying value, and the poll reports the abort rather than sleeping on it.
    const clock = new TestClock();
    const controller = new AbortController();

    let reads = 0;

    const outcome = await pollUntil({ cadenceMs: 25, ceilingMs: 1000, clock, read: async (): Promise<string> => {

      reads++;
      controller.abort();

      return "minimized";
    }, signal: controller.signal, until: (state: string): boolean => state === "normal" });

    assert.equal(outcome.status, "aborted", "the checkpoint before the sleep caught the abort");
    assert.equal(outcome.reads, 1, "the read that aborted is counted");
    assert.equal(reads, 1, "the read ran exactly once");
    assert.deepEqual(clock.requested, [], "no cadence sleep was ever registered");
  });

  test("an abort that lands during a read at the ceiling is reported as aborted, not lapsed", async () => {

    // Both terminal conditions arrive on one read: the clock reaches the ceiling while the read runs and the signal aborts before the read returns. The caller's
    // own stop wins, because a lapse would hand back a value the caller has already stopped caring about.
    const clock = new TestClock();
    const controller = new AbortController();

    const outcome = await pollUntil({ cadenceMs: 25, ceilingMs: 100, clock, read: async (): Promise<string> => {

      clock.advance(100);
      controller.abort();

      return "minimized";
    }, signal: controller.signal, until: (state: string): boolean => state === "normal" });

    assert.equal(outcome.status, "aborted", "the abort wins over the lapse");
    assert.equal(outcome.reads, 1, "the read that aborted is counted");
    assert.deepEqual(clock.requested, [], "no cadence sleep was ever registered");
  });

  test("a clock whose sleep fails for a reason other than the signal propagates that failure", async () => {

    // Negative test: the policy identifies its own abort by the signal it holds, never by the shape of the rejection. A clock that cannot sleep is a fault the
    // caller must see, and reporting it as an abort would hide that fault behind an outcome exactly as swallowing a read's rejection would.
    const failure = new Error("the clock could not sleep");
    const clock = new TestClock();
    const controller = new AbortController();
    const broken: Clock = {

      delay: async (): Promise<void> => { throw failure; },
      now: (): number => clock.now(),
      schedule: (callback: () => void, ms: number, init?: { repeat?: boolean }): Disposable => clock.schedule(callback, ms, init),
      timeout: (ms: number): AbortSignal => clock.timeout(ms)
    };

    await assert.rejects(pollUntil({ cadenceMs: 25, ceilingMs: 1000, clock: broken, read: async (): Promise<string> => "minimized", signal: controller.signal,
      until: (state: string): boolean => state === "normal" }), (error: unknown) => error === failure, "the clock's own failure propagates by reference");

    assert.equal(controller.signal.aborted, false, "the signal never aborted, so the rejection was not the poll's abort");
  });

  test("an abort on the system clock ends the sleep promptly rather than at the cadence's end", async () => {

    const controller = new AbortController();
    const startedAt = process.hrtime.bigint();

    setTimeout(() => { controller.abort(); }, 5);

    const outcome = await pollUntil({ cadenceMs: 500, ceilingMs: 5000, read: async (): Promise<string> => "minimized", signal: controller.signal,
      until: (state: string): boolean => state === "normal" });

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1000000;

    assert.equal(outcome.status, "aborted", "the abort ended the poll");
    assert.ok(elapsedMs < 250, "the poll ended well inside the 500 ms cadence: " + String(elapsedMs) + " ms");
  });

  test("the overloads type a signal-less call to the settled shapes and an optional-signal call to the full outcome", async () => {

    // The two bindings' declared types are the assertion the typecheck makes: a caller with no signal reads the value without narrowing, and a caller holding an
    // optional signal has to narrow past the aborted arm before it can.
    const clock = new TestClock();

    // The optional signal comes from a call, so the binding keeps the union type: a constant initialized to a literal undefined would narrow to undefined and
    // match the signal-less overload, which is the wrong thing to prove.
    const optional = maybeSignal();
    const settled: PollSettled<string> = await pollUntil({ cadenceMs: 25, ceilingMs: 0, clock, read: async (): Promise<string> => "normal",
      until: (state: string): boolean => state === "normal" });

    assert.equal(settled.value, "normal");

    const outcome: PollOutcome<string> = await pollUntil({ cadenceMs: 25, ceilingMs: 0, clock, read: async (): Promise<string> => "normal", signal: optional,
      until: (state: string): boolean => state === "normal" });

    if(outcome.status !== "aborted") {

      assert.equal(outcome.value, "normal");
    }

    assert.equal(outcome.status, "satisfied");
  });
});
