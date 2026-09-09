#!/usr/bin/env node
/**
 * Find the running Antigravity app and everything needed to talk to it.
 *
 * Nothing here is written down by the app in a stable file, so every value is
 * discovered live from the running process and cached in memory keyed by that
 * process pid. The app restarts, the pid changes, discovery runs again.
 *
 * Discovery order:
 *   1. Find the app's language_server process -- NOT the IDE's -- and read the
 *      --csrf_token out of its command line.
 *   2. Take the agentapi entrypoint from that same command line. `agentapi` is
 *      a subcommand of the language_server binary, and the binary's absolute
 *      path is argv[0] of the process we just found.
 *   3. Ask the OS which loopback port that pid listens on. There are usually
 *      several; only one speaks gRPC.
 *   4. Probe each candidate port with get-conversation-metadata until one
 *      answers. That is the address.
 *   5. Read projectId off the newest conversation bound to this workspace.
 *      agentapi rejects new-conversation without it.
 *
 * Step 2 is why this module has no install path in it. The original took
 * agentapi from `~/.gemini/antigravity/bin/agentapi`, which on macOS is a
 * 100-byte `#!/bin/sh` wrapper that execs
 * `/Applications/Antigravity.app/Contents/Resources/bin/language_server
 * agentapi "$@"` -- a POSIX shebang and a macOS-only absolute path, i.e. two
 * separate reasons it can never run on Windows. Reading argv[0] of the process
 * that must already be running is not a workaround for that; it is a better
 * answer on both platforms, because it can only ever name the binary actually
 * serving this app rather than whichever install a path happened to point at.
 *
 * Every step fails loud with the reason and the remedy. A half-resolved
 * environment must never be returned: agentapi's failure mode for a missing
 * value is an opaque gRPC error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isWindows } from "../platform.mjs";
import { listProcesses, listeningPorts } from "../os-probe.mjs";

const PROBE_TIMEOUT_MS = 15_000;

/** How many of the newest conversations to ask for a projectId. See findProjectId. */
const PROJECT_SCAN_LIMIT = 60;

/** The conversation store. The one path the app does keep in a fixed place. */
export function appStore(env = process.env, home = homedir()) {
  return env.AGENT_CREW_ANTIGRAVITY_STORE || join(home, ".gemini", "antigravity");
}

export function conversationsDir(env = process.env, home = homedir()) {
  return join(appStore(env, home), "conversations");
}

export class AntiEnvError extends Error {
  constructor(message, remedy) {
    super(remedy ? `${message}\n  → ${remedy}` : message);
    this.name = "AntiEnvError";
    this.remedy = remedy;
  }
}

const cache = new Map();

/**
 * The executable of a command line, as a path.
 *
 * Must be the first token specifically, not a substring of the whole line. Any
 * process whose arguments mention `language_server` -- a grep, an editor, this
 * module's own test -- matches a substring search, and the app's csrf token is
 * not something to go looking for in the wrong process. Measured while building
 * this: a substring match returned three processes on a machine running one
 * app, and two of them were the probe itself.
 *
 * Windows quotes the executable when its path contains spaces, which is the
 * normal case under `C:\Program Files\`.
 */
export function executableOf(command) {
  const line = String(command).trim();
  if (line.startsWith('"')) {
    const end = line.indexOf('"', 1);
    if (end > 1) return line.slice(1, end);
  }
  return line.split(/\s+/, 1)[0] ?? "";
}

function basenameOf(path) {
  return String(path).split(/[\\/]/).pop() ?? "";
}

/** The app and the IDE both run language_server; only the app serves agentapi. */
function findAppLanguageServer() {
  const wanted = isWindows ? ["language_server.exe", "language_server"] : ["language_server"];
  const matches = listProcesses().filter(({ command }) => {
    if (!wanted.includes(basenameOf(executableOf(command)))) return false;
    // The app's own flags. `--subclient_type hub` is what separates the app's
    // server from the IDE's, and the app_data_dir boundary keeps a
    // `antigravity-nightly` style sibling from matching.
    return / --app_data_dir antigravity(?![\w-])/.test(command)
      && command.includes("--subclient_type hub");
  });

  if (matches.length === 0) {
    throw new AntiEnvError(
      "the Antigravity app is not running (no language_server with --subclient_type hub)",
      "open the Antigravity app, then retry -- or dispatch this job with transport headless",
    );
  }
  if (matches.length > 1) {
    throw new AntiEnvError(
      `found ${matches.length} Antigravity app language_server processes; cannot pick one`,
      "quit the extra Antigravity instances so exactly one remains",
    );
  }

  const { pid, command } = matches[0];
  const csrf = command.match(/--csrf_token[\s=]+(\S+)/)?.[1];
  const exe = executableOf(command);
  if (!csrf) {
    throw new AntiEnvError(
      `the Antigravity language_server (pid ${pid}) has no --csrf_token argument`,
      "restart the Antigravity app",
    );
  }
  if (!exe || !existsSync(exe)) {
    throw new AntiEnvError(
      `the Antigravity language_server (pid ${pid}) reports an executable that is not there: ${exe || "<empty>"}`,
      "restart the Antigravity app; if this persists set AGENT_CREW_AGENTAPI to the language_server binary",
    );
  }
  return { pid, csrf, exe };
}

/**
 * How to invoke agentapi: a file plus the arguments that come before the
 * caller's.
 *
 * An explicit override may name either an agentapi entrypoint or the
 * language_server binary itself; the basename decides which, so a Windows user
 * pointing at `language_server.exe` does not also have to know that agentapi is
 * a subcommand of it.
 */
function agentapiInvocation(exe, env = process.env) {
  const override = env.AGENT_CREW_AGENTAPI;
  if (override) {
    if (!existsSync(override)) {
      throw new AntiEnvError(
        "AGENT_CREW_AGENTAPI points at nothing",
        `probed: ${override}\n     fix it, or unset it to use the running app's own binary`,
      );
    }
    const base = basenameOf(override).replace(/\.exe$/i, "");
    return { file: override, prefixArgs: base === "language_server" ? ["agentapi"] : [] };
  }
  return { file: exe, prefixArgs: ["agentapi"] };
}

function newestConversationIds(env = process.env, home = homedir()) {
  const dir = conversationsDir(env, home);
  if (!existsSync(dir)) {
    throw new AntiEnvError(
      `no conversation store at ${dir}`,
      "open one chat in the Antigravity app so a conversation exists to probe with",
    );
  }
  const dbs = readdirSync(dir)
    .filter((name) => name.endsWith(".db"))
    .map((name) => ({ id: name.slice(0, -3), mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (dbs.length === 0) {
    throw new AntiEnvError(
      "the Antigravity conversation store is empty",
      "open one chat in the Antigravity app so a conversation exists to probe with",
    );
  }
  return dbs.map((d) => d.id);
}

/** One agentapi call. No shell, no concatenation: argv is passed as argv. */
export function callAgentapi(invocation, args, { env, cwd, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return execFileSync(invocation.file, [...invocation.prefixArgs, ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

function probeMetadata(invocation, conversationId, address, csrf) {
  const raw = callAgentapi(invocation, ["get-conversation-metadata", conversationId], {
    env: {
      ANTIGRAVITY_LS_ADDRESS: address,
      ANTIGRAVITY_CSRF_TOKEN: csrf,
      ANTIGRAVITY_SIDECAR_WEB_PORT: "0",
    },
  });
  return JSON.parse(raw);
}

function findGrpcAddress(invocation, ports, csrf, probeId) {
  const failures = [];
  for (const port of ports) {
    const address = `127.0.0.1:${port}`;
    try {
      const parsed = probeMetadata(invocation, probeId, address, csrf);
      if (parsed?.response?.conversationMetadata) return address;
    } catch (err) {
      failures.push(`${address}: ${String(err.stderr || err.message).split("\n")[0].slice(0, 120)}`);
    }
  }
  throw new AntiEnvError(
    `none of the app's listening ports answered agentapi (tried ${ports.join(", ") || "none"})`,
    `port probe results:\n     ${failures.join("\n     ") || "no ports to probe"}`,
  );
}

/**
 * agentapi requires a projectId whenever project_env_config is sent, and the
 * only place a valid one exists is a conversation already bound to this repo.
 */
function findProjectId(invocation, workspace, address, csrf, ids) {
  const wanted = resolve(workspace);
  // One agentapi call per conversation, so the scan is capped rather than
  // exhaustive. Measured on a store of 342 conversations: finding a bound
  // workspace took 0.2s because the match is near the top of an
  // mtime-ordered list, while an unbound workspace scanned every one of them
  // and took 14s to say "open the folder in the app". That cost grows with the
  // store forever, for an answer the cap does not change: a workspace whose
  // newest binding is 60 conversations old is a workspace nobody is working
  // in. The error below reports what was actually scanned, so a capped miss
  // never reads as a definitive one.
  const scanned = ids.slice(0, PROJECT_SCAN_LIMIT);
  for (const id of scanned) {
    let meta;
    try {
      meta = probeMetadata(invocation, id, address, csrf)?.response?.conversationMetadata?.metadata;
    } catch {
      continue;
    }
    if (!meta?.projectId) continue;
    const bound = (meta.workspaceUris ?? []).some((uri) => {
      const path = uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
      // Windows file URIs carry a leading slash before the drive letter.
      const cleaned = isWindows ? path.replace(/^\/(?=[A-Za-z]:)/, "") : path;
      return resolve(cleaned) === wanted;
    });
    if (bound) return { projectId: meta.projectId, sourceConversationId: id };
  }
  const of = ids.length > scanned.length ? ` (scanned the ${scanned.length} newest of ${ids.length})` : "";
  throw new AntiEnvError(
    `no existing Antigravity conversation is bound to ${wanted}${of}`,
    "open this folder in the Antigravity app and start one chat there, then retry",
  );
}

/**
 * Everything app mode needs, or an AntiEnvError with a remedy.
 *
 * Returns { pid, csrf, address, projectId, sourceConversationId, invocation,
 * env } where `env` is ready to spread into a child process.
 */
export function resolveAntiEnv(workspace, { refresh = false, env = process.env, home = homedir() } = {}) {
  const { pid, csrf, exe } = findAppLanguageServer();
  const key = `${pid}:${resolve(workspace)}`;
  if (!refresh && cache.has(key)) return cache.get(key);

  const invocation = agentapiInvocation(exe, env);
  const ports = listeningPorts(pid);
  if (ports.length === 0) {
    throw new AntiEnvError(
      `the Antigravity app (pid ${pid}) is not listening on any loopback port`,
      "the app may still be starting up; wait a few seconds and retry",
    );
  }
  const ids = newestConversationIds(env, home);
  const address = findGrpcAddress(invocation, ports, csrf, ids[0]);
  const { projectId, sourceConversationId } = findProjectId(invocation, workspace, address, csrf, ids);

  const resolved = {
    pid,
    csrf,
    address,
    projectId,
    sourceConversationId,
    invocation,
    store: appStore(env, home),
    env: {
      ANTIGRAVITY_LS_ADDRESS: address,
      ANTIGRAVITY_CSRF_TOKEN: csrf,
      ANTIGRAVITY_SIDECAR_WEB_PORT: "0",
      ANTIGRAVITY_PROJECT_ID: projectId,
    },
  };
  cache.set(key, resolved);
  return resolved;
}

/** Reset the discovery cache. Tests need this; nothing else should. */
export function clearAntiEnvCache() {
  cache.clear();
}
