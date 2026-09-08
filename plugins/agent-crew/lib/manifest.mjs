#!/usr/bin/env node
/**
 * The run manifest is the only shared mutable state in a crew run: the
 * dispatcher appends jobs, several workers finish at unpredictable times, and
 * the collect step reads it. So every mutation goes through a lock and lands
 * via tmp+rename, never a partial write that a concurrent reader could see.
 *
 * Layout: {runRoot}/runs/{runId}/manifest.json
 */
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, rmSync,
  existsSync, statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { toPosix } from "./platform.mjs";

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;

/**
 * Every manifest this build writes carries every field the gate asks about, so
 * a missing `exitCode` means "no runtime vouched for this evidence" rather than
 * "written before that field existed". The version is still recorded, and the
 * gate still reads it, so a future field can be introduced the same way.
 */
export const MANIFEST_VERSION = 1;

class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
}

function lockPath(manifestPath) {
  return `${manifestPath}.lock`;
}

/**
 * mkdir is the atomic primitive available on every filesystem here. A lock
 * older than LOCK_STALE_MS is assumed to be from a crashed process, because no
 * legitimate manifest mutation reads or writes for that long.
 */
function acquireLock(manifestPath) {
  const lock = lockPath(manifestPath);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      // Stamp ownership: a slow holder whose lock got reclaimed as stale must
      // not later delete the lock its successor is holding.
      const token = `${process.pid}:${randomUUID()}`;
      writeFileSync(join(lock, "owner"), token, "utf8");
      return { lock, token };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released while we looked; retry immediately
      }
      if (age > LOCK_STALE_MS) {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch { /* another process won the cleanup race */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new ManifestError(
          `timed out waiting ${LOCK_WAIT_MS}ms for the manifest lock at ${lock}\n` +
          `  → if no crew run is active, remove that directory and retry`,
        );
      }
      // Busy-wait deliberately: this is a sub-second contention window and the
      // callers are synchronous CLI scripts, not an event loop.
      const until = Date.now() + LOCK_POLL_MS;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

/** Only release a lock we still own; a reclaimed lock now belongs to someone else. */
/** True while the lock on disk still carries our stamp. */
function ownsLock(lock, token) {
  try {
    return readFileSync(join(lock, "owner"), "utf8") === token;
  } catch {
    return false; // gone, or reclaimed and re-stamped by someone else
  }
}

function releaseLock(lock, token) {
  if (!ownsLock(lock, token)) return; // not ours to remove
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch { /* already gone */ }
}

export function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    throw new ManifestError(`no manifest at ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ManifestError(`manifest at ${manifestPath} is not valid JSON: ${err.message}`);
  }
  // Older manifests stay readable. Strict equality here meant that bumping the
  // constant made every run already on disk unreadable -- collect and reconcile
  // would throw on the entire history the moment a new field was added. Only a
  // version this script has never heard of is refused, because that one may
  // carry fields whose absence it would misread.
  if (!Number.isInteger(parsed.version) || parsed.version > MANIFEST_VERSION) {
    throw new ManifestError(
      `manifest version ${parsed.version} is newer than this script understands (max ${MANIFEST_VERSION})\n` +
      `  → update the crew's own scripts instead of editing the manifest`,
    );
  }
  // Below 1 is not "an older manifest", it is a malformed one. Version 0 used
  // to read as ancient history, which silenced the provenance warning that only
  // fires from version 2 up -- so a hand-edited 0 bought quieter output.
  if (parsed.version < 1) {
    throw new ManifestError(`manifest version ${parsed.version} is not a real version (min 1)`);
  }
  return parsed;
}

/** tmp+rename so a reader never observes a half-written manifest. */
export function writeManifest(manifestPath, manifest) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(tmp, manifestPath);
  } catch (err) {
    // A partial tmp file left in the run directory looks like run output.
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw err;
  }
  return manifestPath;
}

/** Read-modify-write under the lock. `mutate` receives and returns the manifest. */
export function updateManifest(manifestPath, mutate) {
  const { lock, token } = acquireLock(manifestPath);
  try {
    const manifest = readManifest(manifestPath);
    const next = mutate(manifest) ?? manifest;
    next.updatedAt = new Date().toISOString();
    // Check ownership again, right before writing. A holder slower than
    // LOCK_STALE_MS gets its lock reclaimed; the successor then reads, mutates
    // and writes -- and the slow holder used to write its own stale snapshot
    // on top, silently erasing the successor's work. Losing the lock means
    // losing the right to write, so this refuses instead of overwriting.
    if (!ownsLock(lock, token)) {
      throw new ManifestError(
        `lost the manifest lock at ${lock} before writing (mutation took over ${LOCK_STALE_MS}ms)\n` +
        "  → không ghi đè bản của process kế nhiệm; chạy lại thao tác này",
      );
    }
    writeManifest(manifestPath, next);
    return next;
  } finally {
    releaseLock(lock, token);
  }
}

/**
 * MAX_DEPTH is the second half of the recursion guard. AGENT_CREW_ROLE stops a
 * worker that reads the skill and tries to dispatch; this stops a run that got
 * created anyway. Depth 0 is the dispatcher, depth 1 is a worker sub-run that a
 * human deliberately asked for; deeper than that is a loop, not a plan.
 */
export const MAX_DEPTH = 1;

/**
 * Run-shape ceilings. They used to live in prose and nowhere else, so nothing
 * stopped a dispatcher from adding a seventh job or firing a fourth adapter --
 * and the dispatcher is the one process no guard was watching.
 *
 * A repository may change them in `crew.config.json`; `createRun` copies the
 * effective values onto the run, so a manifest can always be read back against
 * the ceilings it was actually created under rather than today's config.
 */
export const MAX_JOBS = 6;
export const MAX_PARALLEL = 3;

/**
 * How long a `running` job keeps holding its parallel slot.
 *
 * An adapter that dies without recording leaves `running` in the manifest
 * forever. Counting those against MAX_PARALLEL would let three corpses close
 * the run to all further work, so a slot is released once the job is past its
 * own timeout plus a grace. That is a release, not a verdict: the job stays
 * `running` and the collect gate is still the thing that judges it.
 *
 * The number is duplicated from the collect gate rather than imported because this
 * module is the bottom layer and importing upward would make a manifest test
 * drag in the whole gate.
 */
const SLOT_STALE_GRACE_MS = 10 * 60_000;
const SLOT_FALLBACK_SPAN_MS = 35 * 60_000;

export function createRun({
  runDir, runId, label = null, workspace, evidenceRoot,
  depth = 0, dispatcher = "claude",
  maxJobs = MAX_JOBS, maxParallel = MAX_PARALLEL,
}) {
  const manifestPath = join(runDir, "manifest.json");
  if (existsSync(manifestPath)) {
    throw new ManifestError(`run manifest already exists at ${manifestPath}`);
  }
  if (!Number.isInteger(depth) || depth < 0) {
    throw new ManifestError(`depth must be a non-negative integer, got ${depth}`);
  }
  if (depth > MAX_DEPTH) {
    throw new ManifestError(
      `refusing to create a run at depth ${depth} (max ${MAX_DEPTH})\n` +
      `  → a worker is dispatching workers; stop the chain instead of deepening it`,
    );
  }
  // Not `depth === 0`. Gating on depth 0 left the exact hole the guard exists
  // to close: a worker calling createRun({ depth: 1 }) passed both checks and
  // got a valid run to dispatch from. A worker may not create a run at ANY
  // depth. Depth 1 is for a dispatcher deliberately opening a sub-run, and a
  // dispatcher is not running with this variable set.
  if (process.env.AGENT_CREW_ROLE === "worker") {
    throw new ManifestError(
      `refusing to create a run at depth ${depth} while AGENT_CREW_ROLE=worker\n` +
      "  → a worker cannot start a dispatch run, at any depth",
    );
  }
  if (!evidenceRoot) {
    throw new ManifestError(
      "createRun needs evidenceRoot: the workspace-relative directory every evidence path must sit under",
    );
  }
  for (const [name, value] of [["maxJobs", maxJobs], ["maxParallel", maxParallel]]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new ManifestError(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
    }
  }
  const now = new Date().toISOString();
  return {
    manifestPath,
    manifest: writeManifest(manifestPath, {
      version: MANIFEST_VERSION,
      runId,
      label,
      workspace,
      // Workspace-relative and posix-spelled, because it is compared against
      // both `node:path` output and `git status` output.
      evidenceRoot: toPosix(evidenceRoot).replace(/\/+$/, ""),
      dispatcher,
      depth,
      limits: { maxJobs, maxParallel },
      createdAt: now,
      updatedAt: now,
      // Where HEAD was when the run started. The write-scope gate reads only
      // the working tree, so a file a worker committed is invisible to it. This
      // does not make it visible -- nothing here can say who authored a commit
      // -- it lets the gate say out loud that commits happened during the run
      // and that it could not see inside them. Naming the blind spot is worth
      // more than a check that quietly does not cover it.
      headSha: headSha(workspace),
      jobs: [],
    }) && readManifest(manifestPath),
  };
}

/** HEAD, or null outside a repo. A run must not fail because git is unavailable. */
function headSha(workspace) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace, encoding: "utf8", timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Who answers for this job's acceptance. `owner` means the worker does: its
 * evidence IS the deliverable. `assist` means Claude does, and the job is
 * material for something Claude writes.
 */
export const ROLES = new Set(["owner", "assist"]);
export const WORKERS = new Set(["antigravity", "codex", "claude"]);

/**
 * `role` is required, and there is no default.
 *
 * It is the one field that cannot be derived from anything else: two jobs with
 * identical briefs are judged differently depending on whether the worker's
 * evidence IS the deliverable or is raw material for something the dispatcher
 * writes. A default here would answer that question by coin flip.
 */
function resolveRouting(job) {
  if (!WORKERS.has(job.worker)) {
    throw new ManifestError(
      `worker must be one of ${[...WORKERS].join(", ")}, got ${JSON.stringify(job.worker ?? null)}`,
    );
  }
  if (!ROLES.has(job.role)) {
    throw new ManifestError(
      `job needs role "owner" or "assist", got ${JSON.stringify(job.role ?? null)}\n` +
      `  → owner: the worker answers for acceptance; its evidence is the deliverable\n` +
      `  → assist: the job is material for a deliverable Claude writes\n` +
      `  → test: who answers for this job's acceptance?`,
    );
  }
  if ("mode" in job || "transport" in job) {
    // There is one transport now. Accepting the field silently would let a
    // caller believe it selected something.
    throw new ManifestError(
      "`mode`/`transport` are gone: every job runs headless\n" +
      "  → the app transports were removed because nothing could observe them",
    );
  }
  return { role: job.role };
}

/**
 * Jobs are appended with an explicit seq so evidence paths and report ordering
 * stay stable even when jobs finish out of order.
 */
/**
 * Fields whose value is the reason the gate can be trusted.
 *
 * `job.extra` used to spread over everything, so a caller could validate a
 * field and then null it out in the same call -- and a nulled field is one the
 * adapter stops checking. `extra` is for carrying extra facts, never for
 * editing the ones that were just checked.
 */
const SEALED_JOB_FIELDS = new Set([
  "seq", "worker", "role", "evidence", "status", "filesMayModify",
]);

/**
 * Evidence has to be a path inside the workspace, and inside the run directory.
 *
 * Otherwise the doctrine has a hole with a `/tmp` in it: a job declaring
 * `evidence: "/tmp/old-pass.md"` gets read as proof if that file happens to
 * carry a `Status: DONE` line, and the write-scope gate only ever looks at the
 * working tree, so nothing notices. Evidence that lives where the gate cannot
 * see it is not evidence.
 */
function assertEvidencePath(evidence, evidenceRoot) {
  if (typeof evidence !== "string" || evidence.length === 0) {
    throw new ManifestError(`evidence must be a non-empty path, got ${JSON.stringify(evidence)}`);
  }
  if (isAbsolute(evidence)) {
    throw new ManifestError(
      `evidence must be a workspace-relative path, got absolute ${evidence}\n` +
      "  → evidence outside the workspace cannot be checked by the write-scope gate",
    );
  }
  const norm = toPosix(normalize(evidence));
  if (norm.startsWith("..")) {
    throw new ManifestError(`evidence must stay inside the workspace, got ${evidence}`);
  }
  const root = `${toPosix(evidenceRoot).replace(/\/+$/, "")}/`;
  const cmp = process.platform === "win32" ? norm.toLowerCase() : norm;
  const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
  if (!cmp.startsWith(rootCmp)) {
    throw new ManifestError(
      `evidence must live under ${root}, got ${evidence}\n` +
      "  → one run keeps one trail; evidence outside it cannot be attributed to this manifest",
    );
  }
}

export function addJob(manifestPath, job) {
  let added;
  updateManifest(manifestPath, (m) => {
    const maxJobs = m.limits?.maxJobs ?? MAX_JOBS;
    if (m.jobs.length >= maxJobs) {
      throw new ManifestError(
        `run already has ${m.jobs.length} jobs (max ${maxJobs})\n` +
        "  → split the work across runs; a run nobody can hold in their head is a run nobody checks",
      );
    }
    const seq = m.jobs.length + 1;
    const { role } = resolveRouting(job);
    assertEvidencePath(job.evidence, m.evidenceRoot);
    // A string here reaches `.map` in the scope gate and throws mid-collect,
    // which turns a bad declaration into a dead gate.
    if (job.filesMayModify !== undefined && !Array.isArray(job.filesMayModify)) {
      throw new ManifestError(
        `filesMayModify must be an array of path prefixes, got ${typeof job.filesMayModify}`,
      );
    }
    if (job.filesMayModify?.some((x) => typeof x !== "string")) {
      throw new ManifestError("filesMayModify entries must all be strings");
    }
    const extra = { ...job.extra };
    for (const field of SEALED_JOB_FIELDS) {
      if (field in extra) {
        throw new ManifestError(
          `job.extra không được ghi đè "${field}"\n` +
          "  → field này vừa được kiểm; sửa nó ở đây là gỡ chốt vừa đặt",
        );
      }
    }
    added = {
      seq,
      worker: job.worker,
      role,
      model: job.model ?? null,
      // Codex takes its tier as a reasoning effort rather than a model name, so
      // recording only `model` would leave every Codex job looking unset.
      effort: job.effort ?? null,
      title: job.title,
      evidence: job.evidence,
      // Path prefixes this job is allowed to write outside the run directory.
      // This is where the actual work lands -- `src/`, `docs/`, wherever the
      // project keeps it -- and the collect gate treats an undeclared write as
      // a scope violation, so an empty list means "evidence only".
      filesMayModify: job.filesMayModify ?? [],
      status: "pending",
      // Filled in by the adapter when the job starts. The collect gate uses it
      // to decide how long "still running" is allowed to last for this job
      // rather than assuming the global ceiling.
      timeoutMs: null,
      conversationId: null,
      startedAt: null,
      endedAt: null,
      durationSec: null,
      exitCode: null,
      // Notes travel with the job into the collect report, not just into
      // whoever ran the command.
      notes: job.note ? [job.note] : [],
      ...extra,
    };
    m.jobs.push(added);
    return m;
  });
  return added;
}

/**
 * Appends notes to a job inside the lock.
 *
 * `updateJob` assigns `notes` wholesale, so building the array from a snapshot
 * read outside the lock loses any note another process appended in between --
 * and the collect gate is explicitly expected to run while jobs are still live.
 */
export function appendNote(manifestPath, seq, ...notes) {
  let updated;
  updateManifest(manifestPath, (m) => {
    const job = m.jobs.find((j) => j.seq === seq);
    if (!job) throw new ManifestError(`no job with seq ${seq} in ${manifestPath}`);
    job.notes = [...(job.notes ?? []), ...notes.filter(Boolean)];
    updated = job;
    return m;
  });
  return updated;
}

export function updateJob(manifestPath, seq, patch) {
  let updated;
  updateManifest(manifestPath, (m) => {
    const job = m.jobs.find((j) => j.seq === seq);
    if (!job) throw new ManifestError(`no job with seq ${seq} in ${manifestPath}`);
    // A free-form patch used to reach `seq` and `evidence`. Two jobs sharing a
    // seq makes this very `find` pick the wrong one, and a rewritten evidence
    // path re-points the proof after the fact. Progress fields are patchable,
    // identity is not.
    for (const field of ["seq", "worker", "role", "evidence"]) {
      if (field in patch && patch[field] !== job[field]) {
        throw new ManifestError(
          `updateJob không được đổi "${field}" của job ${seq}\n` +
          "  → đây là danh tính của job, không phải tiến độ",
        );
      }
    }
    Object.assign(job, patch);
    if (job.startedAt && job.endedAt) {
      job.durationSec = Math.round((Date.parse(job.endedAt) - Date.parse(job.startedAt)) / 1000);
    }
    updated = job;
    return m;
  });
  return updated;
}

/**
 * Marks a job `running` and takes one of the run's parallel slots, or refuses.
 *
 * This replaces a plain `updateJob({status:"running"})` in both adapters so the
 * count happens inside the manifest lock. Counting outside it does not work:
 * three adapters start within milliseconds of each other, all read "2 running",
 * and all four proceed.
 */
export function claimRunSlot(manifestPath, seq, { startedAt, timeoutMs }) {
  let claimed;
  updateManifest(manifestPath, (m) => {
    const job = m.jobs.find((j) => j.seq === seq);
    if (!job) throw new ManifestError(`no job ${seq} in ${manifestPath}`);
    if (job.status === "running") {
      throw new ManifestError(
        `job ${seq} is already recorded as running\n` +
        "  → it is being dispatched twice; the second adapter would overwrite the first one's trail",
      );
    }
    const now = Date.now();
    const live = m.jobs.filter((j) => {
      if (j.seq === seq || j.status !== "running") return false;
      if (!j.startedAt) return true;
      const span = (j.timeoutMs ?? SLOT_FALLBACK_SPAN_MS) + SLOT_STALE_GRACE_MS;
      return now - Date.parse(j.startedAt) < span;
    });
    const maxParallel = m.limits?.maxParallel ?? MAX_PARALLEL;
    if (live.length >= maxParallel) {
      throw new ManifestError(
        `${live.length} jobs already running (max ${maxParallel}): ${live.map((j) => j.seq).join(", ")}\n` +
        "  → wait for one to finish; if one of those is a corpse, run `crew collect` to see which",
      );
    }
    job.status = "running";
    job.startedAt = startedAt;
    job.timeoutMs = timeoutMs;
    claimed = job;
    return m;
  });
  return claimed;
}

/**
 * Records a failure for a job this process never claimed -- unless someone else
 * is holding it.
 *
 * The adapters' catch-path has to keep writing for the ordinary case: a
 * dispatch refused before the claim (bad duration, missing tier) should
 * leave its reason on the record, or the dispatcher gets silence. But the same
 * write, on a job another invocation is running, erased that invocation's
 * `running` state and freed its parallel slot mid-flight. So the write is kept
 * and the one dangerous case is carved out, inside the lock -- checking the
 * status first and writing after would race with the very adapter it protects.
 */
export function recordUnclaimedFailure(manifestPath, seq, patch) {
  let wrote = false;
  updateManifest(manifestPath, (m) => {
    const job = m.jobs.find((j) => j.seq === seq);
    if (!job || job.status === "running") return m;
    Object.assign(job, patch);
    wrote = true;
    return m;
  });
  return wrote;
}

export { ManifestError };
