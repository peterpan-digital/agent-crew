#!/usr/bin/env node
/**
 * Everything the app transport needs to talk to `codex-companion.mjs`: where it
 * lives, and the thin call/parse layer around its CLI.
 *
 * The companion is the runtime underneath the openai-codex marketplace plugin's
 * `codex-rescue` subagent, and it is the only way into a real Codex app thread
 * (a persisted, resumable conversation, as opposed to a one-shot `codex exec`).
 * It is another project's code at a version this plugin does not control, so
 * every function here treats its output the way you would treat any external
 * API response: parsed defensively, with a named error when a field has moved,
 * never an `undefined` that travels three call frames before something throws.
 *
 * The crew calls it directly rather than going through the marketplace's own
 * subagent. Not because that subagent's transport is bad -- it drives the same
 * app-server turn -- but because `agents/codex-rescue.md` forbids the subagent
 * from polling, monitoring, fetching results, or cancelling. A dispatcher that
 * may not look is how a Codex job can die two minutes in and not be noticed for
 * twenty: the exact failure this whole plugin exists to catch.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnToolSync } from "../platform.mjs";

const REL = join("scripts", "codex-companion.mjs");

/** Companion CLI subcommands report while a job is still going. */
const COMPANION_ACTIVE = new Set(["queued", "running"]);

/** Dispatch is a queue insert, not the job itself: it should answer in seconds. */
export const COMPANION_DISPATCH_TIMEOUT_MS = 120_000;
/** Slack on top of the job's own ceiling, so a hung companion still returns. */
export const COMPANION_WAIT_SLACK_MS = 60_000;
/**
 * `result` reads a finished job out of the companion's own store, so it is a
 * lookup, not work. Kept short and deliberately non-fatal to the caller: the
 * reply text is a record, and a job that already wrote valid evidence must not
 * be failed for losing it.
 */
export const COMPANION_RESULT_TIMEOUT_MS = 30_000;
/** Cancel should be fast; a companion that cannot even cancel in a minute is gone. */
export const COMPANION_CANCEL_TIMEOUT_MS = 60_000;

/**
 * How long after dispatch the companion's job store is allowed to contradict
 * itself, and how often to re-ask inside that window.
 *
 * Measured 2026-08-25 against companion 1.0.5: two app jobs dispatched in the
 * same instant both died about fifteen seconds in, in two different ways -- one
 * `status --wait` denied the very id the dispatch had just returned, the other
 * answered with a job carrying no `status` at all. Staggering the two dispatch
 * commands by five seconds made both pass, so the condition is a race in the
 * companion's store and it settles on its own.
 *
 * The window is wall-clock rather than a plain attempt count, and that is the
 * load-bearing part: `status --wait` blocks until the job settles, so retrying
 * on attempts alone could turn one eight-minute wait into three. A call that
 * actually waited is already past this window and will not be retried.
 */
const SETTLE_RACE_WINDOW_MS = 45_000;
const SETTLE_RETRY_DELAY_MS = 3_000;

export class CodexCompanionError extends Error {
  constructor(message, detail) {
    super(detail ? `${message}\n  ${detail}` : message);
    this.name = "CodexCompanionError";
    this.detail = detail;
  }
}

/**
 * Marketplace path only, plus an explicit env override.
 *
 * `~/.claude/plugins/cache/` is deliberately not probed. Measured 2026-08-25:
 * the cache path carries a version segment
 * (`cache/openai-codex/codex/1.0.5/scripts/...`), so probing it means writing a
 * semver sort to pick "the newest" -- and the newest copy on disk is not
 * necessarily the one actually running. A machine that only has the cache sets
 * AGENT_CREW_CODEX_COMPANION by hand: one explicit line beats a guessing
 * function.
 *
 * Built from `os.homedir()` + `path.join` rather than a POSIX-style string, so
 * the same candidate resolves correctly on Windows (`~` is not a shell
 * expansion Node understands, and the separator differs).
 */
export function companionCandidates(env = process.env, home = homedir()) {
  const out = [];
  if (env.CLAUDE_PLUGIN_ROOT) out.push(join(env.CLAUDE_PLUGIN_ROOT, REL));
  out.push(join(home, ".claude", "plugins", "marketplaces", "openai-codex", "plugins", "codex", REL));
  return out;
}

/**
 * Throws rather than falling back to headless. Silently switching transport is
 * the exact class of failure this harness exists to catch: the manifest would
 * say `app`, no chat box would open, and nobody would know which one lied.
 *
 * The companion is an optional dependency -- it ships in a different plugin --
 * so an absent one is not a bug in this plugin, and the error says exactly what
 * to install rather than surfacing as a stack trace three calls later.
 */
export function resolveCompanion(env = process.env, home = homedir()) {
  // An explicit override is authoritative. If someone names a path and it is
  // not there, that is the error -- searching on would hand them a different
  // companion than the one they asked for, which is the same silent
  // substitution this function refuses everywhere else.
  if (env.AGENT_CREW_CODEX_COMPANION) {
    if (existsSync(env.AGENT_CREW_CODEX_COMPANION)) return env.AGENT_CREW_CODEX_COMPANION;
    throw new CodexCompanionError(
      "AGENT_CREW_CODEX_COMPANION points at nothing",
      `probed:\n    ${env.AGENT_CREW_CODEX_COMPANION}\n` +
        "  → fix AGENT_CREW_CODEX_COMPANION, or unset it to use the marketplace install",
    );
  }
  const candidates = companionCandidates(env, home);
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  throw new CodexCompanionError(
    "could not find codex-companion.mjs",
    `probed:\n${candidates.map((p) => `    ${p}`).join("\n")}\n` +
      '  → install the "codex" plugin from the openai-codex marketplace (it ships codex-companion.mjs),\n' +
      "    or set AGENT_CREW_CODEX_COMPANION to its absolute path",
  );
}

/**
 * One companion call. Launched via `process.execPath`, never a shebang and
 * never a shell: `.mjs` has no exec bit story on Windows, and a shell would
 * have to be handed the worker's brief on a command line, where `&`, `|`, and
 * `%VAR%` are live.
 *
 * Parsed defensively on purpose: this is another project's CLI, so a field
 * that moved must produce a named error rather than an `undefined` that
 * travels three functions before it fails. A future companion version printing
 * a banner before the JSON must not read as a protocol break either, so the
 * fallback tries again from the first `{`.
 */
export function callCompanion(companionPath, args, { workspace, timeoutMs, what, env = {} }) {
  // `viaNode: true` is what makes `platform.mjs#buildLaunch` route this through
  // `process.execPath` instead of trying to execute the file directly.
  const bin = { path: companionPath, viaNode: true, viaCmd: false };
  const proc = spawnToolSync(bin, args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: timeoutMs,
    // Same recursion guard as the headless path: the detached worker the
    // companion spawns inherits this env, so the Codex process running the job
    // reads the skill as a worker and refuses to dispatch further.
    env: { ...process.env, AGENT_CREW_ROLE: "worker", ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
  const stderrTail = String(proc.stderr ?? "").trim().slice(-600);
  if (proc.error?.code === "ETIMEDOUT" || (proc.signal && proc.status === null)) {
    throw new CodexCompanionError(
      `companion ${what} did not return within ${Math.round(timeoutMs / 1000)}s`,
      stderrTail || "no stderr",
    );
  }
  if (proc.error) {
    throw new CodexCompanionError(`could not run the companion: ${proc.error.message}`, companionPath);
  }
  if (proc.status !== 0) {
    throw new CodexCompanionError(`companion ${what} exited ${proc.status}`, stderrTail || "no stderr");
  }
  const raw = String(proc.stdout ?? "");
  const candidates = [raw, raw.slice(raw.indexOf("{"))];
  for (const text of candidates) {
    try { return JSON.parse(text); } catch { /* try the next shape */ }
  }
  throw new CodexCompanionError(`companion ${what} did not print JSON`, raw.trim().slice(0, 600));
}

/**
 * Queue a real thread in the Codex app.
 *
 * Measured 2026-08-25 against companion 1.0.5:
 *   task --background --json -> { jobId, status: "queued", title, summary, logFile }
 *
 * `--write` is always passed, not made conditional on role: every crew job has
 * to write its own evidence file, so a read-only app job could never satisfy
 * the evidence gate at all. This also keeps the two transports on one
 * contract -- headless already runs `--sandbox workspace-write`.
 */
export function dispatchTask(companionPath, {
  workspace, promptPath, model, effort, timeoutMs = COMPANION_DISPATCH_TIMEOUT_MS,
}) {
  const args = [
    "task", "--background", "--json",
    "--prompt-file", promptPath,
    "--cwd", workspace,
    "--write",
  ];
  if (model) args.push("-m", model);
  if (effort) args.push("--effort", effort);

  const queued = callCompanion(companionPath, args, { workspace, timeoutMs, what: "task dispatch" });
  const jobId = queued?.jobId;
  if (typeof jobId !== "string" || !jobId) {
    throw new CodexCompanionError(
      "companion dispatch returned no jobId",
      `got: ${JSON.stringify(queued).slice(0, 400)}`,
    );
  }
  return { jobId, logFile: typeof queued.logFile === "string" ? queued.logFile : null };
}

/** Whether a companion failure is the store denying an id it just issued. */
function isJobNotFound(err) {
  return /no job found/i.test(`${err?.message ?? ""} ${err?.detail ?? ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a job to settle, tolerating a store that has not caught up yet.
 *
 * `--wait` blocks inside the companion until the job settles, which is a real
 * completion signal this transport did not have to fake by polling the
 * evidence file. The timeout ceiling is still enforced independently of it,
 * via `callCompanion`'s own process timeout (`timeoutMs + slack`): `--wait`
 * itself can outlive a dead broker, and a call that never returns cannot be
 * the only thing standing between a hung companion and a hung crew job.
 *
 * Only the two race shapes measured above are tolerated, and only inside
 * `SETTLE_RACE_WINDOW_MS` of the first ask. Everything else still throws on
 * the first failure: a broad retry here would turn a real dead job into a slow
 * dead job, and this transport exists so that a dead job is never mistaken for
 * a slow one.
 *
 * Returns `{ snapshot, job, timedOut, settleRetries, settleRaceWhy }`. `job` is
 * guaranteed to carry a string `.status`; `timedOut` folds together the two
 * ways a job can still be unsettled -- the companion's own `waitTimedOut` flag,
 * and a job whose status is still `queued`/`running` despite `--wait` having
 * returned. `settleRetries` is returned rather than swallowed: a tolerated race
 * whose frequency nobody can see is a race nobody will fix.
 */
export async function waitForSettle(companionPath, jobId, { workspace, timeoutMs }) {
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
      snapshot = callCompanion(companionPath, args, {
        workspace, timeoutMs: timeoutMs + COMPANION_WAIT_SLACK_MS, what: `status --wait for ${jobId}`,
      });
    } catch (err) {
      // Anything but the store denying its own id is a real failure.
      if (!isJobNotFound(err)) throw err;
      failure = err;
      why = "the companion's store has not caught up with the id it just issued";
    }

    if (snapshot) {
      if (typeof snapshot?.job?.status === "string") {
        const job = snapshot.job;
        const timedOut = Boolean(snapshot.waitTimedOut) || COMPANION_ACTIVE.has(job.status);
        return { snapshot, job, timedOut, settleRetries: retries, settleRaceWhy: retries ? why : null };
      }
      // A job with no status is only transient when the call did not wait out
      // its allowance. If it did wait the whole window and still has no
      // status, that is a broken answer, not a store catching up.
      if (snapshot.waitTimedOut === true) {
        throw new CodexCompanionError(
          "companion status returned no job.status",
          `got: ${JSON.stringify(snapshot).slice(0, 400)}`,
        );
      }
      why = "the companion answered with a job that has no status yet";
    }

    if (Date.now() >= deadline) {
      const detail = failure ? (failure.detail ?? failure.message) : `got: ${JSON.stringify(snapshot).slice(0, 400)}`;
      throw new CodexCompanionError(
        `companion never gave job ${jobId} a status within ${Math.round(SETTLE_RACE_WINDOW_MS / 1000)}s of dispatch (${why})`,
        detail,
      );
    }
    retries += 1;
    process.stderr.write(`codex: ${why}, retrying in ${SETTLE_RETRY_DELAY_MS / 1000}s (attempt ${retries})\n`);
    await sleep(SETTLE_RETRY_DELAY_MS);
  }
}

/**
 * Puts down a job the crew can no longer follow, or one that outlived its
 * allowance. Thin wrapper; the caller decides what a cancel failure means for
 * the run (it must never itself block judging the evidence).
 */
export function cancelJob(companionPath, jobId, { workspace, timeoutMs = COMPANION_CANCEL_TIMEOUT_MS } = {}) {
  return callCompanion(companionPath, ["cancel", jobId, "--json", "--cwd", workspace], {
    workspace, timeoutMs, what: `cancel ${jobId}`,
  });
}

/**
 * Brings a finished app job's reply text back, the way headless's
 * `-o lastMessagePath` already does. Without this the app transport threw the
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
 * Two things measured here that were not expected going in. `result.status` is
 * a real exit status (0 on both jobs), so "nothing here exited" was too
 * strong -- but what it holds on a failed job is unmeasured, so it is returned
 * in a field of its own (`companionExitStatus`) rather than folded into
 * anything the write-scope or evidence gate reads. And `result.touchedFiles`
 * is a per-job list of files the runtime says it wrote: an authorship signal
 * the write-scope gate otherwise has no access to for this transport.
 *
 * Every failure here is returned, not thrown: a missing reply is a thinner
 * record, not a failed job. This function does not write anything to disk --
 * the caller owns the reply path and its own truncation policy, the same way
 * it owns every other sidecar.
 */
export function fetchResult(companionPath, jobId, { workspace, timeoutMs = COMPANION_RESULT_TIMEOUT_MS } = {}) {
  const out = { text: null, companionExitStatus: null, touchedFiles: null, replyError: null };
  let payload;
  try {
    payload = callCompanion(companionPath, ["result", jobId, "--json", "--cwd", workspace], {
      workspace, timeoutMs, what: `result ${jobId}`,
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
  out.text = text;
  return out;
}
