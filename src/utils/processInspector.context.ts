/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * processInspector.context.ts: The default adapter for ProcessInspectorContext. Enumerates the OS process table per platform: walks /proc on Linux, spawns
 * `ps` on macOS, and spawns PowerShell with Get-CimInstance on Windows. This file is the only place in the process-inspector module that shells out, reads
 * /proc, or branches on process.platform; the orchestrator's own tests construct ProcessInspectorContext literals inline and reach none of that I/O. It also
 * carries the per-platform parsers that turn each source's raw text into ProcessInfo rows, exported so tests can exercise the format handling against
 * realistic fixtures without spawning subprocesses.
 *
 * Synchronous enumeration is intentional. killStaleChrome (the primary caller) runs in synchronous code paths including process.on("exit") handlers, where the
 * event loop is not guaranteed to be available. The execFileSync / readdirSync / readFileSync calls below are bounded - macOS/Windows shells return in tens of
 * milliseconds for a typical process table, and Linux /proc walks are sub-millisecond.
 */
import type { ProcessInfo, ProcessInspectorContext } from "./processInspector.ts";
import type { Nullable } from "../types/index.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Builds the default ProcessInspectorContext from real runtime I/O. Dispatches to the platform-appropriate enumerator at adapter-creation time so the chosen
 * branch is captured in a closure for every subsequent enumerate() call.
 * @returns A ProcessInspectorContext wired to the current platform's process table reader.
 */
export function createDefaultProcessInspectorContext(): ProcessInspectorContext {

  return { enumerate: pickEnumeratorForPlatform() };
}

/**
 * Selects the platform-appropriate enumerator. Linux uses /proc; macOS and Windows shell out to their native process listing utilities.
 * @returns The enumerator function for the current platform.
 */
function pickEnumeratorForPlatform(): () => ProcessInfo[] {

  switch(process.platform) {

    case "linux": {

      return enumerateLinux;
    }

    case "darwin": {

      return enumerateMacOs;
    }

    case "win32": {

      return enumerateWindows;
    }

    default: {

      // Unsupported platforms return an empty snapshot. Domain code that filters this list (e.g., looking for Chrome) will simply find no matches, which is
      // the safe default - we never SIGTERM anything we did not actually discover.
      return (): ProcessInfo[] => [];
    }
  }
}

/**
 * Enumerates processes on Linux by walking /proc. Each numeric directory under /proc corresponds to a PID; reading its cmdline file yields the command line.
 * Processes that exit between readdir and readFile produce ENOENT, which we silently skip.
 * @returns The current process table.
 */
function enumerateLinux(): ProcessInfo[] {

  const results: ProcessInfo[] = [];

  let entries: string[];

  try {

    entries = fs.readdirSync("/proc");
  } catch {

    return results;
  }

  for(const entry of entries) {

    const pid = parseInt(entry, 10);

    if(Number.isNaN(pid)) {

      continue;
    }

    let cmdlineRaw: string;
    let statRaw: string;

    try {

      cmdlineRaw = fs.readFileSync(path.join("/proc", entry, "cmdline"), "utf-8");
      statRaw = fs.readFileSync(path.join("/proc", entry, "stat"), "utf-8");
    } catch {

      // ENOENT (process exited between readdir and readFile), EACCES (permission denied for some PIDs as a non-root user), and similar are all expected during
      // a /proc walk. Skip silently rather than aborting the whole enumeration.
      continue;
    }

    const ppid = parseLinuxProcStat(statRaw);

    if(ppid === null) {

      continue;
    }

    results.push({ commandLine: parseLinuxProcCmdline(cmdlineRaw), pid, ppid });
  }

  return results;
}

/**
 * Enumerates processes on macOS via `ps -axww -o pid=,ppid=,command=`. The -ax flags select every process on the system; -ww disables column truncation so long
 * command lines (Chrome's are frequently very long) survive intact; the trailing `=` on each -o spec suppresses the column headers.
 * @returns The current process table.
 */
function enumerateMacOs(): ProcessInfo[] {

  try {

    // maxBuffer is bumped to 16MB to accommodate hosts with thousands of processes and Chrome's long --flag-soup command lines.
    const raw = execFileSync("/bin/ps", [ "-axww", "-o", "pid=,ppid=,command=" ], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });

    return parseMacOsPsOutput(raw);
  } catch {

    return [];
  }
}

/**
 * Enumerates processes on Windows via PowerShell's Get-CimInstance Win32_Process pipeline. We choose Format-List output over Format-Table because the latter
 * truncates the CommandLine column, and choose CIM over the legacy wmic.exe because wmic is being deprecated by Microsoft and is absent from Windows Server
 * Core / minimal SKUs.
 * @returns The current process table.
 */
function enumerateWindows(): ProcessInfo[] {

  try {

    // -NoProfile skips loading the user's PowerShell profile (saves hundreds of milliseconds); -Command is the parameter form most resilient to quoting.
    // The same 16MB maxBuffer used for the macOS enumerator comfortably covers Format-List's output here too, since its multi-line, one-property-per-row
    // rendering is more verbose per process than a single ps line but still stays well within that ceiling even on hosts with thousands of processes.
    const raw = execFileSync("powershell.exe",
      [ "-NoProfile", "-Command", "Get-CimInstance Win32_Process | Format-List ProcessId,ParentProcessId,CommandLine" ],
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });

    return parseWindowsFormatListOutput(raw);
  } catch {

    return [];
  }
}

/**
 * Parses a single /proc/<pid>/cmdline payload. The on-disk format separates argv entries with NUL bytes and may or may not include a trailing NUL. Empty
 * payloads (kernel threads, zombie processes) yield an empty command line - callers decide whether to drop those entries.
 * @param raw - The /proc/<pid>/cmdline payload.
 * @returns The decoded command line.
 */
export function parseLinuxProcCmdline(raw: string): string {

  // Drop a trailing NUL if present so the join does not produce a phantom blank arg.
  const trimmed = raw.endsWith("\0") ? raw.slice(0, -1) : raw;

  return trimmed.split("\0").join(" ");
}

/**
 * Parses the ppid (field 4) from a /proc/<pid>/stat payload. The format embeds the executable name in parentheses at field 2; that name can contain
 * whitespace and parentheses itself, so we anchor on the last closing paren before splitting. After the closing paren, the first field is field 3 (state) and
 * the second is field 4 (ppid).
 * @param raw - The /proc/<pid>/stat payload.
 * @returns The parent process ID, or null when the payload is malformed.
 */
export function parseLinuxProcStat(raw: string): Nullable<number> {

  const rparen = raw.lastIndexOf(")");

  if(rparen === -1) {

    return null;
  }

  const fields = raw.slice(rparen + 1).trim().split(/\s+/);

  // We want field 4 (ppid), which lands at index 1 in the post-paren split: index 0 is state (field 3), index 1 is ppid (field 4).
  if(fields.length < 2) {

    return null;
  }

  const ppid = parseInt(fields[1] ?? "", 10);

  return Number.isNaN(ppid) ? null : ppid;
}

/**
 * Parses the output of `ps -axww -o pid=,ppid=,command=` (or equivalent shape). Each non-empty line begins with leading whitespace, then the PID and PPID as
 * integers, then whitespace, then the full command. Lines that do not match this shape are silently dropped.
 * @param raw - The raw ps output.
 * @returns The parsed process table.
 */
export function parseMacOsPsOutput(raw: string): ProcessInfo[] {

  const results: ProcessInfo[] = [];

  for(const line of raw.split("\n")) {

    const trimmed = line.trim();

    if(trimmed === "") {

      continue;
    }

    // Three captures: pid, ppid, and the rest. The command line is the rest of the line verbatim (may contain spaces).
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(trimmed);

    if(match === null) {

      continue;
    }

    const pid = parseInt(match[1] ?? "", 10);
    const ppid = parseInt(match[2] ?? "", 10);
    const commandLine = match[3] ?? "";

    if(Number.isNaN(pid) || Number.isNaN(ppid)) {

      continue;
    }

    results.push({ commandLine, pid, ppid });
  }

  return results;
}

/**
 * Parses the output of PowerShell's `Get-CimInstance Win32_Process | Format-List ProcessId,ParentProcessId,CommandLine` (or equivalent shape). The format
 * places each property on its own line as "Name : Value", with blank lines separating records. CommandLine may be blank (system processes) or contain
 * embedded colons - we split on the first " : " separator only.
 * @param raw - The raw Format-List output.
 * @returns The parsed process table.
 */
export function parseWindowsFormatListOutput(raw: string): ProcessInfo[] {

  const results: ProcessInfo[] = [];

  let currentPid: Nullable<number> = null;
  let currentPpid: Nullable<number> = null;
  let currentCommandLine: Nullable<string> = null;

  // A record is only committed once both pid and ppid have been seen, since ownership decisions depend on both being present and trustworthy. A missing
  // command line is tolerated and recorded as an empty string.
  const flush = (): void => {

    if((currentPid !== null) && (currentPpid !== null)) {

      results.push({ commandLine: currentCommandLine ?? "", pid: currentPid, ppid: currentPpid });
    }

    currentPid = null;
    currentPpid = null;
    currentCommandLine = null;
  };

  for(const line of raw.split(/\r?\n/)) {

    if(line.trim() === "") {

      flush();

      continue;
    }

    // Format-List output is "Name : Value" with the colon surrounded by spaces. We split on the first " : " so values containing colons survive intact.
    const sep = line.indexOf(" : ");

    if(sep === -1) {

      continue;
    }

    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 3);

    switch(key) {

      case "ProcessId": {

        const parsed = parseInt(value.trim(), 10);

        currentPid = Number.isNaN(parsed) ? null : parsed;

        break;
      }

      case "ParentProcessId": {

        const parsed = parseInt(value.trim(), 10);

        currentPpid = Number.isNaN(parsed) ? null : parsed;

        break;
      }

      case "CommandLine": {

        currentCommandLine = value;

        break;
      }

      default: {

        // Other Format-List keys (Name, Path, ...) are ignored. Tolerating extra fields keeps the parser robust to upstream additions.
      }
    }
  }

  // Flush the trailing record if the output did not end with a blank line.
  flush();

  return results;
}
