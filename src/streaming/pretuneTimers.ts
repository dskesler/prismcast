/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * pretuneTimers.ts: Ownership of the pretune safety-timer registry.
 *
 * A pretuned stream is started ahead of its scheduled time and reaped by a per-stream safety timer if no real client ever claims it. That timer must be cancelled
 * when the stream IS claimed and terminated through the normal lifecycle, so terminateStream() (lifecycle.ts) needs to clear it. This registry lives in its own
 * leaf module - importing nothing from the streaming graph - so lifecycle.ts can clear a timer without importing pretune.ts. pretune.ts imports lifecycle.ts (for
 * terminateStream) and hls.ts (for initializeStream/validateChannel), so a direct lifecycle->pretune edge would close a hls -> lifecycle -> pretune -> hls import
 * cycle. Keeping the timer state here is the single source of truth for the registry and keeps the dependency edges acyclic.
 */
import type { Clock } from "homebridge-plugin-utils";
import { TimerRegistry } from "homebridge-plugin-utils";

/* The safety timers, keyed by stream ID, on the library's lifetime-bound timer registry. Used to tear down unclaimed pretuned streams after the scheduled start
 * time. Owned here so both the producer (pretune.ts, which schedules them) and the consumer (lifecycle.ts, which clears them on normal termination) reference one
 * registry without a cyclic import.
 *
 * The binding starts on the system clock at module load and the scheduler replaces it with one on its own clock at every start, draining it at every stop. It is
 * never absent and never throws: an arm that lands on a drained registry is accepted and fires on that registry's clock, which is what a plain map of handles did.
 */
let safetyTimers = new TimerRegistry();

/**
 * Retires the current safety-timer registry and builds a replacement on the scheduler's clock. Called by startPretunePolling() so every reaper a pretune attempt
 * arms runs on the same clock the scheduler's own timers do. The prior registry is disposed BEFORE the replacement is built, so a reaper armed against the earlier
 * generation can never fire once the restart has landed.
 * @param clock - The clock the replacement registry arms its timers on.
 */
export function startPretuneSafetyTimers(clock: Clock): void {

  safetyTimers.dispose();
  safetyTimers = new TimerRegistry({ clock });
}

/**
 * Records the pending safety timer for a pretuned stream, replacing any reaper the registry already holds under that stream ID. Called by pretune.ts when it
 * schedules the reaper. The registry removes a keyed one-shot's entry before running its callback, so the reaper reads its own key as already gone.
 * @param streamId - The numeric stream ID the timer guards.
 * @param callback - The reaper to run when the safety window elapses.
 * @param delayMs - How long to wait before reaping, in milliseconds.
 */
export function setPretuneSafetyTimer(streamId: number, callback: () => void, delayMs: number): void {

  safetyTimers.setTimeout(String(streamId), callback, delayMs);
}

/**
 * Cancels and forgets the pending safety timer for a pretuned stream. Called by terminateStream() when a pretuned stream is claimed and torn down through the normal
 * lifecycle, so the safety timeout - which exists only to reap streams that were never claimed - does not linger in the registry until it fires harmlessly against
 * an already-gone stream. Safe to call for any stream ID; streams without a pending safety timer are a no-op.
 * @param streamId - The numeric stream ID whose safety timer to clear.
 */
export function clearPretuneSafetyTimer(streamId: number): void {

  safetyTimers.clear(String(streamId));
}

/**
 * Cancels every pending safety timer while leaving the registry armed for the arms that follow. Called by stopPretunePolling() on server shutdown so no reaper
 * survives the polling loop. The retirement of the registry itself belongs to the next start, through startPretuneSafetyTimers().
 */
export function clearAllPretuneSafetyTimers(): void {

  safetyTimers.clearAll();
}
