#!/usr/bin/env node
/**
 * One job's lifecycle, shared by both adapters.
 *
 * This used to be copy-pasted into each adapter's own CLI block, and the copies
 * had already drifted: one recorded a field the other did not, and only one of
 * them handled a signal. The sequence is identical for every worker, so it is
 * written once here:
 *
 *   1. stamp the dispatch time BEFORE anything spawns, so a job that dies still
 *      carries a duration;
 *   2. claim a parallel slot inside the manifest lock, or refuse;
 *   3. run the adapter;
 *   4. record the outcome -- on the success path, the failure path, and the
 *      signal path. An unrecorded death reads as `pending` forever, which is
 *      the failure this whole harness exists to catch;
 *   5. return an exit code, because a background dispatch makes the exit code
 *      the only ping the dispatcher gets.
 *
 * Step 4 is deliberately outside the try that wraps step 3: once the job has
 * finished, a manifest write that fails is a bookkeeping problem and must never
 * be reported as a failed job.
 */
import { DEFAULT_TIMEOUT, parseDuration } from "./guards.mjs";
import {
  claimRunSlot, readManifest, recordUnclaimedFailure, updateJob,
} from "./manifest.mjs";

/**
 * Result fields copied onto the job record.
 *
 * A whitelist rather than a spread: a result also carries things that are not
 * bookkeeping (the worker's reply text, for one), and a spread would put worker
 * output into the manifest -- where the collect gate would then print it.
 */
const RECORDED_FIELDS = [
  "status", "reportedStatus", "runtimeVerdict", "model", "effort",
  "startedAt", "endedAt", "exitCode", "signal", "streamEvents",
  "touchedFiles", "evidenceBytes", "stream", "lastMessage",
  "conversationId", "codexVersion", "agentDurationSec", "usage",
  "promptMode", "killedFor", "bin",
];

/** Exit 3: the job finished but a human has to look before it counts. */
export function needsHuman(result) {
  return Boolean(result.runtimeVerdict)
    || result.status === "done_unverified"
    || result.status === "blocked"
    || result.status === "needs_context";
}

function recordOutcome(manifestPath, seq, result) {
  const priorJob = readManifest(manifestPath).jobs.find((j) => j.seq === seq) ?? {};
  const prior = [
    ...(priorJob.notes ?? []),
    // Carried over before `failure` is cleared below, or a retry would erase
    // the only record that an earlier attempt died.
    ...(priorJob.failure ? [`lượt trước fail: ${priorJob.failure}`] : []),
  ];
  const patch = {
    // A retry that succeeded must not inherit the previous attempt's failure:
    // the field would keep firing a WARN on a job that is now clean, and a WARN
    // that cries on every retried job is one people learn to scroll past. The
    // history stays in `notes`, which is append-only.
    failure: undefined,
    notes: result.runtimeVerdict
      ? [...prior, `runtime báo fail (${result.runtimeVerdict}) nhưng evidence tự phán ${result.reportedStatus} — cần người đọc`]
      : prior,
  };
  for (const field of RECORDED_FIELDS) {
    if (result[field] !== undefined) patch[field] = result[field];
  }
  updateJob(manifestPath, seq, patch);
}

/**
 * Run one job end to end. `adapter` is an async function taking the options and
 * returning a result; everything around it is bookkeeping.
 *
 * Returns the process exit code. It does not call process.exit, so the CLI
 * entrypoint stays the only place that does.
 */
export async function runJob({ name, adapter, opts, log = console }) {
  const manifestPath = opts.manifest ?? null;
  const seq = opts.job != null ? Number(opts.job) : null;
  const tracked = Boolean(manifestPath && Number.isInteger(seq));
  let claimed = false;
  let result = null;
  const dispatchedAt = new Date().toISOString();

  // A SIGTERM (session closed, supervisor stopping the tree) does not pass
  // through the catch below: Node exits straight away, leaving a job that was
  // just marked `running` marked `running` for good. The handler is synchronous
  // on purpose -- a signal handler gets no await -- so it writes one record and
  // re-raises with the conventional 128+signo code.
  const recordSignal = (signalName, signo) => {
    if (tracked) {
      try {
        updateJob(manifestPath, seq, {
          status: "failed",
          startedAt: dispatchedAt,
          endedAt: new Date().toISOString(),
          failure: `adapter nhận ${signalName} trước khi job kết thúc`,
        });
      } catch { /* nothing left to do about it from inside a signal */ }
    }
    log.error(`${name}: ${signalName} — đã ghi job là failed`);
    process.exit(128 + signo);
  };
  process.on("SIGTERM", () => recordSignal("SIGTERM", 15));
  process.on("SIGINT", () => recordSignal("SIGINT", 2));
  process.on("SIGHUP", () => recordSignal("SIGHUP", 1));

  try {
    if (tracked) {
      // Recorded before the job spawns, not after it returns. A job that is
      // still working has no result to write, so without this the manifest
      // shows it as `pending` with no start time -- and the collect gate cannot
      // tell a live job from one that never launched, nor attribute any file it
      // writes while it runs. `timeoutMs` goes down for the same reason: the
      // gate needs this job's own allowance to decide when silence means death.
      claimRunSlot(manifestPath, seq, {
        startedAt: dispatchedAt,
        timeoutMs: parseDuration(opts.timeout ?? DEFAULT_TIMEOUT),
      });
      // Only a job this process actually claimed may be written by its failure
      // path. Without this, a refused second dispatch ("already running") falls
      // into the catch below and records the job as `failed` -- erasing the
      // FIRST invocation's `running` state and freeing its slot while it is
      // still working. A guard whose refusal gets overwritten by the caller's
      // own error handler is not a guard.
      claimed = true;
    }
    result = await adapter(opts);
  } catch (err) {
    if (tracked) {
      try {
        const record = claimed ? updateJob : recordUnclaimedFailure;
        record(manifestPath, seq, {
          status: "failed",
          startedAt: dispatchedAt,
          endedAt: new Date().toISOString(),
          failure: err.message,
        });
      } catch (manifestErr) {
        log.error(`${name}: could not record the failure in the manifest: ${manifestErr.message}`);
      }
    }
    log.error(`${name}: ${err.message}`);
    return 1;
  }

  if (tracked) {
    try {
      recordOutcome(manifestPath, seq, result);
    } catch (manifestErr) {
      log.error(
        `${name}: job finished ${result.status} but the manifest was not updated: ${manifestErr.message}\n` +
        `  → the evidence at ${result.evidence} is valid; re-run the manifest update, not the job`,
      );
      log.log(JSON.stringify(result, null, 2));
      return 2; // distinct from 1: the job worked, the bookkeeping did not
    }
  }

  // A runtime that disagreed with self-judging evidence must be said out loud,
  // not resolved quietly in either direction.
  if (result.runtimeVerdict) {
    log.error(
      `${name}: the runtime disagreed with the evidence (${result.runtimeVerdict})\n` +
      `  → evidence judged itself ${result.reportedStatus}; a human must read ${result.evidence}`,
    );
  }
  // A worker that skipped the contract's Status line cannot be judged silently.
  if (result.status === "done_unverified") {
    log.error(`${name}: evidence has no "Status:" line, so the outcome is unverified\n  → ${result.evidence}`);
  }
  log.log(JSON.stringify(result, null, 2));
  return needsHuman(result) ? 3 : 0;
}
