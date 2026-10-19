#!/usr/bin/env node
/**
 * A stand-in for the Codex plugin's codex-companion.mjs.
 *
 * It exists because the app transport cannot be tested against the real thing:
 * that would need the Codex app running, would cost tokens, and could not be
 * made to fail on demand. The failure shapes are the point of these tests.
 *
 * The JSON shapes below were measured against companion 1.0.5 on 2026-08-25 --
 * a fixture invented from the plan's guesses would have tested the wrong
 * contract, which is exactly what nearly shipped:
 *   task --background --json  ->  { jobId, status, title, summary, logFile }
 *   status <id> --wait --json ->  { workspaceRoot, job, waitTimedOut, timeoutMs }
 *   result <id> --json        ->  { job, storedJob: { ..., result, rendered } }
 *   storedJob.result          ->  { status, threadId, rawOutput, touchedFiles, reasoningSummary }
 *
 * Driven by env so the adapter's own argv stays untouched:
 *   FAKE_COMPANION_MODE     ok | failed | timeout | no_job_id | not_json | crash
 *                           | status_hang -- `status --wait` really blocks, so a test
 *                             can signal the adapter while it is genuinely waiting
 *                           | status_dead -- `status --wait` itself dies with a
 *                             message that is NOT "No job found", i.e. the adapter
 *                             has lost track of a job that may still be running
 *   FAKE_COMPANION_RESULT   ok (default) | empty | crash | no_result
 *                           -- the reply lookup fails independently of the job,
 *                              because a job can succeed and still lose its text
 *   FAKE_COMPANION_EVIDENCE absolute path the fake "worker" writes
 *   FAKE_COMPANION_BODY     what it writes there ("" writes nothing)
 *   FAKE_COMPANION_MARKER   file that records which subcommands were called
 *   FAKE_COMPANION_RACE     none (default) | no_job_found:<n> | no_status:<n>
 *                           | no_status_waited:<n>  -- same missing status, but
 *                             waitTimedOut true: the call did wait, so this is
 *                             a broken answer rather than a store catching up
 *                           -- the two shapes measured when two app jobs were
 *                              dispatched in the same instant: the store either
 *                              denies the id it just handed out, or answers with
 *                              a job carrying no `status` at all. Stateful: it
 *                              misbehaves for the first <n> `status` calls and
 *                              then answers normally, because that is what the
 *                              real thing does -- the condition settles.
 *   FAKE_COMPANION_RACE_STATE  file used to count those calls across processes
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

const mode = process.env.FAKE_COMPANION_MODE ?? "ok";
const [cmd, ...rest] = process.argv.slice(2);
const marker = process.env.FAKE_COMPANION_MARKER;

if (marker) appendFileSync(marker, `${cmd}\n`);

const JOB_ID = "task-fake-0001";
const THREAD_ID = "01a037ab-924f-7fe1-b76a-9bfd7e329ded";

function say(value) {
  console.log(JSON.stringify(value, null, 2));
  process.exit(0);
}

if (cmd === "task") {
  if (mode === "crash") {
    process.stderr.write("fake-companion: codex is not available\n");
    process.exit(1);
  }
  if (mode === "not_json") {
    console.log("Queued.");
    process.exit(0);
  }
  if (mode === "no_job_id") say({ status: "queued", title: "Codex Task" });

  // The real worker writes the evidence; the fake does it at dispatch time
  // because there is no separate process here to do it later.
  const evidence = process.env.FAKE_COMPANION_EVIDENCE;
  const body = process.env.FAKE_COMPANION_BODY ?? "";
  if (evidence && body) {
    mkdirSync(dirname(evidence), { recursive: true });
    writeFileSync(evidence, body, "utf8");
  }
  say({ jobId: JOB_ID, status: "queued", title: "Codex Task", summary: "fake", logFile: "/tmp/fake.log" });
}

if (cmd === "status") {
  if (mode === "status_hang") {
    // Actually blocks, unlike `timeout` which returns waitTimedOut immediately.
    // A test that wants to signal the adapter mid-wait needs the adapter to
    // really be mid-wait; otherwise it signals a process that already finished
    // and the assertion passes for the wrong reason.
    spawnSync("sleep", ["30"]);
    process.exit(1);
  }
  if (mode === "status_dead") {
    // Not the "No job found" shape: that one is tolerated as a store catching
    // up. This is the companion or broker falling over while a background job
    // is still alive.
    process.stderr.write("broker connection reset\n");
    process.exit(2);
  }
  // The dispatch race, replayed. Counting happens on disk because each fake
  // invocation is its own process, exactly as the real companion is.
  const [raceKind, raceTimes] = (process.env.FAKE_COMPANION_RACE ?? "none").split(":");
  if (raceKind === "no_job_found" || raceKind === "no_status" || raceKind === "no_status_waited") {
    const statePath = process.env.FAKE_COMPANION_RACE_STATE;
    let seen = 0;
    if (statePath) {
      try { seen = Number(readFileSync(statePath, "utf8").trim()) || 0; } catch { seen = 0; }
      writeFileSync(statePath, String(seen + 1), "utf8");
    }
    // Parsed, not coerced: `Number(x) || 1` turns an explicit ":0" into one
    // misbehaviour, which is the opposite of what ":0" asks for.
    const times = raceTimes === undefined ? 1 : Number(raceTimes);
    if (seen < (Number.isFinite(times) ? times : 1)) {
      if (raceKind === "no_job_found") {
        process.stderr.write(`No job found for "${rest[0]}". Run /codex:status to list known jobs.\n`);
        process.exit(1);
      }
      // Measured shape: a job object with no `status` and no `threadId`, and
      // waitTimedOut false -- the call returned without having waited.
      say({
        workspaceRoot: process.cwd(),
        job: { id: JOB_ID, phase: "starting", kindLabel: "job", progressPreview: [], elapsed: "0s", duration: null },
        waitTimedOut: raceKind === "no_status_waited",
        timeoutMs: Number(rest[rest.indexOf("--timeout-ms") + 1]) || 0,
      });
    }
  }
  const active = mode === "timeout";
  say({
    workspaceRoot: process.cwd(),
    job: {
      id: JOB_ID,
      status: active ? "running" : (mode === "failed" ? "failed" : "completed"),
      phase: active ? "working" : "done",
      threadId: THREAD_ID,
      turnId: "01a037ab-a252-7ed0-bf3c-d8996a8c1fa2",
      errorMessage: mode === "failed" ? "the worker fell over" : null,
      logFile: "/tmp/fake.log",
    },
    waitTimedOut: active,
    timeoutMs: Number(rest[rest.indexOf("--timeout-ms") + 1]) || 0,
  });
}

if (cmd === "result") {
  const rmode = process.env.FAKE_COMPANION_RESULT ?? "ok";
  if (rmode === "crash") {
    process.stderr.write(`fake-companion: no job found for "${rest[0]}"\n`);
    process.exit(1);
  }
  // A payload with no storedJob.result is its own case: the companion answered,
  // it just has nothing stored for this job.
  if (rmode === "no_result") say({ job: { id: JOB_ID }, storedJob: { id: JOB_ID } });
  say({
    job: { id: JOB_ID, status: "completed", threadId: THREAD_ID },
    storedJob: {
      id: JOB_ID,
      result: {
        status: 0,
        threadId: THREAD_ID,
        rawOutput: rmode === "empty" ? "" : "Xong. Đã ghi evidence.\n\n- Status: DONE\n",
        touchedFiles: rmode === "empty" ? [] : [process.env.FAKE_COMPANION_EVIDENCE ?? "/tmp/fake-evidence.md"],
        reasoningSummary: [],
      },
      rendered: rmode === "empty" ? "" : "Xong. Đã ghi evidence.\n\nResume in Codex: codex resume x\n",
    },
  });
}

if (cmd === "cancel") say({ jobId: JOB_ID, status: "cancelled", title: "Codex Task" });

process.stderr.write(`fake-companion: unknown command ${cmd}\n`);
process.exit(2);
