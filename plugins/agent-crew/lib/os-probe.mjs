#!/usr/bin/env node
/**
 * Reading the state of the running machine: which processes exist, which ports
 * they listen on, and whether a sqlite3 binary is around.
 *
 * This is separate from `platform.mjs` on purpose. That module is about
 * *launching* things and comparing paths -- work every job does. This one is
 * about *inspecting* the host, which only the app transports need, and it does
 * it with a completely different set of tools per platform:
 *
 *   POSIX     `ps` and `lsof`, parsed as text.
 *   Windows   PowerShell CIM/`Get-NetTCPConnection`, parsed as JSON.
 *
 * There is no shared implementation to factor out here -- the two platforms
 * agree on nothing but the shape of the answer -- so the seam is the return
 * value, and each side is written to fail with a remedy rather than an empty
 * list. An empty list from a probe is indistinguishable from "the thing you are
 * looking for is not running", and that ambiguity is what makes app-mode
 * failures unreadable.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isWindows, PlatformError, resolveBin } from "./platform.mjs";

const PROBE_TIMEOUT_MS = 20_000;

/** Absolute fallbacks for tools that may not be on a non-interactive PATH. */
const POSIX_PS = ["/bin/ps", "/usr/bin/ps"];
const POSIX_LSOF = ["/usr/sbin/lsof", "/usr/bin/lsof", "/bin/lsof"];

function firstExisting(candidates) {
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * A tool this module needs, or a PlatformError naming what to install.
 *
 * PATH is consulted first so a Homebrew/busybox install wins over a system one,
 * then the absolute fallbacks, because a spawned Node process does not
 * necessarily inherit a login shell's PATH.
 */
function probeTool(name, fallbacks, remedy) {
  const onPath = resolveBin(name, { cache: true });
  if (onPath) return onPath.path;
  const abs = firstExisting(fallbacks);
  if (abs) return abs;
  throw new PlatformError(`cannot find ${name}, which app mode needs to inspect the host`, remedy);
}

/** PowerShell, preferring the cross-platform build when both are installed. */
function powershell() {
  for (const name of ["pwsh", "powershell"]) {
    const bin = resolveBin(name, { cache: true });
    if (bin) return bin.path;
  }
  throw new PlatformError(
    "cannot find pwsh or powershell, which app mode needs to inspect the host",
    "install PowerShell, or run the job with transport headless",
  );
}

/**
 * Run a PowerShell snippet and parse its JSON.
 *
 * `-NoProfile` matters for correctness, not just speed: a user profile that
 * prints a banner would put that banner in front of the JSON. The snippets here
 * are fixed strings from this file -- no caller data is interpolated -- so there
 * is no quoting hazard, and there must never be one: PowerShell would treat an
 * interpolated path as code.
 */
function ps1(script, what) {
  let raw;
  try {
    raw = execFileSync(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    throw new PlatformError(
      `PowerShell could not ${what}`,
      String(err.stderr || err.message).trim().split("\n")[0].slice(0, 300),
    );
  }
  const text = raw.trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PlatformError(`PowerShell returned no JSON when asked to ${what}`, text.slice(0, 300));
  }
  // ConvertTo-Json emits a bare object, not an array, for a single result.
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Every process on the machine as `{ pid, command }`, where `command` is the
 * full command line including arguments.
 *
 * The arguments are the point: the Antigravity app puts its csrf token in its
 * own argv, and that token is the only way in. On Windows `CommandLine` is null
 * for processes owned by another user, and those rows are dropped rather than
 * reported as a process with no arguments.
 */
export function listProcesses() {
  if (isWindows) {
    const rows = ps1(
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress -Depth 2",
      "list processes",
    );
    return rows
      .filter((r) => r && Number.isInteger(r.ProcessId) && typeof r.CommandLine === "string")
      .map((r) => ({ pid: r.ProcessId, command: r.CommandLine }));
  }

  const ps = probeTool("ps", POSIX_PS, "app mode needs ps; run the job with transport headless instead");
  let out;
  try {
    out = execFileSync(ps, ["-Ao", "pid,command"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  } catch (err) {
    throw new PlatformError("cannot list processes", String(err.stderr || err.message).trim().slice(0, 300));
  }
  const rows = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    const m = trimmed.match(/^(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), command: m[2] });
  }
  return rows;
}

/**
 * The loopback ports a pid is listening on.
 *
 * Loopback only, and that is a filter rather than an accident: what the caller
 * is looking for is a local IPC port, and a process also listening on a public
 * interface should not have that address handed to a probe.
 */
export function listeningPorts(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) throw new PlatformError(`not a pid: ${JSON.stringify(pid)}`);

  if (isWindows) {
    // -ErrorAction SilentlyContinue: a pid with no listeners is a valid answer
    // (an empty list), not a PowerShell error to surface as a probe failure.
    const rows = ps1(
      `Get-NetTCPConnection -State Listen -OwningProcess ${id} -ErrorAction SilentlyContinue |`
      + " Select-Object LocalAddress,LocalPort | ConvertTo-Json -Compress -Depth 2",
      `list listening ports for pid ${id}`,
    );
    const ports = new Set();
    for (const r of rows) {
      const addr = String(r?.LocalAddress ?? "");
      if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "0.0.0.0" && addr !== "::") continue;
      if (Number.isInteger(r?.LocalPort)) ports.add(r.LocalPort);
    }
    return [...ports];
  }

  const lsof = probeTool("lsof", POSIX_LSOF, "app mode needs lsof; run the job with transport headless instead");
  let out;
  try {
    // `-a` is required: without it lsof ORs -p and -i and returns other processes.
    out = execFileSync(lsof, ["-nP", "-a", "-p", String(id), "-i"], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
    });
  } catch (err) {
    // lsof exits non-zero when a pid has no matching handles, which is an empty
    // list rather than a failure. Anything with stderr text is a real failure.
    const stderr = String(err.stderr ?? "").trim();
    if (stderr) {
      throw new PlatformError(`lsof failed for pid ${id}`, stderr.split("\n")[0].slice(0, 300));
    }
    return [];
  }
  const ports = new Set();
  for (const line of out.split("\n")) {
    if (!line.includes("(LISTEN)")) continue;
    const port = line.match(/(?:127\.0\.0\.1|\[::1\]|\*):(\d+)\s+\(LISTEN\)/)?.[1];
    if (port) ports.add(Number(port));
  }
  return [...ports];
}

/**
 * A sqlite3 binary, or null.
 *
 * Null is a supported answer, not a failure: macOS ships sqlite3 at
 * /usr/bin/sqlite3 and Windows ships nothing, and the only caller uses it for
 * an optional progress reading. Making app mode depend on sqlite3 would have
 * put a Windows install step in front of the whole transport for a signal the
 * transport does not actually decide anything with.
 */
export function resolveSqlite(env = process.env) {
  if (env.AGENT_CREW_SQLITE) {
    return existsSync(env.AGENT_CREW_SQLITE) ? env.AGENT_CREW_SQLITE : null;
  }
  const onPath = resolveBin("sqlite3", { env, cache: true });
  if (onPath) return onPath.path;
  return firstExisting(["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]);
}
