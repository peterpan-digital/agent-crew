/**
 * A stand-in for `codex-companion.mjs`, the openai-codex plugin's runtime.
 *
 * The real companion belongs to another project, drives a real Codex app
 * thread, and costs a real run to exercise. It also cannot be asked to produce
 * a failure shape on demand -- and the shapes that matter here are exactly the
 * ones a healthy companion never emits: a store that denies the id it just
 * issued, a `--wait` that returns with the job still running, an empty reply, a
 * dispatch with no jobId.
 *
 * Node rather than a shell script, and invoked through `process.execPath` the
 * same way the adapter invokes the real companion, so this runs on Windows too.
 *
 * FAKE_COMPANION_MODE picks the shape. FAKE_COMPANION_STATE is a directory used
 * for the little state a multi-call protocol needs: the issued job id, how many
 * times `status` has been asked, and a log of every subcommand, which is how a
 * test asserts that a cancel actually happened.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_COMPANION_MODE ?? "ok";
const stateDir = process.env.FAKE_COMPANION_STATE ?? "";
const evidencePath = process.env.FAKE_COMPANION_EVIDENCE ?? "";
const JOB_ID = "fake-job-0001";
const THREAD_ID = "01a037ab-924f-7fe1-b76a-9bfd7e329ded";

const statePath = join(stateDir, "state.json");
const callsPath = join(stateDir, "calls.log");

function readState() {
  if (!existsSync(statePath)) return { statusCalls: 0 };
  try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return { statusCalls: 0 }; }
}
function writeState(s) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(s), "utf8");
}
function logCall(name) {
  if (!stateDir) return;
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(callsPath, `${name}\n`, "utf8");
}
const out = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exit(0);
};
const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

const sub = argv[0];

// --- task: queue a background job -----------------------------------------
if (sub === "task") {
  logCall("task");
  const promptFile = argv[argv.indexOf("--prompt-file") + 1];
  if (!promptFile || !existsSync(promptFile)) die("no prompt file", 2);

  if (mode === "no-jobid") out({ status: "queued", title: "t", summary: "s" });
  if (mode === "dispatch-fails") die("companion could not reach the app-server", 3);

  writeState({ statusCalls: 0 });
  // The real companion's worker is what writes the evidence file, so a mode
  // that leaves it absent is how "the job ran and produced nothing" is tested.
  const writesEvidence = !["failed-no-evidence", "timeout"].includes(mode);
  if (writesEvidence && evidencePath) {
    writeFileSync(evidencePath, "đã sửa xong\n\nStatus: DONE\nSummary: ok\nConcerns/Blockers: none\n", "utf8");
  }
  out({ jobId: JOB_ID, status: "queued", title: "fake", summary: "fake", logFile: join(stateDir, "job.log") });
}

// --- status --wait: block until the job settles ---------------------------
if (sub === "status") {
  logCall("status");
  const state = readState();
  state.statusCalls = (state.statusCalls ?? 0) + 1;
  writeState(state);

  // The measured race: the store denies an id it issued moments ago. Only the
  // first ask fails, so a tolerated retry succeeds and the adapter reports how
  // many it needed.
  if (mode === "settle-race" && state.statusCalls === 1) die(`no job found for id ${JOB_ID}`, 1);
  if (mode === "no-status") out({ workspaceRoot: process.cwd(), job: {}, waitTimedOut: true, timeoutMs: 1000 });
  if (mode === "timeout") {
    out({
      workspaceRoot: process.cwd(),
      job: { id: JOB_ID, status: "running", threadId: THREAD_ID, logFile: join(stateDir, "job.log") },
      waitTimedOut: true,
      timeoutMs: 1000,
    });
  }
  if (mode === "failed-no-evidence" || mode === "failed-with-evidence") {
    out({
      workspaceRoot: process.cwd(),
      job: { id: JOB_ID, status: "failed", errorMessage: "worker died", threadId: THREAD_ID },
      waitTimedOut: false,
      timeoutMs: 1000,
    });
  }
  out({
    workspaceRoot: process.cwd(),
    job: { id: JOB_ID, status: "completed", threadId: THREAD_ID, logFile: join(stateDir, "job.log") },
    waitTimedOut: false,
    timeoutMs: 1000,
  });
}

// --- result: what the worker said -----------------------------------------
if (sub === "result") {
  logCall("result");
  if (mode === "result-unavailable") die("store read failed", 4);
  if (mode === "empty-reply") {
    out({ job: { id: JOB_ID }, storedJob: { result: { status: 0, threadId: THREAD_ID, rawOutput: "   " }, rendered: "" } });
  }
  if (mode === "no-stored-result") out({ job: { id: JOB_ID } });
  out({
    job: { id: JOB_ID },
    storedJob: {
      result: {
        status: 0,
        threadId: THREAD_ID,
        rawOutput: "Tôi đã sửa xong và ghi evidence.",
        touchedFiles: ["src/thing.js"],
      },
      rendered: "Tôi đã sửa xong và ghi evidence.\n\n— resume in Codex",
    },
  });
}

// --- cancel ---------------------------------------------------------------
if (sub === "cancel") {
  logCall("cancel");
  if (mode === "cancel-fails") die("cancel refused", 5);
  out({ ok: true, jobId: JOB_ID });
}

die(`fake-companion: unknown subcommand ${JSON.stringify(sub)}`, 2);
