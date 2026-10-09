#!/usr/bin/env node
/**
 * The run manifest is the only shared mutable state in a crew run: the
 * dispatcher appends jobs, several workers finish at unpredictable times, and
 * the collect step reads it. So every mutation goes through a lock and lands
 * via tmp+rename, never a partial write that a concurrent reader could see.
 *
 * Layout: tasks/{task}/reports/crew-{runId}/manifest.json
 */
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, rmSync,
  existsSync, statSync, readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize, resolve as resolvePath, sep } from "node:path";
import { holdsFingerprint, supersedeSeq } from "./lib/holds.mjs";
import { replacedFingerprint } from "./lib/replaced-jobs.mjs";
import { controlPlaneInside, taskRel, touchesControlPlane } from "./crew-scope.mjs";

export { taskRel };

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;

/**
 * Bumped to 2 when the adapters started recording who delivered a job
 * (`exitCode` / `conversationId`) and how long it was allowed to run
 * (`timeoutMs`). Bumped to 3 when every job started carrying why it was
 * dispatched the way it was (`role`) and which way that is (`transport`).
 *
 * The collect gate reads the version to know whether the absence of those
 * fields means something: on a version-1 manifest it means nothing, because
 * nothing wrote them yet.
 */
export const MANIFEST_VERSION = 3;

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
      `  → update mwg-agent-crew/scripts/ instead of editing the manifest`,
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
 * MAX_DEPTH is the second half of the recursion guard. MWG_CREW_ROLE stops a
 * worker that reads the skill and tries to dispatch; this stops a run that got
 * created anyway. Depth 0 is the dispatcher, depth 1 is a worker sub-run that a
 * human deliberately asked for; deeper than that is a loop, not a plan.
 */
export const MAX_DEPTH = 1;

/**
 * Run-shape ceilings from mwg-agent-crew/cost-gate.md. They were written in
 * SKILL.md and nowhere else, so nothing stopped a dispatcher from adding a
 * seventh job or firing a fourth adapter -- and the dispatcher is the one
 * process no guard was watching.
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
 * `running` and crew-reconcile is still the thing that judges it.
 *
 * The number is duplicated from crew-collect rather than imported because this
 * module is the bottom layer and importing upward would make a manifest test
 * drag in the whole gate.
 */
const SLOT_STALE_GRACE_MS = 10 * 60_000;
const SLOT_FALLBACK_SPAN_MS = 35 * 60_000;

export function createRun({ runDir, runId, task, workspace, depth = 0, dispatcher = "claude" }) {
  const manifestPath = join(runDir, "manifest.json");
  if (existsSync(manifestPath)) {
    throw new ManifestError(`run manifest already exists at ${manifestPath}`);
  }
  const rel = taskRel(task);
  if (!rel || isAbsolute(rel) || rel.split("/").includes("..")) {
    throw new ManifestError(`task must be a path under tasks/ like "260615-x" or "260615-x/work-items/y", got "${task}"`);
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
  if (process.env.MWG_CREW_ROLE === "worker") {
    throw new ManifestError(
      `refusing to create a run at depth ${depth} while MWG_CREW_ROLE=worker\n` +
      "  → a worker cannot start a dispatch run, at any depth",
    );
  }
  const now = new Date().toISOString();
  return {
    manifestPath,
    manifest: writeManifest(manifestPath, {
      version: MANIFEST_VERSION,
      runId,
      task: rel,
      workspace,
      dispatcher,
      depth,
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
      cwd: workspace, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
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
export const TRANSPORTS = new Set(["app", "headless"]);

/**
 * Headless is the default for both roles because it is the transport the
 * harness can actually observe. Measured 2026-08-25 across six app-transport
 * jobs: an app job reports no token usage and no reply text, the Antigravity
 * adapter passes `runtimeOk: true` unconditionally so silent failure stops
 * being detectable, the Codex adapter runs without an idle watchdog and leaves
 * `exitCode` null, and the app's thread list does not update live -- the owner
 * has to quit and reopen it to see anything. So "open a box so the owner can
 * watch" buys less than it costs.
 *
 * Role stays recorded next to transport. Role is the reason (who answers for
 * this job's acceptance); transport is the consequence. Keeping them separate
 * is what let this default change without making old runs unreadable.
 */
const DEFAULT_TRANSPORT = { owner: "headless", assist: "headless" };

/**
 * The previous rule -- "app when the user wants to watch" -- was not a rule: it
 * could not be checked, so 34 historical jobs split 10/24 between the two
 * transports with no way to ask why any single one went where it went.
 */
function resolveRouting(job) {
  if (!ROLES.has(job.role)) {
    throw new ManifestError(
      `job needs role "owner" or "assist", got ${JSON.stringify(job.role ?? null)}\n` +
      `  → owner: the worker answers for acceptance; its evidence is the deliverable\n` +
      `  → assist: the job is material for a deliverable Claude writes\n` +
      `  → test: who answers for this job's acceptance?`,
    );
  }
  if ("mode" in job) {
    throw new ManifestError(
      "`mode` is gone; pass `transport: \"app\" | \"headless\"` instead\n" +
      "  → transport now follows from role, so it is recorded with the reason next to it",
    );
  }
  // Claude is the dispatcher. Nothing is spawned for a Claude job, so there is
  // no transport to record -- writing one would put a chat box in the manifest
  // that never opened.
  if (job.worker === "claude") {
    if (job.transport != null) {
      throw new ManifestError(
        `a claude job has no transport (got ${JSON.stringify(job.transport)})\n` +
        `  → Claude does the work in-process; nothing is dispatched to record`,
      );
    }
    return { role: job.role, transport: null };
  }
  const fallback = DEFAULT_TRANSPORT[job.role];
  const transport = job.transport ?? fallback;
  if (!TRANSPORTS.has(transport)) {
    throw new ManifestError(
      `transport must be "app" or "headless", got ${JSON.stringify(transport)}`,
    );
  }
  if (transport !== fallback && !job.note) {
    throw new ManifestError(
      `job overrides the ${job.role} default transport (${fallback} → ${transport}) with no reason\n` +
      `  → pass note: "<why>"; an override without one is transport picked by feel again\n` +
      `  → app is worth its cost in three cases: an Antigravity job that will hit a\n` +
      `    permission prompt a person must answer, exploratory work with no acceptance\n` +
      `    writable in advance, or a thread that must be resumable in a later session`,
    );
  }
  return { role: job.role, transport };
}

/**
 * Jobs are appended with an explicit seq so evidence paths and report ordering
 * stay stable even when jobs finish out of order.
 */
/**
 * Fields whose value is the reason the gate can be trusted.
 *
 * `job.extra` used to spread over everything, so a caller could validate a
 * transport and then null it out in the same call -- and `assertTransport`
 * skips a null, so the adapter stopped checking too. `extra` is for carrying
 * extra facts, never for editing the ones that were just checked.
 */
const SEALED_JOB_FIELDS = new Set([
  "seq", "worker", "role", "transport", "evidence", "status", "filesMayModify",
  "holdsFingerprint", "holdsTamper", "replacedFingerprint",
]);

/**
 * Evidence has to be a path inside the workspace, and inside `tasks/`.
 *
 * Otherwise the doctrine has a hole with a `/tmp` in it: a job declaring
 * `evidence: "/tmp/old-pass.md"` gets read as proof if that file happens to
 * carry a `Status: DONE` line, and the write-scope gate only ever looks at the
 * working tree, so nothing notices. Evidence that lives where the gate cannot
 * see it is not evidence.
 */
function assertEvidencePath(evidence) {
  if (typeof evidence !== "string" || evidence.length === 0) {
    throw new ManifestError(`evidence must be a non-empty path, got ${JSON.stringify(evidence)}`);
  }
  if (isAbsolute(evidence)) {
    throw new ManifestError(
      `evidence must be a workspace-relative path, got absolute ${evidence}\n` +
      "  → evidence outside the workspace cannot be checked by the write-scope gate",
    );
  }
  const norm = normalize(evidence);
  if (norm.startsWith("..")) {
    throw new ManifestError(`evidence must stay inside the workspace, got ${evidence}`);
  }
  if (!norm.startsWith(`tasks${sep}`)) {
    throw new ManifestError(
      `evidence must live under tasks/, got ${evidence}\n` +
      "  → chỉ file trong tasks/ được tính là bằng chứng",
    );
  }
}

/**
 * What a job may write outside its task folder. Checked on add and on every
 * update, because `updateJob` is where a dispatcher widens scope after the owner
 * says ok -- the moment a worker's chat could talk it into handing over more.
 */
function assertFilesMayModify(list, workspace) {
  if (list === undefined) return;
  // A string here reaches `.map` in the scope gate and throws mid-collect,
  // which turns a bad declaration into a dead gate.
  if (!Array.isArray(list)) {
    throw new ManifestError(`filesMayModify must be an array of path prefixes, got ${typeof list}`);
  }
  if (list.some((x) => typeof x !== "string")) {
    throw new ManifestError("filesMayModify entries must all be strings");
  }
  // Hai việc đọc cùng danh sách này: cổng phạm vi ghi, và đồng hồ "job còn sống
  // không" của adapter Anti app (mtime của các file khai ở đây). Một prefix
  // tuyệt đối hoặc có `..` thì cả hai đều trỏ ra ngoài workspace.
  for (const prefix of list) {
    // Một dấu phẩy thừa khi ghép danh sách sinh ra phần tử rỗng, và rỗng nghĩa là
    // cả workspace; báo đúng lỗi đó thay vì để nó rơi vào lỗi control plane.
    if (prefix.trim() === "") {
      throw new ManifestError("filesMayModify có phần tử rỗng (dấu phẩy thừa?) — rỗng nghĩa là cả workspace");
    }
    if (isAbsolute(prefix)) {
      throw new ManifestError(`filesMayModify phải là đường dẫn tương đối trong workspace, nhận đường tuyệt đối ${prefix}`);
    }
    if (normalize(prefix).split(sep).includes("..") || prefix.split(/[\\/]/).includes("..")) {
      throw new ManifestError(`filesMayModify không được chứa "..", nhận ${prefix}`);
    }
    const inside = touchesControlPlane(prefix) ? prefix : (workspace ? controlPlaneInside(workspace, prefix) : null);
    if (inside) {
      throw new ManifestError(
        `filesMayModify chạm control plane hoặc file được bảo vệ: ${prefix}${inside === prefix ? "" : ` (chứa ${inside})`}\n` +
        "  → control plane — owner sửa tay, không qua crew",
      );
    }
  }
}

export function addJob(manifestPath, job) {
  let added;
  updateManifest(manifestPath, (m) => {
    if (m.jobs.length >= MAX_JOBS) {
      throw new ManifestError(
        `run already has ${m.jobs.length} jobs (max ${MAX_JOBS})\n` +
        "  → split the work across runs; a run nobody can hold in their head is a run nobody checks",
      );
    }
    const seq = m.jobs.length + 1;
    const { role, transport } = resolveRouting(job);
    assertEvidencePath(job.evidence);
    assertFilesMayModify(job.filesMayModify, m.workspace);
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
      transport,
      model: job.model ?? null,
      // Codex takes its tier as a reasoning effort rather than a model name, so
      // recording only `model` would leave every Codex job looking unset.
      effort: job.effort ?? null,
      title: job.title,
      evidence: job.evidence,
      // Path prefixes this job is allowed to write outside tasks/{task}/. Some
      // real work lands there -- an article edit belongs in
      // mwg-content-editor/content-workspaces/ -- and the collect gate treats
      // an undeclared write as a scope violation.
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
      // A transport override lands here so the justification travels with the
      // job into the collect report, not just into whoever ran the command.
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
/**
 * Store one runtime reading on the run.
 *
 * `transport` says what the dispatcher chose and `role` says why. Neither says
 * what the machine did with the choice, and that is the part that decides
 * whether two concurrent runs share one Codex runtime or start their own. This
 * is the third field, and it is deliberately an observation rather than a
 * decision: nothing reads it to route work.
 *
 * Two moments, because one reading is not enough (đo 25/08/2026):
 * `sessionRuntime.mode` read `direct` at 21:47 and `shared` at 22:05 with
 * nothing dispatched in between -- a broker had come up on its own. A single
 * pre-run reading describes a machine that no longer exists by the time the
 * jobs land.
 *
 * The write rule needs no coordination between adapters, which is why it is
 * shaped this way: `atDispatch` is written only when absent, so the first job
 * to fire records it; `atSettle` is overwritten every time, so the last job to
 * finish records it. Several adapters can call this concurrently -- they do,
 * up to MAX_PARALLEL of them -- and the two fields still mean "when the run
 * started dispatching" and "when it finished settling".
 *
 * The reading is passed in rather than taken here on purpose. This module is
 * the lowest layer and stays free of process spawning, so a manifest test does
 * not have to run `ps` or the companion to exercise a write.
 */
export function recordRuntime(manifestPath, when, reading) {
  if (when !== "atDispatch" && when !== "atSettle") {
    throw new ManifestError(`runtime reading must be atDispatch or atSettle, got ${when}`);
  }
  let stored;
  updateManifest(manifestPath, (m) => {
    m.codexRuntime = m.codexRuntime ?? { atDispatch: null, atSettle: null };
    // First writer wins for dispatch, last writer wins for settle.
    if (when === "atSettle" || m.codexRuntime.atDispatch === null) {
      m.codexRuntime[when] = reading;
    }
    stored = m.codexRuntime;
    return m;
  });
  return stored;
}

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
    // A free-form patch used to reach `seq`, `transport` and `evidence`. Two
    // jobs sharing a seq makes this very `find` pick the wrong one; a nulled
    // transport makes `assertTransport` stop checking; a rewritten evidence
    // path re-points the proof after the fact. Progress fields are patchable,
    // identity is not.
    for (const field of ["seq", "worker", "role", "transport", "evidence"]) {
      if (field in patch && patch[field] !== job[field]) {
        throw new ManifestError(
          `updateJob không được đổi "${field}" của job ${seq}\n` +
          "  → đây là danh tính của job, không phải tiến độ",
        );
      }
    }
    if ("filesMayModify" in patch) assertFilesMayModify(patch.filesMayModify, m.workspace);
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
 * Refuses to dispatch down a transport the manifest did not record.
 *
 * The manifest is the only place a run's shape survives, and phase-3 style
 * measurement reads it back -- so a job recorded as `app` and then fired
 * headless is worse than no record at all. Version-gated for the usual reason:
 * a manifest written before `transport` existed cannot be asked about it.
 */
/**
 * Marks a job `running` and takes one of the run's parallel slots, or refuses.
 *
 * This replaces a plain `updateJob({status:"running"})` in both adapters so the
 * count happens inside the manifest lock. Counting outside it does not work:
 * three adapters start within milliseconds of each other, all read "2 running",
 * and all four proceed.
 */
/**
 * Job còn sống đang giữ conversation `id`: `pending`/`running` mang `conversationId`
 * hoặc `resumedFrom` bằng id, trong `m` (đọc trong khoá) và mọi run khác cùng thư mục
 * `reports/` (đọc không khoá — cửa sổ đua ở đây chỉ còn vài ms, vì claim ghi
 * `resumedFrom` ngay trong khoá). Job `running` quá timeout + grace là xác, không tính,
 * cùng luật nhả slot bên dưới.
 */
export function conversationHolders(manifestPath, m, id, { exceptSeq = null, now = Date.now() } = {}) {
  const alive = (j) => {
    if (j.status === "pending") return true;
    if (j.status !== "running") return false;
    if (!j.startedAt) return true;
    return now - Date.parse(j.startedAt) < (j.timeoutMs ?? SLOT_FALLBACK_SPAN_MS) + SLOT_STALE_GRACE_MS;
  };
  const holds = (j) => alive(j) && (j.conversationId === id || j.resumedFrom === id);
  const out = m.jobs.filter((j) => j.seq !== exceptSeq && holds(j)).map((j) => ({ run: m.runId, seq: j.seq }));
  const runDir = dirname(manifestPath);
  const reportsDir = dirname(runDir);
  let siblings = [];
  try { siblings = readdirSync(reportsDir).filter((d) => d.startsWith("crew-") && join(reportsDir, d) !== runDir); } catch { /* không có reports/ thì không có run khác */ }
  for (const d of siblings) {
    let other;
    try { other = readManifest(join(reportsDir, d, "manifest.json")); } catch { continue; } // run hỏng không được chặn job lành
    for (const j of other.jobs ?? []) if (holds(j)) out.push({ run: other.runId, seq: j.seq });
  }
  return out;
}

export function claimRunSlot(manifestPath, seq, { startedAt, timeoutMs, resumeId = null }) {
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
    // Resume vào conversation còn job sống: hai lượt chen nhau trong một conversation,
    // và cả hai chấm chung những gì worker viết ra. Từ chối trước khi gửi gì đi. Adapter
    // ghi job này `failed` kèm lý do (đường recordUnclaimedFailure), claim lại được ngay.
    if (resumeId) {
      const busy = conversationHolders(manifestPath, m, resumeId, { exceptSeq: seq, now });
      if (busy.length) {
        throw new ManifestError(
          `conversation ${resumeId} đang có job ${busy.map((b) => `${b.run}#${b.seq}`).join(", ")} chạy\n` +
          "  → chưa gửi gì cho worker; đợi job đó xong rồi bắn lại job này",
        );
      }
    }
    if (live.length >= MAX_PARALLEL) {
      throw new ManifestError(
        `${live.length} jobs already running (max ${MAX_PARALLEL}): ${live.map((j) => j.seq).join(", ")}\n` +
        "  → wait for one to finish; if one of those is a corpse, run crew-reconcile first",
      );
    }
    // Lần chạy mới của seq này làm các hold của lần chạy cũ hết tác dụng. Đây là
    // một lần ghi `holds` HỢP LỆ khi job khác đang chạy, nên vân tay của những job
    // đó phải được đóng dấu lại -- nhưng chỉ job nào còn khớp vân tay trước lần ghi:
    // job đã lệch từ trước (worker sửa holds) giữ nguyên chỗ lệch để adapter bắt.
    const before = holdsFingerprint(m.holds);
    const changed = supersedeSeq(m, seq, startedAt);
    const after = holdsFingerprint(m.holds);
    if (changed) {
      for (const j of m.jobs) {
        if (j.seq !== seq && j.status === "running" && j.holdsFingerprint === before) j.holdsFingerprint = after;
      }
    }
    job.status = "running";
    job.startedAt = startedAt;
    job.timeoutMs = timeoutMs;
    // Conversation của lượt trước không thuộc lượt này: để lại thì guard ở trên coi nó
    // là đang bận suốt lượt mới, và `crew-session latest` trả nó như conversation mới
    // nhất. Id cũ vào note để vẫn resume được. Ghi `resumedFrom` trong khoá để adapter
    // thứ hai thấy ngay conversation đã có chủ (guard so cả hai trường).
    // `conversationId` để null tới khi runtime trả lời: collect đọc nó như bằng chứng
    // runtime đã giao evidence, nên điền sẵn id xin resume thì job chết trước khi
    // runtime trả lời mà có evidence viết tay sẽ qua cổng không WARN.
    if (job.conversationId) {
      job.notes = [...(job.notes ?? []), `claim lại: lượt trước dùng conversation ${job.conversationId}`];
    }
    job.conversationId = null;
    job.resumedFrom = resumeId ?? null;
    // `evidenceSha256` và `reportedStatus` của lượt trước cố ý GIỮ. Xoá `reportedStatus`
    // thì reconcile chấm job đang chạy lại theo evidence cũ của lượt trước (holds test
    // bắt được). Xoá sha thì lượt này hết giờ rồi worker ghi muộn qua cổng exit 0, vì
    // reconcile bỏ qua job đã có reportedStatus. Giữ sha thì ca đó bị chặn (EVIDENCE-ĐỔI);
    // lượt này xong bình thường thì adapter ghi đè sha.
    // Vân tay `holds` lúc claim. Adapter so lại ở mọi đường thoát (xem holdsTamperPatch).
    job.holdsFingerprint = after;
    // Cùng lý do cho sổ job làm thay: `--replaced` bị từ chối khi run còn job chạy,
    // nên mọi thay đổi `replacedJobs` giữa lúc claim và lúc thoát là của worker.
    job.replacedFingerprint = replacedFingerprint(m.replacedJobs);
    claimedReplaced.set(claimKey(manifestPath, seq), job.replacedFingerprint);
    claimed = job;
    return m;
  });
  return claimed;
}

/**
 * Mảnh patch cho `updateJob` ở mọi đường thoát của adapter: `holdsTamper` nếu
 * `holds` khác với lúc job này claim, còn không thì {} -- không ghi `undefined`,
 * vì Object.assign sẽ xoá một phát hiện đã ghi ở lượt trước (cùng lý do với
 * `credentialPatch`).
 *
 * Hold chỉ đổi được khi run không còn job chạy (crew-hold từ chối, collect hoãn
 * tạo), nên với một job đang chạy mọi thay đổi `holds` không do claim hợp lệ đều
 * là của worker. Đọc cả `holds` lẫn vân tay từ MỘT lần đọc manifest để hai vế
 * cùng một thời điểm. Không đọc được manifest thì trả {}: lúc đó updateJob ngay
 * sau cũng sẽ lỗi và adapter báo exit 2.
 */
/**
 * Vân tay `replacedJobs` lúc claim, giữ trong bộ nhớ của chính adapter đã claim.
 *
 * Vân tay ghi trong manifest thì worker sửa được cùng lúc với danh sách (reviewer tái
 * hiện 09/10: khai giả đủ ghim + tự tính lại vân tay → exit 0). Bản trong bộ nhớ thì
 * worker không với tới. Chỉ làm cho `replacedJobs`: `--replaced` bị từ chối khi run còn
 * job chạy nên giữa claim và thoát không có lần ghi hợp lệ nào. `holds` thì có (claim
 * của job khác đóng dấu lại vân tay, xem `supersedeSeq`), nên vẫn so theo manifest.
 * Rủi ro còn lại, chung cho mọi sổ trong manifest: worker app chạy tiếp SAU khi adapter
 * thoát thì không còn ai so — xem lib/replaced-jobs.mjs.
 */
const claimedReplaced = new Map();
const claimKey = (manifestPath, seq) => `${resolvePath(manifestPath)}#${seq}`;

export function holdsTamperPatch(manifestPath, seq) {
  try {
    const m = readManifest(manifestPath);
    const job = m.jobs.find((j) => j.seq === seq);
    if (!job) return {};
    const remembered = claimedReplaced.get(claimKey(manifestPath, seq));
    if (!job.holdsFingerprint && !remembered) return {};
    const holdsChanged = Boolean(job.holdsFingerprint) && holdsFingerprint(m.holds) !== job.holdsFingerprint;
    // Có bản trong bộ nhớ thì vân tay trong manifest phải khớp nó (sửa hay xoá đều là
    // tamper). Không có (tiến trình khác, job claim trước khi có vân tay này) thì so
    // với manifest, hoặc không có gì để so.
    const expected = remembered ?? job.replacedFingerprint;
    const replacedChanged = Boolean(expected)
      && (replacedFingerprint(m.replacedJobs) !== expected || (remembered != null && job.replacedFingerprint !== remembered));
    if (!holdsChanged && !replacedChanged) return {};
    return {
      holdsTamper: {
        at: new Date().toISOString(), holdIdsAtExit: (m.holds ?? []).map((h) => h.id),
        ...(replacedChanged ? { replacedJobsChanged: true } : {}),
        ...(replacedChanged && holdsChanged ? { holdsChanged: true } : {}),
      },
    };
  } catch {
    return {};
  }
}

/**
 * Records a failure for a job this process never claimed -- unless someone else
 * is holding it.
 *
 * The adapters' catch-path has to keep writing for the ordinary case: a
 * dispatch refused before the claim (wrong transport, bad duration) should
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

export function assertTransport(manifestPath, seq, mode) {
  const manifest = readManifest(manifestPath);
  if (!(manifest.version >= 3)) return null;
  const job = manifest.jobs.find((j) => j.seq === seq);
  if (!job || job.transport == null) return null;
  if (job.transport !== mode) {
    throw new ManifestError(
      `job ${seq} is recorded as transport "${job.transport}" but was dispatched as "${mode}"\n` +
      `  → fix the flag, or fix the manifest; do not leave the two disagreeing`,
    );
  }
  return job.transport;
}

export { ManifestError };

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "read") {
      console.log(JSON.stringify(readManifest(rest[0]), null, 2));
    } else if (cmd === "update-job") {
      const [path, seq, patchJson] = rest;
      console.log(JSON.stringify(updateJob(path, Number(seq), JSON.parse(patchJson)), null, 2));
    } else {
      console.error("usage: crew-manifest.mjs read <manifest.json>\n       crew-manifest.mjs update-job <manifest.json> <seq> <patchJson>");
      process.exit(2);
    }
  } catch (err) {
    console.error(`crew-manifest: ${err.message}`);
    process.exit(1);
  }
}
