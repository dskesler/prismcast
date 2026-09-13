/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * retry.ts: PrismCast's retry policy over the library's retry loop. homebridge-plugin-utils owns the attempt loop, the attempt budget, and the between-attempt
 * wait, together with the exponential ladder that wait is measured by; this file owns what one attempt is - the abort gate, the per-attempt bound, the
 * session-closed pass-through, the early-success check, the ladder's ceiling and jitter, and the logging - and the closed-form estimate of a run's worst-case
 * duration. The loop and the wait policies both run on the library's Clock, so a test drives an entire retry - every per-attempt bound and every backoff - from
 * one TestClock and asserts the schedule rather than waiting it out.
 */
import { exponentialBackoff, retry, systemClock } from "homebridge-plugin-utils";
import { formatError, isSessionClosedError } from "./errors.ts";
import type { Clock } from "homebridge-plugin-utils";
import { LOG } from "./logger.ts";
import { waitWithTimeout } from "./delay.ts";

// Default maximum jitter added to each backoff sleep in milliseconds. Prevents synchronized retries across concurrent operations. Read by both retryOperation's
// destructuring default and maxRetryDuration, so the worst-case estimate cannot drift from the policy that produces the sleeps.
const DEFAULT_BACKOFF_JITTER = 1000;

// Default cap on each backoff sleep in milliseconds. Bounds the exponential growth so a long retry chain never sleeps unboundedly. Read by both retryOperation's
// destructuring default and maxRetryDuration, so the worst-case estimate cannot drift from the policy that produces the sleeps.
const DEFAULT_MAX_BACKOFF_DELAY = 3000;

// Thrown by the attempt gate when shouldAbort reports the abort condition before an attempt starts. It is its own class so the retry veto can tell it from an
// attempt's own failure: the gate's throw is never warned about and never retried, exactly as a closed session is not.
class RetryAbortedError extends Error {

  public constructor() {

    super("Operation aborted: abort condition met before retry.");
    this.name = "RetryAbortedError";
  }
}

/**
 * Options for retryOperation. Groups all parameters into a single object to avoid positional parameter sprawl and make the function extensible.
 */
export interface RetryOptions<T> {

  // Maximum jitter added to the backoff delay in milliseconds. Prevents synchronized retries across concurrent operations. Default: 1000ms.
  backoffJitter?: number;

  // The clock the backoff sleeps and the per-attempt bound run on. Defaults to the system clock; a test injects the library's virtual clock so the backoff
  // schedule and the bounds run on virtual time and every wait the policy makes is asserted rather than waited out.
  clock?: Clock;

  // Human-readable description for logging purposes.
  description: string;

  // Optional async function called after timeout errors. If it returns a truthy value, the operation is considered successful and retrying stops. Useful for
  // cases where the operation succeeded but took too long (e.g., page loaded and video started playing, but networkidle2 never completed).
  earlySuccessCheck?: () => Promise<boolean>;

  // Maximum number of attempts before giving up.
  maxAttempts: number;

  // Maximum backoff delay in milliseconds between retry attempts. Caps the exponential growth to prevent excessively long waits. Default: 3000ms.
  maxBackoffDelay?: number;

  // An async function to attempt. Should throw on failure.
  operation: () => Promise<T>;

  // Optional function called before each attempt. If it returns true, retries are aborted immediately. Useful for checking if the page was closed during the
  // backoff delay.
  shouldAbort?: () => boolean;

  // Timeout in milliseconds for each individual attempt.
  timeoutMs: number;
}

/**
 * Implements a generic retry mechanism with exponential backoff and jitter. This function attempts an operation multiple times, waiting progressively longer between
 * attempts to avoid overwhelming failing services. The exponential backoff with jitter prevents thundering herd problems where many clients retry simultaneously.
 * The library's retry loop owns the attempt budget and the backoff wait; this policy owns the backoff ladder the loop waits on (seeded at one second, doubling,
 * capped, and jittered) and what one attempt is: the abort gate, the per-attempt bound, the session-closed pass-through, the early-success check, and the logging.
 * @param options - Retry configuration including the operation, attempt limits, timeouts, and optional backoff tuning.
 * @returns The result of the operation if successful, or undefined when earlySuccessCheck reports the operation already succeeded after a timeout-shaped error.
 * @throws The last error encountered if all attempts fail.
 */
export async function retryOperation<T>(options: RetryOptions<T>): Promise<T | undefined> {

  const { backoffJitter = DEFAULT_BACKOFF_JITTER, clock = systemClock, description, earlySuccessCheck, maxAttempts, maxBackoffDelay = DEFAULT_MAX_BACKOFF_DELAY,
    operation, shouldAbort, timeoutMs } = options;

  // The ladder is the library's exponential backoff at the configured ceiling; the jitter added to each wait is PrismCast's, so concurrent retries never synchronize.
  const ladder = exponentialBackoff({ ceilingMs: maxBackoffDelay });

  // The attempt number the log lines report, advanced as each attempt starts; the loop that runs the attempts is the library's.
  let attempt = 0;

  return retry(async (): Promise<T | undefined> => {

    attempt++;

    // The abort gate runs before every attempt, so a page closed during the backoff is caught before another attempt is issued against it.
    if(shouldAbort?.()) {

      throw new RetryAbortedError();
    }

    if(attempt > 1) {

      LOG.debug("retry", "Retrying %s (attempt %s of %s).", description, attempt, maxAttempts);
    }

    try {

      return await waitWithTimeout(operation(), timeoutMs, { clock });
    } catch(error) {

      // If the page or session was closed, retrying is pointless. Abort immediately without warning since we're not going to retry.
      if(isSessionClosedError(error)) {

        LOG.debug("retry", "Page was closed, aborting retries for %s.", description);

        throw error;
      }

      // For timeout errors, check if the operation actually succeeded despite the timeout. This handles cases where the page loaded and video started playing, but
      // some wait condition like networkidle2 never completed. We check this before logging a warning because if early success passes, there's nothing to warn about.
      if(earlySuccessCheck && formatError(error).includes("timed out")) {

        try {

          if(await earlySuccessCheck()) {

            return undefined;
          }
        } catch(_checkError) {

          // Early success check failed, continue with retry logic.
        }
      }

      // Every failed attempt is an actual issue to report, the last one included, so the warning is logged here rather than by the retry veto, which the loop
      // consults only while attempts remain.
      LOG.warn("Attempt %s failed for %s: %s.", attempt, description, formatError(error));

      throw error;
    }
  }, {

    attempts: maxAttempts,
    backoff: (next: number): number => ladder(next) + (Math.random() * backoffJitter),
    clock,

    // A closed session and a met abort condition are the failures the loop never retries; every other failure retries until the attempt budget runs out.
    shouldRetry: (error: unknown): boolean => !isSessionClosedError(error) && !(error instanceof RetryAbortedError)
  });
}

/**
 * The timing fields maxRetryDuration reads from a retry configuration. A narrow subset of RetryOptions so the estimator depends only on what its closed form
 * needs, never on the operation, clock, or callbacks.
 */
export interface RetryDurationTiming {

  // Maximum jitter added to each backoff sleep in milliseconds. Defaults to the same constant retryOperation uses.
  backoffJitter?: number;

  // Maximum number of attempts before giving up.
  maxAttempts: number;

  // Maximum backoff delay in milliseconds between attempts. Defaults to the same constant retryOperation uses.
  maxBackoffDelay?: number;

  // Timeout in milliseconds for each individual attempt.
  timeoutMs: number;
}

/**
 * Computes the worst-case wall-clock duration of a retryOperation run: every attempt consuming its full per-attempt timeout, plus one backoff sleep per retry
 * after the first, each taken at its ceiling (the backoff cap plus the full jitter). The estimate reads the same default constants the policy reads, so it cannot
 * drift from the policy's arithmetic. The policy seeds each backoff at one second and doubles, capped at maxBackoffDelay, so every gap is at or below
 * maxBackoffDelay + backoffJitter; taking that ceiling for each gap makes the result an upper bound - a leak bound for a caller sizing a window that must outlive
 * the retries, never an under-count. The closed form holds only for configurations whose operation carries no unbounded callback: earlySuccessCheck runs awaited
 * on the timeout path and can add time beyond the per-attempt timeout, so a caller relying on the bound must pass a configuration without one.
 *
 * @param timing - The attempt count, per-attempt timeout, and optional backoff tuning.
 * @returns The worst-case duration in milliseconds.
 */
export function maxRetryDuration(timing: RetryDurationTiming): number {

  const { backoffJitter = DEFAULT_BACKOFF_JITTER, maxAttempts, maxBackoffDelay = DEFAULT_MAX_BACKOFF_DELAY, timeoutMs } = timing;

  // One backoff sleep sits between consecutive attempts, so a run of N attempts has N-1 gaps. Clamped at zero so an out-of-contract attempt count below one never
  // produces a negative gap count.
  const gaps = Math.max(0, maxAttempts - 1);

  return (maxAttempts * timeoutMs) + (gaps * (maxBackoffDelay + backoffJitter));
}
