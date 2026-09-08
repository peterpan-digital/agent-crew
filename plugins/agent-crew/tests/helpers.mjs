/**
 * Minimal test scaffolding for the crew plugin.
 *
 * There is no test framework here on purpose: the module is a handful of small
 * libraries behind one CLI, and the thing worth testing is their behaviour at
 * the process boundary -- exit codes, files on disk, manifest contents. A runner
 * that can spawn a process and compare strings is the whole requirement.
 */
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MODULE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = join(MODULE_ROOT, "tests", "fixtures");
/** The single entrypoint; every subcommand goes through it. */
export const CREW_CLI = join(MODULE_ROOT, "bin", "crew.mjs");

/**
 * The run layout `crew.config.json` defaults to: `.crew/runs/{runId}`.
 *
 * Spelled with forward slashes because that is how `evidenceRoot` is stored and
 * how `git status` reports paths, on every platform.
 */
export const RUN_ID = "test";
export const RUN_REL = `.crew/runs/${RUN_ID}`;
export const runRel = (runId) => `.crew/runs/${runId}`;
/** A path inside a run directory, in the spelling the manifest uses. */
export const under = (root, ...parts) => [root, ...parts].join("/");

export function makeChecker(title) {
  let pass = 0;
  const failures = [];
  return {
    check(name, got, want) {
      const ok = String(got) === String(want);
      if (ok) pass += 1;
      else failures.push({ name, got, want });
      console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}`);
      if (!ok) console.log(`        got  ${got}\n        want ${want}`);
      return ok;
    },
    /** Exit code doubles as the CI signal, so a runner needs nothing else. */
    finish() {
      console.log(`\n${title}: ${pass} passed, ${failures.length} failed`);
      return failures.length === 0;
    },
  };
}

/**
 * A workspace with an empty run directory in it. Every crew guard refuses to
 * write outside the run's `evidenceRoot`, so a test workspace must have one --
 * and must never be the real repo, or a test run would litter it.
 *
 * `realpathSync` because mkdtemp hands back `/var/...` on macOS while `git
 * rev-parse` answers `/private/var/...`; comparing one against the other is a
 * flake nobody would find twice.
 */
export function tmpWorkspace(prefix = "crew-test-") {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(ws, ".crew", "runs", RUN_ID), { recursive: true });
  return ws;
}

export function writeFile(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/**
 * Installs a launcher for the fake codex CLI into `dir` and returns its path,
 * for `AGENT_CREW_CODEX_BIN`.
 *
 * The fixture itself is a Node module (`fake-codex.mjs`), so the suite runs on
 * Windows as well as POSIX. What differs per platform is only how the OS is
 * persuaded to execute it, because the adapter spawns the resolved binary
 * directly and never through a shell:
 *
 *   - Windows: a `.cmd` shim, which is what an npm-installed CLI actually is
 *     there, and which `lib/platform.mjs` knows to route through cmd.exe.
 *   - POSIX: a tiny extension-less launcher with a `#!<this node>` line, made
 *     executable here rather than committed with an exec bit -- a bit that
 *     does not survive every checkout, and cannot be set on Windows at all.
 */
export function installFakeCodex(dir) {
  mkdirSync(dir, { recursive: true });
  const target = pathToFileURL(join(FIXTURES, "fake-codex.mjs")).href;
  if (process.platform === "win32") {
    const cmd = join(dir, "fake-codex.cmd");
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${fileURLToPath(target)}" %*\r\n`, "utf8");
    return cmd;
  }
  const launcher = join(dir, "fake-codex");
  // No extension and no package.json alongside it, so Node loads this as CJS --
  // where a dynamic import of the ESM fixture is still available.
  writeFileSync(launcher, `#!${process.execPath}\nimport(${JSON.stringify(target)});\n`, "utf8");
  chmodSync(launcher, 0o755);
  return launcher;
}
