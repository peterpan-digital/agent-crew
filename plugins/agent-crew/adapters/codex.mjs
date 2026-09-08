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
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
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

export function codexRun(options) {
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

export { CodexRunError };
