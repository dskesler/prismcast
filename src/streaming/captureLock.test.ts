/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * captureLock.test.ts: Unit tests for the task-scoped capture lock. Every "held" or "released" claim is observed structurally through a QUEUED FURTHER run() whose
 * task callback has (or has not) been invoked, never through a bare comment. The lock is driven with a TestClock and task stubs backed by Promise.withResolvers, so
 * turn grants, give-ups, wedges, and deadlines settle on virtual time in the order the mechanism itself produces: the wedge bound derives as
 * max(wedgeFloorMs, deadlineMs + wedgeMarginMs), so a held task's deadline always lapses before its wedge fires, and the wedge is armed with no cancellation, so it
 * stays registered until it fires whatever the task does. A fresh createCaptureLock is built per test so no tail leaks between cases.
 */
import { CaptureAbandonedError, CaptureDeadlineError, CaptureTurnTimeoutError, createCaptureLock } from "./captureLock.ts";
import { assertNoUnhandledRejections, expectAt } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import type { CaptureRunOptions } from "./captureLock.ts";
import { TestClock } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { waitWithTimeout } from "../utils/index.ts";

// A standard set of per-call options: a 10s task deadline and turn-wait, matching the stream call site's navigationTimeout default. Returned fresh each call so no
// onWedge callback is shared across tests.
function runOpts(): CaptureRunOptions {

  return { deadlineMessage: "deadline", deadlineMs: 10000, turnWaitMs: 10000 };
}

// Drains the microtask queue so chained promise settlements (turn grant, forwarding, markSettled) resolve before an assertion reads them. The lock schedules no real
// timers under the virtual clock, so a bounded microtask flush is sufficient.
async function flushMicro(): Promise<void> {

  for(let i = 0; i < 30; i++) {

    // eslint-disable-next-line no-await-in-loop -- Sequential microtask yields are the point; parallelizing would defeat the drain.
    await Promise.resolve();
  }
}

// Yields one macrotask so any unhandledRejection event has been emitted before assertNoUnhandledRejections's cleanup reads its capture buffer.
async function flushMacro(): Promise<void> {

  await new Promise<void>((resolve) => {

    setImmediate(resolve);
  });
}

// The waits a held turn registers, in the order run() asks for them: the turn-wait bound, the wedge, and the caller-facing deadline bound. Rows read the clock's
// ledger against this to prove the turn armed exactly what the mechanism says it arms.
const HELD_TURN_WAITS = [ 10000, 30000, 10000 ];

// The wedge bound a 10s deadline derives to under the 30s floor these rows construct their locks with.
const WEDGE_BOUND_MS = 30000;

describe("createCaptureLock", () => {

  test("serializes tasks: a later task does not begin until the earlier task settles", async () => {

    const clock = new TestClock();
    const lock = createCaptureLock({ clock, wedgeFloorMs: 30000, wedgeMarginMs: 5000 });
    const aWork = Promise.withResolvers<string>();
    const calls: string[] = [];
    const pA = lock.run(async (): Promise<string> => {

      calls.push("A");

      return aWork.promise;
    }, runOpts());
    const pB = lock.run(async (): Promise<string> => {

      calls.push("B");

      return "B";
    }, runOpts());

    await flushMicro();

    assert.deepEqual(calls, ["A"], "B has not begun while A holds the turn");
    assert.equal(clock.pending, 3, "A's deadline bound and wedge, plus B's turn-wait bound");

    aWork.resolve("A");

    await flushMicro();

    assert.deepEqual(calls, [ "A", "B" ], "B begins only after A settles");
    assert.equal(await pA, "A");
    assert.equal(await pB, "B");

    clock.advance(WEDGE_BOUND_MS);
    await flushMicro();

    assert.equal(clock.pending, 0, "both wedges fired against settled tasks and nothing is left on the timeline");
  });

  test("give-up forwards to the predecessor and never advances the chain past an unsettled task", async () => {

    const restore = assertNoUnhandledRejections();

    /* B's turn-wait is shorter than A's deadline and than C's turn-wait, so advancing to B's bound alone lapses exactly one waiter. That ordering is the
     * mechanism's own: every bound sits on one clock, so a row can only reach a later bound by crossing the earlier ones.
     */
    const clock = new TestClock();
    const lock = createCaptureLock({ clock, wedgeFloorMs: 30000, wedgeMarginMs: 5000 });
    const aWork = Promise.withResolvers<string>();
    const calls: string[] = [];
    const pA = lock.run(async (): Promise<string> => {

      calls.push("A");

      return aWork.promise;
    }, runOpts());

    let bRan = false;
    const pB = lock.run(async (): Promise<string> => {

      bRan = true;

      return "B";
    }, { ...runOpts(), turnWaitMs: 1000 });

    const pC = lock.run(async (): Promise<string> => {

      calls.push("C");

      return "C";
    }, runOpts());

    // The expectation is attached before the clock is driven, so the rejection the advance releases is observed rather than left unhandled.
    const giveUp = assert.rejects(pB, (error: unknown) => error instanceof CaptureTurnTimeoutError);

    await flushMicro();

    assert.equal(clock.nextDeadline, 1000, "B's turn-wait is the earliest bound on the clock");

    clock.advance(1000);

    await giveUp;
    await flushMicro();

    assert.equal(clock.nextDeadline, 10000, "C's turn-wait is still armed, alongside A's own deadline");
    assert.equal(bRan, false, "the give-up waiter's task never ran");
    assert.deepEqual(calls, ["A"], "C is still blocked behind the unsettled A - the give-up did not advance the chain");

    aWork.resolve("A");

    await flushMicro();

    assert.deepEqual(calls, [ "A", "C" ], "C runs only after the running task actually settles");
    assert.equal(await pA, "A");
    assert.equal(await pC, "C");

    await flushMacro();

    restore();
  });

  test("the wedge fires exactly once at the derived bound and never releases the turn early", async () => {

    /* The wedge sits strictly later than the caller deadline by derivation, so a task still running at its wedge is a task whose caller was already rejected at
     * its deadline. The row walks that true order: the deadline lapses first, the turn stays held, and only then does the wedge fire.
     */
    const clock = new TestClock();
    const lock = createCaptureLock({ clock, wedgeFloorMs: 30000, wedgeMarginMs: 5000 });
    const aWork = Promise.withResolvers<string>();
    const calls: string[] = [];
    let wedgeCount = 0;
    const pA = lock.run(async (): Promise<string> => {

      calls.push("A");

      return aWork.promise;
    }, { ...runOpts(), onWedge: (): void => {

      wedgeCount++;
    } });

    // The expectation is attached before the clock is driven, so the deadline rejection the advance releases is observed rather than left unhandled.
    const deadline = assert.rejects(pA, (error: unknown) => error instanceof CaptureDeadlineError);

    await flushMicro();

    assert.deepEqual(calls, ["A"], "A holds the turn");
    assert.deepEqual(clock.requested, HELD_TURN_WAITS, "the turn armed its turn-wait, its wedge at the derived 30s floor, and its deadline bound");
    assert.equal(wedgeCount, 0, "the wedge has not fired while the task is under the bound");

    // The waiter's turn-wait sits beyond the wedge bound, so it is still queued when the wedge fires rather than having lapsed on the way there.
    let bRan = false;
    const pB = lock.run(async (): Promise<string> => {

      bRan = true;

      return "B";
    }, { ...runOpts(), turnWaitMs: 60000 });

    await flushMicro();

    assert.equal(bRan, false, "B is blocked while A holds the turn");

    clock.advance(10000);

    await deadline;
    await flushMicro();

    assert.equal(wedgeCount, 0, "the deadline lapsed first and the wedge is still under its own bound");
    assert.equal(bRan, false, "the deadline did not release the turn: B is still blocked");

    clock.advance(WEDGE_BOUND_MS - 10000);

    await flushMicro();

    assert.equal(wedgeCount, 1, "the wedge fired exactly once at the bound");
    assert.equal(bRan, false, "the wedge did not release the turn either: B is still blocked");

    aWork.resolve("A");

    await flushMicro();

    assert.equal(bRan, true, "B runs only after A truly settles");
    assert.equal(wedgeCount, 1, "the wedge did not fire a second time");
    assert.equal(await pB, "B");

    clock.advance(WEDGE_BOUND_MS);
    await flushMicro();

    assert.equal(clock.pending, 0, "B's own wedge fired against a settled task and nothing is left on the timeline");
  });

  test("the wedge does not fire when the task settles before the bound", async () => {

    const clock = new TestClock();
    const lock = createCaptureLock({ clock, wedgeFloorMs: 30000, wedgeMarginMs: 5000 });
    let wedged = false;
    const p = lock.run(async (): Promise<string> => "done", { ...runOpts(), onWedge: (): void => {

      wedged = true;
    } });

    await flushMicro();

    assert.equal(await p, "done");
    assert.deepEqual(clock.requested, HELD_TURN_WAITS, "the turn armed its turn-wait, its wedge, and its deadline bound");
    assert.equal(clock.pending, 1, "the settled task cancelled both bounds, and the wedge is the one wait that survives it");

    // The wedge is armed with no cancellation, so it stays registered until it fires - and firing it against a settled task is the no-op this row is about.
    clock.advance(WEDGE_BOUND_MS);

    await flushMicro();

    assert.equal(wedged, false, "the wedge does not fire for a task that settled before the bound");
    assert.equal(clock.pending, 0, "and nothing is left on the timeline behind it");
  });

  test("the wedge never fires for a task still waiting for its turn", async () => {

    const clock = new TestClock();
    const lock = createCaptureLock({ clock, wedgeFloorMs: 30000, wedgeMarginMs: 5000 });
    const aWork = Promise.withResolvers<string>();
    const pA = lock.run(async (): Promise<string> => aWork.promise, runOpts());
    let bWedged = false;

    // The waiter's turn-wait sits beyond the holder's wedge bound, so it is still queued when that wedge fires.
    const pB = lock.run(async (): Promise<string> => "B", { ...runOpts(), onWedge: (): void => {

      bWedged = true;
    }, turnWaitMs: 60000 });

    // The expectation is attached before the clock is driven, so the deadline rejection the advance releases is observed rather than left unhandled.
    const deadline = assert.rejects(pA, (error: unknown) => error instanceof CaptureDeadlineError);

    await flushMicro();

    // The waiter's turn-wait lands between the holder's own turn-wait and the pair the holder arms once its turn is granted, because a granted turn resolves on a
    // microtask while a queued run() registers its bound synchronously.
    assert.deepEqual(clock.requested, [ 10000, 60000, 30000, 10000 ], "only the turn-holder armed a wedge; the waiter armed nothing but its turn-wait");

    clock.advance(10000);

    await deadline;

    // Crossing the holder's own wedge bound cannot fire B's wedge, because B is still in the turn-wait phase and has armed none.
    clock.advance(WEDGE_BOUND_MS - 10000);

    await flushMicro();

    assert.equal(bWedged, false, "a task waiting for its turn never fires its wedge");

    aWork.resolve("A");

    await flushMicro();

    assert.equal(await pB, "B");

    clock.advance(WEDGE_BOUND_MS);
    await flushMicro();

    assert.equal(bWedged, false, "and its wedge, once armed, still finds a task that settled first");
    assert.equal(clock.pending, 0, "nothing is left on the timeline");
  });

  test("the wedge bound derives as max(floor, deadline + margin) and is always later than the caller deadline", async () => {

    // A small deadline derives to the floor, which is strictly later than the 10s caller deadline (30000 > 10000).
    {

      const clock = new TestClock();
      const lock = createCaptureLock({ clock, wedgeFloorMs: 30000, wedgeMarginMs: 5000 });
      const work = Promise.withResolvers<string>();
      const p = lock.run(async (): Promise<string> => work.promise, { deadlineMessage: "d", deadlineMs: 10000, onWedge: (): void => { /* Unused here. */ },
        turnWaitMs: 10000 });

      await flushMicro();

      assert.deepEqual(clock.requested, [ 10000, 30000, 10000 ], "a 10s deadline derives the wedge to the 30s floor, strictly later than the caller deadline");

      work.resolve("x");

      await p;
    }

    // A large deadline derives to deadline + margin, which is strictly later than the 40s caller deadline (45000 > 40000).
    {

      const clock = new TestClock();
      const lock = createCaptureLock({ clock, wedgeFloorMs: 30000, wedgeMarginMs: 5000 });
      const work = Promise.withResolvers<string>();
      const p = lock.run(async (): Promise<string> => work.promise, { deadlineMessage: "d", deadlineMs: 40000, onWedge: (): void => { /* Unused here. */ },
        turnWaitMs: 40000 });

      await flushMicro();

      assert.deepEqual(clock.requested, [ 40000, 45000, 40000 ],
        "a 40s deadline derives the wedge to deadline + margin, strictly later than the caller deadline");

      work.resolve("x");

      await p;
    }
  });

  test("the deadline applies to the task phase only, aborts the signal, and holds the turn until the task truly settles", async () => {

    const clock = new TestClock();
    const lock = createCaptureLock({ clock, wedgeFloorMs: 30000, wedgeMarginMs: 5000 });
    const aWork = Promise.withResolvers<string>();
    let capturedSignal: AbortSignal | null = null;
    const pA = lock.run(async (signal: AbortSignal): Promise<string> => {

      capturedSignal = signal;

      return aWork.promise;
    }, { deadlineMessage: "Stream initialization timed out.", deadlineMs: 10000, turnWaitMs: 10000 });

    // The expectation is attached before the clock is driven, so the rejection the advance releases is observed rather than left unhandled.
    const deadline = assert.rejects(pA, (error: unknown) => (error instanceof CaptureDeadlineError) && (error.message === "Stream initialization timed out."));

    await flushMicro();

    assert.deepEqual(clock.requested, HELD_TURN_WAITS, "the turn armed its turn-wait, its wedge, and its deadline bound");

    clock.advance(10000);

    await deadline;

    const abortedSignal = await expectAt(() => capturedSignal ?? undefined);

    assert.equal(abortedSignal.aborted, true, "the task's signal was aborted when the deadline fired");

    let bRan = false;
    const pB = lock.run(async (): Promise<string> => {

      bRan = true;

      return "B";
    }, runOpts());

    await flushMicro();

    assert.equal(bRan, false, "the turn is held past the deadline until the abandoned task settles");

    aWork.resolve("late");

    await flushMicro();

    assert.equal(bRan, true, "the successor runs once the abandoned task truly settles");
    assert.equal(await pB, "B");
  });

  test("an orphaned late success is retired inside the turn before the successor begins", async () => {

    const restore = assertNoUnhandledRejections();
    const clock = new TestClock();
    const lock = createCaptureLock({ clock, wedgeFloorMs: 30000, wedgeMarginMs: 5000 });
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Standard pattern for signal promises.
    const gotStream = Promise.withResolvers<void>();
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Standard pattern for signal promises.
    const stopConfirmed = Promise.withResolvers<void>();
    const stubStream = { destroy(): void {

      this.destroyed = true;
    }, destroyed: false, stopped: stopConfirmed.promise };
    let retireComplete = false;
    const pA = lock.run(async (signal: AbortSignal): Promise<typeof stubStream> => {

      await gotStream.promise;

      /* Mirror the real stream task's abandonment branch: on a fired deadline, retire the resource this task produced - destroy it, then wait for the capture
       * extension to confirm the recording stopped - and only then reject, so no path uses it. The confirmation, not a fixed wait, is what the turn is held for.
       */
      if(signal.aborted) {

        stubStream.destroy();

        await waitWithTimeout(stubStream.stopped, 3000, { clock, reason: new Error("The capture extension did not confirm the recording stopped in time.") });

        retireComplete = true;

        throw new CaptureAbandonedError();
      }

      return stubStream;
    }, { deadlineMessage: "Stream initialization timed out.", deadlineMs: 10000, turnWaitMs: 10000 });

    // The expectation is attached before the clock is driven, so the rejection the advance releases is observed rather than left unhandled.
    const deadline = assert.rejects(pA, (error: unknown) => error instanceof CaptureDeadlineError);

    await flushMicro();

    assert.deepEqual(clock.requested, HELD_TURN_WAITS, "the turn armed its turn-wait, its wedge, and its deadline bound");

    clock.advance(10000);

    await deadline;

    let stateAtBStart: { destroyed: boolean; retireComplete: boolean } | null = null;
    const pB = lock.run(async (): Promise<string> => {

      stateAtBStart = { destroyed: stubStream.destroyed, retireComplete };

      return "B";
    }, runOpts());

    await flushMicro();

    assert.equal(stateAtBStart, null, "the successor has not begun while the orphan is being retired");

    // The operation resolves late, after the caller abandoned it.
    gotStream.resolve();

    await flushMicro();

    assert.equal(stateAtBStart, null, "the successor still waits while the retire waits on the stop confirmation");

    // The capture extension confirms the recording stopped, which is what completes the retire and releases the turn.
    stopConfirmed.resolve();

    await flushMicro();

    const observedAtBStart = await expectAt(() => stateAtBStart ?? undefined);

    assert.equal(observedAtBStart.destroyed, true, "the orphaned stream was destroyed before the turn released");
    assert.equal(observedAtBStart.retireComplete, true, "the stop confirmation completed before the turn released");
    assert.equal(await pB, "B");

    await flushMacro();

    restore();
  });

  test("a task rejection releases the turn without an unhandled rejection, in-time and late-after-abandonment", async () => {

    const restore = assertNoUnhandledRejections();

    // Variant 1: an in-time rejection reaches the caller and releases the turn.
    {

      const clock = new TestClock();
      const lock = createCaptureLock({ clock, wedgeFloorMs: 30000, wedgeMarginMs: 5000 });
      const aWork = Promise.withResolvers<string>();
      const pA = lock.run(async (): Promise<string> => aWork.promise, runOpts());
      let bRan = false;
      const pB = lock.run(async (): Promise<string> => {

        bRan = true;

        return "B";
      }, runOpts());

      await flushMicro();

      assert.equal(bRan, false, "B is blocked while A holds the turn");

      const boom = new Error("in-time boom");

      aWork.reject(boom);

      await assert.rejects(pA, (error: unknown) => error === boom);
      await flushMicro();

      assert.equal(bRan, true, "the successor runs after the in-time rejection releases the turn");
      assert.equal(await pB, "B");
    }

    // Variant 2: a late rejection, after the caller abandoned the task at the deadline, still releases the turn.
    {

      const clock = new TestClock();
      const lock = createCaptureLock({ clock, wedgeFloorMs: 30000, wedgeMarginMs: 5000 });
      const aWork = Promise.withResolvers<string>();
      const pA = lock.run(async (): Promise<string> => aWork.promise, { deadlineMessage: "Stream initialization timed out.", deadlineMs: 10000, turnWaitMs: 10000 });

      // The expectation is attached before the clock is driven, so the rejection the advance releases is observed rather than left unhandled.
      const deadline = assert.rejects(pA, (error: unknown) => error instanceof CaptureDeadlineError);

      await flushMicro();
      clock.advance(10000);
      await deadline;

      let bRan = false;
      const pB = lock.run(async (): Promise<string> => {

        bRan = true;

        return "B";
      }, runOpts());

      await flushMicro();

      assert.equal(bRan, false, "the turn is still held while the abandoned task is pending");

      aWork.reject(new Error("late boom"));

      await flushMicro();

      assert.equal(bRan, true, "the late rejection released the turn");
      assert.equal(await pB, "B");
    }

    await flushMacro();

    restore();
  });

  test("the error classes carry their exact, compatibility-critical messages", () => {

    assert.equal(new CaptureTurnTimeoutError().message, "Capture queue wait timed out.");
    assert.equal(new CaptureDeadlineError("Stream initialization timed out.").message, "Stream initialization timed out.");
    assert.equal(new CaptureAbandonedError().message, "Capture stream retired after the caller abandoned its turn.");
  });
});
