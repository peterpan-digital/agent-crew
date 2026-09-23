#!/usr/bin/env node
/**
 * Anti headless resume: `--conversation`, and the check that it was honoured.
 *
 * Measured against the real agy on 22/09, and the negative case is why the
 * verification exists at all:
 *
 *   agy --conversation <unknown-id>  ->  `warning: ... not found` on STDERR,
 *                                        exit 0, a BRAND NEW conversation id
 *   agy --conversation <real-id>     ->  the same id back, num_turns 2,
 *                                        20k cached tokens, and it answered
 *                                        from the earlier turn
 *
 * So a resume that did not happen is indistinguishable from one that did,
 * unless the returned id is compared with the requested one. The id is
 * compared rather than the warning text: two asserted facts are a measurement,
 * a stderr phrase is a guess about wording that is free to change.
 *
 * Run: node mwg-agent-crew/tests/anti-resume.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRun, addJob, readManifest } from "../scripts/crew-manifest.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("anti-resume");
const ANTI = join(MODULE_ROOT, "scripts", "anti-run.mjs");
const ws = tmpWorkspace("antiresume-");
const RUN_DIR_REL = join("tasks", "t", "reports", "crew-test");
mkdirSync(join(ws, RUN_DIR_REL), { recursive: true });
const brief = writeFile(join(ws, "brief.md"), "do the thing\n");

function run({ evidence, extra = [], conversationId, manifest, job, mode = "argvdump" }) {
  const proc = spawnSync("node", [
    ANTI,
    "--prompt-file", brief,
    "--evidence", evidence,
    "--workspace", ws,
    "--timeout", "60s",
    ...(manifest ? ["--manifest", manifest, "--job", String(job)] : []),
    ...extra,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${process.env.PATH}`,
      FAKE_MODE: mode,
      FAKE_EVIDENCE: join(ws, evidence),
      ...(conversationId ? { FAKE_CONVERSATION_ID: conversationId } : {}),
    },
    timeout: 90_000,
  });
  return { exit: proc.status, stderr: proc.stderr ?? "", stdout: proc.stdout ?? "" };
}

const argvOf = (evidence) => readFileSync(join(ws, evidence), "utf8");

// --- the argv ---------------------------------------------------------------

{
  const evidence = join(RUN_DIR_REL, "argv-plain.md");
  run({ evidence });
  const argv = argvOf(evidence);
  t.check("a job with no --resume passes no session flag",
    /--conversation|--continue/.test(argv), false);
}

{
  const evidence = join(RUN_DIR_REL, "argv-resume.md");
  run({ evidence, extra: ["--resume", "conv-abc"], conversationId: "conv-abc" });
  const argv = argvOf(evidence);
  t.check("--resume becomes --conversation <id>", /--conversation conv-abc/.test(argv), true);
  // agy has --continue for "the most recent conversation". With max_parallel at
  // 3 that is a race, and losing it feeds a follow-up into another job's session.
  t.check("...and never --continue", /--continue/.test(argv), false);
}

// --- the honoured / not-honoured distinction --------------------------------

{
  // The positive case. Without it, a check that failed every resume would still
  // leave the negative case below green.
  const evidence = join(RUN_DIR_REL, "honoured.md");
  const r = run({ evidence, extra: ["--resume", "conv-keep"], conversationId: "conv-keep" });
  t.check("a resume the runtime honoured succeeds", r.exit, 0);
  t.check("...and is not flagged", /mở conversation mới/.test(r.stderr), false);
}

{
  // The measured failure, reproduced: the runtime silently substitutes a new
  // session and still reports SUCCESS with an exit code of 0.
  const evidence = join(RUN_DIR_REL, "mismatch.md");
  const r = run({ evidence, extra: ["--resume", "conv-asked"], conversationId: "conv-other" });
  t.check("a silently substituted session fails the job", r.exit !== 0, true);
  t.check("...and names both ids", /conv-asked/.test(r.stderr) && /conv-other/.test(r.stderr), true);
  // The evidence is deliberately NOT the deciding signal here: the worker did
  // write a well-formed file, it just wrote it in the wrong session.
  t.check("...even though the worker wrote valid evidence",
    existsSync(join(ws, evidence)) && /Status: DONE/.test(argvOf(evidence)), true);
}

{
  // Fails closed. The premise of this whole check is that the runtime can fail
  // to resume without saying so, so "the field is missing" must not read as
  // "verified" -- a rename in a future agy would otherwise switch verification
  // off on every resume at once, silently.
  const evidence = join(RUN_DIR_REL, "no-conv-id.md");
  const r = run({ evidence, extra: ["--resume", "conv-asked"], mode: "no_conv_id" });
  t.check("an unverifiable resume does not pass quietly", r.exit !== 0, true);
  t.check("...and says what could not be checked",
    /không trả conversation_id/.test(r.stderr), true);
  t.check("...but is not accused of a mismatch it cannot prove",
    /mở conversation mới/.test(r.stderr), false);
}

// --- what the manifest records ---------------------------------------------

{
  const runDir = join(ws, RUN_DIR_REL, "m");
  mkdirSync(runDir, { recursive: true });
  const { manifestPath } = createRun({ runDir, runId: "crew-m", task: "t", workspace: ws, depth: 0 });
  // Distinct basenames: the sidecar log is named after the evidence basename,
  // so a collision makes the adapter refuse to start and the job then "fails"
  // for a reason that has nothing to do with this test.
  const okEv = join(RUN_DIR_REL, "m", "m-ok.md");
  const badEv = join(RUN_DIR_REL, "m", "m-bad.md");
  addJob(manifestPath, { worker: "antigravity", role: "owner", title: "ok", evidence: okEv });
  addJob(manifestPath, { worker: "antigravity", role: "owner", title: "bad", evidence: badEv });

  run({ evidence: okEv, extra: ["--resume", "conv-keep"],
    conversationId: "conv-keep", manifest: manifestPath, job: 1 });
  run({ evidence: badEv, extra: ["--resume", "conv-asked"],
    conversationId: "conv-other", manifest: manifestPath, job: 2 });

  const jobs = readManifest(manifestPath).jobs;
  const ok = jobs.find((j) => j.seq === 1);
  const bad = jobs.find((j) => j.seq === 2);

  t.check("an honoured resume records what it continued", ok.resumedFrom, "conv-keep");
  t.check("...and is not marked mismatched", Boolean(ok.resumeMismatch), false);

  // conversationId alone cannot show this: it reports the session that RAN, not
  // the one that was asked for. Both fields are needed to see the substitution.
  t.check("a substituted resume still records what was asked for", bad.resumedFrom, "conv-asked");
  t.check("...and what actually ran", bad.conversationId, "conv-other");
  t.check("...and is marked mismatched", bad.resumeMismatch, true);
  // Deliberately NOT "failed": crew-collect re-derives status from the evidence
  // Status line, so an override here would be discarded at the gate and leave
  // the manifest contradicting the gate table. The mismatch is enforced through
  // runtimeVerdict (the WARN + --ack-runtime path) instead.
  t.check("...without the manifest contradicting the gate", bad.status, "done");
  t.check("...and carries a runtime verdict for the gate to act on",
    Boolean(bad.runtimeVerdict), true);
  t.check("...with a failure a reader can act on",
    /conv-asked/.test(bad.failure ?? "") && /conv-other/.test(bad.failure ?? ""), true);
}

process.exit(t.finish() ? 0 : 1);
