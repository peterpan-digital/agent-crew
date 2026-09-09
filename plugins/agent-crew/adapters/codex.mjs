#!/usr/bin/env node
/**
 * Run one Codex job under the same contract as the Antigravity adapter.
 *
 * Why this exists rather than a "please run this" hand-off: a forwarder may not
 * poll, monitor, or fetch results, so a Codex job dispatched that way has no
 * timeout, no evidence gate, and nothing that records its outcome. Measured
 * once, that is not theoretical -- a Codex job died two minutes in, its record
 * carried no failure field at all, and the death was noticed twenty minutes
 * later.
 *
 * Everything below exists so that a job which dies cannot be silent:
 *   - settle on `exit`, not `close`. A model-generated shell command can leave a
 *     grandchild holding stdout, and `close` waits for every pipe to reach EOF:
 *     measured 6s late on a trivial case, unbounded in the general one. A child
 *     killed while a grandchild keeps the pipe open never fires `close` at all,
 *     which would hang past every timeout with the manifest stuck on "pending" --
 *     the exact shape of the failure this adapter was written to catch.
 *   - kill the whole process tree, not the pid, so that grandchild goes too.
 *   - an idle watchdog on stdout events, because the observed death was a
 *     process that stopped producing events while its state still read running.
 *   - a manifest write on the success path, the failure path, and every error
 *     path in between. An unrecorded crash reads as "pending" forever.
 *
 * The prompt goes in on stdin rather than argv: a brief is a file, and argv has
 * a length limit that a long brief can reach.
 *
 * Two transports share the contract above, selected by `options.transport`:
 *   - "headless" (the default): `codex exec`, spawned and watched directly, as
 *     described above.
 *   - "app": dispatched through `codex-companion.mjs` (lib/app/codex-companion.mjs)
 *     into a real thread in the Codex desktop app -- a persisted, resumable
 *     conversation rather than a one-shot process. Worth it for exactly three
 *     cases: a job that will hit a permission prompt a human must answer,
 *     open-ended work with no acceptance criteria written yet, or a thread to
 *     resume in a later session. See lib/manifest.mjs for why headless is the
 *     measured default for both roles regardless.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEFAULT_TIMEOUT,
  GuardError,
  assertEvidenceAbsent,
  judgeJob,
  parseDuration,
  readPrompt,
  validateEvidencePath,
} from "../lib/guards.mjs";
import { killTree, resolveBin, spawnTool, spawnToolSync } from "../lib/platform.mjs";
import { updateJob } from "../lib/manifest.mjs";
import {
  cancelJob,
  dispatchTask,
  fetchResult,
  resolveCompanion,
  waitForSettle,
} from "../lib/app/codex-companion.mjs";

/** A job that emits no stdout event for this long is treated as dead, not as thinking. */
const DEFAULT_IDLE_MS = 120_000;
/** Grace between the polite kill and the hard one. */
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

/** Transports this adapter answers to. Same two words lib/manifest.mjs records. */
const TRANSPORTS = new Set(["headless", "app"]);

/** Same reasoning as MAX_EVENT_BYTES: a truncated reply still says what happened. */
const MAX_REPLY_BYTES = 32 * 1024;

class CodexRunError extends GuardError {
  constructor(message, detail) {
    super(message, detail);
    this.name = "CodexRunError";
  }
}

/** Captured before the job starts: a flag that changed under us makes codex fail. */
function codexVersion(bin) {
  try {
    const proc = spawnToolSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
    return proc.status === 0 ? String(proc.stdout ?? "").trim() : null;
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
        process.stderr.write(`codex: stream log disabled (${err.message})\n`);
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
 * Where a job's raw log goes: a `logs/` folder beside the evidence.
 *
 * The stream log is large, noisy and disposable, while the evidence next to it
 * is the thing worth keeping -- so `crew new-run` drops a `.gitignore` in the
 * run directory that ignores exactly this folder. One rule, written once, in
 * the place it applies to; the manifest records the resulting path so nothing
 * downstream has to guess the name.
 */
export function resolveLogDir(evidenceAbs) {
  return join(dirname(evidenceAbs), "logs");
}

function buildArgs({ workspace, model, effort, lastMessagePath }) {
  const args = [
    "exec",
    "--json",                        // JSONL events: the heartbeat this adapter watches
    "-C", workspace,
    "--sandbox", "workspace-write",  // a worker writes inside the workspace, nowhere else
    "-o", lastMessagePath,
    "--color", "never",
  ];
  if (model) args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
  args.push("-");                    // read the prompt from stdin
  return args;
}

/** Inputs and guards, resolved before anything is spawned. */
function prepareRun(options) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const evidenceAbs = validateEvidencePath(options.evidence, workspace, options.evidenceRoot);
  const promptText = readPrompt(options);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const timeoutMs = parseDuration(timeout); // validates against the 30m ceiling
  const effort = options.effort ?? null;
  if (effort && !EFFORTS.has(effort)) {
    throw new CodexRunError(`unknown effort "${effort}"`, `use one of: ${[...EFFORTS].join(", ")}`);
  }

  assertEvidenceAbsent(evidenceAbs);

  const logDir = resolveLogDir(evidenceAbs);
  mkdirSync(logDir, { recursive: true });
  const base = basename(evidenceAbs).replace(/\.md$/, "");
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

function runHeadless(options) {
  const {
    workspace, evidenceAbs, promptText, timeout, timeoutMs, effort, logDir, base,
  } = prepareRun(options);
  const idleMs = options.idle ? parseDuration(options.idle) : DEFAULT_IDLE_MS;

  const streamPath = join(logDir, `${base}.codex-stream.jsonl`);
  const lastMessagePath = join(logDir, `${base}.codex-last-message.txt`);
  assertSidecarsAbsent([streamPath, lastMessagePath]);

  const bin = resolveBin("codex", { envOverride: "AGENT_CREW_CODEX_BIN" });
  const version = codexVersion(bin);
  const args = buildArgs({ workspace, model: options.model, effort, lastMessagePath });
  const stream = makeStreamWriter(streamPath);

  return new Promise((resolveRun, rejectRun) => {
    const startedAt = new Date();
    // The brief goes in on stdin, so nothing this harness did not author ever
    // reaches argv -- which is what makes a cmd shim safe to launch on Windows.
    const child = spawnTool(bin, args, {
      cwd: workspace,
      // The guard that stops a worker from reading the skill and dispatching.
      env: { ...process.env, AGENT_CREW_ROLE: "worker" },
      stdio: ["pipe", "pipe", "pipe"],
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
      process.stderr.write(`codex: ${note} events=${events} t=${elapsed()}s\n`);
    };

    // The whole tree, not the pid: killing only the child leaves a grandchild
    // holding stdout open, and then the reader waits past every timeout. On
    // Windows there is no process group to signal, so `killTree` shells out to
    // taskkill /T instead -- and there is no graceful stage there, which is why
    // the escalation below is allowed to be a no-op.
    const signalGroup = (sig) => {
      if (!killTree(child.pid, sig)) {
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
        // A job that produced no usable evidence is the case these facts exist
        // for: without them the ledger says "failed" and nothing about the
        // runtime that failed. `stream` matters most -- it is the path to the
        // raw log, and nothing else records it on this path.
        err.runtimeFacts = {
          codexVersion: version,
          stream: streamPath,
          streamEvents: events,
          exitCode: code,
          signal,
          killedFor,
          bin: bin.path,
        };
        rejectRun(err);
        return;
      }

      resolveRun({
        worker: "codex",
        mode: "exec",
        transport: "headless",
        model: options.model ?? null,
        effort,
        codexVersion: version,
        startedAt: startedAt.toISOString(),
        endedAt,
        durationSec: Math.round((Date.parse(endedAt) - startedAt.getTime()) / 1000),
        streamEvents: events,
        // Same field name the Antigravity adapter fills, so the
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
      const failure = new CodexRunError(
        `could not run codex: ${err.message}`,
        `resolved to ${bin.path}; check the install, or set AGENT_CREW_CODEX_BIN`,
      );
      // Nothing ran, so there is no version to report -- but which binary was
      // tried is the whole question when a spawn fails.
      failure.runtimeFacts = { bin: bin.path, stream: streamPath };
      rejectRun(failure);
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
 * Captures `codex --version` for the app transport, tolerating a missing
 * binary.
 *
 * Headless needs the `codex` binary to run at all, so `resolveBin` throwing
 * there correctly fails the job. The app transport never spawns `codex`
 * directly -- the companion does, wherever it likes -- so a `codex` this
 * machine cannot find is a fact worth recording, not a reason to refuse a run
 * that does not depend on it.
 */
function tryCodexVersion() {
  try {
    return codexVersion(resolveBin("codex", { envOverride: "AGENT_CREW_CODEX_BIN" }));
  } catch (err) {
    // Swallowed, but not silent. This field exists to explain a run that went
    // wrong, so `codexVersion: null` on a failed job is read as a fact -- "no
    // codex on this machine" -- when it has several possible causes, and the
    // likeliest one is a stale AGENT_CREW_CODEX_BIN pointing at a binary that
    // has moved. A null with no reason next to it sends the reader looking in
    // the wrong place.
    process.stderr.write(`codex: could not read codex --version: ${err.message}\n`);
    return null;
  }
}

/**
 * Puts the companion's job id in the manifest the moment it exists.
 *
 * A job whose adapter dies mid-flight -- the process killed, the machine
 * losing power -- is exactly the job whose id nobody can look up afterwards,
 * and without the id there is no way to ask the companion whether the work is
 * still running or long gone. The id has to outlive the process that learned
 * it, which is why this runs right after dispatch succeeds rather than being
 * folded into the result written at the end.
 *
 * Failure here is recorded, never thrown: a manifest write that failed does
 * not mean the dispatch failed, and the run has to keep going either way --
 * the alternative is cancelling a job that is already running because its own
 * bookkeeping could not be written.
 */
function registerCompanionJob(options, jobId) {
  if (!options.manifest || options.job == null) return;
  try {
    updateJob(options.manifest, Number(options.job), { companionJobId: jobId });
  } catch (err) {
    process.stderr.write(`codex: could not record the companion job id: ${err.message}\n`);
  }
}

/**
 * The app transport: dispatches through codex-companion.mjs into a real thread
 * in the Codex app, which is the whole point -- an owner job is one whose
 * evidence IS the deliverable, so the person who will be judged on it gets to
 * watch it being made, and a resumable thread survives past this process.
 *
 * The sequence, and why each step is where it is:
 *   1. Resolve the companion before spending anything. Throws rather than
 *      falling back to headless -- see resolveCompanion's own comment.
 *   2. Dispatch, then record the jobId immediately (registerCompanionJob),
 *      before anything else can go wrong.
 *   3. Wait for it to settle, with the crew's own timeout enforced
 *      independently of the companion's `--wait` (see waitForSettle). A call
 *      this adapter can no longer follow -- broker stuck, companion gone -- is
 *      a background job nobody is watching any more, so it is cancelled
 *      rather than abandoned.
 *   4. Fetch the reply text (fetchResult) and write it to disk the way
 *      headless's `-o lastMessagePath` does. Every failure here is recorded
 *      and swallowed: a missing reply is a thinner record, not a failed job.
 *   5. Judge last, never first: judgeJob() reads the evidence file, and the
 *      companion's own verdict is consulted only where guards.mjs says to.
 */
export async function runApp(options) {
  const {
    workspace, evidenceAbs, promptText, timeout, timeoutMs, effort, logDir, base,
  } = prepareRun(options);

  let companion;
  try {
    companion = resolveCompanion();
  } catch (err) {
    // Never fall back to headless. A manifest that says `app` while nothing
    // opened is exactly the silent-substitution failure this harness exists
    // to catch, and it would be invisible until someone went looking for a
    // thread that was never started.
    throw new CodexRunError(err.message, err.detail);
  }

  const promptPath = join(logDir, `${base}.codex-app-prompt.md`);
  const statusPath = join(logDir, `${base}.codex-app-status.json`);
  const replyPath = join(logDir, `${base}.codex-app-reply.md`);
  assertSidecarsAbsent([promptPath, statusPath, replyPath]);
  // The companion reads the prompt from a file, so it doubles as the audit
  // record of exactly what the worker was asked to do.
  writeFileSync(promptPath, promptText, "utf8");

  const version = tryCodexVersion();
  const startedAt = new Date();

  let jobId;
  let dispatchLogFile = null;
  try {
    const dispatched = dispatchTask(companion, {
      workspace, promptPath, model: options.model, effort,
    });
    jobId = dispatched.jobId;
    dispatchLogFile = dispatched.logFile;
  } catch (err) {
    err.runtimeFacts = {
      codexVersion: version, transport: "app",
      companionJobId: null, companionStatus: null, threadId: null, companionLog: null,
    };
    throw err;
  }

  process.stderr.write(`codex: app job ${jobId} queued, waiting up to ${timeout}\n`);
  // Has to survive this process dying, which is why it is written here rather
  // than with the rest of the result at the end.
  registerCompanionJob(options, jobId);

  let settled;
  try {
    settled = await waitForSettle(companion, jobId, { workspace, timeoutMs });
  } catch (err) {
    // The cancel below used to be reachable only through a settled snapshot.
    // So when `status --wait` itself hung or died -- broker stuck, companion
    // gone -- the adapter would record a failed job and walk away from a
    // background job that was still running, still writing, still burning
    // quota, with nobody watching it. A job this adapter can no longer follow
    // is a job it has to put down.
    try {
      cancelJob(companion, jobId, { workspace });
      process.stderr.write(`codex: cancelled ${jobId} after losing track of it\n`);
    } catch (cancelErr) {
      process.stderr.write(`codex: cancel ${jobId} failed: ${cancelErr.message}\n`);
    }
    err.runtimeFacts = {
      codexVersion: version, transport: "app", companionJobId: jobId,
      companionStatus: null, threadId: null, companionLog: dispatchLogFile,
    };
    throw err;
  }

  const { snapshot, job, timedOut, settleRetries, settleRaceWhy } = settled;

  try {
    writeFileSync(statusPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch { /* an audit copy must not fail a finished job */ }

  let cancelled = null;
  if (timedOut) {
    // Cancel before judging, so a job that outlived its allowance is not left
    // running against a workspace nobody is watching any more.
    try {
      cancelJob(companion, jobId, { workspace });
      cancelled = "cancelled after timeout";
    } catch (err) {
      cancelled = `cancel failed: ${err.message}`;
    }
    process.stderr.write(`codex: ${cancelled}\n`);
  }

  // Asked for even on a job the companion calls failed, and even after a
  // cancel: whatever the worker managed to say before it stopped is the most
  // useful thing there is for working out why.
  const reply = fetchResult(companion, jobId, { workspace });
  let replyError = reply.replyError;
  let lastMessage = null;
  if (reply.text) {
    const capped = Buffer.byteLength(reply.text, "utf8") > MAX_REPLY_BYTES
      ? `${reply.text.slice(0, MAX_REPLY_BYTES)}\n…[crew: truncated the rest]\n`
      : reply.text;
    try {
      writeFileSync(replyPath, capped.endsWith("\n") ? capped : `${capped}\n`, "utf8");
      lastMessage = replyPath;
    } catch (err) {
      replyError = `could not write reply file: ${err.message}`;
    }
  }
  if (replyError) process.stderr.write(`codex: ${replyError}\n`);

  const runtimeOk = job.status === "completed" && !timedOut;
  const runtimeDetail = runtimeOk ? null
    : timedOut ? `companion job did not settle within ${timeout} (status ${job.status}); ${cancelled}`
    : `companion job ${job.status}${job.errorMessage ? `: ${job.errorMessage}` : ""}`;

  // Evidence gets the first word even here: a job the companion calls `failed`
  // may still have written a complete report before it fell over. If it wrote
  // nothing, judgeJob throws and the caller records the failure -- which is
  // the whole reason this adapter exists.
  let verdict;
  try {
    verdict = judgeJob(evidenceAbs, {
      runtimeOk,
      runtimeDetail,
      context: `codex app job ${jobId}, thread ${job.threadId ?? "none"}, log at ${job.logFile ?? "unknown"}`,
    });
  } catch (err) {
    err.runtimeFacts = {
      codexVersion: version, transport: "app", companionJobId: jobId,
      companionStatus: job.status, threadId: job.threadId ?? null, companionLog: job.logFile ?? null,
    };
    throw err;
  }

  const endedAt = new Date().toISOString();
  return {
    worker: "codex",
    mode: "app",
    transport: "app",
    model: options.model ?? null,
    effort,
    codexVersion: version,
    startedAt: startedAt.toISOString(),
    endedAt,
    durationSec: Math.round((Date.parse(endedAt) - startedAt.getTime()) / 1000),
    // The provenance field the write-scope gate already reads for app-mode
    // jobs on the Antigravity side. Reusing the name means no new branch in
    // the gate to forget to update.
    conversationId: job.threadId ?? null,
    companionJobId: jobId,
    companionStatus: job.status,
    // How many times the store had to be re-asked before it would name a
    // status, and why. Recorded rather than swallowed: see waitForSettle.
    settleRetries: settleRetries || undefined,
    settleRaceWhy: settleRaceWhy ?? undefined,
    turnId: job.turnId ?? null,
    companionLog: job.logFile ?? null,
    statusFile: statusPath,
    prompt: promptPath,
    // Same field the headless path uses for the worker's final message, so a
    // reader of the result checks one name for both transports.
    lastMessage,
    // The companion's own exit status for the codex run, and the files it
    // says it wrote. Kept separate from `exitCode` because the gate reads
    // that one, and what this holds on a failed job has not been measured.
    companionExitStatus: reply.companionExitStatus,
    touchedFiles: reply.touchedFiles,
    replyError,
    // Null, not 0: this adapter did not spawn the process that exited. A fake
    // 0 here would claim a clean exit on behalf of something it never watched.
    exitCode: null,
    killedFor: timedOut ? runtimeDetail : null,
    evidence: evidenceAbs,
    ...verdict,
  };
}

/**
 * The one entrypoint dispatch.mjs calls. `options.transport` picks the
 * transport; "headless" is the default so every existing caller that has
 * never heard of `transport` keeps running exactly as before.
 */
export function codexRun(options) {
  const transport = options.transport ?? "headless";
  if (!TRANSPORTS.has(transport)) {
    throw new CodexRunError(`unknown transport "${transport}"`, `use one of: ${[...TRANSPORTS].join(", ")}`);
  }
  return transport === "app" ? runApp(options) : runHeadless(options);
}

export { CodexRunError };
