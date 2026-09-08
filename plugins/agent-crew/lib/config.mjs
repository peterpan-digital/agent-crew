#!/usr/bin/env node
/**
 * The one place a repository says how it differs from every other repository.
 *
 * The crew's rules are not repo-specific -- "a worker's own claim of success is
 * not evidence" is true everywhere -- but three things are: where evidence may
 * be written, which files must never be touched, and which APIs cost money. In
 * the harness this was ported from, all three were hardcoded, so handing it to
 * another team meant editing library code. They live in `crew.config.json` now.
 *
 * Zero config is a supported state: the defaults below work in any git
 * repository, and `crew doctor` prints what it would use.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { toPosix } from "./platform.mjs";

export const CONFIG_NAME = "crew.config.json";

export class ConfigError extends Error {
  constructor(message, detail) {
    super(detail ? `${message}\n  ${detail}` : message);
    this.name = "ConfigError";
    this.detail = detail;
  }
}

/**
 * Defaults.
 *
 * `runRoot` is `.crew` rather than anything resembling a task folder: a crew run
 * has to write its ledger, briefs and evidence somewhere inside the repo (so the
 * scope gate has something to anchor on), and a dot-directory is the one place
 * that does not collide with a project's own layout.
 *
 * `protectedPaths` deliberately lists credential-shaped files rather than
 * anything project-specific. These are checked even when git cannot see them,
 * which is the whole point: a gitignored `.env` is invisible to a diff-based
 * check and is exactly what a confused worker overwrites.
 */
export const DEFAULTS = {
  runRoot: ".crew",
  maxParallel: 3,
  maxJobs: 6,
  defaultTimeout: "15m",
  defaultIdleTimeout: "2m",
  briefMaxBytes: 2048,
  /** Minutes a job's write window extends past its end time. */
  scopeGraceMinutes: 2,
  /** Minutes of silence past a job's own timeout before it counts as dead. */
  staleGraceMinutes: 10,
  protectedPaths: [
    ".env",
    ".env.local",
    ".mcp.json",
    ".claude/.mcp.json",
    ".claude/settings.local.json",
    ".npmrc",
    ".netrc",
  ],
  protectedDirs: [
    ".claude/skills/",
    ".git/",
  ],
  /** Prefixes every job may write, on top of its own run directory. */
  defaultFilesMayModify: [],
  /** Named APIs a worker must stop at instead of calling. */
  costGate: [],
  /** Per-runtime model or effort tier used when a job does not name one. */
  defaultModel: {
    antigravity: null,
    codex: null,
  },
};

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));

/**
 * The repository root.
 *
 * git's answer is preferred because the scope gate reads `git status`, and a
 * root disagreeing with git's root would compare paths from two different
 * origins. Without git the cwd is used and the gate degrades to its
 * mtime-and-declaration half, which `crew doctor` reports.
 */
export function findWorkspace(start = process.cwd()) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    if (top) return resolve(top);
  } catch {
    // Not a git repo, or git is missing. Both are reported by `doctor`.
  }
  return resolve(start);
}

/** True when the workspace is a git repository, so callers can degrade loudly. */
export function hasGit(workspace) {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function validate(raw, path) {
  const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    // A typo'd key that is silently ignored reads as a setting that does not
    // work. The list of accepted keys is short enough to print in full.
    throw new ConfigError(
      `${path} has keys this version does not understand: ${unknown.join(", ")}`,
      `accepted keys: ${[...KNOWN_KEYS].join(", ")}`,
    );
  }
  for (const key of ["maxParallel", "maxJobs", "briefMaxBytes", "scopeGraceMinutes", "staleGraceMinutes"]) {
    if (key in raw && (!Number.isFinite(raw[key]) || raw[key] <= 0)) {
      throw new ConfigError(`${path}: ${key} must be a positive number, got ${JSON.stringify(raw[key])}`);
    }
  }
  for (const key of ["protectedPaths", "protectedDirs", "defaultFilesMayModify", "costGate"]) {
    if (key in raw && !Array.isArray(raw[key])) {
      throw new ConfigError(`${path}: ${key} must be an array`);
    }
  }
  if ("runRoot" in raw) {
    const rr = String(raw.runRoot);
    if (isAbsolute(rr) || toPosix(rr).split("/").includes("..")) {
      // An absolute or climbing runRoot puts evidence outside the repository,
      // where neither the scope gate nor a reviewer can see it.
      throw new ConfigError(
        `${path}: runRoot must be a relative path inside the repo, got ${rr}`,
      );
    }
  }
  return raw;
}

/**
 * Read config for a workspace. Missing file means defaults, not an error.
 *
 * The returned object carries `workspace`, `configPath` (null when defaulted)
 * and `git`, so every caller can report what it is actually operating on
 * without re-deriving it.
 */
export function loadConfig({ workspace = findWorkspace(), configPath = null } = {}) {
  const ws = resolve(workspace);
  const path = configPath ?? join(ws, CONFIG_NAME);
  let raw = {};
  let used = null;
  if (existsSync(path)) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      throw new ConfigError(`cannot read ${path}: ${err.message}`);
    }
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new ConfigError(`${path} is not valid JSON`, err.message);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigError(`${path} must contain a JSON object`);
    }
    validate(raw, path);
    used = path;
  }
  const merged = {
    ...DEFAULTS,
    ...raw,
    defaultModel: { ...DEFAULTS.defaultModel, ...(raw.defaultModel ?? {}) },
  };
  return {
    ...merged,
    workspace: ws,
    configPath: used,
    git: hasGit(ws),
  };
}

/** Absolute path of the directory holding every run. */
export function runsDir(config) {
  return join(config.workspace, config.runRoot, "runs");
}

/** Absolute path of one run's directory. */
export function runDir(config, runId) {
  return join(runsDir(config), runId);
}

/** The repo-relative, posix-spelled form of one run's directory. */
export function runDirRel(config, runId) {
  return `${toPosix(config.runRoot)}/runs/${runId}`;
}
