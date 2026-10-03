/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * processInspector.ts: The OS process-table port. Returns a snapshot of every visible process on the host with its full command line so domain code can match
 * by intent (e.g., "Chrome processes using our profile directory") rather than by historical PID. This is the architecturally correct primitive for finding
 * orphaned processes after an ungraceful shutdown - a saved PID has no provenance after a reboot, but a live process's command line is the actual source of
 * truth for what it is and what it is doing.
 *
 * Every platform branch lives in processInspector.context.ts, the per-platform parsers that decode each enumeration source's raw text included. The
 * orchestrator here is a one-line dispatch over a ProcessInspectorContext, which tests construct as a literal with pre-built ProcessInfo arrays.
 */
import { createDefaultProcessInspectorContext } from "./processInspector.context.ts";

/**
 * One row of the OS process table. The fields let domain code identify a process by intent and verify its ownership via the parent-child relationship. The
 * ppid in particular is what lets killStaleChrome safely run from any context: a process whose Chrome is matched by profile but whose ppid points at a live
 * unrelated parent is owned by that parent, not by us, and we must leave it alone.
 */
export interface ProcessInfo {

  // The full command line as the OS reports it. On Linux this is the space-joined /proc/<pid>/cmdline (NUL bytes replaced with spaces); on macOS the output of
  // `ps -o command=`; on Windows the CommandLine property from Win32_Process. May be empty for kernel threads or processes that hid their command line.
  readonly commandLine: string;

  // The process ID. Stable for the lifetime of the process.
  readonly pid: number;

  // The parent process ID at the moment of enumeration. After the parent dies, the kernel reparents the child to the init process (PID 1 on Linux/macOS,
  // distinct system process on Windows); a ppid that points at a dead PID or at init signals an orphan.
  readonly ppid: number;
}

/**
 * The runtime capability set listProcesses consumes. Production wires it from real I/O via createDefaultProcessInspectorContext; tests pass a context literal
 * holding the desired ProcessInfo[].
 */
export interface ProcessInspectorContext {

  // Returns the current process table snapshot. Implementations may spawn a subprocess, read /proc, or query a platform API - the orchestrator does not care.
  readonly enumerate: () => ProcessInfo[];
}

/**
 * Returns a snapshot of every visible process. Callers filter the result for the processes they care about.
 * @param ctx - The process inspector context. Defaults to real I/O wiring.
 * @returns The current process table.
 */
export function listProcesses(ctx: ProcessInspectorContext = createDefaultProcessInspectorContext()): ProcessInfo[] {

  return ctx.enumerate();
}
