#!/usr/bin/env node
/**
 * Runs every *.test.mjs in this folder and fails the run if any one of them
 * fails. Each test file is its own process, so a hang or a crash in one cannot
 * take the others' results with it.
 *
 * Run: node plugins/agent-crew/tests/run.mjs
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(HERE).filter((f) => f.endsWith(".test.mjs")).sort();

const failed = [];
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  // A lifecycle test deliberately waits out kill deadlines, so the ceiling here
  // has to be generous; it exists only to turn a hang into a reported failure.
  const proc = spawnSync("node", [join(HERE, file)], { stdio: "inherit", timeout: 300_000 });
  if (proc.status !== 0) failed.push(`${file} (exit ${proc.status}${proc.signal ? `, ${proc.signal}` : ""})`);
}

console.log(`\n${files.length - failed.length}/${files.length} test files passed`);
for (const f of failed) console.log(`  FAILED  ${f}`);
process.exit(failed.length === 0 ? 0 : 1);
