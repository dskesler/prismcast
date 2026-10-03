/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * retry.test.ts: Unit tests for retryOperation as PrismCast's policy over the library's retry loop, and for the pure maxRetryDuration estimator. Every policy
 * row drives one TestClock and asserts its requested ledger, which carries the per-attempt bound (registered by waitWithTimeout before each attempt)
 * interleaved with the backoff sleeps in registration order - so a policy that reached for the system clock, skipped a wait, or handed the ladder the wrong
 * attempt number fails its row loudly rather than passing it slowly. The estimator is tested against the same default constants the policy reads, so the
 * worst-case closed form stays tied to the schedule it estimates.
 */
import { TestClock, advanceThroughSchedule, drainClock, settle } from "homebridge-plugin-utils/testing";
import { describe, mock, test } from "node:test";
import { maxRetryDuration, retryOperation } from "./retry.ts";
import assert from "node:assert/strict";

describe("retryOperation over the library's retry loop", () => {

  test("returns the operation's value on first-attempt success and registers only the bound", async () => {

    const clock = new TestClock();
    let attempts = 0;

    const result = await retryOperation({

      clock,
      description: "happy-path",
      maxAttempts: 3,
      operation: async () => {

        attempts++;

        return "ok";
      },
      timeoutMs: 1000
    });

    assert.equal(result, "ok", "successful op returns its value");
    assert.equal(attempts, 1, "operation invoked exactly once");
    assert.deepEqual(clock.requested, [1000], "the bound is the only wait registered");
    await settle();
    assert.equal(clock.pending, 0, "the bound was cancelled at settlement");
  });

  test("returns the value after N failures by exercising the backoff between attempts", async () => {

    const clock = new TestClock();
    let attempts = 0;

    const running = retryOperation({

      backoffJitter: 0,
      clock,
      description: "succeeds-on-third",
      maxAttempts: 5,
      maxBackoffDelay: 100,
      operation: async () => {

        attempts++;

        if(attempts < 3) {

          throw new Error("transient failure " + String(attempts));
        }

        return "succeeded";
      },
      timeoutMs: 1000
    });

    await settle();
    assert.equal(clock.pending, 1, "the first backoff is parked on the clock");
    await advanceThroughSchedule(clock, [ 100, 100 ]);

    assert.equal(await running, "succeeded", "third attempt succeeded");
    assert.equal(attempts, 3, "operation invoked three times");
    assert.deepEqual(clock.requested, [ 1000, 100, 1000, 100, 1000 ], "the bounds interleave with the two backoffs");
    assert.equal(clock.pending, 0, "nothing stays registered after success");
  });

  test("the backoff binds on the virtual deadline: one millisecond short holds, the last millisecond releases the next attempt", async () => {

    const clock = new TestClock();
    let attempts = 0;

    const running = retryOperation({

      backoffJitter: 0,
      clock,
      description: "binds",
      maxAttempts: 2,
      maxBackoffDelay: 100,
      operation: async () => {

        attempts++;

        if(attempts === 1) {

          throw new Error("first");
        }

        return "second";
      },
      timeoutMs: 1000
    });

    await settle();
    assert.equal(clock.nextDeadline, 100, "the backoff deadline is the capped seed");
    clock.advance(99);
    await settle();
    assert.equal(attempts, 1, "one millisecond short of the backoff, the second attempt has not started");
    clock.advance(1);
    await settle();
    assert.equal(attempts, 2, "the final millisecond releases the second attempt");
    assert.equal(await running, "second");
  });

  test("throws the last error after exhausting maxAttempts when operation never succeeds", async () => {

    const clock = new TestClock();
    let attempts = 0;

    const running = retryOperation({

      backoffJitter: 0,
      clock,
      description: "always-fails",
      maxAttempts: 3,
      maxBackoffDelay: 100,
      operation: async () => {

        attempts++;

        throw new Error("attempt " + String(attempts) + " failed");
      },
      timeoutMs: 1000
    });

    // The expectation is attached before the clock is driven, so the rejection that lands mid-drive is observed rather than unhandled.
    const rejection = assert.rejects(running, /attempt 3 failed/, "throws the most recent error after exhaustion");

    await advanceThroughSchedule(clock, [ 100, 100 ]);
    await rejection;

    assert.equal(attempts, 3, "operation tried exactly maxAttempts times");
    assert.deepEqual(clock.requested, [ 1000, 100, 1000, 100, 1000 ], "no backoff after the final failed attempt");
  });

  test("schedules exponential backoff capped by maxBackoffDelay and growing below it", async () => {

    const cap = new TestClock();

    const capped = retryOperation({

      backoffJitter: 0,
      clock: cap,
      description: "capped",
      maxAttempts: 3,
      maxBackoffDelay: 100,
      operation: async () => {

        throw new Error("fail");
      },
      timeoutMs: 500
    });

    const cappedRejection = assert.rejects(capped, /fail/);

    await drainClock(cap);
    await cappedRejection;
    assert.deepEqual(cap.requested, [ 500, 100, 500, 100, 500 ], "both backoffs clamp to the cap because the seed already exceeds it");

    const grow = new TestClock();

    const growing = retryOperation({

      backoffJitter: 0,
      clock: grow,
      description: "growing",
      maxAttempts: 3,
      maxBackoffDelay: 5000,
      operation: async () => {

        throw new Error("fail");
      },
      timeoutMs: 500
    });

    const growingRejection = assert.rejects(growing, /fail/);

    await drainClock(grow);
    await growingRejection;
    assert.deepEqual(grow.requested, [ 500, 1000, 500, 2000, 500 ], "the backoff seeds at one second and doubles when below the cap");
  });

  test("throws immediately on a session-closed error without consuming a retry budget", async () => {

    const clock = new TestClock();
    let attempts = 0;

    await assert.rejects(

      () => retryOperation({

        clock,
        description: "session-closed",
        maxAttempts: 5,
        operation: async () => {

          attempts++;

          throw new Error("Target closed");
        },
        timeoutMs: 1000
      }),
      /Target closed/,
      "session-closed errors propagate immediately"
    );

    assert.equal(attempts, 1, "no retries attempted after session closed");
    assert.deepEqual(clock.requested, [1000], "no backoff is registered after a closed session");
  });

  test("aborts before the first attempt when shouldAbort returns true upfront", async () => {

    const clock = new TestClock();
    const operation = mock.fn(async (): Promise<string> => "should-not-run");

    await assert.rejects(

      () => retryOperation({

        clock,
        description: "pre-abort",
        maxAttempts: 3,
        operation,
        shouldAbort: () => true,
        timeoutMs: 1000
      }),
      /Operation aborted/,
      "abort throws the documented sentinel"
    );

    assert.equal(operation.mock.callCount(), 0, "operation never invoked when abort is true at the gate");
    assert.deepEqual(clock.requested, [], "neither a bound nor a backoff is registered when the gate throws");
  });

  test("aborts mid-retry when shouldAbort flips during the first attempt, after exactly one backoff", async () => {

    const clock = new TestClock();
    let attempts = 0;
    let aborted = false;

    const running = retryOperation({

      backoffJitter: 0,
      clock,
      description: "mid-abort",
      maxAttempts: 5,
      maxBackoffDelay: 100,
      operation: async () => {

        attempts++;

        // Flip the abort flag after the first failure - the gate sees it before the second attempt starts.
        if(attempts === 1) {

          aborted = true;
        }

        throw new Error("attempt " + String(attempts));
      },
      shouldAbort: () => aborted,
      timeoutMs: 1000
    });

    const rejection = assert.rejects(running, /Operation aborted/, "abort short-circuits the retry loop");

    await drainClock(clock);
    await rejection;

    assert.equal(attempts, 1, "second attempt was skipped because abort fired");
    assert.deepEqual(clock.requested, [ 1000, 100 ], "one backoff ran before the gate fired, and nothing after it");
  });

  test("returns undefined when earlySuccessCheck signals success after a timeout", async () => {

    const clock = new TestClock();

    const result: string | undefined = await retryOperation({

      clock,
      description: "early-success",
      earlySuccessCheck: async () => true,
      maxAttempts: 3,
      operation: async (): Promise<string> => {

        throw new Error("Operation timed out after 1000ms.");
      },
      timeoutMs: 1000
    });

    assert.equal(result, undefined, "early-success path returns undefined (no value to surface)");
    assert.deepEqual(clock.requested, [1000], "no backoff follows an early success");
  });

  test("ignores earlySuccessCheck failures and continues retrying", async () => {

    const clock = new TestClock();
    let attempts = 0;

    const running = retryOperation({

      backoffJitter: 0,
      clock,
      description: "early-success-throws",
      earlySuccessCheck: async () => {

        throw new Error("check failed");
      },
      maxAttempts: 2,
      maxBackoffDelay: 100,
      operation: async () => {

        attempts++;

        throw new Error("Operation timed out after 1000ms.");
      },
      timeoutMs: 1000
    });

    const rejection = assert.rejects(running, /timed out/, "outer rejection surfaces the operation error, not the early-check error");

    await drainClock(clock);
    await rejection;

    assert.equal(attempts, 2, "retry continued normally after the early-check throw");
    assert.deepEqual(clock.requested, [ 1000, 100, 1000 ], "one backoff between the two attempts");
  });

  test("the per-attempt bound lapses on the clock when the operation hangs, and the loop moves to the next attempt", async () => {

    const clock = new TestClock();
    let attempts = 0;

    const running = retryOperation({

      backoffJitter: 0,
      clock,
      description: "hangs",
      maxAttempts: 2,
      maxBackoffDelay: 100,
      operation: async () => {

        attempts++;

        // The operation never resolves; the bound on the clock is what ends each attempt.
        return new Promise<string>(() => { /* never resolves */ });
      },
      timeoutMs: 1000
    });

    const rejection = assert.rejects(running, /timed out after 1000ms/, "the bound's default reason is the error the loop ultimately throws");

    await settle();
    assert.equal(clock.nextDeadline, 1000, "the first bound is armed at timeoutMs");

    const steps = await drainClock(clock);

    await rejection;
    assert.equal(attempts, 2, "both attempts started even though both timed out");
    assert.equal(steps, 3, "the drain stepped the first bound, the backoff, and the second bound");
    assert.deepEqual(clock.requested, [ 1000, 100, 1000 ], "backoff between the two timed-out attempts");
  });

  test("respects a maxAttempts of 1 (no retries, single shot)", async () => {

    const clock = new TestClock();
    let attempts = 0;

    await assert.rejects(

      () => retryOperation({

        clock,
        description: "single-shot",
        maxAttempts: 1,
        operation: async () => {

          attempts++;

          throw new Error("nope");
        },
        timeoutMs: 1000
      }),
      /nope/,
      "single attempt, single throw"
    );

    assert.equal(attempts, 1, "exactly one attempt");
    assert.deepEqual(clock.requested, [1000], "no backoff with maxAttempts=1");
  });

  test("a maxAttempts below one rejects with the loop's own error naming the attempt budget, without invoking the operation", async () => {

    // The attempt budget is validated by the library's loop, so an out-of-contract count is rejected with a descriptive error before any attempt runs. The
    // configuration floor is one attempt, so production never reaches this path.
    const clock = new TestClock();
    let attempts = 0;

    await assert.rejects(

      () => retryOperation({

        clock,
        description: "zero-attempts",
        maxAttempts: 0,
        operation: async () => {

          attempts++;

          return "should-not-run";
        },
        timeoutMs: 1000
      }),
      (error: unknown): boolean => (error instanceof Error) && error.message.includes("attempts"),
      "the rejection is an Error naming the attempt budget"
    );

    assert.equal(attempts, 0, "operation never invoked with maxAttempts=0");
    assert.deepEqual(clock.requested, [], "nothing is registered when the budget is rejected");
  });

  test("default-arg wires through to the system clock when no clock is supplied", async () => {

    // With no clock injected the backoff runs on the platform timer, so a failed first attempt is followed by a real wait. A one-millisecond ceiling keeps the row
    // fast while still proving the default reaches a clock that elapses time rather than one that parks the wait.
    let attempts = 0;

    const result = await retryOperation({

      backoffJitter: 0,
      description: "default-clock",
      maxAttempts: 2,
      maxBackoffDelay: 1,
      operation: async () => {

        attempts++;

        if(attempts === 1) {

          throw new Error("first");
        }

        return "wired";
      },
      timeoutMs: 1000
    });

    assert.equal(result, "wired", "the retry landed after a real backoff on the platform timer");
    assert.equal(attempts, 2, "the second attempt ran, so the default clock's delay elapsed");
  });
});

describe("maxRetryDuration", () => {

  test("sums every attempt's timeout plus one ceilinged backoff gap per retry using the shared defaults", () => {

    // The closed form is maxAttempts * timeoutMs + (maxAttempts - 1) * (maxBackoffDelay + backoffJitter). With retry.ts's defaults - a 3000ms backoff cap and a
    // 1000ms jitter ceiling, the same constants the policy's destructuring reads - three attempts of 10000ms with two gaps of 4000ms gives 38000ms.
    assert.equal(maxRetryDuration({ maxAttempts: 3, timeoutMs: 10000 }), (3 * 10000) + (2 * (3000 + 1000)));
    assert.equal(maxRetryDuration({ maxAttempts: 3, timeoutMs: 10000 }), 38000);
  });

  test("honors explicit backoff overrides in place of the defaults", () => {

    // Four attempts of 5000ms with three gaps, each capped at 2000ms plus 500ms of jitter, gives 20000 + 7500 = 27500ms.
    assert.equal(maxRetryDuration({ backoffJitter: 500, maxAttempts: 4, maxBackoffDelay: 2000, timeoutMs: 5000 }), (4 * 5000) + (3 * (2000 + 500)));
  });

  test("adds no backoff for a single attempt", () => {

    // With one attempt there are zero gaps, so the estimate is just the one per-attempt timeout.
    assert.equal(maxRetryDuration({ maxAttempts: 1, timeoutMs: 8000 }), 8000);
  });

  test("clamps the gap count at zero for an out-of-contract attempt count below one", () => {

    // An attempt count below one affords no attempts and therefore no gaps, so the closed form clamps the gap count rather than producing a negative term.
    assert.equal(maxRetryDuration({ maxAttempts: 0, timeoutMs: 8000 }), 0);
  });
});
