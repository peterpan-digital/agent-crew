/**
 * Minimal test scaffolding for the crew module.
 *
 * There is no test framework here on purpose: the module is a handful of
 * synchronous CLI scripts, and the thing worth testing is their behaviour at the
 * process boundary -- exit codes, files on disk, manifest contents. A runner
 * that can spawn a process and compare strings is the whole requirement.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const MODULE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = join(MODULE_ROOT, "tests", "fixtures");
/**
 * Prepend this to PATH to make `codex` resolve to the fake. The fake lives one
 * level up under its own name so it reads as a fixture; `bin/codex` is the
 * symlink that gives it the spelling the adapter actually spawns. Without the
 * exact name, PATH quietly falls through to the real CLI and the whole suite
 * measures nothing.
 */
export const FIXTURE_BIN = join(FIXTURES, "bin");

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
 * A workspace with its own tasks/ tree. Every crew guard refuses to write
 * outside tasks/, so a test workspace must have one -- and must never be the
 * real repo, or a test run would litter the task folders it is meant to protect.
 */
export function tmpWorkspace(prefix = "crew-test-") {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(ws, "tasks", "t", "reports", "crew-test"), { recursive: true });
  return ws;
}

export function writeFile(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}
