/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * processInspector.test.ts: Unit tests for the process-inspector port. The port's whole surface is listProcesses, so the coverage here is its two paths: the
 * dispatch over a caller-supplied ProcessInspectorContext literal, and the default-parameter fallback that wires the real platform adapter. The per-platform
 * parsers belong to that adapter and are exercised against fixtures in processInspector.context.test.ts.
 */
import { describe, test } from "node:test";
import type { ProcessInspectorContext } from "./processInspector.ts";
import assert from "node:assert/strict";
import { listProcesses } from "./processInspector.ts";

describe("listProcesses", () => {

  test("delegates to ctx.enumerate", () => {

    const expected = [ { commandLine: "node /app/index.js", pid: 1234, ppid: 1 }, { commandLine: "/usr/bin/chrome --user-data-dir=/x", pid: 5678, ppid: 1234 } ];
    const ctx: ProcessInspectorContext = { enumerate: () => expected };

    assert.deepEqual(listProcesses(ctx), expected);
  });

  test("falls back to the default adapter when called with no context", () => {

    // The current process is the fixture because it is the one row every supported host reports: the default parameter reaching the real adapter is what puts
    // our own PID in the result, so a table without it would mean the default wiring never ran.
    const supported = [ "darwin", "linux", "win32" ];
    const table = listProcesses();

    assert.ok(Array.isArray(table), "listProcesses() returns an array");

    if(!supported.includes(process.platform)) {

      assert.deepEqual(table, [], "an unsupported platform enumerates an empty table");

      return;
    }

    assert.ok(table.some((row) => row.pid === process.pid), "the current process appears in the default adapter's table");
  });
});
