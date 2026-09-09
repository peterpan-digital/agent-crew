#!/usr/bin/env node
/**
 * The bookkeeping subcommands: `new-run`, `add-job`, `claim`, `finish`,
 * `note`, `retry-log`.
 *
 * All of them exist so the skill's instructions can be commands rather than
 * shell. The version this was ported from told the dispatcher to run `date`,
 * `mkdir -p`, `node -e 'import(...)'` and a bash parameter expansion -- none of
 * which is the same on Windows, and one of which (`${f/a/b}`) is not even the
 * same across POSIX shells. A subcommand is one spelling everywhere.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { loadConfig, runDir, runDirRel, runsDir } from "../config.mjs";
import {
  addJob, appendNote, claimRunSlot, createRun, readManifest, updateJob, updateManifest,
} from "../manifest.mjs";
import { DEFAULT_TIMEOUT, GuardError, parseDuration, readWorkerStatus } from "../guards.mjs";
import { ArgError, int, parse, required } from "./args.mjs";
import { resolveLogDir } from "../../adapters/codex.mjs";

/** Local time, because a run id is something a person reads back off a folder. */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function newRun(argv, { cwd }) {
  const parsed = parse(argv, { label: "value", allow: "list" });
  const config = loadConfig({ workspace: cwd });

  // Two runs opened in the same minute get distinct ids rather than a collision
  // error: the minute is a convenience for humans, not an identity.
  let runId = stamp();
  for (let n = 2; existsSync(runDir(config, runId)); n += 1) runId = `${stamp()}-${n}`;

  const dir = runDir(config, runId);
  mkdirSync(dir, { recursive: true });
  const { manifestPath } = createRun({
    runDir: dir,
    runId,
    label: parsed.values.get("label") ?? null,
    workspace: config.workspace,
    evidenceRoot: runDirRel(config, runId),
    maxJobs: config.maxJobs,
    maxParallel: config.maxParallel,
  });

  const runLevelAllow = [...(config.defaultFilesMayModify ?? []), ...(parsed.lists.get("allow") ?? [])];
  if (runLevelAllow.length) {
    updateManifest(manifestPath, (m) => {
      m.filesMayModify = runLevelAllow;
      return m;
    });
  }

  console.log(`run     ${runId}`);
  console.log(`dir     ${relative(config.workspace, dir)}`);
  console.log(`manifest ${relative(config.workspace, manifestPath)}`);
  if (runLevelAllow.length) console.log(`allow   ${runLevelAllow.join(", ")}`);
  if (!existsSync(join(runsDir(config), "..", ".gitignore"))) {
    console.log("gợi ý: chạy `crew init` một lần để bỏ log thô ra khỏi git");
  }
  return 0;
}

/** Which tier flag each worker needs, and why it is not optional. */
function tierFor(worker, parsed) {
  const model = parsed.values.get("model") ?? null;
  const effort = parsed.values.get("effort") ?? null;
  if (worker === "codex") {
    if (!effort) {
      throw new ArgError(
        "--effort is required for a codex job",
        "codex picks its own model; the tier is the reasoning effort",
      );
    }
    if (model) throw new ArgError("a codex job takes --effort, not --model");
    return { effort };
  }
  // A claude job spawns nothing, so it has no tier to require -- the same
  // reason its transport is null. Demanding one here asked for a fact about a
  // process that never starts. It is still recorded when given, because naming
  // the model that did the work is worth something to a reader later.
  if (!model && worker !== "claude") {
    throw new ArgError(
      `--model is required for a ${worker} job`,
      "every job in the manifest used to read null, so nothing could say which tier failed",
    );
  }
  if (effort) throw new ArgError(`a ${worker} job takes --model, not --effort`);
  return { model };
}

export function addJobCmd(argv, { cwd }) {
  const parsed = parse(argv, {
    manifest: "value", worker: "value", role: "value", title: "value",
    model: "value", effort: "value", evidence: "value", note: "value",
    transport: "value", allow: "list",
  });
  const config = loadConfig({ workspace: cwd });
  const manifestPath = parsed.values.get("manifest") ?? defaultManifest(config);
  const manifest = readManifest(manifestPath);
  const worker = required(parsed, "worker");
  const seq = manifest.jobs.length + 1;

  // Derived, not asked for. Two jobs sharing an evidence path is the one
  // mistake that destroys the record itself -- the second worker overwrites the
  // first one's proof -- so the path is generated from the seq the manifest is
  // about to assign rather than typed by whoever is dispatching.
  const evidence = parsed.values.get("evidence")
    ?? `${manifest.evidenceRoot}/worker-${worker}-${seq}.md`;
  const brief = `${manifest.evidenceRoot}/brief-${worker}-${seq}.md`;

  const added = addJob(manifestPath, {
    worker,
    role: required(parsed, "role"),
    title: required(parsed, "title"),
    evidence,
    note: parsed.values.get("note") ?? null,
    filesMayModify: parsed.lists.get("allow") ?? [],
    // Omitted rather than passed as null: a claude job must have no transport
    // at all, and `addJob` tells "not asked for" from "explicitly nothing".
    ...(parsed.values.has("transport") ? { transport: parsed.values.get("transport") } : {}),
    ...tierFor(worker, parsed),
  });

  console.log(`job      ${added.seq}`);
  console.log(`transport ${added.transport ?? "(không có — job claude)"}`);
  console.log(`evidence ${added.evidence}`);
  console.log(`brief    ${brief}`);
  console.log(`ghi brief vào đường dẫn trên trước khi dispatch (trần ${config.briefMaxBytes} B)`);
  return 0;
}

/** The newest run's manifest, so the common case needs no path typed twice. */
function defaultManifest(config) {
  const runs = runsDir(config);
  let entries;
  try {
    entries = readdirSync(runs, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    throw new GuardError(
      `chưa có run nào ở ${config.runRoot}/runs/`,
      "chạy `crew new-run` trước, hoặc truyền --manifest",
    );
  }
  const withManifest = entries
    .map((e) => join(runs, e.name, "manifest.json"))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (withManifest.length === 0) {
    throw new GuardError(`chưa có manifest nào ở ${config.runRoot}/runs/`, "chạy `crew new-run` trước");
  }
  return withManifest[0];
}

export { defaultManifest };

/**
 * Marks a Claude job running.
 *
 * A Claude job is work the dispatcher does itself, so nothing spawns and
 * nothing claims a slot. Without a claim it has no start time, and the scope
 * gate then cannot attribute a single file to it -- which reads as "the
 * dispatcher wrote nothing", not as "nobody looked".
 */
export function claim(argv, { cwd }) {
  const parsed = parse(argv, { manifest: "value", job: "value", timeout: "value" });
  const config = loadConfig({ workspace: cwd });
  const manifestPath = parsed.values.get("manifest") ?? defaultManifest(config);
  const seq = int(parsed, "job", { required: true });
  const job = claimRunSlot(manifestPath, seq, {
    startedAt: new Date().toISOString(),
    timeoutMs: parseDuration(parsed.values.get("timeout") ?? config.defaultTimeout ?? DEFAULT_TIMEOUT),
  });
  console.log(`job ${job.seq} đang chạy từ ${job.startedAt}`);
  return 0;
}

/**
 * Records the outcome of a job nothing spawned, by reading its evidence.
 *
 * The evidence is judged exactly the way a worker's is -- same Status line,
 * same rules -- because a Claude job that judged itself by a different standard
 * would be the one job in the run nobody checked.
 */
export function finish(argv, { cwd }) {
  const parsed = parse(argv, { manifest: "value", job: "value" });
  const config = loadConfig({ workspace: cwd });
  const manifestPath = parsed.values.get("manifest") ?? defaultManifest(config);
  const seq = int(parsed, "job", { required: true });
  const manifest = readManifest(manifestPath);
  const job = manifest.jobs.find((j) => j.seq === seq);
  if (!job) throw new GuardError(`no job ${seq} in ${manifestPath}`);

  const evidenceAbs = join(manifest.workspace, job.evidence);
  if (!existsSync(evidenceAbs) || statSync(evidenceAbs).size === 0) {
    throw new GuardError(
      `job ${seq} chưa có evidence tại ${job.evidence}`,
      "viết evidence trước — file rỗng không được tính là xong",
    );
  }
  const verdict = readWorkerStatus(evidenceAbs);
  const now = new Date().toISOString();
  updateJob(manifestPath, seq, {
    status: verdict.status,
    reportedStatus: verdict.reported,
    // A job that was never claimed gets a zero-width window rather than one
    // reaching back to the run's start: an invented span would charge this job
    // with every file touched since, and the gate reads that span as evidence.
    startedAt: job.startedAt ?? now,
    endedAt: now,
    evidenceBytes: statSync(evidenceAbs).size,
  });
  if (!job.startedAt) {
    appendNote(manifestPath, seq, "finish: job không claim trước nên không có khoảng thời gian để quy file");
  }
  console.log(`job ${seq}: ${verdict.status}${verdict.reported ? ` (${verdict.reported})` : " — evidence không có dòng Status"}`);
  return verdict.reported ? 0 : 3;
}

export function note(argv, { cwd }) {
  const parsed = parse(argv, { manifest: "value", job: "value", text: "value" });
  const config = loadConfig({ workspace: cwd });
  const manifestPath = parsed.values.get("manifest") ?? defaultManifest(config);
  appendNote(manifestPath, int(parsed, "job", { required: true }), required(parsed, "text"));
  console.log("đã ghi note");
  return 0;
}

/**
 * Moves a failed Codex attempt's sidecars aside so a retry can run.
 *
 * The adapter refuses to start when an earlier attempt's log is still there,
 * and that guard is right -- two attempts interleaved in one log destroys the
 * evidence of both. But it also made the "retry once" rule unenforceable
 * without a rename, and a rename is where a bash-only incantation used to sit.
 *
 * Renamed, never deleted: an attempt that failed because of its brief is the
 * data you fix the brief with.
 */
export function retryLog(argv, { cwd }) {
  const parsed = parse(argv, { manifest: "value", job: "value" });
  const config = loadConfig({ workspace: cwd });
  const manifestPath = parsed.values.get("manifest") ?? defaultManifest(config);
  const seq = int(parsed, "job", { required: true });
  const manifest = readManifest(manifestPath);
  const job = manifest.jobs.find((j) => j.seq === seq);
  if (!job) throw new GuardError(`no job ${seq} in ${manifestPath}`);

  const evidenceAbs = join(manifest.workspace, job.evidence);
  const logDir = resolveLogDir(evidenceAbs);
  const base = basename(evidenceAbs).replace(/\.md$/, "");
  const moved = [];

  // The attempt number is chosen by looking, not by counting retries: a third
  // attempt must not overwrite the first one's rename.
  let attempt = 1;
  const taken = (n) => existsSync(join(logDir, `attempt${n}-${base}.codex-stream.jsonl`));
  while (taken(attempt)) attempt += 1;

  for (const name of safeReaddir(logDir)) {
    if (!name.startsWith(`${base}.`)) continue;
    renameSync(join(logDir, name), join(logDir, `attempt${attempt}-${name}`));
    moved.push(name);
  }
  if (existsSync(evidenceAbs)) {
    const kept = join(manifest.workspace, job.evidence.replace(/([^/]+)$/, `attempt${attempt}-$1`));
    renameSync(evidenceAbs, kept);
    moved.push(basename(evidenceAbs));
  }
  console.log(moved.length
    ? `đã dời lượt ${attempt} sang attempt${attempt}-: ${moved.join(", ")}`
    : "không có file nào của lượt trước cần dời");
  return 0;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
