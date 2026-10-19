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
 * be running. Deciding that it failed is the dispatcher's call, not this
 * script's, because only the dispatcher knows whether the runtime is still up.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readManifest, updateJob, appendNote } from "./crew-manifest.mjs";
import { evidenceDigest, readWorkerStatus } from "./crew-guards.mjs";
import { probeCompanionJob, COMPANION_ACTIVE, COMPANION_TERMINAL } from "./crew-runtime-probe.mjs";
import { resolveCompanion } from "./codex-companion-path.mjs";

/**
 * The rule, learned from a real run: evidence with a valid Status line outranks
 * every status the runtime recorded -- including "failed".
 *
 * An app-mode job timed out at 8 minutes and was recorded as failed, but its
 * write was queued behind an approval step and landed afterwards. The evidence
 * on disk was complete and correct while the manifest called the job failed.
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

/**
 * Decide what a job with no evidence actually is, given the runtime's answer.
 *
 * The old rule was to leave every such job alone, and the reason was written
 * into this file: "only the dispatcher knows whether the runtime is still up".
 * That was true while the only inputs were the manifest and the filesystem.
 * Since the companion's job id is now recorded at dispatch instead of on the
 * return path, the runtime can be asked, so the missing knowledge is supplied
 * rather than the caution being dropped.
 *
 * Returns `null` for "still waiting, do not touch" -- which stays the answer
 * whenever the runtime says the work is live, or says nothing usable at all.
 * Silence is not death: a probe that errors leaves the job waiting.
 *
 * Pure on purpose. The classification is the part worth testing, and it should
 * not require a companion to exist in order to be exercised.
 */
export function classifyOrphan(job, probe) {
  if (!probe) return null;
  if (probe.error) return null;                       // no answer is not an answer
  if (probe.known === false) {
    return { kind: "unknown_to_runtime", why: "runtime không còn bản ghi nào cho job này" };
  }
  if (probe.known !== true) return null;

  // A live process outranks every status reading. This is the measurement the
  // whole rule rests on -- a running job carries a real pid, a finished one
  // carries none -- so whatever word the runtime uses, a live pid means the
  // work is still going. Checked before the status branches on purpose: an
  // unfamiliar status on a live process must not be able to reach a verdict.
  if (probe.alive === true) return null;

  if (COMPANION_ACTIVE.has(probe.status)) {
    // Missing pid on an "active" job: the runtime is tracking something that
    // no longer exists.
    if (probe.alive === null && probe.pid === null) {
      return { kind: "active_without_process", why: `runtime báo ${probe.status} nhưng không có tiến trình nào` };
    }
    if (probe.alive === false) {
      return { kind: "active_without_process", why: `runtime báo ${probe.status} nhưng pid ${probe.pid} đã chết` };
    }
    return null;
  }

  // A status this code does not recognise as finished is not a settlement.
  // Measured 25/08: a companion answer came back with no `status` field at all
  // while its job was still working -- and the old code read that silence as
  // settled, which would fail a live job. Only a word on the terminal
  // allowlist may justify that verdict.
  if (!COMPANION_TERMINAL.has(probe.status)) return null;

  // Settled, and nothing on disk. Note this is not read as a pass even when the
  // runtime says `completed`: a run that finished without writing its evidence
  // is the silent-success failure this harness exists to catch, and the only
  // thing that can grant a pass is the evidence file.
  return { kind: "settled_without_evidence", why: `runtime báo ${probe.status} nhưng không có evidence` };
}

/**
 * Tell the runtime to drop a job it still thinks is running.
 *
 * Opt-in, never automatic. Detecting an orphan is a reading; cancelling is a
 * change to something outside this repo, and the module's whole posture is that
 * reconcile reports and the dispatcher decides. The flag is the dispatcher
 * deciding.
 */
function cancelCompanionJob(jobId, workspace) {
  try {
    const companion = resolveCompanion();
    const proc = spawnSync(process.execPath, [companion, "cancel", jobId, "--json", "--cwd", workspace], {
      cwd: workspace, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, MWG_CREW_ROLE: "worker" },
    });
    if (proc.error) return `cancel thất bại: ${proc.error.message}`;
    if (proc.status !== 0) return `cancel exit ${proc.status}`;
    return null;
  } catch (err) {
    return `cancel thất bại: ${err.message}`;
  }
}

export function reconcileRun(manifestPath, { dryRun = false, cancelOrphans = false, probe = probeCompanionJob } = {}) {
  const abs = resolve(manifestPath);
  const manifest = readManifest(abs);
  const result = { runId: manifest.runId, patched: [], waiting: [], untouched: [], orphans: [] };

  for (const job of manifest.jobs) {
    const candidate = resolveEvidence(job, manifest.workspace);

    if (!candidate) {
      // No evidence yet. A job whose manifest status already records an outcome
      // is not probed: the question here is only about jobs still described as
      // bookkeeping, and re-litigating a recorded verdict is what this file
      // exists not to do.
      const orphan = BOOKKEEPING.has(job.status) && job.companionJobId
        ? classifyOrphan(job, probe(job.companionJobId, { workspace: manifest.workspace }))
        : null;

      if (!orphan) {
        // Still the old answer, and still for the old reason: the runtime says
        // the work is live, or it said nothing this code can act on.
        result.waiting.push({ seq: job.seq, status: job.status, evidence: job.evidence });
        continue;
      }

      let cancelled = null;
      if (cancelOrphans && orphan.kind === "active_without_process" && !dryRun) {
        cancelled = cancelCompanionJob(job.companionJobId, manifest.workspace) ?? "đã hủy ở runtime";
      }
      result.orphans.push({ seq: job.seq, from: job.status, kind: orphan.kind, why: orphan.why, cancelled });

      if (!dryRun) {
        updateJob(abs, job.seq, {
          status: "failed",
          // Same care as the evidence path: an invented end time at "now" would
          // hand this job a write window reaching the present, and the scope
          // gate would charge it with everything edited meanwhile.
          endedAt: job.endedAt ?? new Date().toISOString(),
          endedAtInferred: job.endedAt ? undefined : true,
          orphanKind: orphan.kind,
        });
        appendNote(abs, job.seq, `reconcile: ${job.status} → failed — ${orphan.why}${cancelled ? ` (${cancelled})` : ""}`);
      }
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
        // Ở đây reconcile chính là người chấm, nên nó ghim bản đã chấm. Thiếu dòng này,
        // một worker app còn sống sau timeout ghi tiếp evidence mà gate không thấy.
        evidenceSha256: evidenceDigest(candidate),
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
        // clean pass. Bước 7 tells the dispatcher to re-run collect while jobs
        // are live, which made the final gating run the one that lost the flag.
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const manifestPath = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const cancelOrphans = args.includes("--cancel-orphans");
  if (!manifestPath) {
    console.error("usage: crew-reconcile.mjs <manifest.json> [--dry-run] [--cancel-orphans]");
    process.exit(2);
  }
  try {
    const r = reconcileRun(manifestPath, { dryRun, cancelOrphans });
    const verb = dryRun ? "sẽ sửa" : "đã sửa";
    for (const p of r.patched) console.log(`${verb} job ${p.seq}: ${p.from} → ${p.to} (${p.reported ?? "không có dòng Status"})`);
    for (const o of r.orphans) {
      console.log(`${verb} job ${o.seq}: ${o.from} → failed — ${o.why}`);
      if (o.cancelled) console.log(`   ${o.cancelled}`);
      else if (o.kind === "active_without_process") console.log(`   runtime vẫn giữ job này; chạy lại với --cancel-orphans để bỏ`);
    }
    for (const w of r.waiting) console.log(`chờ job ${w.seq}: chưa có evidence tại ${w.evidence}`);
    for (const u of r.untouched) console.log(`giữ nguyên job ${u.seq} (${u.status}): ${u.why}`);
    if (r.patched.length === 0 && r.waiting.length === 0 && r.orphans.length === 0) console.log("manifest đã khớp với evidence, không cần sửa");
  } catch (err) {
    console.error(`crew-reconcile: ${err.message}`);
    process.exit(1);
  }
}
