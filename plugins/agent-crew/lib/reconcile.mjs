#!/usr/bin/env node
/**
 * Repair a run manifest from the evidence on disk.
 *
 * A job can finish its work and still leave the manifest stale: the runtime
 * that was carrying it can die between the worker writing evidence and the
 * bookkeeping being recorded. That happened for real -- a Codex subagent was
 * killed when its parent process exited, after the worker had already written
 * a complete report. The work was not lost; only the manifest was wrong.
 *
 * The rule this encodes: evidence on disk outranks the manifest. But the repair
 * is deliberately narrow -- it only fills in jobs that never reached a terminal
 * state, and never rewrites a verdict that was already recorded. A reconcile
 * that could overwrite results would be a second way to lose them.
 *
 * A job with no evidence file is left alone and reported as such: it may still
 * be running. Deciding that it failed is not this file's call -- the collect
 * gate does it on the clock, by comparing the silence against the job's own
 * timeout, and reports it as STALE for a human to abandon deliberately.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readManifest, updateJob, appendNote } from "./manifest.mjs";
import { readWorkerStatus } from "./guards.mjs";

/**
 * The rule, learned from a real run: evidence with a valid Status line outranks
 * every status the runtime recorded -- including "failed".
 *
 * A job timed out at 8 minutes and was recorded as failed, but its write was
 * queued behind an approval step and landed afterwards. The evidence on disk
 * was complete and correct while the manifest called the job failed.
 * A reconcile that respected "failed" would have preserved exactly the wrong
 * answer.
 *
 * Two things keep this from becoming a way to lose results: a job is only
 * patched when its evidence carries a real Status line, and a job whose status
 * already came from that evidence (reportedStatus is set) is left alone.
 */
/** States that record no outcome, so patching over them is not a disagreement. */
const BOOKKEEPING = new Set(["pending", "running"]);

/** Verdicts that already mean "passed"; reconcile must not rewrite these. */
const TERMINAL_PASS = new Set(["done", "done_with_concerns", "done_verified_manually"]);

/**
 * Where a job's evidence actually is.
 *
 * Resolution is against the run's own workspace, never `process.cwd()`. A
 * cwd-relative lookup made the verdict depend on where the command was invoked
 * from: the same finished job read as PASS from the repo root and as unfinished
 * from anywhere else -- and in a second checkout with the same layout it would
 * have read a different tree's file entirely.
 */
export function resolveEvidence(job, workspace) {
  const declared = resolve(workspace, job.evidence);
  return existsSync(declared) ? declared : null;
}

export function reconcileRun(manifestPath, { dryRun = false } = {}) {
  const abs = resolve(manifestPath);
  const manifest = readManifest(abs);
  const result = { runId: manifest.runId, patched: [], waiting: [], untouched: [] };

  for (const job of manifest.jobs) {
    const candidate = resolveEvidence(job, manifest.workspace);

    if (!candidate) {
      // No evidence yet, so there is nothing on disk to reconcile against. The
      // job may be working; saying it failed here would be a guess dressed as a
      // record. The clock-based call belongs to the collect gate.
      result.waiting.push({ seq: job.seq, status: job.status, evidence: job.evidence });
      continue;
    }

    const verdict = readWorkerStatus(candidate);
    if (job.reportedStatus) {
      result.untouched.push({ seq: job.seq, status: job.status, why: "đã đọc từ evidence trước đó" });
      continue;
    }
    // A verdict that already says the job passed is left alone even without a
    // reportedStatus field. Overwriting it can only lose information: a run
    // recorded as done_verified_manually -- a human read the artifact after the
    // runtime cried ERROR -- was being rewritten to a plain done, throwing away
    // both the fact that it was checked and the disagreement worth showing.
    if (TERMINAL_PASS.has(job.status)) {
      result.untouched.push({ seq: job.seq, status: job.status, why: "đã có phán quyết đậu, không ghi đè" });
      continue;
    }
    if (!verdict.reported) {
      result.untouched.push({ seq: job.seq, status: job.status, why: "evidence không có dòng Status" });
      continue;
    }

    result.patched.push({
      seq: job.seq, from: job.status, to: verdict.status,
      reported: verdict.reported, evidence: candidate,
    });
    if (!dryRun) {
      updateJob(abs, job.seq, {
        status: verdict.status,
        reportedStatus: verdict.reported,
        endedAt: job.endedAt ?? new Date().toISOString(),
        // A filled-in end time is bookkeeping, not an observation, and it must
        // say so: the write-scope check derives each job's interval from it, and
        // an invented end at "now" gave a job that died an hour ago a window
        // reaching the present -- which then charged it with everything the user
        // edited meanwhile.
        endedAtInferred: job.endedAt ? undefined : true,
        // Persisted, not just printed. The collect gate raises a WARN on this
        // disagreement, and it used to read it from the ephemeral patch list --
        // so the first collect flagged the job and a second collect showed a
        // clean pass. The dispatcher is told to re-run collect while jobs are
        // live, which made the final gating run the one that lost the flag.
        // `pending` and `running` are excluded: those are bookkeeping states --
        // one written by addJob, one by the adapter before it spawns -- not a
        // runtime claiming the opposite of the evidence. Reporting "manifest
        // ghi running, evidence phán DONE" as a disagreement would put a WARN on
        // every job whose adapter died after the worker finished, which is the
        // ordinary case reconcile exists to repair.
        disagreement: BOOKKEEPING.has(job.status) ? undefined
          : `manifest ghi ${job.status}, evidence phán ${verdict.reported}`,
      });
      appendNote(abs, job.seq, `reconcile: ${job.status} → ${verdict.status} theo evidence trên đĩa`);
    }
  }
  return result;
}
