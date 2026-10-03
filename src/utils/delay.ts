/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * delay.ts: The project's wait policies. homebridge-plugin-utils owns the wait mechanisms - waitWithSignal races a held promise against an interrupt signal,
 * runWithAbort carries the return-null-on-abort policy, and Clock is the time source the waits run on - and this file names the policies built over them
 * exactly once: timeoutSignal is the reason-carrying interrupt source, waitWithTimeout is the throw-shaped bounded wait, boundedWait is the value-shaped one,
 * delay is the named sleep, and pollUntil is the read-a-reported-state shape. Any code path that needs "promise with a bound" consumes a policy here rather
 * than re-rolling the timer, race, and cleanup sequence.
 *
 * Every policy takes its clock through its options and defaults to systemClock, so a test drives the whole policy set from one TestClock: the bound, the
 * cadence, and the sleep settle on a single virtual timeline, and a wait binds on a deadline the test crosses rather than resolving whenever a double decides
 * it should. The system clock reads the host's wall clock, so a step in that clock while a bound or a poll is pending shifts that wait by the size of the
 * step, once; the next reading corrects it.
 *
 * pollUntil sits beside the two bounded waits rather than among them because it binds a different thing. The bounded waits hold a promise somebody else
 * produced and decide what a lapse means; pollUntil has no promise to hold - the state it is waiting on is one the caller can only ask for - so it asks on a
 * cadence and reports what it last saw. That is why its ceiling is a bound to log rather than a delay the healthy path pays: a signal that is already true
 * costs exactly one read. It is also the one policy here that takes an abort signal, because the state it asks for is one its caller may stop caring about
 * before the ceiling, and an abort is a third outcome beside satisfied and lapsed rather than a lapse in disguise.
 *
 * Choosing between the two bounded waits is a question about semantics, not mechanism. A wait whose interruption is exceptional - the operation was supposed
 * to finish and did not - throws through waitWithTimeout, so the failure travels as an error the caller can distinguish by identity or type. A wait whose
 * lapse is an ordinary branch the caller was already going to take returns null through boundedWait, so the caller reads it as a value rather than unwinding
 * through a catch it did not need.
 *
 * Each policy owns its timer's entire lifecycle: it creates the handle, races through the library, and cancels in a finally. Centralizing that ownership is
 * what keeps a forgotten cleanup from leaking a timer at any call site, and it is what guarantees the handle is disposed at settlement while the event loop is
 * still healthy (see the rationale on timeoutSignal).
 */
import { runWithAbort, systemClock, waitWithSignal } from "homebridge-plugin-utils";
import type { Clock } from "homebridge-plugin-utils";
import type { Nullable } from "../types/index.ts";

/**
 * A timeout expressed as an abort signal, paired with the disposal its consumer owes. The signal aborts with the caller's own error object as its reason, which
 * is what the platform's AbortSignal.timeout() cannot express - it always aborts with a generic TimeoutError, forcing every consumer that needs to tell its own
 * lapse apart from anyone else's to translate at the catch site. Carrying the reason instead means a caller can compare the rejection by reference or by type
 * and get an exact answer.
 */
export interface TimeoutSignal {

  cancel: () => void;
  signal: AbortSignal;
}

/**
 * What a bound needs beyond its duration: where its time comes from, and what its lapse says. Every policy in this file accepts this shape, so one clock
 * injected at a call site drives whichever bound that call site builds.
 */
export interface BoundOptions {

  // The time port the bound runs on. Defaults to the system clock, whose timers are the platform's; a virtual clock instead fires the bound when a test
  // advances past its deadline, so a bound is asserted rather than waited out.
  readonly clock?: Clock;

  // The error the bound carries when it lapses: thrown by waitWithTimeout, set as the abort reason by timeoutSignal. Defaults to a generic Error naming the
  // duration.
  readonly reason?: Error;
}

/**
 * Creates a timeout signal that aborts after the given duration, carrying the supplied error as its abort reason. The bound is a one-shot armed on the clock,
 * so it comes due wherever that clock's time comes from - a platform timer under the system clock, an advance under a virtual one.
 *
 * The consumer owns the returned handle and must cancel() it once its wait settles. That discipline is what keeps a timer from being disposed at process exit
 * instead of at settlement: on Windows, libuv disposing a still-pending timeout handle during natural exit can race pending socket cleanup and trip the
 * UV_HANDLE_CLOSING assertion in libuv's async.c. Cancelling at settlement disposes the handle while the event loop is still healthy, which sidesteps the race
 * regardless of how soon afterwards the process exits. A bound left pending holds the loop open for at most its own duration, and that never delays exit,
 * because shutdown ends the process explicitly (see app.ts) rather than waiting for the loop to empty.
 *
 * The system clock reads the host's wall clock, so a step in that clock while a bound is pending shifts the bound by the size of the step, once; the next
 * reading corrects it.
 *
 * The default error is built inside the timer callback so a wait that finishes in time allocates nothing.
 * @param ms - The timeout duration in milliseconds.
 * @param options - The clock the bound runs on and the reason it aborts with when it lapses.
 * @returns A handle exposing the timeout's signal and the cancel function that disposes its timer.
 */
export function timeoutSignal(ms: number, options: BoundOptions = {}): TimeoutSignal {

  const { clock = systemClock, reason } = options;
  const controller = new AbortController();

  // The bound is a one-shot on the clock, so a virtual clock fires it inside advance and disposing the handle cancels it before it fires. The default reason is
  // built when the bound fires, so a wait that finishes in time allocates nothing.
  const timer = clock.schedule((): void => {

    controller.abort(reason ?? new Error("Operation timed out after " + String(ms) + "ms."));
  }, ms);

  return { cancel: (): void => { timer[Symbol.dispose](); }, signal: controller.signal };
}

/**
 * Waits for a promise, bounded by a timeout that throws. If the promise settles first its outcome passes through unchanged; if the bound lapses first, the
 * caller's exact error object is thrown, so a call site can identify its own lapse by reference or by instanceof rather than by parsing a message.
 *
 * This is the throw-shaped wait policy: reach for it when a lapse means the operation failed. The timer's full lifecycle lives here - created before the race
 * and cancelled in the finally on every exit path - so no call site can forget the cleanup.
 * @param promise - The promise to wait on.
 * @param timeoutMs - The timeout duration in milliseconds.
 * @param options - The clock the bound runs on and the reason thrown when it lapses.
 * @returns The resolved value of the promise.
 * @throws The supplied error (or the default) when the bound lapses first, or the promise's own rejection when it settles first.
 */
export async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, options: BoundOptions = {}): Promise<T> {

  const timeout = timeoutSignal(timeoutMs, options);

  try {

    return await waitWithSignal(promise, timeout.signal);
  } finally {

    timeout.cancel();
  }
}

/**
 * Waits for a promise, bounded by a timeout that yields null. If the promise settles first its value is returned; if the bound lapses first the result is null,
 * so the caller branches on a value rather than unwinding through a catch.
 *
 * This is the value-shaped wait policy: reach for it when a lapse is an ordinary outcome the caller already handles - a shutdown escalating from SIGTERM to
 * SIGKILL, a tune that did not land, an interception that never arrived. A promise's own rejection still propagates, because a rejection is a failure rather
 * than a lapse.
 *
 * The composition is deliberate. runWithAbort performs no race of its own; it composes the bounds into one signal, hands that signal to the factory, and maps
 * an abort-time rejection to null. So the factory forwards the signal into waitWithSignal, and that forwarding is what makes the bound genuinely bind on a
 * promise this code does not own - a factory that ignored its signal would leave a held promise waiting forever. The bound uses timeoutSignal rather than
 * runWithAbort's own timeout option so every bound in the project flows through the one source that can carry a reason, owns its timer, and runs on an
 * injected clock.
 *
 * The lapse carries no reason, because there is no rejection to carry it on: a caller that needs to tell its own lapse apart reaches for waitWithTimeout.
 *
 * One constraint belongs to the caller: a promise that can itself resolve null cannot be told apart from a lapse. Callers own that fit.
 * @param promise - The promise to wait on.
 * @param timeoutMs - The timeout duration in milliseconds.
 * @param options - The clock the bound runs on.
 * @returns The resolved value of the promise, or null if the bound lapsed first.
 */
export async function boundedWait<T>(promise: Promise<T>, timeoutMs: number, options: Pick<BoundOptions, "clock"> = {}): Promise<Nullable<T>> {

  const timeout = timeoutSignal(timeoutMs, { clock: options.clock });

  try {

    return await runWithAbort((signal) => waitWithSignal(promise, signal), { signal: timeout.signal });
  } finally {

    timeout.cancel();
  }
}

/**
 * Creates a promise that resolves after the specified delay. This is the project's one canonical "sleep" name, over the system clock's delay, for the call
 * sites that hold no clock of their own; a consumer that does hold one calls clock.delay instead, so its sleep runs on the same time source as its bounds.
 * @param ms - The delay duration in milliseconds.
 * @returns A promise that resolves after the specified delay.
 */
export async function delay(ms: number): Promise<void> {

  await systemClock.delay(ms);
}

/**
 * The inputs to one poll: what to read, when to stop reading, how often to ask, how long to keep asking, and what ends the asking early.
 */
export interface PollUntilOptions<T> {

  // The wait between one read and the next. A cadence, not a settle: nothing is being given time to happen, the state is simply being asked for again.
  readonly cadenceMs: number;

  // The longest the poll keeps asking before it gives up and reports what it last saw. A ceiling of 0 performs exactly one read.
  readonly ceilingMs: number;

  // The time port driving the cadence and the elapsed measurement. Defaults to the system clock; a test passes a virtual clock and advances it to release each
  // cadence, so the whole poll runs on virtual time.
  readonly clock?: Clock;

  // Reads the signal once. A rejection propagates to the caller unchanged, because what a failed read means belongs to the caller, not to the poll.
  readonly read: () => Promise<T>;

  // Aborts the poll early. Checked before every read and before every cadence sleep, and carried into the sleep so an abort ends the poll inside it rather than
  // after it; the outcome reports the abort as its own status.
  readonly signal?: AbortSignal;

  // Decides whether a value read is the one the caller was waiting for.
  readonly until: (value: T) => boolean;
}

/**
 * A poll that ended on its own terms: satisfied by a read, or lapsed at its ceiling. The value is the satisfying read in the first case and the last read in the
 * second, and the read count says how many it took - a satisfied-on-arrival signal reads once.
 */
export interface PollSettled<T> {

  readonly reads: number;
  readonly status: "lapsed" | "satisfied";
  readonly value: T;
}

/**
 * A poll its signal ended: before its first read, or between a read and the sleep that would have followed, or inside a cadence sleep. There is no value to
 * report, because the state the caller was asking for was never confirmed and the caller has stopped caring; the read count says how far the poll got.
 */
export interface PollAborted {

  readonly reads: number;
  readonly status: "aborted";
}

/**
 * The result of one poll.
 */
export type PollOutcome<T> = PollAborted | PollSettled<T>;

/* Two overloads above one implementation, in the order the compiler tries them: a caller holding no signal gets the settled shapes alone, so it never has to
 * branch on an abort it cannot receive; every other caller - a definite signal or an optional one - gets the full outcome, because at runtime it may abort. A
 * third overload naming a definite signal would be redundant with the general one, which the family lint's unified-signatures rule reports as an error.
 */
export function pollUntil<T>(options: PollUntilOptions<T> & { readonly signal?: undefined }): Promise<PollSettled<T>>;
export function pollUntil<T>(options: PollUntilOptions<T>): Promise<PollOutcome<T>>;

/**
 * Reads a signal on a cadence until it satisfies a predicate, a ceiling lapses, or an abort signal ends the asking. This is the shape every "wait for a reported
 * state" call in the project shares: a state that only its owner can report, asked for on a cadence, under a ceiling that exists to be logged rather than to be
 * waited out, and stoppable by the caller that no longer needs the answer.
 *
 * The first read runs immediately, with no sleep ahead of it, so a signal that is already true costs one round trip and nothing else. A read that rejects
 * propagates unchanged: the poll has no opinion on what a failed read means, and swallowing it would hide a fault behind a lapse. A supplied signal ends the poll
 * at the next checkpoint - before a read, before a sleep, or inside a sleep - and the outcome says so.
 * @param options - The poll's read, predicate, cadence, ceiling, clock, and signal.
 * @returns The outcome: satisfied or lapsed with the last value read, or aborted with the reads that ran.
 */
export async function pollUntil<T>(options: PollUntilOptions<T>): Promise<PollOutcome<T>> {

  const { cadenceMs, ceilingMs, clock = systemClock, read, signal, until } = options;
  const startedAt = clock.now();

  // The sleep's init is built once: a signal is forwarded so the clock ends the sleep when it aborts, and an absent signal forwards nothing at all.
  const init = signal ? { signal } : undefined;

  let reads = 0;

  for(;;) {

    if(signal?.aborted) {

      return { reads, status: "aborted" };
    }

    // eslint-disable-next-line no-await-in-loop -- A poll is sequential by definition: each read has to settle before the cadence sleep and the next read.
    const value = await read();

    reads++;

    if(until(value)) {

      return { reads, status: "satisfied", value };
    }

    // An abort that landed during the read wins over a lapse at the ceiling and registers no sleep: the caller's own stop is checked before the ceiling and
    // before the cadence, because a lapse would hand back a value the caller has already stopped caring about.
    if(signal?.aborted) {

      return { reads, status: "aborted" };
    }

    // The ceiling is checked only after a read has already happened, so the poll always reports a value and a zero ceiling still asks once.
    if((clock.now() - startedAt) >= ceilingMs) {

      return { reads, status: "lapsed", value };
    }

    try {

      // eslint-disable-next-line no-await-in-loop -- The cadence is the point: the next read must not start until this wait completes.
      await clock.delay(cadenceMs, init);
    } catch(error) {

      // The clock rejects an aborted sleep with its own AbortError rather than the signal's reason, so the poll identifies its abort by the signal it holds and
      // lets any other rejection propagate unchanged.
      if(signal?.aborted) {

        return { reads, status: "aborted" };
      }

      throw error;
    }
  }
}
