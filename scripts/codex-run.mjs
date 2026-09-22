#!/usr/bin/env node
/**
 * Run one Codex job under the same contract as anti-run.mjs.
 *
 * Why this exists: Codex was the only runtime in the crew without an adapter.
 * It was dispatched through the plugin's rescue subagent, which is defined as a
 * forwarder -- it may not poll, monitor, or fetch results -- so a Codex job had
 * no timeout, no evidence gate, and nothing that recorded its outcome. On
 * 2026-08-24 a Codex job died two minutes in; its manifest entry carried no
 * failure field at all and the death was noticed twenty minutes later.
 *
 * Everything below exists so that a job which dies cannot be silent:
 *   - settle on `exit`, not `close`. A model-generated shell command can leave a
 *     grandchild holding stdout, and `close` waits for every pipe to reach EOF:
 *     measured 6s late on a trivial case, unbounded in the general one. A child
 *     killed while a grandchild keeps the pipe open never fires `close` at all,
 *     which would hang past every timeout with the manifest stuck on "pending" --
 *     the exact shape of the failure this adapter was written to catch.
 *   - kill the process group, not the pid, so that grandchild goes too.
 *   - an idle watchdog on stdout events, because the observed death was a
 *     process that stopped producing events while its state still read running.
 *   - a manifest write on the success path, the failure path, and every error
 *     path in between. An unrecorded crash reads as "pending" forever.
 *
 * The prompt goes in on stdin rather than argv: a brief is a file, and argv has
 * a length limit that a long brief can reach.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { resolveCompanion } from "./codex-companion-path.mjs";
// Static, unlike the `await import` calls further down: a signal handler runs
// with no chance to await, so the one write it needs has to be resolved before
// the signal ever arrives.
import { updateJob as updateJobSync } from "./crew-manifest.mjs";
import {
  DEFAULT_TIMEOUT,
  GuardError,
  assertEvidenceAbsent,
  judgeJob,
  parseDuration,
  readPrompt,
  appendWorkerContract,
  snapshotCredentialStore,
  diffCredentialStore,
  isWatchBlind,
  displayCredentialDir,
  CREDENTIAL_STORE_DIR,
  validateEvidencePath,
  workerEnv,
} from "./crew-guards.mjs";

/** A job that emits no stdout event for this long is treated as dead, not as thinking. */
const DEFAULT_IDLE_MS = 120_000;
/** Grace between SIGTERM and SIGKILL for the process group. */
const KILL_GRACE_MS = 5_000;
/** How long to keep draining stdout after the child has exited. */
const DRAIN_MS = 2_000;
/**
 * Per-write cap for the stream log. An event carrying a whole file read is both
 * the bulk of the log's size and the part most likely to hold something that
 * should not be written down; a truncated event still says what happened.
 */
const MAX_EVENT_BYTES = 8 * 1024;

/**
 * Measured 2026-08-24: `codex exec -c model_reasoning_effort=bogus` runs happily
 * and exits 0 -- codex ignores a value it does not know instead of rejecting it.
 * So this list is the only thing standing between a typo and a job that quietly
 * ran at the wrong effort. It is deliberately the union of every value seen in
 * codex and plugin documentation: a false rejection is louder and cheaper than a
 * silent downgrade.
 */
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const KNOWN_FLAGS = new Set([
  "prompt", "promptFile", "evidence", "workspace", "timeout", "idle",
  "model", "effort", "manifest", "job", "mode", "workspaceCli",
]);

/** `--workspace-cli` is opt-in: most jobs have no business holding a live token. */
const WORKSPACE_CLI_VALUES = new Set(["on", "off"]);

/**
 * Opt-in rather than always-on, which is a deliberate departure from the plan's
 * "mint before every spawn". A token read the owner's whole Workspace -- mail,
 * Drive, Sheets -- so a job that only refactors a script has no reason to carry
 * one. Least privilege costs the dispatcher one flag.
 */
function resolveWorkspaceCli(options) {
  const raw = options.workspaceCli;
  if (raw === undefined) return false;
  if (!WORKSPACE_CLI_VALUES.has(raw)) {
    throw new CodexRunError(
      `unknown --workspace-cli value "${raw}"`,
      `use one of: ${[...WORKSPACE_CLI_VALUES].join(", ")}`,
    );
  }
  return raw === "on";
}

/**
 * Where the Workspace CLI credential store lives.
 *
 * Re-exported from crew-guards rather than recomputed: this file used to carry
 * its own copy of the same expression, and the guard that fingerprints the
 * store has to watch the directory the token is actually minted from. Two
 * copies drift, and the drift is silent.
 */
const WORKSPACE_CLI_CONFIG_DIR = CREDENTIAL_STORE_DIR;

/**
 * Mints a short-lived Workspace access token for a job that asked for one.
 *
 * Measured 18/09: `codex exec` runs under a Seatbelt profile that denies writes
 * outside the workspace, and the CLI rewrites its token cache on every refresh
 * -- so a worker whose cached token had already expired hit a 401 it could not
 * recover from, and the job read as BLOCKED. Handing it a token through the env
 * skips the refresh entirely: the token env var outranks the cache, so the
 * worker reads the credential store and writes nothing back to it.
 *
 * Only the access token crosses the boundary. The refresh token and the client
 * secret stay in this process -- a worker holding those could mint tokens long
 * after its job ended.
 *
 * Also measured that day: the token lives 3599s and the grant returns no new
 * refresh token, so minting one per job neither rotates the owner's credential
 * nor races the other jobs. The crew ceiling is 30m (MAX_TIMEOUT_MS), well
 * inside that hour, which is why there is no expiry handling here.
 */
async function mintWorkspaceToken() {
  let creds;
  try {
    const raw = execFileSync("gws", ["auth", "export", "--unmasked"], {
      encoding: "utf8",
      env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: WORKSPACE_CLI_CONFIG_DIR },
      timeout: 30_000,
    });
    // The CLI prints "Using keyring backend: ..." ahead of the JSON.
    creds = JSON.parse(raw.slice(raw.indexOf("{")));
  } catch (err) {
    throw new CodexRunError(
      "could not read the Workspace credentials needed to mint a token",
      `${String(err.message).split("\n")[0]} -- check the store with: auth status`,
    );
  }
  for (const field of ["client_id", "client_secret", "refresh_token"]) {
    if (!creds?.[field]) {
      throw new CodexRunError(
        `the Workspace credential store has no ${field}`,
        "the store looks incomplete; the owner has to re-authenticate",
      );
    }
  }

  let res;
  try {
    res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token,
        grant_type: "refresh_token",
      }),
    });
  } catch (err) {
    throw new CodexRunError("could not reach the Google token endpoint", err.message);
  }
  if (!res.ok) {
    // Status only, never the body: a refused grant echoes request fields back.
    throw new CodexRunError(
      `the Google token endpoint refused the refresh grant (HTTP ${res.status})`,
      "the refresh token may have been revoked; the owner has to re-authenticate",
    );
  }
  const token = (await res.json())?.access_token;
  if (!token) {
    throw new CodexRunError("the token endpoint returned no access_token", "nothing to hand the worker");
  }
  return token;
}

/** Same two words the manifest records, so the flag and the record cannot drift. */
const MODES = new Set(["headless", "app"]);

/**
 * The companion reports these while a job is still going. Anything else is a
 * settled job -- `completed`, `failed`, or `cancelled`.
 */
const COMPANION_ACTIVE = new Set(["queued", "running"]);

/** Slack on top of the job's own ceiling, so a hung companion still returns. */
const COMPANION_WAIT_SLACK_MS = 60_000;
/** Dispatch is a queue insert, not the job: it should answer in seconds. */
const COMPANION_DISPATCH_TIMEOUT_MS = 120_000;

/**
 * How long after dispatch the companion's job store is allowed to contradict
 * itself, and how often to re-ask inside that window.
 *
 * Measured 25/08/2026: two app jobs dispatched in the same instant both died
 * about fifteen seconds in, in two different ways -- one `status --wait` denied
 * the very id the dispatch had just returned, the other answered with a job
 * carrying no `status` at all. Staggering the two commands by five seconds made
 * both pass, so the condition is a race in the store and it settles on its own.
 *
 * The window is wall-clock rather than a plain attempt count, and that is the
 * load-bearing part: `status --wait` blocks until the job settles, so retrying
 * on attempts alone could turn one eight-minute wait into three. A call that
 * actually waited is already past this window and will not be retried.
 */
const SETTLE_RACE_WINDOW_MS = 45_000;
const SETTLE_RETRY_DELAY_MS = 3_000;
/**
 * `result` reads a finished job out of the companion's own store, so it is a
 * lookup, not work. Kept short and deliberately non-fatal: the reply text is a
 * record, and a job that already wrote valid evidence must not be failed for
 * losing it.
 */
const COMPANION_RESULT_TIMEOUT_MS = 30_000;
/** Same reasoning as MAX_EVENT_BYTES: a truncated reply still says what happened. */
const MAX_REPLY_BYTES = 32 * 1024;

class CodexRunError extends GuardError {
  constructor(message, detail) {
    super(message, detail);
    this.name = "CodexRunError";
  }
}

/** Captured before the job starts: a flag that changed under us makes codex fail. */
function codexVersion() {
  try {
    return execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

/**
 * The stream sidecar is written with appendFileSync rather than a WriteStream:
 * this script ends in process.exit(), which does not flush a WriteStream. A
 * measured 2999 of 3001 lines were lost that way -- and those lines are the
 * whole reason the sidecar exists.
 *
 * A sidecar write must never fail the job either. It is a debugging aid, and a
 * job whose work is done does not become a failure because a log line did not
 * land.
 */
function makeStreamWriter(streamPath) {
  let broken = null;
  return {
    write(text) {
      if (broken) return;
      try {
        const s = String(text);
        appendFileSync(
          streamPath,
          s.length > MAX_EVENT_BYTES ? `${s.slice(0, MAX_EVENT_BYTES)}…[crew: cắt ${s.length - MAX_EVENT_BYTES} byte]\n` : s,
        );
      } catch (err) {
        broken = err.message;
        process.stderr.write(`codex-run: stream log disabled (${err.message})\n`);
      }
    },
    note(text) {
      // Wrapped as JSONL so the file stays parseable, and so a Monitor tailing
      // the sidecar can see a kill -- which otherwise only ever appeared on this
      // adapter's own stderr, where a Monitor on the stream file cannot see it.
      this.write(`${JSON.stringify({ type: "crew.note", at: new Date().toISOString(), text })}\n`);
    },
    get broken() { return broken; },
  };
}

/**
 * Pulls the paths codex says it wrote out of one stream line.
 *
 * Measured 2026-08-25 on a real headless run: the patch tool reports itself as
 *   { type: "item.completed", item: { type: "file_change",
 *     changes: [{ path, kind: "add" | "update" | "delete" }] } }
 *
 * This is an authorship signal the write-scope gate otherwise has to guess at
 * from mtimes. It is deliberately a one-way one: a file codex names here is
 * certainly codex's, but a file it does not name may still be codex's, because
 * anything written by a shell command it ran never passes through the patch
 * tool. So the list confirms; it never clears.
 *
 * The substring test comes first so the common case -- a long command_execution
 * event -- is not run through JSON.parse for nothing.
 */
function collectFileChange(line, into) {
  if (!line || !line.includes("file_change")) return;
  let d;
  try { d = JSON.parse(line); } catch { return; }
  const changes = d?.item?.changes;
  if (d?.item?.type !== "file_change" || !Array.isArray(changes)) return;
  for (const c of changes) if (typeof c?.path === "string" && c.path) into.add(c.path);
}

/**
 * Where a job's raw log goes: the task's own `data/` folder, never next to the
 * evidence in `reports/`.
 *
 * The reason is that a task's `data/` folder is already ignored by git, for both
 * the flat and the work-item layout. Keeping the log beside the evidence meant
 * same fact -- "these two files are legitimate and must not be committed" --
 * had to be written in three places: gitignore patterns, a whitelist in the
 * skill's collect step, and an exception in the collect gate. One existing rule
 * replaces all three, and the manifest records the path so nothing has to guess
 * the name.
 */
export function resolveLogDir(evidenceAbs, workspace) {
  const rel = relative(workspace, evidenceAbs).split(sep);
  const i = rel.lastIndexOf("reports");
  // rel[i + 1] is the run folder; if it is the evidence file itself the job was
  // dispatched loose, without a run folder.
  const inRunFolder = i > 0 && i + 2 <= rel.length - 1;
  const owner = i > 0 ? rel.slice(0, i) : rel.slice(0, 2);
  const runName = inRunFolder ? rel[i + 1] : "loose";
  return join(workspace, ...owner, "data", "crew-logs", runName);
}

function buildArgs({ workspace, model, effort, lastMessagePath }) {
  const args = [
    "exec",
    "--json",                        // JSONL events: the heartbeat this adapter watches
    "-C", workspace,
    "--sandbox", "workspace-write",  // a worker writes inside the workspace, nowhere else
    // workspace-write denies network by default, and the explicit --sandbox flag
    // above outranks sandbox_mode in config.toml. Every network-bound job (GSC,
    // GA4, any crawl) returned BLOCKED with unresolvable DNS until this was set.
    "-c", "sandbox_workspace_write.network_access=true",
    "-o", lastMessagePath,
    "--color", "never",
  ];
  if (model) args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
  args.push("-");                    // read the prompt from stdin
  return args;
}

/**
 * Everything both transports need before either one spawns anything. Kept
 * deliberately small: the two paths share their inputs and their guards, not
 * their control flow, and pretending otherwise is how one transport's fix
 * quietly changes the other's behaviour.
 */
function prepareRun(options) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const evidenceAbs = validateEvidencePath(options.evidence, workspace);
  const promptText = appendWorkerContract(readPrompt(options), { evidenceAbs, workspace });
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const timeoutMs = parseDuration(timeout); // validates against the 30m ceiling
  const effort = options.effort ?? null;
  if (effort && !EFFORTS.has(effort)) {
    throw new CodexRunError(`unknown effort "${effort}"`, `use one of: ${[...EFFORTS].join(", ")}`);
  }

  assertEvidenceAbsent(evidenceAbs);

  // The log lives under the task's data/ folder (see resolveLogDir).
  const logDir = resolveLogDir(evidenceAbs, workspace);
  mkdirSync(logDir, { recursive: true });
  const base = evidenceAbs.split(sep).pop().replace(/\.md$/, "");
  return { workspace, evidenceAbs, promptText, timeout, timeoutMs, effort, logDir, base };
}

/**
 * Sidecars are asserted absent for the same reason the evidence is: a retry
 * after an idle-kill usually happens before any evidence was written, so
 * without this a second run appends into the first run's log and the two deaths
 * read as one.
 */
function assertSidecarsAbsent(paths) {
  for (const sidecar of paths) {
    if (existsSync(sidecar)) {
      throw new CodexRunError(
        `a sidecar from an earlier run is still there: ${sidecar}`,
        "use a fresh evidence path per attempt so two runs never share one log",
      );
    }
  }
}

export async function codexRun(options) {
  const {
    workspace, evidenceAbs, promptText, timeout, timeoutMs, effort, logDir, base,
  } = prepareRun(options);
  const idleMs = options.idle ? parseDuration(options.idle) : DEFAULT_IDLE_MS;

  // Minted before anything is spawned. A job that cannot get a token must fail
  // here with the reason, rather than spawn and let the worker walk into a 401
  // it has no way to read as "the dispatcher could not authenticate".
  const extraEnv = {};
  if (resolveWorkspaceCli(options)) {
    extraEnv.GOOGLE_WORKSPACE_CLI_TOKEN = await mintWorkspaceToken();
  }

  const streamPath = join(logDir, `${base}.codex-stream.jsonl`);
  const lastMessagePath = join(logDir, `${base}.codex-last-message.txt`);
  assertSidecarsAbsent([streamPath, lastMessagePath]);

  const version = codexVersion();
  const args = buildArgs({ workspace, model: options.model, effort, lastMessagePath });
  const stream = makeStreamWriter(streamPath);

  return new Promise((resolveRun, rejectRun) => {
    const startedAt = new Date();
    const child = spawn("codex", args, {
      cwd: workspace,
      // MWG_CREW_ROLE stops a worker reading the skill and dispatching further;
      // workerEnv also strips the vars a worker must never carry. See STRIPPED_ENV.
      env: workerEnv(extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so a kill reaches the shell commands codex spawns.
      // Killing only the pid leaves a grandchild holding stdout open.
      detached: true,
    });

    let events = 0;
    let residual = "";              // a chunk can split a line; count whole lines only
    const touched = new Set();      // paths codex says it wrote, from file_change events
    let nextHeartbeat = 25;
    let stderrTail = [];
    let killedFor = null;
    let idleTimer = null;
    let drainTimer = null;
    let hardTimer = null;
    let exited = null;
    let settled = false;

    const elapsed = () => Math.round((Date.now() - startedAt.getTime()) / 1000);
    const heartbeat = (note) => {
      // stderr on purpose: stdout carries the one JSON result the dispatcher
      // parses. The stream sidecar gets its own copy via stream.note().
      process.stderr.write(`codex-run: ${note} events=${events} t=${elapsed()}s\n`);
    };

    const signalGroup = (sig) => {
      try {
        process.kill(-child.pid, sig); // negative pid = the whole group
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };

    const kill = (reason) => {
      if (killedFor) return;
      killedFor = reason;
      heartbeat(`killing: ${reason}`);
      stream.note(`crew killed this job: ${reason}`);
      signalGroup("SIGTERM");
      // Escalation is unconditional: the point of a hard kill is that it happens
      // even when the polite one was ignored.
      hardTimer = setTimeout(() => {
        if (!settled) {
          heartbeat("escalating to SIGKILL");
          signalGroup("SIGKILL");
          // If even SIGKILL leaves the pipes held open by a grandchild, the exit
          // handler still settles this run through the drain window below.
        }
      }, KILL_GRACE_MS);
    };

    const clearTimers = () => {
      for (const t of [idleTimer, drainTimer, hardTimer, overall]) if (t) clearTimeout(t);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      // Stop waiting on pipes a grandchild may still hold.
      child.stdout.destroy();
      child.stderr.destroy();

      const endedAt = new Date().toISOString();
      const code = exited?.code ?? null;
      const signal = exited?.signal ?? null;
      const runtimeOk = code === 0 && !killedFor;
      const runtimeDetail = runtimeOk ? null
        : killedFor ? `codex killed: ${killedFor}`
        : `codex exited ${code}${signal ? ` on ${signal}` : ""}${stderrTail.length ? `: ${stderrTail.join(" | ")}` : ""}`;

      // Whatever the runtime did, the evidence gets the first word: a job killed
      // for going quiet may still have written a complete report before it went
      // quiet.
      let verdict;
      try {
        verdict = judgeJob(evidenceAbs, {
          runtimeOk,
          runtimeDetail,
          context: `codex run, ${events} stream events, log at ${streamPath}`,
        });
      } catch (err) {
        rejectRun(err);
        return;
      }

      resolveRun({
        worker: "codex",
        mode: "exec",
        model: options.model ?? null,
        effort,
        codexVersion: version,
        startedAt: startedAt.toISOString(),
        endedAt,
        durationSec: Math.round((Date.parse(endedAt) - startedAt.getTime()) / 1000),
        streamEvents: events,
        // Same field name the app transport fills from the companion, so the
        // write-scope gate reads one name whatever the transport was.
        touchedFiles: touched.size ? [...touched] : null,
        exitCode: code,
        signal,
        killedFor,
        stream: streamPath,
        streamBroken: stream.broken,
        lastMessage: lastMessagePath,
        evidence: evidenceAbs,
        ...verdict,
      });
    };

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => kill(`no stdout event for ${Math.round(idleMs / 1000)}s`), idleMs);
    };

    const overall = setTimeout(() => kill(`exceeded ${timeout}`), timeoutMs);
    armIdle();

    child.stdout.on("data", (chunk) => {
      stream.write(chunk);
      const parts = (residual + chunk).split("\n");
      residual = parts.pop() ?? "";
      events += parts.filter(Boolean).length;
      for (const line of parts) collectFileChange(line, touched);
      // Only stdout re-arms the watchdog. Re-arming on stderr let a process that
      // had stopped working keep itself alive with warning chatter -- the silent
      // crashloop the skill warns about.
      armIdle();
      if (events >= nextHeartbeat) {
        heartbeat("running");
        nextHeartbeat = events + 25; // a threshold, not a modulo: a multi-line
      }                              // chunk can step straight over a multiple
    });

    child.stderr.on("data", (chunk) => {
      // Wrapped, not raw: raw stderr interleaved mid-line would break every
      // parser over a file named .jsonl.
      stream.write(`${JSON.stringify({ type: "crew.stderr", text: String(chunk) })}\n`);
      stderrTail = [...stderrTail, ...String(chunk).split("\n").filter(Boolean)].slice(-5);
    });

    // EPIPE, reproduced: a child that dies without draining stdin rejects a
    // brief larger than the pipe buffer. Uncaught, it crashed the adapter before
    // the manifest failure write -- on the watchdog path, of all places.
    child.stdin.on("error", (err) => {
      stream.note(`stdin write failed: ${err.code ?? err.message}`);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectRun(new CodexRunError(`could not run codex: ${err.message}`, "check that codex is on PATH"));
    });

    // exit, not close: see the header. The drain window gives stdout a bounded
    // chance to deliver its tail without letting a lingering grandchild hold this
    // run open forever.
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(finish, DRAIN_MS);
    });
    child.on("close", () => finish());

    child.stdin.end(promptText);
  });
}

/**
 * One companion call. Parsed defensively on purpose: this is another project's
 * CLI, so a field that moved must produce a named error rather than an
 * `undefined` that travels three functions before it fails.
 */
function callCompanion(companion, args, { workspace, timeoutMs, what }) {
  const proc = spawnSync(process.execPath, [companion, ...args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: timeoutMs,
    // Same recursion guard as the headless path: the detached worker the
    // companion spawns inherits this env, so the Codex process running the job
    // reads the skill as a worker and refuses to dispatch further. workerEnv
    // also strips the vars a worker must never carry -- see STRIPPED_ENV.
    env: workerEnv(),
    maxBuffer: 16 * 1024 * 1024,
  });
  const stderrTail = String(proc.stderr ?? "").trim().slice(-600);
  if (proc.error?.code === "ETIMEDOUT" || (proc.signal && proc.status === null)) {
    throw new CodexRunError(
      `companion ${what} did not return within ${Math.round(timeoutMs / 1000)}s`,
      stderrTail || "no stderr",
    );
  }
  if (proc.error) throw new CodexRunError(`could not run the companion: ${proc.error.message}`, companion);
  if (proc.status !== 0) {
    throw new CodexRunError(`companion ${what} exited ${proc.status}`, stderrTail || "no stderr");
  }
  const raw = String(proc.stdout ?? "");
  // A future plugin version printing a banner before the JSON must not read as
  // a protocol break, so fall back to the first brace.
  const candidates = [raw, raw.slice(raw.indexOf("{"))];
  for (const text of candidates) {
    try { return JSON.parse(text); } catch { /* try the next shape */ }
  }
  throw new CodexRunError(`companion ${what} did not print JSON`, raw.trim().slice(0, 600));
}

/**
 * The app transport: a real thread in the Codex app, which is the whole point --
 * an owner job is one whose evidence IS the deliverable, so the person who will
 * be judged on it gets to watch it being made.
 *
 * Measured 2026-08-25 against companion 1.0.5, because a parser written from
 * guesses is how a transport fails silently:
 *   task --background --json  ->  { jobId, status: "queued", title, summary, logFile }
 *   status <id> --wait --json ->  { workspaceRoot, job: {...}, waitTimedOut, timeoutMs }
 *   job.status                ->  queued | running | completed | failed | cancelled
 *   job.threadId              ->  the app thread, populated by the time it settles
 *
 * Unlike Anti's app mode there is a real completion signal here (`--wait`
 * blocks), so this does not poll the evidence file. The timeout ceiling is still
 * enforced separately, because `--wait` itself can outlive a dead broker.
 *
 * After settling it asks `result` for what the worker said -- see
 * fetchCompanionReply. Skipping that step was this transport's real gap next to
 * headless: the job ran, the evidence was judged, and the answer was discarded.
 */
/**
 * Brings a finished app job's reply text back, the way `-o lastMessagePath`
 * already does on the headless path. Without this the app transport threw the
 * worker's answer away: the adapter waited for the job, judged the evidence,
 * and never asked what the worker actually said.
 *
 * Measured against companion 1.0.5 on 2026-08-25, on two real settled jobs:
 *   result <id> --json -> { job: {...}, storedJob: { ..., result, rendered } }
 *   storedJob.result   -> { status, threadId, rawOutput, touchedFiles, reasoningSummary }
 *   storedJob.rendered -> rawOutput plus the companion's "resume in Codex" footer
 *
 * `rawOutput` is taken over `rendered` because the footer is the companion
 * talking to a human, not the worker's answer.
 *
 * Two things measured here that the plan did not expect. `result.status` is a
 * real exit status (0 on both jobs), so "nothing here exited" was too strong --
 * but what it holds on a failed job is unmeasured, so it goes in a field of its
 * own rather than into `exitCode`, where the gate would read it. And
 * `result.touchedFiles` is a per-job list of files the runtime says it wrote:
 * an authorship signal the write-scope gate currently has no access to.
 *
 * Every failure here is recorded and swallowed. A missing reply is a thinner
 * record; it is not a failed job.
 */
function fetchCompanionReply(companion, jobId, { workspace, replyPath }) {
  const out = { lastMessage: null, companionExitStatus: null, touchedFiles: null, replyError: null };
  let payload;
  try {
    payload = callCompanion(companion, ["result", jobId, "--json", "--cwd", workspace], {
      workspace, timeoutMs: COMPANION_RESULT_TIMEOUT_MS, what: `result ${jobId}`,
    });
  } catch (err) {
    out.replyError = `result unavailable: ${err.message}`;
    return out;
  }

  const r = payload?.storedJob?.result;
  if (!r || typeof r !== "object") {
    out.replyError = `result returned no storedJob.result (got keys: ${Object.keys(payload ?? {}).join(", ") || "none"})`;
    return out;
  }
  if (typeof r.status === "number") out.companionExitStatus = r.status;
  if (Array.isArray(r.touchedFiles)) out.touchedFiles = r.touchedFiles;

  const text = typeof r.rawOutput === "string" && r.rawOutput.trim()
    ? r.rawOutput
    : (typeof payload.storedJob.rendered === "string" ? payload.storedJob.rendered : "");
  if (!text.trim()) {
    out.replyError = "companion returned an empty reply";
    return out;
  }
  const capped = Buffer.byteLength(text, "utf8") > MAX_REPLY_BYTES
    ? `${text.slice(0, MAX_REPLY_BYTES)}\n…[crew: cắt phần còn lại]\n`
    : text;
  try {
    writeFileSync(replyPath, capped.endsWith("\n") ? capped : `${capped}\n`, "utf8");
    out.lastMessage = replyPath;
  } catch (err) {
    out.replyError = `could not write reply file: ${err.message}`;
  }
  return out;
}

/**
 * Put the companion's job id in the manifest the moment it exists.
 *
 * It used to be recorded only on the return path, together with the rest of the
 * result -- which meant the one case that needs it never had it. A job whose
 * adapter dies mid-flight is exactly the job whose id nobody can look up, and
 * without the id there is no way to ask the companion whether the work is still
 * running or long gone. The id has to outlive the process that learned it.
 *
 * The later write on the return path is left in place: it carries the settled
 * status alongside, and rewriting the same id with the same value is harmless.
 */
async function registerCompanionJob(options, jobId) {
  if (!options.manifest || !options.job) return;
  try {
    const { updateJob } = await import("./crew-manifest.mjs");
    updateJob(options.manifest, Number(options.job), { companionJobId: jobId });
  } catch (err) {
    process.stderr.write(`codex-run: could not record the companion job id: ${err.message}\n`);
  }
}

/**
 * Take one runtime reading and store it on the run. Swallows everything.
 *
 * App mode only, and that is not an omission. Headless is `codex exec`, its own
 * process with no broker and no app-server, so "shared or private runtime" is
 * not a question that exists for it -- and a reading taken while a headless job
 * ran would attribute whatever broker happened to be up, belonging to some
 * other session, to this job.
 *
 * Failure here is silent by design. This is a diagnostic about the run, and a
 * diagnostic that can fail a job which otherwise succeeded is worse than no
 * diagnostic at all.
 */
async function noteRuntime(options, when, workspace) {
  if (!options.manifest || !options.job) return;
  try {
    const { probeRuntime } = await import("./crew-runtime-probe.mjs");
    const { recordRuntime } = await import("./crew-manifest.mjs");
    recordRuntime(options.manifest, when, probeRuntime({ workspace }));
  } catch (err) {
    process.stderr.write(`codex-run: could not record the runtime reading (${when}): ${err.message}\n`);
  }
}

/** Whether a companion failure is the store denying an id it just issued. */
function isJobNotFound(err) {
  return /no job found/i.test(`${err?.message ?? ""} ${err?.detail ?? ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a job to settle, tolerating a store that has not caught up yet.
 *
 * Only the two measured shapes are tolerated, and only inside
 * `SETTLE_RACE_WINDOW_MS` of the first ask. Everything else still throws on the
 * first failure: a broad retry here would turn a real dead job into a slow dead
 * job, and this adapter exists because a job died once and nobody noticed.
 *
 * The retry count comes back with the snapshot and goes into the manifest. That
 * is deliberate -- tolerating a bug without recording how often it fires would
 * hide the thing worth fixing, and the fix for the race itself is not here: it
 * is in the companion's store.
 */
async function waitForSettle(companion, jobId, { workspace, timeoutMs }) {
  const args = [
    "status", jobId, "--wait",
    "--timeout-ms", String(timeoutMs),
    "--poll-interval-ms", "2000",
    "--json", "--cwd", workspace,
  ];
  const deadline = Date.now() + SETTLE_RACE_WINDOW_MS;
  let retries = 0;
  let why = null;

  for (;;) {
    let snapshot = null;
    let failure = null;
    try {
      snapshot = callCompanion(companion, args, {
        workspace, timeoutMs: timeoutMs + COMPANION_WAIT_SLACK_MS, what: `status --wait for ${jobId}`,
      });
    } catch (err) {
      // Anything but the store denying its own id is a real failure.
      if (!isJobNotFound(err)) throw err;
      failure = err;
      why = "runtime chưa thấy job vừa nhận";
    }

    if (snapshot) {
      if (typeof snapshot?.job?.status === "string") return { snapshot, settleRetries: retries, settleRaceWhy: retries ? why : null };
      // A job with no status is only transient when the call did not wait. If
      // it waited out its whole allowance and still has no status, that is a
      // broken answer, not a store catching up.
      if (snapshot.waitTimedOut === true) {
        throw new CodexRunError(
          "companion status returned no job.status",
          `got: ${JSON.stringify(snapshot).slice(0, 400)}`,
        );
      }
      why = "runtime trả job chưa có status";
    }

    if (Date.now() >= deadline) {
      const detail = failure ? (failure.detail ?? failure.message) : `got: ${JSON.stringify(snapshot).slice(0, 400)}`;
      throw new CodexRunError(
        `companion never gave job ${jobId} a status within ${Math.round(SETTLE_RACE_WINDOW_MS / 1000)}s of dispatch (${why})`,
        detail,
      );
    }
    retries += 1;
    process.stderr.write(`codex-run: ${why}, thử lại sau ${SETTLE_RETRY_DELAY_MS / 1000}s (lần ${retries})\n`);
    await sleep(SETTLE_RETRY_DELAY_MS);
  }
}

export async function codexRunApp(options) {
  // Refused rather than quietly ignored. Measured 18/09: ensureBrokerSession
  // reuses a broker that is already listening, so a token injected at dispatch
  // reaches the companion process and stops there -- the job runs inside a
  // broker started before the env existed. Accepting the flag here would hand
  // back a job that looks authorised and 401s anyway, which is the failure this
  // whole plan is trying to remove.
  if (resolveWorkspaceCli(options)) {
    throw new CodexRunError(
      "--workspace-cli on is not available in app mode",
      "the app broker is reused across dispatches, so it never sees this env. Use --mode headless for jobs that call the Workspace CLI",
    );
  }

  const {
    workspace, evidenceAbs, promptText, timeout, timeoutMs, effort, logDir, base,
  } = prepareRun(options);

  let companion;
  try {
    companion = resolveCompanion();
  } catch (err) {
    // Never fall back to headless. A manifest that says `app` while nothing
    // opened is exactly the silent-substitution failure this harness exists to
    // catch, and it would be invisible until someone went looking for a thread.
    throw new CodexRunError(err.message, err.detail);
  }

  const promptPath = join(logDir, `${base}.codex-app-prompt.md`);
  const statusPath = join(logDir, `${base}.codex-app-status.json`);
  const replyPath = join(logDir, `${base}.codex-app-reply.md`);
  assertSidecarsAbsent([promptPath, statusPath, replyPath]);
  // The companion reads the prompt from a file, so `--prompt` and
  // `--prompt-file` both land here and the file doubles as the audit record.
  writeFileSync(promptPath, promptText, "utf8");

  const version = codexVersion();
  const startedAt = new Date();

  const dispatchArgs = [
    "task", "--background", "--json",
    "--prompt-file", promptPath,
    "--cwd", workspace,
    // Always write. Not role-dependent, despite what the plan first said: every
    // crew job has to write its own evidence file, so a read-only app job could
    // not satisfy the evidence gate at all. This also keeps the two transports
    // on one contract -- headless already runs `--sandbox workspace-write`.
    "--write",
  ];
  if (options.model) dispatchArgs.push("-m", options.model);
  if (effort) dispatchArgs.push("--effort", effort);

  const queued = callCompanion(companion, dispatchArgs, {
    workspace, timeoutMs: COMPANION_DISPATCH_TIMEOUT_MS, what: "task dispatch",
  });
  const jobId = queued?.jobId;
  if (typeof jobId !== "string" || !jobId) {
    throw new CodexRunError(
      "companion dispatch returned no jobId",
      `got: ${JSON.stringify(queued).slice(0, 400)}`,
    );
  }
  process.stderr.write(`codex-run: app job ${jobId} queued, waiting up to ${timeout}\n`);
  // Both of these have to survive this process dying, which is why they are
  // written here rather than with the rest of the result at the end.
  await registerCompanionJob(options, jobId);
  // After the queue succeeds, not before: if this dispatch is what brought a
  // broker up, a reading taken earlier would miss the runtime it just created.
  await noteRuntime(options, "atDispatch", workspace);

  let settled;
  try {
    settled = await waitForSettle(companion, jobId, { workspace, timeoutMs });
  } catch (err) {
    // The cancel below used to be reachable only through a snapshot. So when the
    // `status --wait` call itself hung or died -- broker stuck, companion gone --
    // the adapter recorded a failed job and walked away from a background job
    // that was still running, still writing, still burning quota, with nobody
    // watching it. A job this adapter can no longer follow is a job it has to
    // put down.
    try {
      callCompanion(companion, ["cancel", jobId, "--json", "--cwd", workspace], {
        workspace, timeoutMs: 60_000, what: `cancel ${jobId}`,
      });
      process.stderr.write(`codex-run: cancelled ${jobId} sau khi mất dấu\n`);
    } catch (cancelErr) {
      process.stderr.write(`codex-run: cancel ${jobId} thất bại: ${cancelErr.message}\n`);
    }
    throw err;
  }
  const { snapshot, settleRetries, settleRaceWhy } = settled;

  try {
    writeFileSync(statusPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch { /* an audit copy must not fail a finished job */ }

  // waitForSettle already guarantees a job with a string status, so this is the
  // narrower leftover: a payload with no job object at all.
  const job = snapshot?.job;
  if (!job) {
    throw new CodexRunError("companion status returned no job", `got: ${JSON.stringify(snapshot).slice(0, 400)}`);
  }

  const timedOut = Boolean(snapshot.waitTimedOut) || COMPANION_ACTIVE.has(job.status);
  let cancelled = null;
  if (timedOut) {
    // Cancel before judging, so a job that outlived its allowance is not left
    // running against a workspace nobody is watching any more.
    try {
      callCompanion(companion, ["cancel", jobId, "--json", "--cwd", workspace], {
        workspace, timeoutMs: 60_000, what: `cancel ${jobId}`,
      });
      cancelled = "cancelled after timeout";
    } catch (err) {
      cancelled = `cancel failed: ${err.message}`;
    }
    process.stderr.write(`codex-run: ${cancelled}\n`);
  }

  // After the cancel branch, so a runtime this adapter just tore down reads as
  // torn down rather than as it was while the job still held it.
  await noteRuntime(options, "atSettle", workspace);

  // Asked for even on a job the companion calls failed, and even after a
  // cancel: whatever the worker managed to say before it stopped is the most
  // useful thing there is for working out why. What `result` returns in those
  // two cases is not measured -- no failed or cancelled job existed in the
  // companion's store to probe -- so the call is written to tolerate anything.
  const reply = fetchCompanionReply(companion, jobId, { workspace, replyPath });
  if (reply.replyError) process.stderr.write(`codex-run: ${reply.replyError}\n`);

  const runtimeOk = job.status === "completed" && !timedOut;
  const runtimeDetail = runtimeOk ? null
    : timedOut ? `companion job did not settle within ${timeout} (status ${job.status}); ${cancelled}`
    : `companion job ${job.status}${job.errorMessage ? `: ${job.errorMessage}` : ""}`;

  // Evidence gets the first word even here: a job the companion calls `failed`
  // may still have written a complete report before it fell over. If it wrote
  // nothing, judgeJob throws and the caller records the failure -- which is the
  // whole reason this adapter exists.
  const verdict = judgeJob(evidenceAbs, {
    runtimeOk,
    runtimeDetail,
    context: `codex app job ${jobId}, thread ${job.threadId ?? "none"}, log at ${job.logFile ?? "unknown"}`,
  });

  const endedAt = new Date().toISOString();
  return {
    worker: "codex",
    mode: "app",
    model: options.model ?? null,
    effort,
    codexVersion: version,
    startedAt: startedAt.toISOString(),
    endedAt,
    durationSec: Math.round((Date.parse(endedAt) - startedAt.getTime()) / 1000),
    // The provenance field the collect gate already asks about for app-mode
    // jobs. Reusing it means no new branch in the gate to forget to update.
    conversationId: job.threadId ?? null,
    companionJobId: jobId,
    companionStatus: job.status,
    // How many times the store had to be re-asked before it would name a
    // status, and why. Recorded rather than swallowed: a tolerated race whose
    // frequency nobody can see is a race nobody will fix.
    settleRetries: settleRetries || undefined,
    settleRaceWhy: settleRaceWhy ?? undefined,
    turnId: job.turnId ?? null,
    companionLog: job.logFile ?? null,
    statusFile: statusPath,
    prompt: promptPath,
    // Same field the headless path uses for the worker's final message, so the
    // collect step reads one name for both transports.
    lastMessage: reply.lastMessage,
    // The companion's own exit status for the codex run, and the files it says
    // it wrote. Kept separate from `exitCode` because the gate reads that one,
    // and what this holds on a failed job has not been measured.
    companionExitStatus: reply.companionExitStatus,
    touchedFiles: reply.touchedFiles,
    replyError: reply.replyError,
    // Null, not 0: this adapter did not spawn the process that exited. The gate
    // reads provenance from conversationId for app jobs, and a fake 0 here
    // would claim a clean exit on behalf of something it never watched.
    exitCode: null,
    killedFor: timedOut ? runtimeDetail : null,
    evidence: evidenceAbs,
    ...verdict,
  };
}

export { CodexRunError };

/**
 * The message has to print what the CLI actually accepts. KNOWN_FLAGS holds the
 * internal keys, so a raw dump of it would tell the caller to use --promptFile
 * when the flag is --prompt-file.
 */
function knownFlagSpellings(alias) {
  const cliName = Object.fromEntries(Object.entries(alias).map(([cli, key]) => [key, cli]));
  return [...KNOWN_FLAGS].map((key) => `--${cliName[key] ?? key}`);
}

function parseArgv(argv) {
  const out = {};
  const alias = { "prompt-file": "promptFile", "idle-timeout": "idle", "workspace-cli": "workspaceCli" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new CodexRunError(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    const key = alias[name] ?? name;
    // An unknown flag used to be accepted and ignored, which meant a typo in
    // --idle-timeout silently disabled the watchdog.
    if (!KNOWN_FLAGS.has(key)) {
      throw new CodexRunError(`unknown flag --${name}`, `known flags: ${knownFlagSpellings(alias).join(" ")}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new CodexRunError(`--${name} needs a value`);
    out[key] = value;
    i += 1;
  }
  return out;
}

/** Exit 3: the job finished but a human has to look before it counts. */
function needsHuman(result) {
  return Boolean(result.runtimeVerdict)
    || result.status === "done_unverified"
    || result.status === "blocked"
    || result.status === "needs_context";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let opts = {};
  let mode = "headless";
  let result = null;
  let claimed = false;
  // Captured before the job starts so a job that dies still carries a duration.
  const dispatchedAt = new Date().toISOString();

  // Fingerprinted before anything spawns, and compared on every way out. These
  // two files never change during a healthy job, so a difference is an incident
  // rather than a warning -- which is why this needs no attribution logic and
  // stays correct with three jobs running at once.
  const credentialsBefore = snapshotCredentialStore();
  /**
   * The credential finding, as a patch fragment to spread into updateJob.
   *
   * A fragment rather than a field, and that is the load-bearing part. Writing
   * `credentialTamper: undefined` on a clean attempt looked harmless -- JSON
   * drops the key -- but updateJob does a plain Object.assign, so it also
   * erased a finding recorded by an earlier attempt. An operator who saw exit 2
   * and re-dispatched the job would get a clean run and a store that was still
   * damaged. Omitting the key leaves the earlier record standing; `failure`
   * next door is cleared on purpose and preserves its history in `notes`, and
   * this field does neither.
   *
   * Each finding carries the directory it was taken in. The gate runs in its
   * own process and does not inherit GOOGLE_WORKSPACE_CLI_CONFIG_DIR, so
   * without this it printed its own default path -- sending whoever reads the
   * alarm to look at a file that was never touched. Found by a live run, not
   * by a fixture: a fixture supplies the path it expects.
   */
  const credentialPatch = () => {
    const dir = displayCredentialDir();
    if (isWatchBlind(credentialsBefore)) return { credentialWatch: `blind:${dir}` };
    const changes = diffCredentialStore(credentialsBefore, snapshotCredentialStore());
    return changes.length ? { credentialTamper: changes.map((c) => ({ ...c, dir })) } : {};
  };

  // The adapter exists so that a death is recorded rather than read as
  // `pending` forever -- and until now its own death was the one death nobody
  // recorded. A SIGTERM (session closed, supervisor stopping the tree) does not
  // pass through the catch below: Node exits straight away, leaving the job it
  // had just marked `running` marked `running` for good.
  //
  // Synchronous only, on purpose. A signal handler gets no await, so this uses
  // the already-imported updateJob path and writes one record, then re-raises
  // by exiting with the conventional 128+signal code.
  //
  // Reaches the headless path, not the app one. Measured 25/08: the app wait
  // sits inside `spawnSync`, which blocks the event loop, so Node cannot deliver
  // a signal to any handler until that call returns. This is not worked around
  // here -- an app job killed mid-wait is recovered through the gate, which is
  // why `companionJobId` is written at dispatch: the stale-job check plus
  // `crew-reconcile --cancel-orphans` can still find and put it down. Slower
  // than a handler, but nothing is lost, and the alternative is rewriting every
  // companion call to be async for a case the gate already covers.
  const recordSignal = (name, signo) => {
    if (opts.manifest && opts.job) {
      try {
        updateJobSync(opts.manifest, Number(opts.job), {
          status: "failed",
          startedAt: dispatchedAt,
          endedAt: new Date().toISOString(),
          failure: `adapter nhận ${name} trước khi job kết thúc`,
          // A job killed mid-flight is the most suspect one there is; skipping
          // the check here would leave exactly that group unexamined.
          ...credentialPatch(),
        });
      } catch { /* nothing left to do about it from inside a signal */ }
    }
    console.error(`codex-run: ${name} — đã ghi job là failed`);
    process.exit(128 + signo);
  };
  process.on("SIGTERM", () => recordSignal("SIGTERM", 15));
  process.on("SIGINT", () => recordSignal("SIGINT", 2));
  process.on("SIGHUP", () => recordSignal("SIGHUP", 1));

  try {
    opts = parseArgv(process.argv.slice(2));
    mode = opts.mode ?? "headless";
    if (!MODES.has(mode)) {
      throw new CodexRunError(`unknown mode "${mode}"`, `use one of: ${[...MODES].join(", ")}`);
    }
    // Recorded before the job spawns, not after it returns. A job that is still
    // working has no result to write, so without this the manifest showed it as
    // `pending` with no start time -- and the collect gate cannot tell a live
    // job from one that never launched, nor attribute any file it writes while
    // it runs. `timeoutMs` goes down here for the same reason: the gate needs
    // this job's own allowance to decide when silence means death.
    if (opts.manifest && opts.job) {
      const { assertTransport, claimRunSlot } = await import("./crew-manifest.mjs");
      // Before anything is spawned: a job recorded as one transport and fired
      // down the other leaves a manifest that lies, and the manifest is the only
      // thing later measurement can read.
      assertTransport(opts.manifest, Number(opts.job), mode);
      // Takes a parallel slot inside the manifest lock, or refuses. Counting
      // outside the lock does not work: adapters start milliseconds apart, all
      // read the same count, and all of them proceed.
      claimRunSlot(opts.manifest, Number(opts.job), {
        startedAt: dispatchedAt,
        timeoutMs: parseDuration(opts.timeout ?? DEFAULT_TIMEOUT),
      });
      // Only a job this process actually claimed may be written by its failure
      // path. Without this, a refused second dispatch ("already running") fell
      // into the catch below and recorded the job as `failed` -- erasing the
      // FIRST invocation's `running` state and freeing its slot while it was
      // still working. A guard whose refusal gets overwritten by the caller's
      // own error handler is not a guard.
      claimed = true;
    }
    result = mode === "app" ? await codexRunApp(opts) : await codexRun(opts);
  } catch (err) {
    // The whole point of this adapter: a death nobody records reads as "pending"
    // forever, which is exactly what happened on 2026-08-24.
    if (opts.manifest && opts.job) {
      try {
        const { updateJob, recordUnclaimedFailure } = await import("./crew-manifest.mjs");
        // A job this process claimed is its own to write. One it never claimed
        // may belong to another invocation that is still running, and that one
        // must not be overwritten -- see recordUnclaimedFailure.
        const record = claimed ? updateJob : recordUnclaimedFailure;
        record(opts.manifest, Number(opts.job), {
          status: "failed",
          startedAt: dispatchedAt,
          endedAt: new Date().toISOString(),
          codexVersion: codexVersion(),
          failure: err.message,
          ...credentialPatch(),
        });
      } catch (manifestErr) {
        console.error(`codex-run: could not record the failure in the manifest: ${manifestErr.message}`);
      }
      // The settle reading has to be taken here too. It was originally only on
      // the success path, and the first live run showed why that is wrong: both
      // adapters threw before reaching it, so a run whose failure is the very
      // thing worth diagnosing recorded no reading at all. `atSettle` means
      // "what the runtime looked like when this run ended", and a run that ends
      // badly still ends.
      if (mode === "app") await noteRuntime(opts, "atSettle", resolve(opts.workspace ?? process.cwd()));
    }
    console.error(`codex-run: ${err.message}`);
    process.exit(1);
  }

  // Outside the try above: the job is finished by now, so a failed manifest
  // write is a bookkeeping problem and must never read as a failed job.
  if (opts.manifest && opts.job) {
    try {
      const { updateJob } = await import("./crew-manifest.mjs");
      const { readManifest } = await import("./crew-manifest.mjs");
      const priorJob = readManifest(opts.manifest).jobs.find((j) => j.seq === Number(opts.job)) ?? {};
      const prior = [
        ...(priorJob.notes ?? []),
        // Carried over before `failure` is cleared below, or the retry would
        // erase the only record that an earlier attempt died.
        ...(priorJob.failure ? [`lượt trước fail: ${priorJob.failure}`] : []),
      ];
      updateJob(opts.manifest, Number(opts.job), {
        status: result.status,
        reportedStatus: result.reportedStatus,
        runtimeVerdict: result.runtimeVerdict,
        model: result.model,
        // A retry that succeeded must not inherit the previous attempt's
        // failure: the field would keep firing a WARN on a job that is now
        // clean, and a WARN that cries on every retried job is one people learn
        // to scroll past. The history stays in `notes`, which is append-only.
        failure: undefined,
        effort: result.effort,
        codexVersion: result.codexVersion,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        exitCode: result.exitCode,
        signal: result.signal,
        streamEvents: result.streamEvents,
        // Filled on both transports: headless reads it off the stream's
        // file_change events, app gets it from the companion's result. It is an
        // authorship signal for the write-scope gate, and one-way -- a file
        // named here is this job's, a file not named here may still be.
        touchedFiles: result.touchedFiles,
        evidenceBytes: result.evidenceBytes,
        // Recorded so the collect step can find the log without guessing its name.
        stream: result.stream,
        lastMessage: result.lastMessage,
        // App-transport provenance. Undefined on the headless path, and
        // JSON.stringify drops undefined, so no headless job grows empty fields.
        transportMode: result.mode,
        conversationId: result.conversationId,
        companionJobId: result.companionJobId,
        companionStatus: result.companionStatus,
        companionLog: result.companionLog,
        turnId: result.turnId,
        // App transport only: the companion's exit status for the codex run,
        // and why the reply is missing when it is. Both are record, not verdict.
        companionExitStatus: result.companionExitStatus,
        replyError: result.replyError,
        // App transport only, and only when the dispatch race actually fired.
        settleRetries: result.settleRetries,
        settleRaceWhy: result.settleRaceWhy,
        ...credentialPatch(),
        notes: result.runtimeVerdict
          ? [...prior, `runtime báo fail (${result.runtimeVerdict}) nhưng evidence tự phán ${result.reportedStatus} — cần người đọc`]
          : prior,
      });
    } catch (manifestErr) {
      console.error(
        `codex-run: job finished ${result.status} but the manifest was not updated: ${manifestErr.message}\n` +
        `  → the evidence at ${result.evidence} is valid; re-run the manifest update, not the job`,
      );
      console.log(JSON.stringify(result, null, 2));
      process.exit(2); // distinct from 1: the job worked, the bookkeeping did not
    }
  }

  if (result.runtimeVerdict) {
    console.error(
      `codex-run: the runtime disagreed with the evidence (${result.runtimeVerdict})\n` +
      `  → evidence judged itself ${result.reportedStatus}; a human must read ${result.evidence}`,
    );
  }
  if (result.status === "done_unverified") {
    console.error(`codex-run: evidence has no "Status:" line, so the outcome is unverified\n  → ${result.evidence}`);
  }
  console.log(JSON.stringify(result, null, 2));
  // Background dispatch made the exit code the ping, so a job that needs a human
  // must not ping as a clean success.
  process.exit(needsHuman(result) ? 3 : 0);
}
