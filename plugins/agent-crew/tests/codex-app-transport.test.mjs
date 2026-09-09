#!/usr/bin/env node
/**
 * The Codex `app` transport, driven against a fake companion.
 *
 * Two things are being pinned here, and only one of them is the happy path.
 *
 * The first is that this transport never quietly becomes the other one. The
 * companion belongs to another project and lives outside the plugin, so
 * "missing" is an ordinary state -- and the tempting response, falling back to
 * headless, is the exact failure the harness exists to catch: the manifest
 * would say `app`, no thread would open, and nothing would say which record
 * lied.
 *
 * The second is that a failed app job still carries its diagnostics. Every
 * throw path asserts `codexVersion` below, because an earlier port of this
 * adapter lost that field on precisely the failure path -- the version is
 * captured to explain a run that went wrong, so recording it only when the run
 * goes right is worse than not recording it at all.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURES, RUN_ID, RUN_REL, installFakeCodex, makeChecker, tmpWorkspace, under,
} from "./helpers.mjs";
import { codexRun } from "../adapters/codex.mjs";
import { needsHuman } from "../lib/job-runner.mjs";
import { clearBinCache } from "../lib/platform.mjs";

const t = makeChecker("codex-app-transport");
const COMPANION = join(FIXTURES, "fake-companion.mjs");

/**
 * One app-transport run in its own workspace.
 *
 * `AGENT_CREW_CODEX_BIN` points at the fake codex CLI purely so
 * `codex --version` answers: the app transport never spawns codex to do the
 * work, but it does read the version to record it.
 */
async function runOnce(mode, { seq = 1, evidenceBody = null, companion = COMPANION } = {}) {
  const ws = tmpWorkspace(`codex-app-${mode}-`);
  const runAbs = join(ws, ".crew", "runs", RUN_ID);
  const state = join(ws, "fake-state");
  mkdirSync(state, { recursive: true });
  const evidenceRel = under(RUN_REL, `worker-codex-${seq}.md`);
  const evidenceAbs = join(ws, ".crew", "runs", RUN_ID, `worker-codex-${seq}.md`);
  const briefPath = join(runAbs, `brief-codex-${seq}.md`);
  writeFileSync(briefPath, "sửa cái gì đó và ghi evidence\n", "utf8");
  if (evidenceBody) writeFileSync(evidenceAbs, evidenceBody, "utf8");

  const saved = { ...process.env };
  // `resolveBin` caches by env-var NAME, not by its value, and each case here
  // installs its fake codex inside its own workspace and then deletes it. One
  // process running many cases is not how the plugin runs -- one crew process
  // dispatches one job -- so the cache is right in production and wrong only
  // here. Clearing it is the test's job, not a reason to change the cache.
  clearBinCache();
  Object.assign(process.env, {
    AGENT_CREW_CODEX_COMPANION: companion,
    AGENT_CREW_CODEX_BIN: installFakeCodex(join(ws, "bin")),
    FAKE_COMPANION_MODE: mode,
    FAKE_COMPANION_STATE: state,
    FAKE_COMPANION_EVIDENCE: evidenceAbs,
  });

  let result = null;
  let error = null;
  try {
    result = await codexRun({
      workspace: ws,
      evidenceRoot: RUN_REL,
      evidence: evidenceRel,
      promptFile: briefPath,
      timeout: "1m",
      effort: "medium",
      transport: "app",
    });
  } catch (err) {
    error = err;
  }

  const calls = existsSync(join(state, "calls.log"))
    ? readFileSync(join(state, "calls.log"), "utf8").trim().split("\n")
    : [];
  return {
    result, error, calls, ws, evidenceAbs,
    cleanup: () => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(ws, { recursive: true, force: true });
    },
  };
}

// --- A1: the happy path, end to end --------------------------------------
{
  const r = await runOnce("ok");
  t.check("an app job does not throw", r.error?.message ?? "none", "none");
  t.check("...and reports the transport it used", r.result?.transport, "app");
  t.check("...and is judged done", r.result?.status, "done");
  t.check("...off the evidence file's own verdict", r.result?.reportedStatus, "DONE");
  // The thread id lands in `conversationId`, the same field the Antigravity
  // app path fills, so the collect gate's provenance check needs no new branch.
  t.check("...with the thread id as provenance",
    r.result?.conversationId, "01a037ab-924f-7fe1-b76a-9bfd7e329ded");
  t.check("...and the codex version recorded", /^fake-codex/.test(r.result?.codexVersion ?? ""), true);
  t.check("...and the worker's reply saved to a file", existsSync(r.result?.lastMessage ?? ""), true);
  t.check("...containing what the worker said",
    /sửa xong/.test(readFileSync(r.result.lastMessage, "utf8")), true);
  // `rawOutput` is preferred over `rendered` because the footer the companion
  // appends is it talking to a human, not the worker's answer.
  t.check("...without the companion's resume footer",
    /resume in Codex/.test(readFileSync(r.result.lastMessage, "utf8")), false);
  t.check("...and the settle snapshot kept as an audit copy", existsSync(r.result?.statusFile ?? ""), true);
  t.check("...and the prompt kept as the record of what was asked",
    existsSync(r.result?.prompt ?? ""), true);
  t.check("...and the files the runtime says it touched", (r.result?.touchedFiles ?? []).join(","), "src/thing.js");
  t.check("no cancel on a job that settled cleanly", r.calls.includes("cancel"), false);
  r.cleanup();
}

// --- A2: a job that outlives its allowance is put down -------------------
{
  const r = await runOnce("timeout");
  t.check("a job that never settles fails", Boolean(r.error), true);
  // The cancel is the point of the case, not the throw: an abandoned
  // background job keeps writing to a workspace nobody is watching.
  t.check("...and the background job is cancelled", r.calls.includes("cancel"), true);
  t.check("...and the version survives onto the failure", /^fake-codex/.test(r.error?.runtimeFacts?.codexVersion ?? ""), true);
  t.check("...along with the companion job id", r.error?.runtimeFacts?.companionJobId, "fake-job-0001");
  t.check("...and the transport", r.error?.runtimeFacts?.transport, "app");
  r.cleanup();
}

// --- A3: a companion-reported failure with nothing on disk ---------------
{
  const r = await runOnce("failed-no-evidence");
  t.check("a failed job with no evidence throws", Boolean(r.error), true);
  t.check("...and says the companion called it failed", /failed/.test(r.error?.message ?? ""), true);
  t.check("...and still carries the codex version", /^fake-codex/.test(r.error?.runtimeFacts?.codexVersion ?? ""), true);
  t.check("...and the status the companion reported", r.error?.runtimeFacts?.companionStatus, "failed");
  t.check("...and the thread to go read", r.error?.runtimeFacts?.threadId, "01a037ab-924f-7fe1-b76a-9bfd7e329ded");
  r.cleanup();
}

// --- A4: evidence outranks the companion's own verdict -------------------
{
  // Same failed job, except this time the worker got its report written before
  // falling over. The report is the deliverable, so it wins -- but the
  // disagreement has to reach a human rather than being smoothed over.
  const r = await runOnce("failed-with-evidence");
  t.check("evidence written before the crash is not thrown away", r.error?.message ?? "none", "none");
  // The evidence's own verdict stands: it is the deliverable, and the runtime
  // saying otherwise does not un-write it.
  t.check("...and the evidence's verdict stands", r.result?.status, "done");
  // But the disagreement is recorded rather than resolved, and that is what
  // routes the job to a person -- exit 3, not exit 0.
  t.check("...while the disagreement is kept, not smoothed over",
    /failed/.test(String(r.result?.runtimeVerdict ?? "")), true);
  t.check("...and the job is routed to a human", needsHuman(r.result), true);
  r.cleanup();
}

// --- A5: a thin reply is a thin record, not a failed job -----------------
{
  const r = await runOnce("empty-reply");
  t.check("an empty reply does not fail the job", r.result?.status, "done");
  t.check("...and no reply file is invented", r.result?.lastMessage, "null");
  const r2 = await runOnce("result-unavailable");
  t.check("a result call that fails does not fail the job", r2.result?.status, "done");
  r.cleanup();
  r2.cleanup();
}

// --- A6: the store denying the id it just issued is tolerated, once ------
{
  const r = await runOnce("settle-race");
  t.check("a settle race is retried rather than failed", r.result?.status, "done");
  // Reported, not swallowed: a tolerated race whose frequency nobody can see
  // is a race nobody will ever fix.
  t.check("...and the retry is counted on the record", Number(r.result?.settleRetries) >= 1, true);
  t.check("...with the reason it retried", /store has not caught up/.test(r.result?.settleRaceWhy ?? ""), true);
  r.cleanup();
}

// --- A7: a dispatch that names no job is refused, not guessed -----------
{
  const r = await runOnce("no-jobid");
  t.check("a dispatch with no jobId throws", /returned no jobId/.test(r.error?.message ?? ""), true);
  // Nothing to cancel and nothing to follow, but the version is still the
  // thing that explains which companion behaved this way.
  t.check("...and still records the codex version", /^fake-codex/.test(r.error?.runtimeFacts?.codexVersion ?? ""), true);
  t.check("...and admits it has no job id", r.error?.runtimeFacts?.companionJobId, "null");
  r.cleanup();
}

// --- A8: no companion is an error, never a downgrade --------------------
{
  const r = await runOnce("ok", { companion: join(FIXTURES, "no-such-companion.mjs") });
  t.check("a companion that is not there fails the job", Boolean(r.error), true);
  t.check("...naming the env var that was set", /AGENT_CREW_CODEX_COMPANION/.test(r.error?.message ?? ""), true);
  // The assertion that matters: it did not run headless instead. A headless
  // run would have produced a result with transport "headless" rather than
  // throwing, and the manifest would then disagree with what happened.
  t.check("...and does NOT fall back to headless", r.result, "null");
  r.cleanup();
}

process.exit(t.finish() ? 0 : 1);
