#!/usr/bin/env node
/**
 * Read the Codex runtime a run is actually sitting on, at the moment of asking.
 *
 * The manifest already records `transport` -- what the dispatcher chose -- and
 * `role` -- why it chose it. Neither says what the machine did with that
 * choice. A headless job and an app job can both end up on a shared broker or
 * on a private process, and the difference decides whether a second concurrent
 * run shares one runtime or starts its own.
 *
 * Why this is read twice per run rather than once (đo 25/08/2026): the reading
 * is not stable. `sessionRuntime.mode` came back `direct` at 21:47 and `shared`
 * at 22:05 with nothing dispatched in between -- the broker had come up on its
 * own. A single pre-run reading describes a machine that no longer exists by
 * the time the jobs land, which is why the manifest stores `atDispatch` and
 * `atSettle` and never a single value.
 *
 * Two independent sources, deliberately:
 *
 *   1. The companion's own `setup --json` (`sessionRuntime.mode`). This is the
 *      runtime answering about itself, so it is the authority. Measured cost
 *      0.45-0.52s, paid twice per run.
 *   2. `broker.json` under the plugin's state directory. Free to read, and it
 *      carries the broker pid -- which the companion's answer does not -- so it
 *      is what distinguishes a live broker from a stale file.
 *
 * The state directory name is `{basename}-{sha256(abspath)[:16]}`, confirmed
 * against the live path on 25/08. That is the plugin's private scheme, so the
 * file is treated as corroboration that may vanish, never as the primary
 * answer: if the plugin renames its state layout, `mode` still comes back
 * correct from the companion and only `brokerPid` goes null.
 *
 * Nothing in here throws. A probe is a diagnostic, and a diagnostic that can
 * break a dispatch is worse than no diagnostic -- every failure lands in the
 * returned `errors` array instead.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { resolveCompanion } from "./codex-companion-path.mjs";

const COMPANION_TIMEOUT_MS = 15_000;
const PS_TIMEOUT_MS = 10_000;

/** Modes the probe is allowed to report. `unknown` is a real answer, not a gap. */
export const RUNTIME_MODES = new Set(["shared", "direct", "unknown"]);

/**
 * Where the plugin keeps this workspace's broker record.
 *
 * Exported so a test can point at a temp home instead of the real one.
 */
export function brokerStatePath(workspace, home = homedir()) {
  const abs = resolve(workspace);
  const digest = createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return join(home, ".claude", "plugins", "data", "codex-inline", "state",
    `${basename(abs)}-${digest}`, "broker.json");
}

/** True when a pid names a process that exists right now. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 asks the kernel about the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else -- still alive.
    return err?.code === "EPERM";
  }
}

/**
 * What `broker.json` says, and whether the process it names is still there.
 *
 * A broker file with an endpoint and a dead pid is the trap this guards: the
 * file outlives the process, so "file has an endpoint" alone would report
 * `shared` for a runtime that is gone.
 */
export function readBrokerFile(workspace, { home = homedir() } = {}) {
  // Inside the try, not before it. `brokerStatePath` calls `resolve()`, which
  // throws a TypeError on a missing workspace -- and a throw here escapes the
  // whole never-throws contract before any `errors` array can carry it. A CLI
  // typo (`--workspace` with no value) was enough to reach it.
  let path = null;
  try {
    path = brokerStatePath(workspace, home);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const pid = Number.isInteger(raw?.pid) ? raw.pid : null;
    return {
      path,
      present: true,
      hasEndpoint: typeof raw?.endpoint === "string" && raw.endpoint.length > 0,
      pid,
      alive: pid === null ? null : pidAlive(pid),
      error: null,
    };
  } catch (err) {
    // Missing is the ordinary case, not a fault: no broker has been started.
    const missing = err?.code === "ENOENT";
    return {
      path, present: false, hasEndpoint: false, pid: null, alive: null,
      error: missing ? null : `không đọc được broker.json: ${err.message}`,
    };
  }
}

/**
 * How many app-servers are up, and which of them belong to this workspace.
 *
 * A raw count is the wrong number (đo 25/08/2026). Five matching processes were
 * live on this machine at once and only three were ours:
 *
 *   18224  ChatGPT.app's own app-server
 *   55831  the VS Code extension's app-server
 *   65720  the plugin broker (app-server-broker.mjs), ppid 1
 *   65736  node wrapper `codex app-server`, child of the broker
 *   65737  the native binary, child of 65736
 *
 * So an unqualified count is a number that changes when the user opens VS Code,
 * which makes it useless as run evidence. Servers are attributed instead: ours
 * are the ones whose ancestry reaches the broker, and everything else is
 * reported separately as foreign rather than silently added in.
 *
 * Two more distinctions the count has to make:
 *
 *   - The broker is not an app-server. Its command line contains the substring,
 *     but it is the process that owns servers, so counting it inflates ours by
 *     exactly one.
 *   - One app-server is two processes: the node wrapper and the native binary
 *     it spawns. A matching process whose parent also matches is the child, so
 *     servers are the ones whose parent is outside the set.
 *
 * `ps -Ao pid,ppid,command` only -- `pgrep -fc` does not exist on this macOS
 * and a probe must not depend on a flag that differs per platform.
 */
export function countAppServers({ psOutput = null, brokerPid = null } = {}) {
  let text = psOutput;
  if (text === null) {
    const proc = spawnSync("ps", ["-Ao", "pid,ppid,command"], {
      encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
    });
    if (proc.error || proc.status !== 0) {
      return {
        servers: null, foreign: null, processes: null, pids: [], foreignPids: [],
        error: `ps thất bại: ${proc.error?.message ?? `exit ${proc.status}`}`,
      };
    }
    text = String(proc.stdout ?? "");
  }

  // Full parent map, not just matching rows: attribution has to walk up through
  // processes that are not themselves app-servers to reach the broker.
  const parent = new Map();
  const rows = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const cmd = m[3];
    parent.set(pid, ppid);
    // `grep` itself matches the pattern it is searching for; so does this
    // probe's own command line when invoked with an --arg naming the runtime.
    if (cmd.includes("grep")) continue;
    // `app-server` has to END the token. `\b` alone also matches the first
    // half of `app-server-broker` and of any future `app-server-*` helper,
    // which would count a process that is not an app-server at all. The broker
    // is the instance this was measured on; the rule covers the whole family.
    if (!/\bapp-server(?![\w-])/.test(cmd)) continue;
    if (!/codex/.test(cmd)) continue;
    rows.push({ pid, ppid });
  }

  const seen = new Set(rows.map((r) => r.pid));
  const roots = rows.filter((r) => !seen.has(r.ppid)).map((r) => r.pid);

  /** True when walking up from pid reaches the broker. Bounded: pid 1 is the top. */
  const underBroker = (pid) => {
    if (!Number.isInteger(brokerPid)) return false;
    let cur = pid;
    for (let hops = 0; hops < 64; hops += 1) {
      const pp = parent.get(cur);
      if (pp === undefined || pp <= 1) return false;
      if (pp === brokerPid) return true;
      cur = pp;
    }
    return false;
  };

  const ours = roots.filter((pid) => underBroker(pid));
  const foreign = roots.filter((pid) => !underBroker(pid));
  return {
    servers: ours.length, pids: ours,
    foreign: foreign.length, foreignPids: foreign,
    processes: rows.length, error: null,
  };
}

/** Companion job states that mean the work has not stopped yet. */
export const COMPANION_ACTIVE = new Set(["queued", "running"]);

/**
 * Companion job states that mean the work has genuinely stopped.
 *
 * An allowlist, not the complement of COMPANION_ACTIVE, and that is the whole
 * point: only a word measured to mean "finished" may justify failing a job.
 * The vocabulary measured against companion 1.0.5 is queued / running /
 * completed / failed / cancelled, so anything outside both sets is a word this
 * code has never seen -- read as "wait", never as "settled".
 */
export const COMPANION_TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * Ask the companion what became of one job it was given.
 *
 * This is what lets reconcile answer the question it has always refused to
 * answer. Its own docstring says a job with no evidence is left alone "because
 * only the dispatcher knows whether the runtime is still up" -- true when the
 * only inputs were the manifest and the filesystem. With the job id recorded at
 * dispatch, the runtime can be asked directly, so the knowledge reconcile was
 * missing is now available to it rather than the rule being relaxed.
 *
 * Measured on 25/08/2026, and two of these were not what the plan assumed:
 *
 *   - An unknown id exits 1 and prints plain text, not JSON. Detection is by
 *     exit code; parsing the message would be reading an error string.
 *   - A job from seven hours earlier was still retrievable by id, while
 *     `status --all` listed nothing at all. So "absent from the job list" is not
 *     evidence of anything, and `result <id>` is the only usable oracle.
 *   - A running job carries a live pid; a finished one has `pid: null`. That is
 *     what makes "the runtime says running but its process is gone" a safe
 *     orphan test rather than a way to kill live work.
 *
 * `alive` is deliberately three-valued. `null` means the question could not be
 * answered, and a caller must not read that as dead.
 */
export function probeCompanionJob(jobId, { workspace, timeoutMs = COMPANION_TIMEOUT_MS } = {}) {
  let companion;
  try {
    companion = resolveCompanion();
  } catch (err) {
    return { known: null, status: null, pid: null, alive: null, error: `không tìm thấy companion: ${err.message}` };
  }
  const proc = spawnSync(process.execPath, [companion, "result", jobId, "--json", "--cwd", workspace], {
    cwd: workspace, encoding: "utf8", timeout: timeoutMs,
    env: { ...process.env, MWG_CREW_ROLE: "worker" },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (proc.error) {
    return { known: null, status: null, pid: null, alive: null, error: `companion result thất bại: ${proc.error.message}` };
  }
  if (proc.status !== 0) {
    // Exit 1 with "No job found" is the companion answering, not failing: it
    // has no record of this id. Anything else is an unknown failure, and the
    // difference matters -- one is a verdict, the other is no answer at all.
    const tail = `${String(proc.stdout ?? "")}${String(proc.stderr ?? "")}`.trim().slice(0, 300);
    if (/no job found/i.test(tail)) return { known: false, status: null, pid: null, alive: null, error: null };
    return { known: null, status: null, pid: null, alive: null, error: `companion result exit ${proc.status}: ${tail || "không có stderr"}` };
  }

  const raw = String(proc.stdout ?? "");
  for (const text of [raw, raw.slice(raw.indexOf("{"))]) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { continue; }
    const job = parsed?.job ?? {};
    const pid = Number.isInteger(job.pid) ? job.pid : null;
    return {
      known: true,
      status: typeof job.status === "string" ? job.status : null,
      phase: typeof job.phase === "string" ? job.phase : null,
      pid,
      alive: pid === null ? null : pidAlive(pid),
      error: null,
    };
  }
  return { known: null, status: null, pid: null, alive: null, error: "companion result không in ra JSON" };
}

/** The companion's own answer about the runtime it is on. */
function askCompanion(workspace) {
  let companion;
  try {
    companion = resolveCompanion();
  } catch (err) {
    return { mode: null, label: null, error: `không tìm thấy companion: ${err.message}` };
  }
  const proc = spawnSync(process.execPath, [companion, "setup", "--json", "--cwd", workspace], {
    cwd: workspace, encoding: "utf8", timeout: COMPANION_TIMEOUT_MS,
    // Same recursion guard the adapters use: anything the companion spawns
    // inherits this and reads the crew skill as a worker.
    env: { ...process.env, MWG_CREW_ROLE: "worker" },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (proc.error || proc.status !== 0) {
    return { mode: null, label: null, error: `companion setup thất bại: ${proc.error?.message ?? `exit ${proc.status}`}` };
  }
  const raw = String(proc.stdout ?? "");
  for (const text of [raw, raw.slice(raw.indexOf("{"))]) {
    try {
      const sr = JSON.parse(text)?.sessionRuntime ?? {};
      const mode = RUNTIME_MODES.has(sr.mode) ? sr.mode : null;
      return { mode, label: typeof sr.label === "string" ? sr.label : null, error: null };
    } catch { /* try the next shape */ }
  }
  return { mode: null, label: null, error: "companion setup không in ra JSON" };
}

/**
 * One reading of the runtime. Never throws.
 *
 * `source` says which of the two inputs produced `mode`, so a later reader can
 * tell an authoritative answer from a fallback guess without re-deriving it.
 */
export function probeRuntime({ workspace, home = homedir(), skipCompanion = false } = {}) {
  const at = new Date().toISOString();
  const errors = [];

  // One place to make the never-throws contract true at the input boundary. A
  // missing workspace used to reach `resolve()` and `spawnSync()` as undefined,
  // both of which throw a TypeError -- so the probe died instead of reporting.
  // Falling back to cwd keeps the reading available and says so out loud.
  let ws = workspace;
  if (typeof ws !== "string" || ws.length === 0) {
    ws = process.cwd();
    errors.push(`workspace không hợp lệ, đọc theo cwd: ${ws}`);
  }

  const broker = readBrokerFile(ws, { home });
  if (broker.error) errors.push(broker.error);

  // Attribution needs the broker pid, so the broker file is read first even
  // though the companion is the authority on `mode`.
  const servers = countAppServers({ brokerPid: broker.pid });
  if (servers.error) errors.push(servers.error);

  let mode = "unknown";
  let source = null;
  let label = null;

  if (!skipCompanion) {
    const asked = askCompanion(ws);
    if (asked.error) errors.push(asked.error);
    if (asked.mode) { mode = asked.mode; source = "companion"; label = asked.label; }
  }

  if (source === null) {
    // Fallback: a broker is only shared if the process behind it answers.
    if (broker.present && broker.hasEndpoint && broker.alive === true) { mode = "shared"; source = "broker-file"; }
    else if (broker.present || servers.servers === 0) { mode = "direct"; source = "broker-file"; }
  }

  return {
    at, mode, source, label,
    appServers: servers.servers,
    appServerPids: servers.pids,
    foreignAppServers: servers.foreign,
    foreignAppServerPids: servers.foreignPids,
    appServerProcesses: servers.processes,
    brokerPid: broker.pid,
    brokerAlive: broker.alive,
    brokerPath: broker.path,
    errors: errors.length ? errors : null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const wsFlag = args.indexOf("--workspace");
  const workspace = wsFlag >= 0 ? args[wsFlag + 1] : process.cwd();
  const r = probeRuntime({ workspace, skipCompanion: args.includes("--no-companion") });
  if (args.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`runtime: ${r.mode}${r.source ? ` (theo ${r.source})` : ""}${r.label ? ` — ${r.label}` : ""}`);
    console.log(`app-server của ta: ${r.appServers ?? "?"}${r.appServerPids.length ? ` (pid ${r.appServerPids.join(", ")})` : ""}`);
    console.log(`app-server ngoài: ${r.foreignAppServers ?? "?"}${r.foreignAppServerPids.length ? ` (pid ${r.foreignAppServerPids.join(", ")})` : ""} — ChatGPT.app / VS Code, không tính vào run`);
    console.log(`broker: pid ${r.brokerPid ?? "không có"}${r.brokerAlive === null ? "" : r.brokerAlive ? " (còn sống)" : " (đã chết — file cũ)"}`);
    for (const e of r.errors ?? []) console.log(`  ! ${e}`);
  }
}
