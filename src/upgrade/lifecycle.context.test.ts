/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * lifecycle.context.test.ts: Unit tests for the default UpgradeLifecycleContext adapter's command runner. The strategies in lifecycle.ts are pure functions over
 * the context and are covered by lifecycle.test.ts against a stubbed runCommand; the runner itself - the spawn, the deadline that kills a stalled command, and
 * the disposal that deadline owes on either exit - has no coverage there, because a stub is exactly what those tests replace it with.
 *
 * The deadline arms on the clock the context is built with, so both rows below read it as a value: one armed entry while a command runs, none once it has
 * settled, and a kill that arrives when virtual time crosses the deadline rather than after a real wait. Each row builds its context inside a temporary data
 * directory, because the adapter resolves the upgrade log's path from the data directory as it is constructed.
 */
import { describe, test } from "node:test";
import { TestClock } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { createDefaultLifecycleContext } from "./lifecycle.context.ts";
import { initializeDataDir } from "../config/paths.ts";
import { withTempDir } from "../testing.helpers.ts";

// The deadline these rows give their commands. Nothing waits it out in real time: the killed command's row crosses it on the clock, and the fast command's row
// never reaches it.
const COMMAND_TIMEOUT_MS = 30000;

describe("createDefaultLifecycleContext - the command runner's deadline", () => {

  test("kills a command that outlives its deadline and reports the failure", async (t) => {

    /* The deadline exists so a stalled package manager cannot hold an HTTP request open indefinitely. The row starts a command that would otherwise outlast the
     * test, crosses the deadline on the clock, and reads the outcome: SIGTERM ends the child, the exit that follows carries a signal rather than a zero code, and
     * the runner reports failure through its ordinary path.
     */
    if(process.platform === "win32") {

      t.skip("The row drives a POSIX sleep, which the Windows shell has no equivalent of.");

      return;
    }

    await withTempDir(async (dir) => {

      initializeDataDir(dir);

      const clock = new TestClock();
      const ctx = createDefaultLifecycleContext({ clock, commandTimeoutMs: COMMAND_TIMEOUT_MS });
      const run = ctx.runCommand("sleep 5", { timeoutMs: ctx.commandTimeoutMs });

      // The deadline is armed before the runner returns its promise, so it is on the clock the instant the command starts. A deadline left on the platform's
      // timer registers nothing here.
      assert.equal(clock.pending, 1, "the deadline is armed on the clock the context was built with");

      clock.advance(COMMAND_TIMEOUT_MS);

      assert.deepEqual(await run, { success: false }, "the killed command reports failure");
      assert.equal(clock.pending, 0, "and the deadline was disposed on the way out");
    });
  });

  test("resolves a command that finishes first and leaves no deadline armed", async () => {

    // The other exit: the command settles well inside its deadline, and the disposal the settle owes is what keeps the handle from outliving the run.
    await withTempDir(async (dir) => {

      initializeDataDir(dir);

      const clock = new TestClock();
      const ctx = createDefaultLifecycleContext({ clock, commandTimeoutMs: COMMAND_TIMEOUT_MS });

      assert.deepEqual(await ctx.runCommand("exit 0", { timeoutMs: ctx.commandTimeoutMs }), { success: true }, "a command that exits zero reports success");
      assert.equal(clock.pending, 0, "and its deadline was disposed rather than left armed");
    });
  });
});
