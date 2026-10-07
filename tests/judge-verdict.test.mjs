#!/usr/bin/env node
/**
 * The evidence-first decision table in crew-guards.judgeJob().
 *
 * This is the rule two finished jobs were lost to on 2026-08-24: the runtime's
 * verdict was consulted before the evidence, so an agy ERROR over a complete
 * report was recorded as a failure. Every row below is a case that inversion got
 * wrong or could get wrong again.
 */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { judgeJob } from "../scripts/crew-guards.mjs";
import { makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const ws = tmpWorkspace("judge-");
const dir = join(ws, "tasks", "t", "reports", "crew-test");
const t = makeChecker("judge-verdict");

/** Collapses a verdict (or the error it threw) into one comparable string. */
const judge = (path, runtimeOk, detail) => {
  try {
    const v = judgeJob(path, { runtimeOk, runtimeDetail: detail, context: "test" });
    return `${v.status}${v.runtimeVerdict ? "+disagree" : ""}`;
  } catch (err) {
    return `throw:${err.message.split("\n")[0]}`;
  }
};

const done = writeFile(join(dir, "done.md"), "work\n\nStatus: DONE\nSummary: x\n");
const concerns = writeFile(join(dir, "concerns.md"), "work\n\nStatus: DONE_WITH_CONCERNS\n");
const blocked = writeFile(join(dir, "blocked.md"), "stopped\n\nStatus: BLOCKED\nConcerns/Blockers: COST_GATE — Ahrefs\n");
const noStatus = writeFile(join(dir, "no-status.md"), "did some work, forgot the contract\n");
const empty = writeFile(join(dir, "empty.md"), "");
const missing = join(dir, "never-written.md");

// The runtime agrees: nothing to arbitrate.
t.check("evidence + Status + runtime ok", judge(done, true), "done");

// The rows that matter: evidence that judged itself outranks a runtime failure.
t.check("evidence + Status + runtime ERROR", judge(done, false, "agy reported status ERROR"), "done+disagree");
t.check("concerns survive a runtime failure", judge(concerns, false, "agy exited 1"), "done_with_concerns+disagree");
t.check("a cost gate is not a failure", judge(blocked, false, "codex killed"), "blocked+disagree");

// No Status line: now the runtime decides whether this is a report or a corpse.
t.check("no Status + runtime ok", judge(noStatus, true), "done_unverified");
t.check("no Status + runtime failed", judge(noStatus, false, "codex killed: idle"), "throw:the runtime failed and the evidence carries no Status line");

// No usable evidence: the runtime's account is the only account there is, and
// the two stories get two different headlines.
t.check("empty evidence + runtime ok", judge(empty, true), "throw:the worker created an empty evidence file");
t.check("missing evidence + runtime ok", judge(missing, true), "throw:the worker reported success but wrote no evidence file");
t.check("missing evidence + runtime failed", judge(missing, false, "died"), "throw:the job did not finish and left no usable evidence");

// Collect so lại digest này để biết evidence có bị ghi đè sau khi chấm không.
{
  const v = judgeJob(done, { runtimeOk: true, context: "test" });
  t.check("verdict mang sha256 của đúng file đã chấm", v.evidenceSha256, createHash("sha256").update(readFileSync(done)).digest("hex"));
}

process.exit(t.finish() ? 0 : 1);
