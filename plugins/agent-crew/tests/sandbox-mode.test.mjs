#!/usr/bin/env node
/**
 * `--sandbox-mode`: how much of the machine a worker may touch.
 *
 * Measured 22/09 across three surfaces: the tool list is IDENTICAL everywhere
 * -- eighteen tools, Computer Use among them -- and the sandbox alone decides
 * whether any of them act. Under `workspace-write` a screenshot returns
 * "Computer Use was not approved" and a write outside the repo returns
 * "Operation not permitted"; without the flag both succeed. A worker is not
 * missing tools, it is forbidden to use them.
 *
 * So this flag is a real grant of power, and the tests are weighted that way.
 * The one that matters most is not "the flag works" -- it is the pair at the
 * bottom: the default is unchanged, and the credential guard still turns the
 * gate red when the sandbox is open. The 18/09 incident (a worker deleting the
 * owner's credential store) was stopped by the sandbox; opening it deliberately
 * means the hash guard is the only thing left, so it has to be proven at this
 * permission level and not merely assumed to carry over.
 *
 * Run: node mwg-agent-crew/tests/sandbox-mode.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRun, addJob, readManifest } from "../scripts/crew-manifest.mjs";
import { resolveLogDir } from "../scripts/codex-run.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("sandbox-mode");
const ADAPTER = join(MODULE_ROOT, "scripts", "codex-run.mjs");
const ws = tmpWorkspace("sandboxmode-");
const RUN_DIR_REL = join("tasks", "t", "reports", "crew-test");
mkdirSync(join(ws, RUN_DIR_REL), { recursive: true });
const brief = writeFile(join(ws, "brief.md"), "do the thing\n");

function run({ evidence, extra = [], env = {}, mode = "argvdump" }) {
  const proc = spawnSync("node", [
    ADAPTER,
    "--prompt-file", brief,
    "--evidence", evidence,
    "--workspace", ws,
    "--timeout", "60s",
    ...extra,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${process.env.PATH}`,
      FAKE_MODE: mode,
      FAKE_EVIDENCE: join(ws, evidence),
      ...env,
    },
    timeout: 90_000,
  });
  return { exit: proc.status, stderr: proc.stderr ?? "", stdout: proc.stdout ?? "" };
}

const argvOf = (evidence) => readFileSync(join(ws, evidence), "utf8");
/**
 * A refusal has to stop the job, not just print. Checking the exit code alone
 * would pass just as happily on a run that printed a complaint and then went
 * ahead -- the evidence file is written by the worker, so its absence is the
 * only proof nothing ran.
 */
const ranNothing = (evidence) => !existsSync(join(ws, evidence));

// --- the default must not move --------------------------------------------

{
  // The whole opt-in design rests on this: a dispatcher that says nothing gets
  // exactly what it got before the flag existed.
  const evidence = join(RUN_DIR_REL, "default.md");
  const r = run({ evidence });
  const body = argvOf(evidence);
  t.check("a job with no flag still runs", r.exit, 0);
  t.check("...and is still sandboxed to the workspace", /--sandbox workspace-write/.test(body), true);
  t.check("...and says nothing alarming", /CẢNH BÁO/.test(r.stderr), false);
}

// --- the grant -------------------------------------------------------------

{
  const evidence = join(RUN_DIR_REL, "full.md");
  const r = run({ evidence, extra: ["--sandbox-mode", "danger-full-access"] });
  const body = argvOf(evidence);
  t.check("the flag reaches codex", r.exit, 0);
  // Asserted where it lands, not where it was typed: a flag parsed and then
  // dropped before buildArgs would pass any test that only checked the input.
  t.check("...as the sandbox codex actually receives", /--sandbox danger-full-access/.test(body), true);
  t.check("...and no workspace-write is left behind", /--sandbox workspace-write/.test(body), false);
  // A job running outside the sandbox has to be visible without anyone opening
  // the manifest to find out.
  t.check("...and the log says so loudly", /CẢNH BÁO.*danger-full-access/.test(r.stderr), true);
}

{
  const evidence = join(RUN_DIR_REL, "explicit-default.md");
  const r = run({ evidence, extra: ["--sandbox-mode", "workspace-write"] });
  t.check("naming the default explicitly is allowed", r.exit, 0);
  // Read back rather than inferred from exit 0: a flag parsed and then dropped
  // would pass an exit-code-only check.
  t.check("...and still reaches codex as workspace-write", /--sandbox workspace-write/.test(argvOf(evidence)), true);
  t.check("...and is not treated as a grant", /CẢNH BÁO/.test(r.stderr), false);
}

// --- a value nobody defined ------------------------------------------------

{
  // Refused, never coerced. Falling back to the default here would run the job
  // at a permission level the dispatcher did not ask for and say nothing --
  // the same shape of bug as codex accepting an unknown reasoning effort.
  const evidence = join(RUN_DIR_REL, "badvalue.md");
  const r = run({ evidence, extra: ["--sandbox-mode", "full"] });
  t.check("an unknown value is refused", r.exit !== 0, true);
  t.check("...and lists what is allowed", /use one of: workspace-write, danger-full-access/.test(r.stderr), true);
  // The first version of this asserted that stderr lacked "--sandbox
  // workspace-write" -- vacuous, because the built argv never appears on
  // stderr on any path, so it passed whether or not the code fell back.
  t.check("...and does not quietly fall back to the default", ranNothing(evidence), true);
}

{
  const evidence = join(RUN_DIR_REL, "typo.md");
  const r = run({ evidence, extra: ["--sandbox", "danger-full-access"] });
  t.check("a near-miss flag name is refused, not ignored", r.exit !== 0, true);
  t.check("...and names the flags it knows", /--sandbox-mode/.test(r.stderr), true);
  t.check("...and no worker was spawned", ranNothing(evidence), true);
}

// --- app mode cannot honour it --------------------------------------------

{
  // Measured 22/09: an app-mode probe writing to $HOME came back "Operation not
  // permitted" exactly like sandboxed headless, and its browser was gone as
  // well. The app sandboxes dispatched tasks itself, so accepting this flag
  // would hand back a job that looks unsandboxed and is not.
  const evidence = join(RUN_DIR_REL, "appmode.md");
  const r = run({ evidence, extra: ["--mode", "app", "--sandbox-mode", "danger-full-access"] });
  t.check("app mode refuses the flag", r.exit !== 0, true);
  t.check("...and explains the app decides, not this adapter", /app sandboxes dispatched tasks/.test(r.stderr), true);
  t.check("...and points at the transport that works", /--mode headless/.test(r.stderr), true);
}

// --- the manifest has to remember the permission level ---------------------

/** Through the real construction path, not a hand-written JSON blob. */
function newRun(name) {
  const dir = join(ws, RUN_DIR_REL, name);
  mkdirSync(dir, { recursive: true });
  const { manifestPath } = createRun({ runDir: dir, runId: name, task: "t", workspace: ws, depth: 0 });
  // Basename, not folder, is what names the sidecar log, so it has to be unique
  // across the whole file -- a collision makes the adapter refuse to start and
  // the job then "fails" for a reason that has nothing to do with the test.
  const evidence = join(RUN_DIR_REL, name, `w-${name}.md`);
  addJob(manifestPath, { worker: "codex", role: "assist", title: name, evidence });
  return { manifestPath, evidence };
}

{
  // Without this the manifest cannot answer the first question anyone asks
  // during an incident: what was this job allowed to do?
  const { manifestPath, evidence } = newRun("granted");
  const r = run({
    evidence,
    extra: ["--sandbox-mode", "danger-full-access", "--manifest", manifestPath, "--job", "1"],
  });
  t.check("the job runs with a manifest attached", r.exit, 0);
  t.check("...and the manifest records the permission level",
    readManifest(manifestPath).jobs[0].sandboxMode, "danger-full-access");
}

{
  const { manifestPath, evidence } = newRun("plain");
  run({ evidence, extra: ["--manifest", manifestPath, "--job", "1"] });
  // Recorded on the default path too, so an absent field means one thing only:
  // a job from before this field existed.
  t.check("the default level is recorded too, not left blank",
    readManifest(manifestPath).jobs[0].sandboxMode, "workspace-write");
}

{
  // The case the field exists for. It used to be taken from the finished
  // result, which only exists when the job succeeds -- so the jobs that lost
  // the field were the crashed ones, which is exactly the population anyone
  // investigating an incident is looking at.
  const { manifestPath, evidence } = newRun("died");
  const r = run({
    evidence,
    mode: "nodrain",  // exits 7 without writing evidence
    extra: ["--sandbox-mode", "danger-full-access", "--manifest", manifestPath, "--job", "1"],
  });
  const job = readManifest(manifestPath).jobs[0];
  t.check("a job that dies is recorded as failed", job.status, "failed");
  t.check("...and still says what it was allowed to do", job.sandboxMode, "danger-full-access");
  t.check("...and the adapter reports the failure", r.exit !== 0, true);
}

// --- the grant has to outlive the terminal it was typed in -----------------

{
  // stderr is for whoever is watching right now. The sidecar is for whoever
  // reads the run back next week, and a background dispatch has no one
  // watching at all -- so the record of a privilege grant cannot live only in
  // a terminal.
  const { manifestPath, evidence } = newRun("durable");
  run({
    evidence,
    extra: ["--sandbox-mode", "danger-full-access", "--manifest", manifestPath, "--job", "1"],
  });
  const logDir = resolveLogDir(join(ws, evidence), ws);
  const sidecar = readFileSync(join(logDir, "w-durable.codex-stream.jsonl"), "utf8");
  t.check("the grant is written into the durable log", /CẢNH BÁO/.test(sidecar), true);
  t.check("...naming the level", /danger-full-access/.test(sidecar), true);
}

// --- a worker may not raise its own ceiling --------------------------------

{
  // The crew already refuses to let a worker dispatch another worker. A worker
  // handing itself full machine access is the same escalation by a shorter
  // route, and closing it does not depend on Seatbelt profile inheritance --
  // which nobody here has verified.
  const evidence = join(RUN_DIR_REL, "asworker.md");
  const r = run({
    evidence,
    extra: ["--sandbox-mode", "danger-full-access"],
    env: { MWG_CREW_ROLE: "worker" },
  });
  t.check("a worker cannot grant itself full access", r.exit !== 0, true);
  t.check("...and is told why", /not available to a worker/.test(r.stderr), true);
  t.check("...and nothing was spawned", ranNothing(evidence), true);
}

// --- the guards do not weaken with the sandbox open ------------------------

{
  // The 18/09 deletion came in through this variable. The strip must not be
  // conditional on the sandbox: the unsandboxed run is exactly where it counts.
  const evidence = join(RUN_DIR_REL, "strip-full.md");
  const r = run({
    evidence,
    mode: "envdump",
    extra: ["--sandbox-mode", "danger-full-access"],
    env: { GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file" },
  });
  const body = readFileSync(join(ws, evidence), "utf8");
  t.check("an unsandboxed job still runs", r.exit, 0);
  t.check("...and still never sees the keyring override", /KEYRING=absent/.test(body), true);
  t.check("...and still carries the recursion guard", /ROLE=worker/.test(body), true);
}

{
  // Mirrors --workspace-cli, which accepts `off` in app mode and refuses `on`.
  // A dispatcher template that passes the default level uniformly must not
  // break every app job -- and telling it "use headless for full permissions"
  // when it asked for the default would answer a question it never asked.
  const evidence = join(RUN_DIR_REL, "app-default.md");
  const r = run({ evidence, extra: ["--mode", "app", "--sandbox-mode", "workspace-write"] });
  // The app path fails here for its own reasons (no companion in the fixture
  // environment); all this asserts is that the sandbox check is not the one
  // stopping it.
  t.check("app mode does not refuse the default level", /sandbox-mode .* is not available in app mode/.test(r.stderr), false);
}

{
  // The brief is the only boundary left once Seatbelt is off (owner chốt 22/09:
  // không cấm cặp cờ này). Asserted on what the worker was actually handed on
  // stdin, not on what the adapter composed -- the unit test covers composition,
  // and a wiring mistake would pass that one while shipping nothing.
  const plain = "brief-plain.md";
  run({ evidence: join(RUN_DIR_REL, plain), mode: "briefdump" });
  t.check("a sandboxed job's brief carries no extra boundary line",
    /NGOÀI sandbox/.test(readFileSync(join(ws, RUN_DIR_REL, plain), "utf8")), false);

  const loose = "brief-loose.md";
  run({
    evidence: join(RUN_DIR_REL, loose),
    extra: ["--sandbox-mode", "danger-full-access"],
    mode: "briefdump",
  });
  const text = readFileSync(join(ws, RUN_DIR_REL, loose), "utf8");
  t.check("an unsandboxed job is handed the boundary line", /chạy NGOÀI sandbox/.test(text), true);
  t.check("...naming the credential store", text.includes("~/.config/gws/"), true);
  t.check("...and the author's own brief survives", text.includes("do the thing"), true);
}

process.exit(t.finish() ? 0 : 1);
