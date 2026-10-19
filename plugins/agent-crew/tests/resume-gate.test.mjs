#!/usr/bin/env node
/**
 * `--resume`: the gate, before any surface can honour it.
 *
 * This exists because of a silent failure, not a missing feature. `--resume`
 * was already in anti-run's KNOWN_FLAGS but only read on the app branch, so
 * `--mode headless --resume <id>` parsed cleanly, printed nothing, and opened a
 * BRAND NEW conversation. The worker re-read everything from scratch and the
 * run looked exactly like a successful resume from the outside. Nothing in the
 * manifest, the evidence, or the exit code could tell the two apart.
 *
 * So the assertions here are not "the error message is nice". They are: the
 * process spawned nothing, and it left nothing behind. A refusal that prints a
 * complaint and then runs the job anyway is the bug, not the fix.
 *
 * Run: node mwg-agent-crew/tests/resume-gate.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { resolveResume, GuardError } from "../scripts/crew-guards.mjs";
import { resolveLogDir } from "../scripts/codex-run.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("resume-gate");
const CODEX = join(MODULE_ROOT, "scripts", "codex-run.mjs");
const ANTI = join(MODULE_ROOT, "scripts", "anti-run.mjs");
const ws = tmpWorkspace("resumegate-");
const RUN_DIR_REL = join("tasks", "t", "reports", "crew-test");
mkdirSync(join(ws, RUN_DIR_REL), { recursive: true });
const brief = writeFile(join(ws, "brief.md"), "do the thing\n");

function run(adapter, { evidence, extra = [], mode = "argvdump" }) {
  const proc = spawnSync("node", [
    adapter,
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
    },
    timeout: 90_000,
  });
  return { exit: proc.status, stderr: proc.stderr ?? "", stdout: proc.stdout ?? "" };
}

/** The evidence file is written by the worker, so its absence is the proof. */
const ranNothing = (evidence) => !existsSync(join(ws, evidence));

/**
 * Sidecar logs this job left behind. Named after the evidence BASENAME, so this
 * is per-job -- unlike the log directory, which every job in the run folder
 * shares and which therefore says nothing about any one of them.
 */
const sidecarsOf = (evidence) => {
  const dir = resolveLogDir(join(ws, evidence), ws);
  if (!existsSync(dir)) return [];
  const base = evidence.split(sep).pop().replace(/\.md$/, "");
  return readdirSync(dir).filter((f) => f.startsWith(base));
};

const throwsGuard = (fn) => {
  try { fn(); return null; } catch (err) { return err instanceof GuardError ? err : null; }
};

// --- the unit: what the gate decides ---------------------------------------

{
  t.check("no flag means no resume", resolveResume({}, { worker: "codex", mode: "headless", supportsResume: true }), null);
  t.check("...and an unsupported surface with no flag is still fine",
    resolveResume({}, { worker: "codex", mode: "app", supportsResume: false }), null);
  t.check("a supported surface returns the id",
    resolveResume({ resume: "abc" }, { worker: "antigravity", mode: "app", supportsResume: true }), "abc");
  t.check("...trimmed",
    resolveResume({ resume: "  abc  " }, { worker: "antigravity", mode: "app", supportsResume: true }), "abc");
}

{
  // The exact bug: the flag is parsed, the surface cannot honour it.
  const err = throwsGuard(() => resolveResume({ resume: "abc" }, { worker: "antigravity", mode: "headless", supportsResume: false }));
  t.check("an unsupported surface refuses", Boolean(err), true);
  t.check("...and names the surface in the message", /antigravity --mode headless/.test(err?.message ?? ""), true);
}

{
  // An empty id is worse than no id: it reads as "resume" and resolves to nothing.
  for (const value of ["", "   "]) {
    const err = throwsGuard(() => resolveResume({ resume: value }, { worker: "codex", mode: "headless", supportsResume: true }));
    t.check(`an empty id (${JSON.stringify(value)}) is refused`, Boolean(err), true);
  }
}

{
  const err = throwsGuard(() => resolveResume(
    { resume: "abc", model: "gpt-5" },
    { worker: "antigravity", mode: "app", supportsResume: true },
  ));
  t.check("--resume with --model is refused", Boolean(err), true);
  t.check("...saying why a session keeps its model",
    /already has the model/.test(err?.message ?? ""), true);
}

{
  // Order matters: an unsupported surface must be reported as unsupported, not
  // as a model conflict. The dispatcher's first fix would otherwise be to drop
  // --model and try again on a surface that still cannot resume.
  const err = throwsGuard(() => resolveResume(
    { resume: "abc", model: "gpt-5" },
    { worker: "codex", mode: "app", supportsResume: false },
  ));
  t.check("unsupported outranks the model conflict", /not available/.test(err?.message ?? ""), true);
}

// --- the adapters: a refusal has to stop the job ---------------------------

{
  // Codex headless resumes as of Phase 3; only an empty id is refused there.
  const evidence = join(RUN_DIR_REL, "codex-empty-id.md");
  const r = run(CODEX, { evidence, extra: ["--resume", "   "] });
  t.check("codex headless refuses an empty --resume", r.exit !== 0, true);
  t.check("...and spawned nothing", ranNothing(evidence), true);
  // Per-job, not per-directory: the log dir is shared by every job in the run
  // folder, so `the dir does not exist` only holds while no job has run yet.
  // That made the old assertion pass on execution order rather than on the
  // refusal -- it went red the moment a real job ran earlier in this file.
  t.check("...and left no sidecar of its own", sidecarsOf(evidence).length, 0);
}

{
  // Codex app resumes as of Phase 4; only an empty id is refused by the gate.
  const evidence = join(RUN_DIR_REL, "codex-app-empty.md");
  const r = run(CODEX, { evidence, extra: ["--mode", "app", "--resume", ""] });
  t.check("codex app refuses an empty --resume at the gate",
    /--resume needs the id/.test(r.stderr), true);
  t.check("...and spawned nothing", ranNothing(evidence), true);
  t.check("...and left no sidecar of its own", sidecarsOf(evidence).length, 0);
}

{
  // Anti headless resumes as of Phase 2, so what is refused here is the
  // COMBINATION, not the surface. The block has to be read carefully: without
  // an `agy` on PATH anti-run dies
  // at "could not run agy" whether the gate fires or not, so `ranNothing` would
  // pass with the gate deleted. The fixture makes the spawn succeed, which is
  // what turns "nothing ran" from a tautology into a measurement.
  const evidence = join(RUN_DIR_REL, "anti-model-conflict.md");
  const r = run(ANTI, { evidence, extra: ["--resume", "abc", "--model", "pro"] });
  t.check("anti --resume with --model is refused", r.exit !== 0, true);
  t.check("...and opens no conversation", ranNothing(evidence), true);
  t.check("...and never reached agy at all", /could not run agy/.test(r.stderr), false);
  t.check("...and says a session keeps its model",
    /already has the model/.test(r.stderr), true);
}

// --- controls: the gate must not refuse jobs that never asked to resume -----

{
  const evidence = join(RUN_DIR_REL, "control.md");
  const r = run(CODEX, { evidence });
  t.check("a codex job with no --resume still runs", r.exit, 0);
  t.check("...and wrote its evidence", ranNothing(evidence), false);
}

{
  // Without this, a gate that wrongly refused every anti job leaves the suite
  // green -- every other anti assertion here is about a refusal.
  const evidence = join(RUN_DIR_REL, "control-anti.md");
  const r = run(ANTI, { evidence });
  t.check("an anti job with no --resume still runs", r.exit, 0);
  t.check("...and wrote its evidence", ranNothing(evidence), false);
}

// --- the same defect, three more flags --------------------------------------

{
  // Found while reviewing the resume gate: each of these parsed cleanly, was
  // read on exactly one branch, and was dropped in silence on the other.
  // `--idle` is the one that mattered -- it reads as a watchdog, so a
  // dispatcher passing it on an app job believed a hung worker would be killed.
  const cases = [
    { name: "anti headless --title", adapter: ANTI, extra: ["--title", "x"], flag: "--title" },
    { name: "anti app --agy-mode", adapter: ANTI, extra: ["--mode", "app", "--agy-mode", "plan"], flag: "--agy-mode" },
    { name: "codex app --idle", adapter: CODEX, extra: ["--mode", "app", "--idle", "5m"], flag: "--idle" },
  ];
  for (const c of cases) {
    const evidence = join(RUN_DIR_REL, `unsupported-${c.flag.replace(/-/g, "")}.md`);
    const r = run(c.adapter, { evidence, extra: c.extra });
    t.check(`${c.name} is refused instead of ignored`,
      new RegExp(`${c.flag} is not available`).test(r.stderr), true);
    t.check("...and spawned nothing", ranNothing(evidence), true);
  }
}

{
  // The controls. A guard that refused these flags on the surface that DOES
  // read them would be a worse bug than the silence it replaces.
  const a = run(ANTI, { evidence: join(RUN_DIR_REL, "ok-agymode.md"), extra: ["--agy-mode", "plan"] });
  t.check("anti headless still accepts --agy-mode", a.exit, 0);
  const c = run(CODEX, { evidence: join(RUN_DIR_REL, "ok-idle.md"), extra: ["--idle", "5m"] });
  t.check("codex headless still accepts --idle", c.exit, 0);
}

process.exit(t.finish() ? 0 : 1);
