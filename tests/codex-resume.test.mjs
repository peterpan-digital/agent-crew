#!/usr/bin/env node
/**
 * Codex headless resume: the argv shape, and the session id that makes it possible.
 *
 * Two measurements drove this, both on codex-cli 0.154.0, 23/09:
 *
 *   `codex exec resume --sandbox ...`  ->  error: unexpected argument '--sandbox'
 *   `codex exec --json -C ... --sandbox ... --color never resume --help`  ->  parses
 *
 * `resume` is a SUBCOMMAND of `exec`, and -C / --sandbox / --color belong to the
 * parent, so they have to precede it. That makes the insertion point load-bearing
 * rather than cosmetic, which is why argv order is asserted here rather than
 * assumed -- a reviewer has already caught this adapter reordering argv once.
 *
 * The id itself has been on the wire since at least 27/08: every stored sidecar
 * opens with `{"type":"thread.started","thread_id":"01a0..."}`. Nothing read it,
 * so the one thing needed to continue a job was discarded on every run.
 *
 * Run: node mwg-agent-crew/tests/codex-resume.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRun, addJob, readManifest } from "../scripts/crew-manifest.mjs";
import { resolveLogDir } from "../scripts/codex-run.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("codex-resume");
const ADAPTER = join(MODULE_ROOT, "scripts", "codex-run.mjs");
const ws = tmpWorkspace("codexresume-");
const RUN_DIR_REL = join("tasks", "t", "reports", "crew-test");
mkdirSync(join(ws, RUN_DIR_REL), { recursive: true });
const brief = writeFile(join(ws, "brief.md"), "do the thing\n");

function run({ evidence, extra = [], mode = "argvdump", threadId, manifest, job }) {
  const proc = spawnSync("node", [
    ADAPTER,
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
      ...(threadId ? { FAKE_THREAD_ID: threadId } : {}),
    },
    timeout: 90_000,
  });
  return { exit: proc.status, stderr: proc.stderr ?? "" };
}

const argvOf = (evidence) => readFileSync(join(ws, evidence), "utf8").match(/^ARGV=(.*)$/m)?.[1] ?? "";

{
  // `-o` is normalised out of the argv comparisons above, so without this
  // nothing in the repo asserts where the last-message file lands -- the
  // fixture used to ignore the flag entirely.
  const evidence = join(RUN_DIR_REL, "lastmsg.md");
  run({ evidence, mode: "thread" });
  const expected = join(resolveLogDir(join(ws, evidence), ws), "lastmsg.codex-last-message.txt");
  t.check("the -o path is where the adapter says the reply goes",
    existsSync(expected), true);
}

// --- the argv shape ---------------------------------------------------------

const plainEv = join(RUN_DIR_REL, "argv-plain.md");
run({ evidence: plainEv });
const plain = argvOf(plainEv);

{
  t.check("a job with no --resume has no subcommand", / resume /.test(` ${plain} `), false);
}

{
  const evidence = join(RUN_DIR_REL, "argv-resume.md");
  run({ evidence, extra: ["--resume", "01a0-thread", "--effort", "low"] });
  const tokens = argvOf(evidence).split(" ");
  const at = (flag) => tokens.indexOf(flag);

  t.check("--resume becomes the exec subcommand", tokens[at("resume") - 0], "resume");
  t.check("...carrying the id", tokens[at("resume") + 1], "01a0-thread");

  // The insertion INDEX, not just "the token is somewhere". A `resume` inserted
  // after -m/-c parses too, so a position-blind assertion cannot tell the two
  // apart -- and position is the whole finding of this phase.
  t.check("...immediately after the last parent flag",
    at("resume"), at("never") + 1);

  // Measured: `codex exec resume` rejects these outright ("unexpected
  // argument"), so each has to land before the subcommand or the job dies on
  // argv parsing. And they do reach the resumed turn -- a probe with
  // --sandbox danger-full-access recorded danger-full-access on the new turn.
  for (const flag of ["-C", "--sandbox", "--color"]) {
    t.check(`...with ${flag} ahead of it, where exec requires it`,
      at(flag) < at("resume") && at(flag) !== -1, true);
  }

  // The opposite rule, and the bug that made this phase worth reviewing twice:
  // `-c` in the PARENT position is silently dropped on a resume. Read from one
  // session's rollout: fresh turn network_access true, resumed turn FALSE, and
  // true again once -c moved after the subcommand.
  t.check("...and the network -c moved AFTER it, where it survives",
    at("sandbox_workspace_write.network_access=true") > at("resume"), true);
  // The token this test exists to keep behind the subcommand. Nothing else in
  // the argv sits after the insertion point, so without --effort above, a
  // `resume` pushed too late is indistinguishable from one pushed correctly.
  t.check("...and the effort -c stays behind the subcommand too",
    at("model_reasoning_effort=low") > at("resume"), true);
  t.check("...appearing exactly once", 
    tokens.filter((x) => x === "sandbox_workspace_write.network_access=true").length, 1);
}

{
  // The non-resume argv must be byte-identical: a reviewer has already caught
  // this adapter reordering argv once. Asserted against the literal shape so a
  // reordering cannot hide behind a same-length diff.
  const tokens = plain.split(" ");
  t.check("a plain job's argv is unchanged in shape",
    [tokens[0], tokens[1], tokens[2], tokens[4], tokens[6], tokens[8], tokens[10], tokens[11], tokens[12]],
    ["exec", "--json", "-C", "--sandbox", "-c", "-o", "--color", "never", "-"]);
}

// --- the session id ---------------------------------------------------------

{
  const evidence = join(RUN_DIR_REL, "thread-plain.md");
  const manifest = setupManifest("m1", evidence);
  run({ evidence, mode: "thread", threadId: "01a0-captured", manifest, job: 1 });
  const jobRec = readManifest(manifest).jobs[0];

  // Captured for EVERY job, not only resumed ones: a job only becomes worth
  // continuing after you have seen what it produced.
  t.check("an ordinary job records its session id", jobRec.conversationId, "01a0-captured");
  t.check("...and records that it continued nothing", jobRec.resumedFrom, null);
}

{
  const evidence = join(RUN_DIR_REL, "thread-resumed.md");
  const manifest = setupManifest("m2", evidence);
  run({ evidence, mode: "thread", threadId: "01a0-same", extra: ["--resume", "01a0-same"], manifest, job: 1 });
  const jobRec = readManifest(manifest).jobs[0];
  t.check("a resumed job records what it continued", jobRec.resumedFrom, "01a0-same");
  t.check("...and the session it ran in", jobRec.conversationId, "01a0-same");
}

{
  // A stream that never names a thread must leave the field empty rather than
  // inventing one; a wrong id is worse than none, because it would be resumed.
  const evidence = join(RUN_DIR_REL, "thread-absent.md");
  const manifest = setupManifest("m3", evidence);
  run({ evidence, mode: "ok", manifest, job: 1 });
  t.check("no thread.started means no id claimed",
    readManifest(manifest).jobs[0].conversationId ?? null, null);
}

{
  // Insurance against a behaviour change, not a fix for today's behaviour:
  // measured 23/09, `codex exec resume <unknown-id>` exits 1 with "no rollout
  // found", so the real runtime never reaches this. agy, one surface over, does
  // the opposite -- warns and opens a fresh session with exit 0 -- and that is
  // the failure that leaves no trace anywhere else, so codex must not be the
  // surface without the check.
  const evidence = join(RUN_DIR_REL, "thread-substituted.md");
  const manifest = setupManifest("m4", evidence);
  const r = run({ evidence, mode: "thread", threadId: "01a0-other",
    extra: ["--resume", "01a0-asked"], manifest, job: 1 });
  t.check("a substituted session does not pass quietly", r.exit !== 0, true);
  const jobRec = readManifest(manifest).jobs[0];
  t.check("...and the manifest shows both ids",
    [jobRec.resumedFrom, jobRec.conversationId], ["01a0-asked", "01a0-other"]);
  t.check("...and is marked mismatched", jobRec.resumeMismatch, true);
}

function setupManifest(name, evidence) {
  const runDir = join(ws, RUN_DIR_REL, name);
  mkdirSync(runDir, { recursive: true });
  const { manifestPath } = createRun({ runDir, runId: `crew-${name}`, task: "t", workspace: ws, depth: 0 });
  addJob(manifestPath, { worker: "codex", role: "assist", title: name, evidence });
  return manifestPath;
}

process.exit(t.finish() ? 0 : 1);
