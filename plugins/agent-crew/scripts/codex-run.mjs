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
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { isWorkerRole } from "./lib/crew-role.mjs";
// Static, unlike the `await import` calls further down: a signal handler runs
// with no chance to await, so the one write it needs has to be resolved before
// the signal ever arrives.
import { readManifest, updateJob as updateJobSync, holdsTamperPatch } from "./crew-manifest.mjs";
import {
  DEFAULT_TIMEOUT,
  GuardError,
  resolveResume,
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
  resolveLogDir,
  jobLayout,
  softDeadlineAt,
  handoffRescuePrompt,
  HANDOFF_RESCUE_MS,
  HANDOFF_RESCUE_IDLE_MS,
  codexTurnUsage,
} from "./crew-guards.mjs";
import { evidenceHasStatus, runHandoffRescue } from "./codex-handoff-rescue.mjs";
import { LIVENESS_RECHECK_MS, createLivenessProbe } from "./lib/codex-liveness.mjs";
import { codexExitDetail, collectCodexError } from "./lib/codex-failure.mjs";
import { loadCrewConfig } from "./lib/crew-config.mjs";
import { assertAccount, listWorkspaceProfiles, resolveWorkspaceProfile, tokenEmail } from "./lib/workspace-cli-profile.mjs";
// Dời sang crew-guards để anti-run dùng chung; giữ export ở đây cho test và nơi gọi cũ.
export { resolveLogDir };

/**
 * After this long with no stdout event, the watchdog asks codex-liveness whether
 * the job is still alive (CPU still used by codex or a command it runs, network
 * bytes still arriving, or a model connection held open for a bounded time).
 * Only a job silent on every count is killed. Codex prints nothing while it waits on the model, so silence alone
 * killed jobs that were waiting on a slow network.
 */
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
  "model", "effort", "manifest", "job", "mode", "workspaceCli", "sandboxMode",
  "resume", "workspaceProfile",
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
 * How much of the machine a worker may touch.
 *
 * Measured 22/09: the tool list is IDENTICAL at every surface -- eighteen tools,
 * Computer Use among them -- and the sandbox is the only thing that decides
 * whether they do anything. Under `workspace-write` a screenshot comes back
 * "Computer Use was not approved" and a write outside the repo comes back
 * "Operation not permitted"; drop the flag and both succeed. So a worker is not
 * missing tools, it is forbidden to use them, and this flag is the whole lever.
 *
 * `workspace-write` stays the default. Opening the sandbox removes a defence
 * that did real work: on 18/09 a worker set KEYRING_BACKEND=file, the Workspace
 * CLI concluded the store was corrupt and issued a delete, and the sandbox
 * refused the write. The same delete outside a sandbox destroyed the store.
 *
 * What makes the opt-in defensible is that the credential store now has its own
 * guard -- the hash taken before and after every job -- built precisely because
 * Antigravity workers were never sandboxed. Opening Codex's sandbox puts it level
 * with the path Anti already runs on, not below it. It is still one layer fewer,
 * which is why it is a flag and not a new default.
 */
const SANDBOX_MODES = new Set(["workspace-write", "danger-full-access"]);

function resolveSandboxMode(options) {
  const raw = options.sandboxMode;
  if (raw === undefined) return "workspace-write";
  // Refused, never coerced. A value the caller invented has to stop the job:
  // falling back to the default would run at a permission level the dispatcher
  // did not ask for, and say nothing about it.
  if (!SANDBOX_MODES.has(raw)) {
    throw new CodexRunError(
      `unknown --sandbox-mode value "${raw}"`,
      `use one of: ${[...SANDBOX_MODES].join(", ")}`,
    );
  }
  return raw;
}

/**
 * The profile directory a `--workspace-cli on` job mints from, plus the account
 * crew.config.json expects it to be.
 *
 * One function for both the mint and the credential guard: the guard has to
 * fingerprint the directory the token actually came from, and two copies of the
 * choice drift silently -- which is how a two-profile machine minted from the
 * default profile while the worker used the other one (07/11).
 */
export function workspaceProfileFor(options) {
  const workspace = resolve(options.workspace ?? process.cwd());
  let config;
  try {
    config = loadCrewConfig(workspace);
  } catch (err) {
    throw new CodexRunError(`crew.config.json: ${err.message}`);
  }
  let picked;
  try {
    picked = resolveWorkspaceProfile({ flag: options.workspaceProfile, configDir: config.workspaceCliConfigDir });
  } catch (err) {
    throw new CodexRunError(err.message);
  }
  return { ...picked, expected: config.workspaceCliAccount };
}

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
async function mintWorkspaceToken(profileDir) {
  let creds;
  try {
    const raw = execFileSync("gws", ["auth", "export", "--unmasked"], {
      encoding: "utf8",
      env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: profileDir },
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

/**
 * The only transport Codex runs on since 2.0.4. Still a set, not a constant
 * compare: the manifest records the same word, so flag and record cannot drift.
 */
const MODES = new Set(["headless"]);

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
 * The session id, for resuming this job later.
 *
 * It has been on the wire since at least 27/08 -- every stored sidecar opens
 * with `{"type":"thread.started","thread_id":"01a0..."}` -- and nothing read
 * it, so the one thing needed to continue a headless job was thrown away on
 * every run. Captured for EVERY job, not just resumed ones: a job only becomes
 * worth continuing after you have seen what it produced.
 *
 * Substring test first, same as collectFileChange: the common case is a long
 * command_execution event that has no business going through JSON.parse.
 */
function collectThreadId(line, prev) {
  if (prev || !line || !line.includes("thread.started")) return prev;
  let d;
  try { d = JSON.parse(line); } catch { return prev; }
  if (d?.type !== "thread.started") return prev;
  return typeof d.thread_id === "string" && d.thread_id ? d.thread_id : prev;
}

function buildArgs({ workspace, model, effort, lastMessagePath, sandboxMode = "workspace-write", resumeId = null }) {
  // workspace-write denies network by default, and the explicit --sandbox flag
  // outranks sandbox_mode in config.toml. Every network-bound job (GSC, GA4,
  // any crawl) returned BLOCKED with unresolvable DNS until this was set.
  const NETWORK = ["-c", "sandbox_workspace_write.network_access=true"];
  const args = [
    "exec",
    "--json",                        // JSONL events: the heartbeat this adapter watches
    "-C", workspace,
    "--sandbox", sandboxMode,        // default: a worker writes inside the workspace, nowhere else
    // Only on a fresh run. On a resume this same `-c` goes AFTER the subcommand
    // -- see below, and do not "tidy" it back up here.
    ...(resumeId ? [] : NETWORK),
    "-o", lastMessagePath,
    "--color", "never",
  ];
  // `resume` is a SUBCOMMAND of `exec`, not a flag, and the insertion point is
  // load-bearing. Measured 23/09 against codex-cli 0.154.0: `codex exec resume`
  // rejects -C, --sandbox and --color outright ("unexpected argument"), because
  // those belong to `exec` and clap wants a parent's flags before the
  // subcommand. Every one of them is already above this line, so inserting here
  // leaves the non-resume argv byte-identical -- which matters: a reviewer once
  // caught this adapter reordering argv, and the flags below (-m, effort) are
  // accepted by `resume` itself.
  // `resume` is a SUBCOMMAND of `exec`, not a flag, and both the insertion point
  // and what follows it are load-bearing. Measured 23/09 on codex-cli 0.154.0:
  //
  //   `codex exec resume --sandbox ...`  ->  error: unexpected argument
  //   `-C`, `--sandbox`, `--color` are `exec`'s and must precede the subcommand.
  //   All three are already above this line, and they DO reach the resumed turn:
  //   a probe with `--sandbox danger-full-access --resume <id>` recorded
  //   `{"type":"danger-full-access"}` on the new turn in the rollout file.
  //
  // But `-c` does NOT survive in the parent position, and this cost a real bug.
  // Read straight out of one session's rollout, same adapter, same flags:
  //   turn 1 (fresh exec)   sandbox_policy.network_access: true
  //   turn 2 (exec resume)  sandbox_policy.network_access: FALSE
  //   turn 4 (-c moved after `resume`)  network_access: true again
  // Every resumed job was heading back to unresolvable DNS, and the symptom
  // would have surfaced inside the worker as a network error with nothing in
  // the manifest saying a flag had been dropped.
  //
  // `-m` and the effort `-c` below are already on the correct side of the
  // subcommand, which is why they are left where they are.
  if (resumeId) args.push("resume", resumeId, ...NETWORK);
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
  const layout = jobLayout({ manifest: options.manifest, workspace });
  const evidenceAbs = validateEvidencePath(options.evidence, workspace, layout);
  const briefText = readPrompt(options);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const timeoutMs = parseDuration(timeout); // validates against the 30m ceiling
  const effort = options.effort ?? null;
  if (effort && !EFFORTS.has(effort)) {
    throw new CodexRunError(`unknown effort "${effort}"`, `use one of: ${[...EFFORTS].join(", ")}`);
  }

  // Resolved here, beside the other validation, and deliberately before the
  // caller mints anything: this used to run after mintWorkspaceToken, so
  // `--workspace-cli on --sandbox-mode bogus` minted a live Workspace access
  // token for a job that was then refused. A refusal must not leave a token
  // behind it, nor a log directory for a job that never ran.
  const sandboxMode = resolveSandboxMode(options);

  // A profile names where the token comes from; without a token it would change
  // nothing, and a flag that silently does nothing is read as one that worked.
  if (options.workspaceProfile !== undefined && !resolveWorkspaceCli(options)) {
    throw new CodexRunError("--workspace-profile chỉ có nghĩa khi kèm --workspace-cli on");
  }

  // A worker may not raise its own ceiling. The crew already refuses to let a
  // worker dispatch another worker (MWG_CREW_ROLE + manifest depth); a worker
  // handing itself full machine access is the same escalation by a shorter
  // route. Cheap to close, and it does not depend on Seatbelt inheritance
  // holding -- which nobody here has verified.
  if (sandboxMode !== "workspace-write" && isWorkerRole()) {
    throw new CodexRunError(
      `--sandbox-mode ${sandboxMode} is not available to a worker`,
      "only the dispatcher grants this level; a worker raising its own ceiling is an escalation",
    );
  }

  // Refusing here, before the log dir and before any spawn, keeps a flag that
  // cannot be honoured from looking like a resume that worked.
  const mode = options.mode ?? "headless";
  const resumeId = resolveResume(options, { worker: "codex", mode, supportsResume: true });

  assertEvidenceAbsent(evidenceAbs);

  // The log lives in the layout's logDir (see resolveLogDir).
  const logDir = resolveLogDir(evidenceAbs, workspace, layout);
  mkdirSync(logDir, { recursive: true });
  const base = evidenceAbs.split(sep).pop().replace(/\.md$/, "");
  // Composed here rather than above because the extra boundary line depends on
  // the sandbox level, which is only known after validation. readPrompt still
  // runs first, so a brief over the byte ceiling is reported before a bad flag.
  const promptText = appendWorkerContract(briefText, {
    evidenceAbs,
    workspace,
    unsandboxed: sandboxMode !== "workspace-write",
    mayModify: jobFilesMayModify(options),
    // Tính từ lúc soạn brief, tức là ngay trước khi spawn: worker đọc giờ máy.
    softDeadline: softDeadlineAt(Date.now(), timeoutMs),
  });

  return { workspace, evidenceAbs, promptText, timeout, timeoutMs, effort, logDir, base, sandboxMode, resumeId };
}

/** Đường `--allow` của job trong sổ; chạy không có sổ thì không có. */
function jobFilesMayModify(options) {
  if (!options.manifest || !options.job) return [];
  const job = readManifest(options.manifest).jobs.find((j) => j.seq === Number(options.job));
  return job?.filesMayModify ?? [];
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
    workspace, evidenceAbs, promptText, timeout, timeoutMs, effort, logDir, base, sandboxMode, resumeId,
  } = prepareRun(options);
  const idleMs = options.idle ? parseDuration(options.idle) : DEFAULT_IDLE_MS;

  // Minted before anything is spawned. A job that cannot get a token must fail
  // here with the reason, rather than spawn and let the worker walk into a 401
  // it has no way to read as "the dispatcher could not authenticate".
  const extraEnv = {};
  if (resolveWorkspaceCli(options)) {
    const { dir, source, expected } = workspaceProfileFor(options);
    const shown = displayCredentialDir(dir);
    const token = await mintWorkspaceToken(dir);
    const email = await tokenEmail(token);
    let verified;
    try {
      ({ verified } = assertAccount({ expected, actual: email, dir: shown }));
    } catch (err) {
      throw new CodexRunError(err.message);
    }
    // The worker gets the same directory, so its CLI reads the profile the token
    // came from; the token env outranks that profile's cache, so nothing in it
    // needs a refresh -- the write the sandbox refuses never happens.
    extraEnv.GOOGLE_WORKSPACE_CLI_TOKEN = token;
    extraEnv.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = dir;
    console.error(`codex-run: workspace-cli dùng hồ sơ ${shown} (${source}), tài khoản ${email ?? "không đọc được"}`);
    const profiles = listWorkspaceProfiles();
    if (!expected && profiles.length > 1) {
      console.error(
        `codex-run: máy có ${profiles.length} hồ sơ gws (${profiles.map((d) => displayCredentialDir(d)).join(", ")}) — `
        + "khai workspaceCliAccount trong crew.config.json để crew chặn job khi chọn nhầm tài khoản",
      );
    }
    options.onWorkspaceProfile?.({ workspaceProfile: shown, workspaceAccountVerified: verified });
  }

  const streamPath = join(logDir, `${base}.codex-stream.jsonl`);
  const lastMessagePath = join(logDir, `${base}.codex-last-message.txt`);
  assertSidecarsAbsent([streamPath, lastMessagePath]);

  const version = codexVersion();
  const args = buildArgs({ workspace, model: options.model, effort, lastMessagePath, sandboxMode, resumeId });
  const stream = makeStreamWriter(streamPath);

  // Announced after the stream writer exists, on purpose. The first version
  // wrote this to stderr only, and before the writer was even created -- so a
  // dispatch run in the background lost the one record that a job had been
  // granted full machine access. stderr is for the human watching now; the
  // sidecar is for whoever reads the run back later, and those are different
  // people.
  if (sandboxMode !== "workspace-write") {
    const extra = resolveWorkspaceCli(options)
      // Worth spelling out: this pair is the 18/09 shape. Unsandboxed, the
      // worker can run the Workspace CLI itself and write the credential store,
      // and the hash guard only detects that afterwards.
      ? " Kèm --workspace-cli on: worker vừa có token vừa ghi được kho credential — rào hash chỉ PHÁT HIỆN sau, không chặn."
      : "";
    const line = `CẢNH BÁO — job chạy ở --sandbox-mode ${sandboxMode}, ngoài sandbox. `
      + `Kho credential vẫn bị canh bằng hash, nhưng lớp sandbox không còn.${extra}`;
    process.stderr.write(`codex-run: ${line}\n`);
    stream.note(line);
  }

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
    let usage = null;               // last turn.completed usage (thread total, see codexTurnUsage)
    let threadId = null;            // the session id, for a later `exec resume`
    let nextHeartbeat = 25;
    let stderrTail = [];
    let streamError = null;         // lỗi Codex tự báo trong stream (turn.failed/error)
    let killedFor = null;
    let idleTimer = null;
    let drainTimer = null;
    let hardTimer = null;
    let exited = null;
    let settled = false;
    // Only the job's own ceiling earns a handoff rescue. An idle kill means the
    // process was stuck, and a resumed turn on a stuck thread buys nothing.
    let timedOut = false;

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

    const finish = async () => {
      if (settled) return;
      // Set before the rescue is awaited: `close` and the drain timer both call
      // finish, and the second call must not start a second rescue or a second
      // resolve while the first one is still waiting.
      settled = true;
      clearTimers();
      // Stop waiting on pipes a grandchild may still hold.
      child.stdout.destroy();
      child.stderr.destroy();

      // Cut at the hard timeout with no verdict on disk: one short turn on the
      // same thread to write `## Handoff` + `Status: CONTINUE`. Never longer
      // than the job itself was allowed, never quieter than its own watchdog.
      let handoffRescue = null;
      if (timedOut && threadId && !evidenceHasStatus(evidenceAbs)) {
        handoffRescue = await runHandoffRescue({
          args: buildArgs({
            workspace, model: options.model, effort, sandboxMode, resumeId: threadId,
            lastMessagePath: join(logDir, `${base}.codex-handoff-last-message.txt`),
          }),
          prompt: handoffRescuePrompt(relative(workspace, evidenceAbs).split(sep).join("/")),
          workspace,
          evidenceAbs,
          stream,
          hardMs: Math.min(HANDOFF_RESCUE_MS, timeoutMs),
          idleMs: Math.min(HANDOFF_RESCUE_IDLE_MS, idleMs),
        });
      }

      const endedAt = new Date().toISOString();
      const code = exited?.code ?? null;
      const signal = exited?.signal ?? null;
      // Insurance, and labelled as such: measured 23/09, `codex exec resume
      // <unknown-id>` exits 1 with "no rollout found for thread id ...", so
      // this branch is unreachable today. It exists because the neighbouring
      // runtime does the opposite -- agy warns on stderr, exits 0, and opens a
      // fresh conversation -- and a silent substitution is the one failure that
      // leaves no trace anywhere else. Three lines to make sure codex is not
      // the surface without the check if its behaviour ever moves.
      const resumeMismatch = Boolean(resumeId && threadId && threadId !== resumeId);
      // A rescued job was cut on purpose and then stopped in order: the timeout
      // is what CONTINUE means, not a runtime disagreeing with the evidence.
      const runtimeOk = !resumeMismatch && ((code === 0 && !killedFor) || Boolean(handoffRescue?.ok));
      const runtimeDetail = runtimeOk ? null
        : resumeMismatch ? `job xin tiếp thread ${resumeId} nhưng codex chạy ở thread ${threadId}`
          + " — phiên cũ không được nạp"
        : killedFor ? `codex killed: ${killedFor}`
        : codexExitDetail({ code, signal, streamError, stderrTail, threadId });

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
        // Carried so the failure path still records that a rescue was tried.
        if (handoffRescue) err.handoffRescue = handoffRescue;
        rejectRun(err);
        return;
      }

      resolveRun({
        worker: "codex",
        mode: "exec",
        model: options.model ?? null,
        effort,
        // Recorded so an investigation weeks later can tell what this job was
        // allowed to do. Without it the manifest cannot answer the first
        // question anyone asks about an incident.
        sandboxMode,
        codexVersion: version,
        startedAt: startedAt.toISOString(),
        endedAt,
        durationSec: Math.round((Date.parse(endedAt) - startedAt.getTime()) / 1000),
        streamEvents: events,
        // Same field old app-transport jobs carry in the manifest, so one name
        // answers "which session was this" for every job -- and a later
        // `--resume` reads the id from one place.
        conversationId: threadId,
        resumedFrom: resumeId ?? null,
        resumeMismatch: resumeMismatch || undefined,
        // Same field name old app-transport jobs carry, so the write-scope gate
        // reads one name whatever the transport was.
        touchedFiles: touched.size ? [...touched] : null,
        // Lượt cứu chạy sau lượt chính trên cùng thread, nên số của nó mới hơn.
        usage: handoffRescue?.usage ?? usage,
        exitCode: code,
        signal,
        killedFor,
        handoffRescue: handoffRescue ?? undefined,
        stream: streamPath,
        streamBroken: stream.broken,
        lastMessage: lastMessagePath,
        evidence: evidenceAbs,
        ...verdict,
      });
    };

    // Silence alone is not death: before killing, ask whether the codex process
    // tree is burning CPU, still receiving bytes, or holding a model connection
    // open (capped). Alive → note it, look again later.
    const liveness = options.liveness ?? createLivenessProbe(child.pid);
    const recheckMs = options.livenessRecheckMs ?? LIVENESS_RECHECK_MS;
    let lastEventAt = Date.now();
    let aliveKind = null;           // what kept the current silent stretch alive, noted once per kind
    const onIdle = async () => {
      if (killedFor || settled) return;
      const verdict = await liveness.check({ silentMs: Date.now() - lastEventAt });
      // An event may have arrived during the check: armIdle has already re-armed.
      if (killedFor || settled || Date.now() - lastEventAt < idleMs) return;
      const silentSec = Math.round((Date.now() - lastEventAt) / 1000);
      if (verdict.alive) {
        if (verdict.kind !== aliveKind) {
          aliveKind = verdict.kind;
          stream.note(`im ${silentSec}s nhưng còn sống: ${verdict.reason}`);
        }
        heartbeat(`silent ${silentSec}s, ${verdict.reason}`);
        idleTimer = setTimeout(onIdle, recheckMs);
        return;
      }
      kill(`no stdout event for ${silentSec}s — ${verdict.reason}`);
    };
    const armIdle = () => {
      lastEventAt = Date.now();
      aliveKind = null;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, idleMs);
    };

    const overall = setTimeout(() => {
      timedOut = true;
      kill(`exceeded ${timeout}`);
    }, timeoutMs);
    armIdle();

    child.stdout.on("data", (chunk) => {
      stream.write(chunk);
      const parts = (residual + chunk).split("\n");
      residual = parts.pop() ?? "";
      events += parts.filter(Boolean).length;
      for (const line of parts) {
        collectFileChange(line, touched);
        usage = codexTurnUsage(line, usage);
        streamError = collectCodexError(line, streamError);
        const next = collectThreadId(line, threadId);
        // Reported the moment it is known, not at the end: the job most worth
        // resuming is the one that died mid-flight, and its result object never
        // gets built. The CLI keeps it and patches it onto the failure and
        // SIGTERM paths, the same way it does for sandboxMode.
        if (next !== threadId) options.onThreadId?.(next);
        threadId = next;
      }
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

export function parseArgv(argv) {
  const out = {};
  const alias = {
    "prompt-file": "promptFile", "idle-timeout": "idle",
    "workspace-cli": "workspaceCli", "sandbox-mode": "sandboxMode", "workspace-profile": "workspaceProfile",
  };
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
export function needsHuman(result) {
  return Boolean(result.runtimeVerdict)
    || result.status === "done_unverified"
    || result.status === "blocked"
    || result.status === "needs_context"
    // Not a failure, but not done either: someone has to resume it.
    || result.status === "continue";
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
  let credentialDir = CREDENTIAL_STORE_DIR;
  let credentialsBefore = snapshotCredentialStore(credentialDir);
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
  /**
   * The permission level this job ran at, as a patch fragment.
   *
   * Resolved here rather than taken from the finished result, because the
   * result only exists on the success path -- and the jobs that lose the field
   * that way are exactly the killed, crashed and SIGTERM'd ones, which is the
   * population the field was added for. "What was this job allowed to do" is
   * the first question anyone asks about an incident, and an incident is never
   * the happy path.
   *
   * Null until resolved, so a run refused during validation records nothing
   * rather than claiming a level it never reached.
   */
  let sandboxMode = null;
  const sandboxPatch = () => (sandboxMode ? { sandboxMode } : {});

  // Which profile and whether its account was checked: the first two questions
  // after a wrong-account incident, so recorded on every way out like the rest.
  let workspaceInfo = null;
  const workspacePatch = () => workspaceInfo ?? {};

  // Same reasoning as sandboxMode, for the same population of jobs: a killed or
  // crashed run builds no result, so without this the one job anybody would
  // want to continue is the one whose session id was thrown away.
  let threadId = null;
  const threadPatch = () => (threadId ? { conversationId: threadId } : {});

  const credentialPatch = () => {
    const dir = displayCredentialDir(credentialDir);
    if (isWatchBlind(credentialsBefore)) return { credentialWatch: `blind:${dir}` };
    const changes = diffCredentialStore(credentialsBefore, snapshotCredentialStore(credentialDir));
    return changes.length ? { credentialTamper: changes.map((c) => ({ ...c, dir })) } : {};
  };

  // Whether `holds` moved since this job claimed its slot, as a patch fragment.
  // Sync like the credential check, so the signal handler can use it too. Empty
  // for a job this process never claimed: that one carries the fingerprint of an
  // earlier attempt, and holds legitimately changed in between.
  const holdsPatch = () => (claimed && opts.manifest && opts.job
    ? holdsTamperPatch(opts.manifest, Number(opts.job))
    : {});

  // The adapter exists so that a death is recorded rather than read as
  // `pending` forever -- and until now its own death was the one death nobody
  // recorded. A SIGTERM (session closed, supervisor stopping the tree) does not
  // pass through the catch below: Node exits straight away, leaving the job it
  // had just marked `running` marked `running` for good.
  //
  // Synchronous only, on purpose. A signal handler gets no await, so this uses
  // the already-imported updateJob path and writes one record, then re-raises
  // by exiting with the conventional 128+signal code.
  const recordSignal = (name, signo) => {
    if (opts.manifest && opts.job) {
      try {
        updateJobSync(opts.manifest, Number(opts.job), {
          status: "failed",
          startedAt: dispatchedAt,
          endedAt: new Date().toISOString(),
          failure: `adapter nhận ${name} trước khi job kết thúc`,
          ...sandboxPatch(),
          ...workspacePatch(),
          ...threadPatch(),
          // A job killed mid-flight is the most suspect one there is; skipping
          // the check here would leave exactly that group unexamined.
          ...credentialPatch(),
          ...holdsPatch(),
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
    // Refused before anything else and whether or not a manifest came with it:
    // a check inside the manifest branch would leave the adapter run by hand as
    // a way back to the transport.
    if (opts.mode === "app") {
      const { CODEX_HEADLESS_ONLY } = await import("./crew-manifest.mjs");
      throw new CodexRunError(CODEX_HEADLESS_ONLY);
    }
    mode = opts.mode ?? "headless";
    if (!MODES.has(mode)) {
      throw new CodexRunError(`unknown mode "${mode}"`, "use --mode headless");
    }
    // The guard watches the profile this job will mint from, re-taken before
    // anything spawns; the snapshot above only covered the default directory.
    if (opts.workspaceCli === "on") {
      credentialDir = workspaceProfileFor(opts).dir;
      credentialsBefore = snapshotCredentialStore(credentialDir);
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
        // Chặn resume vào conversation đang có job sống, trong khoá manifest.
        resumeId: typeof opts.resume === "string" && opts.resume.trim() ? opts.resume.trim() : null,
      });
      // Only a job this process actually claimed may be written by its failure
      // path. Without this, a refused second dispatch ("already running") fell
      // into the catch below and recorded the job as `failed` -- erasing the
      // FIRST invocation's `running` state and freeing its slot while it was
      // still working. A guard whose refusal gets overwritten by the caller's
      // own error handler is not a guard.
      claimed = true;
      // Cỡ brief vào sổ (mọi job, để đo); quá trần mềm thì thêm note và báo stderr.
      {
        const { briefSize, longBriefNote } = await import("./crew-guards.mjs");
        const { appendNote: noteJob } = await import("./crew-manifest.mjs");
        const bytes = briefSize(opts);
        const note = longBriefNote(bytes);
        try {
          if (bytes != null) updateJobSync(opts.manifest, Number(opts.job), { briefBytes: bytes });
          if (note) noteJob(opts.manifest, Number(opts.job), note);
        } catch { /* sổ chỉ là bookkeeping ở đây */ }
        if (note) console.error(`codex-run: ${note}`);
      }
    }
    // Set before dispatch so the failure paths above already have it. An absent
    // field then means only one thing -- a job from before this field existed.
    sandboxMode = resolveSandboxMode(opts);
    result = await codexRun({
      ...opts,
      onThreadId: (id) => { threadId = id; },
      onWorkspaceProfile: (info) => { workspaceInfo = info; },
    });
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
          ...(err.handoffRescue ? { handoffRescue: err.handoffRescue } : {}),
          ...sandboxPatch(),
          ...workspacePatch(),
          ...threadPatch(),
          ...credentialPatch(),
          ...holdsPatch(),
        });
      } catch (manifestErr) {
        console.error(`codex-run: could not record the failure in the manifest: ${manifestErr.message}`);
      }
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
        handoffRescue: result.handoffRescue,
        usage: result.usage ?? null,
        // Read off the stream's file_change events. It is an authorship signal
        // for the write-scope gate, and one-way -- a file named here is this
        // job's, a file not named here may still be.
        touchedFiles: result.touchedFiles,
        evidenceBytes: result.evidenceBytes,
        evidenceSha256: result.evidenceSha256,
        // Recorded so the collect step can find the log without guessing its name.
        stream: result.stream,
        lastMessage: result.lastMessage,
        // Same fragment the failure paths use, so one job cannot record the
        // level one way when it succeeds and another when it dies.
        ...sandboxPatch(),
        ...workspacePatch(),
        transportMode: result.mode,
        conversationId: result.conversationId,
        // Which session this job continued, recorded even when the answer is
        // "none". `conversationId` alone cannot answer it: that names the
        // session the job RAN in, which for a fresh job is also a new session.
        resumedFrom: result.resumedFrom ?? null,
        resumeMismatch: result.resumeMismatch,
        ...credentialPatch(),
        ...holdsPatch(),
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
