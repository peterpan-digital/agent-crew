#!/usr/bin/env node
/**
 * A stand-in for the codex companion, reached via CLAUDE_PLUGIN_ROOT.
 *
 * It exists for one assertion the real companion cannot make cheaply: that a
 * resume aimed at the wrong thread is refused BEFORE anything is dispatched.
 * Against the real companion a temp workspace always answers "no candidate",
 * which proves the empty case and nothing else -- and the dangerous case is the
 * other one, where a candidate exists and is the wrong thread.
 *
 * FAKE_CANDIDATE_THREAD sets the thread it claims --resume-last would continue;
 * unset means no resumable task.
 */
import { writeFileSync } from "node:fs";

const [, , subcommand] = process.argv;
const out = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

if (subcommand === "task-resume-candidate") {
  const threadId = process.env.FAKE_CANDIDATE_THREAD || null;
  out({
    available: Boolean(threadId),
    sessionId: "fake-session",
    candidate: threadId ? { id: "job_fake", status: "completed", threadId } : null,
  });
  process.exit(0);
}

if (subcommand === "task") {
  // Recorded because the argv IS the deliverable: deleting `--resume` from the
  // adapter's dispatch used to leave the whole suite green.
  if (process.env.FAKE_ARGV_OUT) {
    writeFileSync(process.env.FAKE_ARGV_OUT, process.argv.slice(2).join(" "), "utf8");
  }
  // Reaching here at all is the failure this fixture is built to catch: the
  // dispatch is the irreversible step. The adapter prints "app job <id> queued"
  // on seeing this reply, and that line -- not anything written here -- is what
  // the test observes: callCompanion captures a child's stderr rather than
  // passing it through.
  // A real companion's worker writes the evidence file. Without that the
  // adapter dies at judgeJob ("no usable evidence") and takes the failure path,
  // which conflates "the resume drifted" with "the job produced nothing" and
  // loses every field the success patch would have recorded.
  if (process.env.FAKE_EVIDENCE) {
    writeFileSync(process.env.FAKE_EVIDENCE, "work\n\nStatus: DONE\nSummary: ok\n", "utf8");
  }
  out({ jobId: "job_fake" });
  process.exit(0);
}

if (subcommand === "status") {
  // A settled job. FAKE_DISPATCH_THREAD is the thread the companion says it
  // actually ran in -- normally the one the probe promised, but settable to a
  // different value to reproduce the window closing between probe and dispatch.
  out({
    job: {
      id: "job_fake",
      status: "completed",
      threadId: process.env.FAKE_DISPATCH_THREAD || process.env.FAKE_CANDIDATE_THREAD || null,
      turnId: "turn_fake",
    },
  });
  process.exit(0);
}

if (subcommand === "result") {
  out({ storedJob: { result: { status: 0, rawOutput: "done", touchedFiles: [] } } });
  process.exit(0);
}

process.stderr.write(`fake-companion: unexpected subcommand ${subcommand}\n`);
process.exit(9);
