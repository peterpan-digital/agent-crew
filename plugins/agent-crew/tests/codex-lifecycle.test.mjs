#!/usr/bin/env node
/**
 * The lifecycle of the Codex adapter, driven by a fake codex the platform layer
 * is pointed at with AGENT_CREW_CODEX_BIN.
 *
 * Every case here is a failure shape that a real Codex run will not produce on
 * demand, and five of them are defects that shipped once: settling on `close`
 * hung forever behind a grandchild holding stdout, an oversized brief crashed on
 * EPIPE before the manifest was written, a broken log file crashed the adapter,
 * the watchdog re-armed on stderr chatter, and a retry appended into the
 * previous attempt's log.
 *
 * Dispatch goes through the real entrypoint -- `crew run --job N` -- because the
 * lifecycle around the adapter (claim a slot, run, record the outcome, choose an
 * exit code) is the half of this that keeps a death from reading as `pending`.
 *
 * Run: node tests/codex-lifecycle.test.mjs
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { addJob, claimRunSlot, createRun, readManifest } from "../lib/manifest.mjs";
import { resolveLogDir } from "../adapters/codex.mjs";
import {
  CREW_CLI, installFakeCodex, makeChecker, runRel, tmpWorkspace, under, writeFile,
} from "./helpers.mjs";

const t = makeChecker("codex-lifecycle");

/** A synchronous pause that needs neither `sleep` nor a shell. */
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function makeWorkspace(prefix, config = null) {
  const ws = tmpWorkspace(prefix);
  // Deterministic workspace resolution for `crew run`, which asks git first.
  execFileSync("git", ["init", "-q"], { cwd: ws });
  if (config) writeFile(join(ws, "crew.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  return ws;
}

const ws = makeWorkspace("lifecycle-");
const CODEX_BIN = installFakeCodex(join(ws, "fake-bin"));

/** One run with one codex job in it, plus the brief `crew run` expects to find. */
function openRun(workspace, runId, { evidence = "w.md", brief = "do the thing\n" } = {}) {
  const rel = runRel(runId);
  const { manifestPath } = createRun({
    runDir: join(workspace, ".crew", "runs", runId), runId,
    label: "lifecycle", workspace, evidenceRoot: rel, depth: 0,
  });
  const job = addJob(manifestPath, {
    worker: "codex", role: "assist", effort: "low", title: runId, evidence: under(rel, evidence),
  });
  writeFile(join(workspace, under(rel, `brief-codex-${job.seq}.md`)), brief);
  return { manifestPath, rel, evidence: under(rel, evidence), seq: job.seq };
}

/** Dispatches the way the skill does, and reports how it ended. */
function dispatch(workspace, run, { mode, extra = [], timeoutSec = 120, bin = CODEX_BIN }) {
  const started = Date.now();
  const proc = spawnSync(process.execPath, [
    CREW_CLI, "run",
    "--manifest", run.manifestPath,
    "--job", String(run.seq),
    "--timeout", `${timeoutSec}s`,
    ...extra,
  ], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_CREW_CODEX_BIN: bin,
      FAKE_MODE: mode,
      FAKE_EVIDENCE: join(workspace, run.evidence),
    },
    // A hang is the bug this file exists to catch, so the harness must outlive
    // the adapter's own deadline rather than the other way round.
    timeout: (timeoutSec + 30) * 1000,
  });
  return {
    exit: proc.status,
    seconds: Math.round((Date.now() - started) / 1000),
    stderr: proc.stderr ?? "",
    json: (() => { try { return JSON.parse(proc.stdout); } catch { return null; } })(),
  };
}

// --- the happy path, and where the log lands -------------------------------
{
  const run = openRun(ws, "ok", { evidence: "ok.md" });
  const ok = dispatch(ws, run, { mode: "ok" });
  t.check("a finished job exits 0", ok.exit, 0);
  t.check("...and its verdict comes off the evidence", ok.json?.status, "done");
  t.check("...and the codex version, captured before the run", Boolean(ok.json?.codexVersion), "true");
  t.check("...and the log is in a logs/ folder, not beside the evidence",
    ok.json?.stream.includes(join("runs", "ok", "logs")), "true");
  t.check("...so the run directory keeps only the evidence",
    existsSync(join(ws, ".crew", "runs", "ok", "ok.codex-stream.jsonl")), "false");
  t.check("...and the manifest records where the log went",
    readManifest(run.manifestPath).jobs[0].stream, ok.json?.stream);
}

// The rule is one line now: the log sits beside the evidence, in `logs/`. It is
// no longer derived from a task-folder layout, so there is one case, not two.
t.check("log dir: beside the evidence",
  resolveLogDir(join("/w", "a", "b", "w.md")), join("/w", "a", "b", "logs"));

// --- C1: a grandchild holding stdout must not hold the run open ------------
{
  const run = openRun(ws, "grandchild", { evidence: "grandchild.md" });
  const gc = dispatch(ws, run, { mode: "grandchild", extra: ["--idle-timeout", "60s"] });
  t.check("grandchild on stdout: still exits 0", gc.exit, 0);
  t.check("grandchild on stdout: settles in the drain window, not 30s", gc.seconds < 10, "true");
}

// --- C2: an oversized brief to a child that never reads stdin --------------
{
  // The brief ceiling is a repository decision now, so a workspace that raised
  // it is the only way this shape is reachable at all -- and it has to be
  // reachable, or the case measures the ceiling instead of the pipe.
  const bigWs = makeWorkspace("lifecycle-epipe-", { briefMaxBytes: 300_000 });
  const bin = installFakeCodex(join(bigWs, "fake-bin"));
  const run = openRun(bigWs, "epipe", { evidence: "epipe.md", brief: "x".repeat(200_000) });
  const epipe = dispatch(bigWs, run, { mode: "nodrain", bin });
  t.check("200KB brief + no reader: controlled failure, not a crash", epipe.exit, 1);
  t.check("...and the crash was not an uncaught EPIPE",
    epipe.stderr.includes("EPIPE") && epipe.stderr.includes("throw"), "false");
  // Proof the brief actually reached stdin: the run got as far as judging a
  // child that had already exited, rather than being refused over its size.
  t.check("...and the brief did clear the ceiling on its way to the pipe",
    epipe.stderr.includes("left no usable evidence"), "true");
}

// --- H2: the watchdog keys on stdout events, not stderr noise --------------
const idleRun = openRun(ws, "idle", { evidence: "idle.md" });
{
  const idle = dispatch(ws, idleRun, { mode: "stderr_only", extra: ["--idle-timeout", "3s"] });
  t.check("stderr chatter does not keep a dead job alive", idle.exit, 1);
  t.check("...and it is killed at the idle deadline", idle.seconds <= 10, "true");
}

// --- the manifest must record a death, which is why this adapter exists ----
{
  const job = readManifest(idleRun.manifestPath).jobs[0];
  t.check("a killed job is recorded as failed", job.status, "failed");
  t.check("...with a non-empty failure field", Boolean(job.failure), "true");
  t.check("...naming the real cause", job.failure.includes("no stdout event"), "true");
}

// --- M1: a retry must not append into the previous attempt's log -----------
{
  const retry = dispatch(ws, idleRun, { mode: "ok", extra: ["--idle-timeout", "3s"] });
  t.check("a leftover sidecar blocks a same-path retry", retry.exit, 1);
  t.check("...with a message naming the sidecar", retry.stderr.includes("sidecar from an earlier run"), "true");
}

// --- C3: the log is a debugging aid; losing it must not fail the job -------
{
  const run = openRun(ws, "broken-log", { evidence: "broken-log.md" });
  const logDir = resolveLogDir(join(ws, run.evidence));
  writeFile(join(logDir, ".keep"), "");
  // A dangling link: existsSync() follows it and answers "free", so the sidecar
  // guard lets the run start -- and then every append fails.
  symlinkSync("/nonexistent/dir/x", join(logDir, "broken-log.codex-stream.jsonl"));
  const brokenLog = dispatch(ws, run, { mode: "ok" });
  t.check("an unwritable log does not fail a finished job", brokenLog.json?.status, "done");
  t.check("...and the reason is recorded", String(brokenLog.json?.streamBroken).includes("ENOENT"), "true");
}

// --- M5: a job that needs a human must not ping as a clean success --------
{
  const run = openRun(ws, "blocked", { evidence: "blocked.md" });
  const blocked = dispatch(ws, run, { mode: "blocked" });
  t.check("BLOCKED exits 3, not 0", blocked.exit, 3);
  t.check("...and keeps the cost-gate verdict", blocked.json?.reportedStatus, "BLOCKED");
}
{
  const run = openRun(ws, "no-status", { evidence: "no-status.md" });
  const noStatus = dispatch(ws, run, { mode: "no_status" });
  t.check("evidence with no Status line also exits 3", noStatus.exit, 3);
}

// --- flags: a safety knob must not be silently ignored --------------------
{
  const run = openRun(ws, "typo", { evidence: "typo.md" });
  const typo = spawnSync(process.execPath, [
    CREW_CLI, "run", "--idle-timout", "1s", "--manifest", run.manifestPath, "--job", "1",
  ], { cwd: ws, encoding: "utf8" });
  t.check("a misspelled flag is refused", typo.status, 2);
  t.check("...and the message prints real CLI spellings",
    typo.stderr.includes("--idle-timeout") && !typo.stderr.includes("--promptFile"), "true");
  t.check("...without spawning anything", existsSync(join(ws, run.evidence)), false);
}

// --- a retry that works must not inherit the last attempt's failure -------
{
  // Seen live 2026-08-25: a job failed, was retried, succeeded -- and the stale
  // `failure` kept the collect gate flagging the clean result forever. A WARN
  // that fires on every retried job is one people stop reading.
  const run = openRun(ws, "retry-case", { evidence: "ok.md" });
  dispatch(ws, run, { mode: "stderr_only", extra: ["--idle-timeout", "3s"] });
  t.check("the failed attempt records a failure", Boolean(readManifest(run.manifestPath).jobs[0].failure), "true");

  // The adapter refuses to reuse a log path, so a retry needs the old sidecar
  // moved aside first. That guard is right -- two attempts interleaved into one
  // log destroys the evidence -- but it means "retry once" is not a thing an
  // operator can do without this step, which is why it is asserted here.
  const refused = dispatch(ws, run, { mode: "ok" });
  t.check("a retry over a live sidecar is refused", refused.exit, 1);
  t.check("...and the message says what to do", refused.stderr.includes("fresh evidence path"), "true");

  const moved = spawnSync(process.execPath, [
    CREW_CLI, "retry-log", "--manifest", run.manifestPath, "--job", String(run.seq),
  ], { cwd: ws, encoding: "utf8" });
  t.check("`crew retry-log` moves the attempt aside", moved.status, 0);

  dispatch(ws, run, { mode: "ok" });
  const after = readManifest(run.manifestPath).jobs[0];
  t.check("the successful retry clears it", after.failure, undefined);
  t.check("...and the job reads as done", after.status, "done");
  t.check("...while the history stays in notes", after.notes.length > 0, "true");
}

// --- a refused second dispatch must not erase the first one's claim ---------
{
  // Found by a crew job on 26/08, the day the parallel cap landed. The direct
  // test of claimRunSlot proved it refuses a second claim -- and stopped there.
  // What it could not see is what the LIFECYCLE does with that refusal: the
  // catch path recorded the job as `failed`, wiping the first invocation's
  // `running` state and handing its parallel slot to whoever asked next, while
  // the first job was still working. The refusal has to survive the refuser.
  const run = openRun(ws, "double-dispatch", { evidence: "w.md" });
  claimRunSlot(run.manifestPath, run.seq, { startedAt: new Date().toISOString(), timeoutMs: 900_000 });

  const second = dispatch(ws, run, { mode: "ok" });
  t.check("a second dispatch of a running job is refused", second.exit, 1);
  t.check("...saying it is already running", second.stderr.includes("already recorded as running"), "true");
  t.check("...and the first claim still stands", readManifest(run.manifestPath).jobs[0].status, "running");
  t.check("...with no failure written over it", readManifest(run.manifestPath).jobs[0].failure ?? null, null);
}

// --- the adapter's own death ------------------------------------------------
{
  // This lifecycle exists so that a death gets recorded instead of reading as
  // `pending` forever -- and its own death was the one nobody recorded. A
  // SIGTERM does not pass through a try/catch: Node exits, leaving the job it
  // marked `running` marked `running` for good.
  const run = openRun(ws, "hl-sig", { evidence: "x.md" });
  const child = spawn(process.execPath, [
    CREW_CLI, "run",
    "--manifest", run.manifestPath, "--job", String(run.seq),
    "--timeout", "25s", "--idle-timeout", "20s",
  ], {
    cwd: ws,
    env: {
      ...process.env,
      AGENT_CREW_CODEX_BIN: CODEX_BIN,
      // Emits only on stderr and never exits, so the dispatch is genuinely
      // mid-job -- with its event loop free -- when the signal lands.
      FAKE_MODE: "stderr_only",
      FAKE_EVIDENCE: join(ws, run.evidence),
    },
    stdio: "ignore",
  });
  const waitUntil = (fn, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (fn()) return true;
      sleep(200);
    }
    return false;
  };
  t.check("the dispatch marks the job running before working",
    waitUntil(() => readManifest(run.manifestPath).jobs[0].status === "running", 15_000), true);
  child.kill("SIGTERM");
  waitUntil(() => readManifest(run.manifestPath).jobs[0].status === "failed", 15_000);
  const killed = readManifest(run.manifestPath).jobs[0];
  t.check("a SIGTERMed dispatch records the job as failed", killed.status, "failed");
  t.check("...naming the signal as the cause", /SIGTERM/.test(killed.failure ?? ""), true);
  t.check("...so nothing is left reading as running", killed.status === "running", false);
}

// --- the codex binary is resolved through one place, and it is authoritative -
{
  // Searching past a path someone named would hand them a different binary than
  // the one they asked for, and then the manifest records a run against a CLI
  // nobody chose.
  const run = openRun(ws, "nobin", { evidence: "w.md" });
  const missing = dispatch(ws, run, { mode: "ok", bin: join(ws, "nope", "codex") });
  t.check("a codex override that points at nothing fails loudly", missing.exit, 1);
  t.check("...listing where it looked", missing.stderr.includes("probed:"), "true");
  t.check("...naming the variable to fix", missing.stderr.includes("AGENT_CREW_CODEX_BIN"), "true");
  t.check("...and never falling back to a codex on PATH", missing.json, "null");
}

process.exit(t.finish() ? 0 : 1);
