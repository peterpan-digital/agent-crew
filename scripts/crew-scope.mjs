#!/usr/bin/env node
/**
 * Attribute working-tree changes to the jobs of a crew run.
 *
 * A worker is allowed to write its evidence and its own data, and nothing else.
 * Checking that with `git status` alone does not work in this workspace: the
 * repo normally carries several hundred modified files of the user's own, so a
 * plain diff reports files no run ever touched.
 *
 * So attribution is by time: a file counts against a job only if it was
 * modified inside that job's own interval. Per-job matters. A run-wide window
 * once charged 32 skill files to a run whose only job never started -- the user
 * was editing those files in the same five minutes, and a window spanning the
 * whole run had no way to say so.
 *
 * Where a runtime says which files it wrote, that beats the clock: a hit is
 * labelled `authored` and charged to the job that named it, even if the mtime
 * only lands in a different job's window.
 *
 * But `authored` is a one-way signal and the label must not be read as a
 * ranking. Measured 2026-08-25: both runtimes fall back to a shell command when
 * their file-writing tool refuses -- Antigravity's `write_to_file` errors on any
 * path outside its own artifact directory, so its workers reach `run_command`
 * routinely -- and nothing written that way passes through the tool that reports
 * file changes. So a file a runtime names is certainly that job's; a file it
 * does not name may still be. `inferred` is therefore charged exactly as hard as
 * `authored`. Downgrading it would let every shell-written violation through.
 *
 * False positives are reduced without weakening that, three ways: a file another
 * run's job authored is reported as that run's; the run records where HEAD was so
 * the gate can say commits happened that it could not see inside; and a path can
 * be dismissed by name with a written reason that lands in the manifest.
 *
 * Two limits are deliberate and documented rather than papered over:
 *   - a write that was committed is invisible here, because only the working
 *     tree is read; workers are not supposed to commit, and a gate that shelled
 *     out to `git log` would still not know who authored a commit. `headSha`
 *     turns that from a silent gap into a reported one;
 *   - a job that died without recording an end time has no knowable interval,
 *     so anything found in its capped window is reported as suspect rather than
 *     charged as a violation. Failing hard there made the gate unpassable on
 *     exactly the runs it exists for, which teaches a dispatcher to ignore it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** How long after a job ends a write can still plausibly be that job's. */
export const DEFAULT_GRACE_MS = 120_000;

/**
 * The widest interval a job with no recorded end can be given. `updatedAt` is
 * unusable as the bound: the gate reconciles before it checks, which moves
 * `updatedAt` to now, so a killed job would get a window reaching the present
 * and swallow everything the user touched meanwhile.
 */
export const MAX_JOB_SPAN_MS = 35 * 60_000;

/**
 * The widest window a job may be given, preferring what the adapter recorded
 * over the derived ceiling. A job that was only ever allowed five minutes must
 * not be charged with what the user edited half an hour later.
 */
function jobSpanMs(job, graceMs) {
  return Number.isFinite(job.timeoutMs) && job.timeoutMs > 0
    ? job.timeoutMs + graceMs
    : MAX_JOB_SPAN_MS;
}

/** Ceiling on entries read per declared prefix, so a stray declaration cannot hang the gate. */
const WALK_LIMIT = 20_000;

/**
 * Paths a worker must never write, checked whatever git thinks of them.
 *
 * This list exists because `git status` cannot see them: every one of these is
 * gitignored in this repo, so the diff-based check is blind to a worker that
 * overwrites a runtime config or a credential file. Kept in sync with the
 * Protected Files list in CLAUDE.md.
 */
export const PROTECTED_PATHS = [
  ".mcp.json", ".claude/.mcp.json", ".agents/mcp_config.json",
  ".codex/config.toml", ".gemini/settings.json", "skills-lock.json",
  "mwg-workflow-n8n/.env", "mwg-workflow-n8n/.claude/.mcp.json",
  "mwg-workflow-n8n/.codex/config.toml", "mwg-workflow-n8n/.gemini/settings.json",
  "mwg-workflow-n8n/.agents/mcp_config.json",
  "mwg-seo-analytics/.env", "mwg-seo-analytics/config/client_secret.json",
];

/**
 * Protected *directories* from CLAUDE.md — everything under them is protected.
 *
 * Split out because the check was an exact-path match, so the eight skill
 * directories CLAUDE.md protects were protected in the document and unprotected
 * in the code: a worker editing `.claude/skills/seo-crew/SKILL.md` matched no
 * entry above, then matched the task's allowed prefixes, and landed in
 * `inScope`. Prefix-matched here instead.
 */
export const PROTECTED_DIRS = [
  ".agents/skills/", ".codex/skills/", ".claude/skills/", ".gemini/skills/",
  "mwg-workflow-n8n/.agents/skills/", "mwg-workflow-n8n/.codex/skills/",
  "mwg-workflow-n8n/.claude/skills/", "mwg-workflow-n8n/.gemini/skills/",
];

/** True when a path is a protected file, or sits under a protected directory. */
export function isProtectedPath(path) {
  if (PROTECTED_PATHS.includes(path)) return true;
  return PROTECTED_DIRS.some((d) => path.startsWith(d));
}

/** A prefix only means "this directory" if it ends in a separator. */
function normalizePrefix(p) {
  return p.endsWith("/") || p.endsWith(sep) ? p : `${p}/`;
}

/**
 * One interval per job. A job with no `startedAt` never ran, so nothing can be
 * charged to it; a cancelled job is the same case after the fact.
 */
export function jobIntervals(manifest, graceMs = DEFAULT_GRACE_MS) {
  return manifest.jobs
    .filter((job) => job.startedAt && job.status !== "cancelled")
    .map((job) => {
      const from = Date.parse(job.startedAt);
      // `endedAtInferred` means reconcile filled the end time in rather than the
      // runtime reporting it, so the interval is a guess and must be treated
      // like a missing one.
      return job.endedAt && !job.endedAtInferred
        ? { seq: job.seq, from, to: Date.parse(job.endedAt) + graceMs, bounded: true }
        : { seq: job.seq, from, to: Math.min(from + jobSpanMs(job, graceMs), Date.parse(job.endedAt ?? "") + graceMs || Infinity), bounded: false };
    });
}

/**
 * Where each job may write. `tasks/{task}/` is implicit for every job; anything
 * else has to be declared per job, because some legitimate work lands outside
 * it -- an article edit belongs in `mwg-content-editor/content-workspaces/`,
 * which is durable and shared, not task-scoped.
 */
export function allowedFor(manifest, seqs) {
  const implicit = [normalizePrefix(`tasks/${manifest.task}`)];
  const runLevel = (manifest.filesMayModify ?? []).map(normalizePrefix);
  const perJob = manifest.jobs
    .filter((j) => seqs.includes(j.seq))
    .flatMap((j) => (j.filesMayModify ?? []).map(normalizePrefix));
  return [...implicit, ...runLevel, ...perJob];
}

/** Every prefix any job declared, for the walk that git cannot do. */
function declaredPrefixes(manifest) {
  return [
    ...(manifest.filesMayModify ?? []),
    ...manifest.jobs.flatMap((j) => j.filesMayModify ?? []),
  ].map(normalizePrefix);
}

/** `git status --porcelain -z`, keeping the second path of a rename record. */
function changedPaths(workspace) {
  const out = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd: workspace, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const records = out.split("\0");
  const paths = [];
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (!rec) continue;
    const code = rec.slice(0, 2);
    paths.push(rec.slice(3));
    // A rename/copy record is followed by its source path in its own field, so
    // it must be consumed here or it is read as a status line on the next pass.
    if (code[0] === "R" || code[0] === "C") {
      i += 1;
      if (records[i]) paths.push(records[i]);
    }
  }
  return paths;
}

/**
 * Files under a declared prefix or on the protected list, found by walking
 * rather than by asking git. Both categories are gitignored in this repo, which
 * is why declaring `filesMayModify` was a no-op before this existed.
 */
function watchedPaths(workspace, manifest) {
  const found = new Set();
  const add = (rel) => found.add(rel.split(sep).join("/"));

  for (const file of PROTECTED_PATHS) {
    try {
      statSync(join(workspace, file));
      add(file);
    } catch { /* absent here; nothing to attribute */ }
  }
  // PROTECTED_DIRS are deliberately not walked: unlike the files above they are
  // git-tracked, so `changedPaths` already reports any write inside them. What
  // they needed was the right classification, not discovery -- see
  // isProtectedPath. Walking them would add thousands of paths for nothing.
  for (const prefix of declaredPrefixes(manifest)) {
    const root = join(workspace, prefix);
    let entries;
    try {
      entries = readdirSync(root, { recursive: true, withFileTypes: true });
    } catch { continue; }
    let n = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (n += 1, n > WALK_LIMIT) break;
      // `relative`, not a slice off root's length: `prefix` ends in a separator,
      // so `root` does too, and slicing past it ate the first character of every
      // subdirectory name -- `images-original/x.jpg` was recorded as
      // `mages-original/x.jpg`. Those paths then failed to stat, so a declared
      // write landed in `unattributable` instead of `inScope` and the run's
      // in-scope count read zero.
      add(join(prefix, relative(root, e.parentPath), e.name));
    }
  }
  return [...found];
}

/** Ceiling on how many other runs' manifests are read, so the gate stays bounded. */
const CROSS_RUN_LIMIT = 40;
/** Only a run that started recently can plausibly own a file in this run's window. */
const CROSS_RUN_AGE_MS = 24 * 3600_000;

/** A workspace-relative, forward-slash path, whatever shape the runtime reported. */
function toRel(workspace, p) {
  if (typeof p !== "string" || !p) return null;
  const rel = isAbsolute(p) ? relative(workspace, p) : p;
  // A path outside the workspace is not this gate's business and `relative`
  // would return a `..` walk that matches no prefix.
  if (!rel || rel.startsWith("..")) return null;
  return rel.split(sep).join("/");
}

/**
 * path -> the seqs whose runtime named it. This is the authorship index; see the
 * file docstring for why it confirms but never clears.
 */
export function authoredIndex(manifest, workspace) {
  const index = new Map();
  for (const job of manifest.jobs) {
    for (const p of job.touchedFiles ?? []) {
      const rel = toRel(workspace, p);
      if (!rel) continue;
      if (!index.has(rel)) index.set(rel, []);
      if (!index.get(rel).includes(job.seq)) index.get(rel).push(job.seq);
    }
  }
  return index;
}

/**
 * path -> "{runId} job {seq}" for files another crew run's worker says it wrote.
 *
 * Ownership across runs is decided by authorship, never by time. With
 * MAX_PARALLEL 3 and a two-minute grace, every concurrent run's windows overlap,
 * so a time-based cross-run check would hand half of this run's writes to
 * whichever other run happened to be open.
 */
export function foreignAuthors(manifest, workspace, { now = Date.now() } = {}) {
  const owners = new Map();
  const here = join(workspace, "tasks");
  let entries;
  try {
    entries = readdirSync(here, { recursive: true, withFileTypes: true });
  } catch {
    return owners;
  }
  let read = 0;
  for (const e of entries) {
    if (read >= CROSS_RUN_LIMIT) break;
    if (!e.isFile() || e.name !== "manifest.json") continue;
    const dir = e.parentPath ?? "";
    if (!dir.includes(`${sep}reports${sep}crew-`) && !dir.includes("/reports/crew-")) continue;
    const full = join(dir, e.name);
    let other;
    try {
      other = JSON.parse(readFileSync(full, "utf8"));
    } catch { continue; }
    if (!other || other.runId === manifest.runId) continue;
    const created = Date.parse(other.createdAt ?? "");
    if (!Number.isFinite(created) || now - created > CROSS_RUN_AGE_MS) continue;
    read += 1;
    for (const job of other.jobs ?? []) {
      for (const p of job.touchedFiles ?? []) {
        const rel = toRel(workspace, p);
        // First writer wins: two runs both claiming a file is itself worth
        // seeing, and the label points at one of them either way.
        if (rel && !owners.has(rel)) owners.set(rel, `${other.runId} job ${job.seq}`);
      }
    }
  }
  return owners;
}

export function collectWriteScope(manifest, { workspace, graceMs = DEFAULT_GRACE_MS, notOurs = [] } = {}) {
  if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 24 * 3600_000) {
    throw new Error(`--grace không hợp lệ: ${graceMs}. Phải là số ms từ 0 đến 86400000.`);
  }
  const intervals = jobIntervals(manifest, graceMs);
  const result = {
    intervals, inScope: [], outOfScope: [], suspect: [],
    protectedHits: [], outsideWindow: [], unattributable: [],
    ownedElsewhere: [], dismissed: [], unusedDismissals: [],
  };
  const authored = authoredIndex(manifest, workspace);
  const foreign = foreignAuthors(manifest, workspace);
  const waived = new Set(notOurs.map((p) => toRel(workspace, p)).filter(Boolean));
  const paths = new Set([...changedPaths(workspace), ...watchedPaths(workspace, manifest)]);

  for (const path of paths) {
    let mtime;
    try {
      mtime = statSync(join(workspace, path)).mtimeMs;
    } catch {
      // Deleted, or a path git sees and we cannot stat. A deletion carries no
      // timestamp, so it cannot be charged to a job -- but it also cannot be
      // waved through, so it is surfaced for a human. It is not made blocking:
      // this repo already carries an unrelated deletion, and a gate that failed
      // every run over it would be ignored within a day.
      result.unattributable.push(path);
      continue;
    }
    const mine = authored.get(path);
    const hits = intervals.filter((i) => mtime >= i.from && mtime <= i.to);
    if (!mine && hits.length === 0) {
      result.outsideWindow.push(path);
      continue;
    }

    // A file this run's own worker named is this run's, whatever any other run
    // says, so the foreign check comes after the authored one.
    if (!mine && foreign.has(path)) {
      result.ownedElsewhere.push({ path, owner: foreign.get(path) });
      continue;
    }

    const seqs = mine ?? hits.map((h) => h.seq);
    // With MAX_PARALLEL 3 and a two-minute grace, concurrent jobs' windows
    // always overlap, so every candidate is named. Picking the first would
    // routinely accuse the wrong worker -- and that name is the line a human
    // reads to find the culprit. An authored hit needs no such hedge: the
    // runtime said which job it was.
    const entry = {
      path,
      seqs,
      source: mine ? "authored" : "inferred",
      // An authored hit has a known writer, so the interval it happens to fall
      // in is irrelevant to whether it can be charged.
      bounded: mine ? true : hits.some((h) => h.bounded),
    };

    const protectedHit = isProtectedPath(path);
    if (!protectedHit && allowedFor(manifest, seqs).some((p) => path.startsWith(p))) {
      result.inScope.push(entry);
      continue;
    }
    // Dismissal is checked only for something that would otherwise be charged:
    // waiving a path that was never a violation would hide nothing and teach the
    // dispatcher that the flag is free.
    //
    // It is checked for a protected hit too, and that is deliberate. This repo
    // has several sessions working in it at once, so another session editing a
    // protected path is a real and frequent event. Making protected hits
    // undismissable would mean no run can ever pass while a neighbour touches
    // one -- and a gate that cannot be satisfied honestly is a gate people learn
    // to ignore, which costs more than the case it was guarding. The waiver is
    // still recorded with its reason, and `protected` stays on the entry so the
    // report shows what kind of path was waived.
    if (waived.has(path)) {
      result.dismissed.push({ ...entry, protected: protectedHit || undefined });
      continue;
    }
    if (protectedHit) {
      result.protectedHits.push(entry);
      continue;
    }
    if (entry.bounded) {
      result.outOfScope.push(entry);
    } else {
      // Only jobs with no recorded end could have written this, so the interval
      // is a guess. Report it loudly; do not fail the run on a guess.
      result.suspect.push(entry);
    }
  }
  // A dismissal that suppressed nothing has to be said out loud. Silence here
  // reads as "the flag does not work": a dispatcher dismissed one
  // `worker-anti-1.md` while the charged file was a second copy of that name at
  // the repo root, saw the identical violation again, and concluded the waiver
  // was broken. Nothing was broken -- the two paths were different files, and
  // only the report could have said so.
  const suppressed = new Set(result.dismissed.map((d) => d.path));
  result.unusedDismissals = [...waived].filter((p) => !suppressed.has(p));
  return result;
}

/**
 * Whether HEAD moved since the run was created. The gate reads the working tree
 * only, so a committed write is invisible to it; this cannot see inside those
 * commits either, and does not pretend to. It reports that they exist.
 *
 * A run from before `headSha` was recorded returns `known: false` rather than a
 * fabricated comparison.
 */
export function headMovement(manifest, workspace) {
  if (typeof manifest.headSha !== "string" || !manifest.headSha) {
    return { known: false, moved: false, commits: null };
  }
  let head;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return { known: false, moved: false, commits: null };
  }
  if (head === manifest.headSha) return { known: true, moved: false, commits: 0 };
  let commits = null;
  try {
    commits = Number(execFileSync("git", ["rev-list", "--count", `${manifest.headSha}..HEAD`], {
      cwd: workspace, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim());
  } catch { /* the old sha may be gone; moved is still the fact */ }
  return { known: true, moved: true, commits: Number.isFinite(commits) ? commits : null };
}
