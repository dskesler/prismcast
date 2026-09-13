/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * health.helpers.ts: Test-only helper that establishes the health store on a caller-supplied clock. Co-located with the health module, whose loadHealthState is
 * the store's one establishment point - it hydrates the maps, sets the clock every stamp and expiry test reads, and builds the registry the flush debounce
 * arms on.
 *
 * This is the establishment a test uses when it holds no data directory of its own. A suite that skipped it would leave the store on the system clock, so its
 * marks would stamp real epochs and its debounce would arm a real two-second timer that outlives the row - which is why such suites reach for a global timer
 * mock instead. Handing the load a TestClock removes the reason for that mock: the stamps are the clock's, the debounce is on virtual time, and nothing the
 * row arms can survive it.
 *
 * The temporary directory exists because the debounce writes health.json when it fires; a store pointed at a missing data directory would fail that write
 * rather than exercise it. Disposal flushes before it removes the directory, so the write behind the store's serialization queue has landed before the
 * directory it targets disappears.
 */
import { flushHealthStateNow, loadHealthState } from "./health.ts";
import { mkdtemp, rm } from "node:fs/promises";
import type { Clock } from "homebridge-plugin-utils";
import { TMPDIR_PREFIX } from "../testing.helpers.ts";
import { initializeDataDir } from "./paths.ts";
import os from "node:os";
import path from "node:path";

/**
 * Puts the health store on the supplied clock, backed by a fresh temporary data directory, and answers the disposal that tears both down.
 * @param clock - The clock the store's stamps, expiry tests, and flush debounce run on for the lifetime of this establishment.
 * @returns A dispose function that clears any pending debounce, drains the store's write queue, and removes the temporary directory.
 */
export async function useHealthStoreOnClock(clock: Clock): Promise<() => Promise<void>> {

  const dir = await mkdtemp(path.join(os.tmpdir(), TMPDIR_PREFIX));

  initializeDataDir(dir);

  await loadHealthState(clock);

  return async (): Promise<void> => {

    await flushHealthStateNow();
    await rm(dir, { force: true, recursive: true });
  };
}
