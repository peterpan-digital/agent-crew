#!/usr/bin/env node
/**
 * Discover the runtime environment needed to talk to the Antigravity 2.0 app
 * via its first-party `agentapi` binary.
 *
 * Nothing here is configured or persisted by Antigravity in a stable file, so
 * every value is discovered live from the running process and then cached in
 * memory keyed by that process pid. If the app restarts, the pid changes and
 * discovery runs again.
 *
 * Discovery order:
 *   1. Find the app's language_server process (NOT the IDE's) and read its
 *      --csrf_token from the command line.
 *   2. Ask lsof which localhost port that pid is listening on. There are
 *      usually several; only one speaks gRPC.
 *   3. Pick any existing conversation id to use as a harmless read-only probe.
 *   4. Probe each candidate port with get-conversation-metadata until one
 *      answers. That is ANTIGRAVITY_LS_ADDRESS.
 *   5. Read projectId off the newest conversation whose workspaceUris contain
 *      the target workspace. agentapi rejects new-conversation without it.
 *
 * Every step fails loud with the reason and the remedy. A half-resolved
 * environment must never be returned, because agentapi's failure mode for a
 * missing value is an opaque gRPC error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const APP_STORE = join(homedir(), ".gemini", "antigravity");
const AGENTAPI = join(APP_STORE, "bin", "agentapi");
const CONVERSATIONS = join(APP_STORE, "conversations");
const PROBE_TIMEOUT_MS = 15_000;

class AntiEnvError extends Error {
  constructor(message, remedy) {
    super(remedy ? `${message}\n  → ${remedy}` : message);
    this.name = "AntiEnvError";
    this.remedy = remedy;
  }
}

const cache = new Map();

function sh(file, args) {
  return execFileSync(file, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
}

/** The app and the IDE both run `language_server`; only the app serves agentapi. */
function findAppLanguageServer() {
  let out;
  try {
    out = sh("/bin/ps", ["-Ao", "pid,command"]);
  } catch (err) {
    throw new AntiEnvError(`cannot list processes: ${err.message}`);
  }
  // Match on the executable itself, not on substrings anywhere in the line:
  // any shell running this script has these same strings in its own argv.
  const matches = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      const [pid, exe] = line.split(/\s+/, 2);
      if (!/^\d+$/.test(pid ?? "") || !exe) return false;
      if (exe.split("/").pop() !== "language_server") return false;
      return / --app_data_dir antigravity(?![\w-])/.test(line)
        && line.includes("--subclient_type hub");
    });

  if (matches.length === 0) {
    throw new AntiEnvError(
      "Antigravity 2.0 app is not running (no language_server with --subclient_type hub)",
      "open the Antigravity app, then retry",
    );
  }
  if (matches.length > 1) {
    throw new AntiEnvError(
      `found ${matches.length} Antigravity app language_server processes; cannot pick one`,
      "quit the extra Antigravity instances so exactly one remains",
    );
  }

  const line = matches[0];
  const pid = Number(line.split(/\s+/, 1)[0]);
  const csrf = line.match(/--csrf_token\s+(\S+)/)?.[1];
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new AntiEnvError("could not parse the language_server pid");
  }
  if (!csrf) {
    throw new AntiEnvError(
      `language_server pid ${pid} has no --csrf_token argument`,
      "restart the Antigravity app",
    );
  }
  return { pid, csrf };
}

/** `-a` is required: without it lsof ORs -p and -i and returns other processes. */
function listeningPorts(pid) {
  let out;
  try {
    out = sh("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-i"]);
  } catch (err) {
    throw new AntiEnvError(
      `lsof failed for pid ${pid}: ${err.message}`,
      "check that lsof is available at /usr/sbin/lsof",
    );
  }
  const ports = new Set();
  for (const line of out.split("\n")) {
    if (!line.includes("(LISTEN)")) continue;
    const port = line.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/)?.[1];
    if (port) ports.add(Number(port));
  }
  if (ports.size === 0) {
    throw new AntiEnvError(
      `pid ${pid} is not listening on any 127.0.0.1 port`,
      "the app may still be starting up; wait a few seconds and retry",
    );
  }
  return [...ports];
}

function newestConversationId() {
  if (!existsSync(CONVERSATIONS)) {
    throw new AntiEnvError(
      `no conversation store at ${CONVERSATIONS}`,
      "open one chat in the Antigravity app so a conversation exists to probe with",
    );
  }
  const dbs = readdirSync(CONVERSATIONS)
    .filter((name) => name.endsWith(".db"))
    .map((name) => ({ id: name.slice(0, -3), mtime: statSync(join(CONVERSATIONS, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (dbs.length === 0) {
    throw new AntiEnvError(
      "the Antigravity conversation store is empty",
      "open one chat in the Antigravity app so a conversation exists to probe with",
    );
  }
  return dbs[0].id;
}

function probeMetadata(conversationId, address, csrf) {
  const raw = execFileSync(AGENTAPI, ["get-conversation-metadata", conversationId], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    env: {
      ...process.env,
      ANTIGRAVITY_LS_ADDRESS: address,
      ANTIGRAVITY_CSRF_TOKEN: csrf,
      ANTIGRAVITY_SIDECAR_WEB_PORT: "0",
    },
  });
  return JSON.parse(raw);
}

function findGrpcAddress(ports, csrf, probeId) {
  const failures = [];
  for (const port of ports) {
    const address = `127.0.0.1:${port}`;
    try {
      const parsed = probeMetadata(probeId, address, csrf);
      if (parsed?.response?.conversationMetadata) return { address, probe: parsed };
    } catch (err) {
      failures.push(`${address}: ${String(err.stderr || err.message).split("\n")[0].slice(0, 120)}`);
    }
  }
  throw new AntiEnvError(
    `none of the app's listening ports answered agentapi (tried ${ports.join(", ")})`,
    `port probe results:\n     ${failures.join("\n     ")}`,
  );
}

/**
 * agentapi requires a projectId whenever project_env_config is sent, and the
 * only place a valid one exists is a conversation already bound to this repo.
 */
function findProjectId(workspace, address, csrf) {
  const wanted = resolve(workspace);
  const dbs = readdirSync(CONVERSATIONS)
    .filter((name) => name.endsWith(".db"))
    .map((name) => ({ id: name.slice(0, -3), mtime: statSync(join(CONVERSATIONS, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const { id } of dbs) {
    let meta;
    try {
      meta = probeMetadata(id, address, csrf)?.response?.conversationMetadata?.metadata;
    } catch {
      continue;
    }
    if (!meta?.projectId) continue;
    const uris = meta.workspaceUris ?? [];
    const bound = uris.some((uri) => {
      const path = uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
      return resolve(path) === wanted;
    });
    if (bound) return { projectId: meta.projectId, sourceConversationId: id };
  }
  throw new AntiEnvError(
    `no existing Antigravity conversation is bound to ${wanted}`,
    "open this folder in the Antigravity app and start one chat there, then retry",
  );
}

/**
 * Returns { pid, csrf, address, projectId, env } where `env` is ready to spread
 * into a child process. Throws AntiEnvError with a remedy on any failure.
 */
export function resolveAntiEnv(workspace, { refresh = false } = {}) {
  if (!existsSync(AGENTAPI)) {
    throw new AntiEnvError(
      `agentapi not found at ${AGENTAPI}`,
      "install/update the Antigravity app; agentapi ships inside it",
    );
  }
  const { pid, csrf } = findAppLanguageServer();
  const key = `${pid}:${resolve(workspace)}`;
  if (!refresh && cache.has(key)) return cache.get(key);

  const ports = listeningPorts(pid);
  const { address } = findGrpcAddress(ports, csrf, newestConversationId());
  const { projectId, sourceConversationId } = findProjectId(workspace, address, csrf);

  const resolved = {
    pid,
    csrf,
    address,
    projectId,
    sourceConversationId,
    agentapi: AGENTAPI,
    store: APP_STORE,
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

export { AntiEnvError, APP_STORE, AGENTAPI, CONVERSATIONS };

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspace = process.argv[2] || process.cwd();
  try {
    const r = resolveAntiEnv(workspace);
    // Secrets stay out of stdout: the csrf token is a live credential.
    console.log(JSON.stringify({
      pid: r.pid,
      address: r.address,
      projectId: r.projectId,
      sourceConversationId: r.sourceConversationId,
      csrf: `<redacted:${r.csrf.length} chars>`,
      workspace: resolve(workspace),
    }, null, 2));
  } catch (err) {
    console.error(`anti-env: ${err.message}`);
    process.exit(1);
  }
}
