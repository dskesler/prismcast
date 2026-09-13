/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timing.ts: Timing measurement utilities for PrismCast. Reads the clock through the library's Clock port so tests can inject a deterministic time source;
 * production callers omit the argument and the default-argument wires through to systemClock, whose now() reads epoch milliseconds.
 */
import type { Clock } from "homebridge-plugin-utils";
import { systemClock } from "homebridge-plugin-utils";

/**
 * Creates a lightweight elapsed-time closure. Captures the clock's current reading at creation and rounds the elapsed delta on each call. Production callers
 * pass no argument and consume the systemClock default; tests inject a virtual clock and advance it for deterministic time control.
 * @param clock - The clock to read time from. Defaults to systemClock, whose now() reads epoch milliseconds.
 * @returns A closure that returns elapsed milliseconds as a rounded integer.
 */
export function startTimer(clock: Clock = systemClock): () => number {

  const start = clock.now();

  return (): number => Math.round(clock.now() - start);
}
