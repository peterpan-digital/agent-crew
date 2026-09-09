#!/usr/bin/env node
/**
 * `role` and `transport` are two axes, and the ledger has to keep them apart.
 *
 * The failure these cases exist for is a run whose record disagrees with what
 * ran: the manifest says one transport, the adapter used the other, and the run
 * is no longer auditable in the one place anybody would look. That was a real
 * hazard the first time this field existed -- 34 historical jobs split 10 app /
 * 24 headless with no recoverable reason for any single one -- which is why
 * choosing the non-default now requires a written reason, and why the field is
 * sealed against every later write path.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  CREW_CLI, RUN_ID, RUN_REL, makeChecker, tmpWorkspace, under,
} from "./helpers.mjs";
import {
  MANIFEST_VERSION, TRANSPORTS, addJob, assertTransport, createRun, readManifest, updateJob,
} from "../lib/manifest.mjs";

const t = makeChecker("transport-axis");

const newRun = (ws) => {
  const runDir = join(ws, ".crew", "runs", RUN_ID);
  return createRun({
    runDir, runId: RUN_ID, workspace: ws, evidenceRoot: RUN_REL, dispatcher: "claude",
  }).manifestPath;
};

const job = (over = {}) => ({
  worker: "codex", role: "owner", title: "t", effort: "medium",
  evidence: under(RUN_REL, "worker-codex-1.md"), ...over,
});

const threw = (fn) => {
  try { fn(); return null; } catch (err) { return err.message; }
};

// --- T1: the default is headless, and it is the same for both roles ---------
{
  const ws = tmpWorkspace("crew-tp1-");
  const m = newRun(ws);
  t.check("an owner job defaults to headless", addJob(m, job()).transport, "headless");
  t.check("an assist job defaults to headless too", addJob(m, job({
    role: "assist", evidence: under(RUN_REL, "worker-codex-2.md"),
  })).transport, "headless");
  t.check("the manifest records version 2", readManifest(m).version, MANIFEST_VERSION);
  rmSync(ws, { recursive: true, force: true });
}

// --- T2: the non-default needs a written reason ----------------------------
{
  const ws = tmpWorkspace("crew-tp2-");
  const m = newRun(ws);
  const refused = threw(() => addJob(m, job({ transport: "app" })));
  t.check("app with no note is refused", /overrides the owner default transport/.test(refused ?? ""), true);
  // The remedy has to name the three cases, or "pass a note" just teaches the
  // reader to type any string to get past the gate.
  t.check("...and the message names what app is actually worth it for",
    /permission prompt|acceptance criteria|resume/.test(refused ?? ""), true);
  const ok = addJob(m, job({ transport: "app", note: "worker sẽ gặp prompt permission cần người bấm" }));
  t.check("app with a note is accepted", ok.transport, "app");
  t.check("...and the reason travels with the job", ok.notes.length, 1);
  t.check("an unknown transport is refused",
    /transport must be "app" or "headless"/.test(threw(() => addJob(m, job({
      transport: "ssh", note: "why", evidence: under(RUN_REL, "worker-codex-3.md"),
    }))) ?? ""), true);
  rmSync(ws, { recursive: true, force: true });
}

// --- T3: a claude job has no transport, and null is the record -------------
{
  const ws = tmpWorkspace("crew-tp3-");
  const m = newRun(ws);
  const claude = addJob(m, job({ worker: "claude", role: "assist", effort: undefined, model: null }));
  t.check("a claude job records transport null", claude.transport, null);
  // Not cosmetic: "headless" here would put a process in the ledger that never
  // started, and the collect table would then report a transport for a job
  // whose work happened in the dispatcher's own session.
  t.check("...and naming one explicitly is refused",
    /a claude job has no transport/.test(threw(() => addJob(m, job({
      worker: "claude", role: "assist", transport: "headless",
      evidence: under(RUN_REL, "worker-claude-2.md"),
    }))) ?? ""), true);
  rmSync(ws, { recursive: true, force: true });
}

// --- T4: `mode` was this field's old name and must not be silently ignored --
{
  const ws = tmpWorkspace("crew-tp4-");
  const m = newRun(ws);
  const refused = threw(() => addJob(m, job({ mode: "app" })));
  t.check("the old `mode` field is refused", /`mode` is gone/.test(refused ?? ""), true);
  t.check("...and points at the field that replaced it", /transport/.test(refused ?? ""), true);
  rmSync(ws, { recursive: true, force: true });
}

// --- T5: the field is sealed against every later write --------------------
{
  const ws = tmpWorkspace("crew-tp5-");
  const m = newRun(ws);
  addJob(m, job({ transport: "app", note: "cần thread resume buổi sau" }));
  t.check("updateJob cannot rewrite transport",
    /không được đổi "transport"/.test(threw(() => updateJob(m, 1, { transport: "headless" })) ?? ""), true);
  t.check("job.extra cannot smuggle it in",
    /không được ghi đè "transport"/.test(threw(() => addJob(m, job({
      evidence: under(RUN_REL, "worker-codex-2.md"), extra: { transport: "app" },
    }))) ?? ""), true);
  // Patching the same value is not a change, so progress writes that echo the
  // record back must not be turned into errors.
  t.check("re-patching the same value is allowed", updateJob(m, 1, { transport: "app" }).transport, "app");
  rmSync(ws, { recursive: true, force: true });
}

// --- T6: assertTransport is the gate between ledger and process -----------
{
  const ws = tmpWorkspace("crew-tp6-");
  const m = newRun(ws);
  addJob(m, job({ transport: "app", note: "việc mở, chưa viết được acceptance" }));
  addJob(m, job({ evidence: under(RUN_REL, "worker-codex-2.md") }));
  addJob(m, job({ worker: "claude", role: "assist", effort: undefined, evidence: under(RUN_REL, "worker-claude-3.md") }));

  t.check("a matching dispatch passes", assertTransport(m, 1, "app"), "app");
  const mismatch = threw(() => assertTransport(m, 2, "app"));
  t.check("a mismatched dispatch is refused", /recorded as transport "headless"/.test(mismatch ?? ""), true);
  t.check("...and says why it matters", /cannot be audited/.test(mismatch ?? ""), true);
  t.check("a claude job has nothing to check", assertTransport(m, 3, "headless"), null);

  // A manifest written before the field existed must answer "cannot say"
  // rather than "no transport" -- the two have the same shape and opposite
  // meanings, and conflating them would let a v1 run be dispatched any way at
  // all while looking checked.
  const raw = readManifest(m);
  delete raw.jobs[1].transport;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(m, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  t.check("a job with no transport key is unaskable, not unset", assertTransport(m, 2, "app"), null);
  rmSync(ws, { recursive: true, force: true });
}

// --- T7: the CLI surface, at the process boundary -------------------------
{
  const ws = tmpWorkspace("crew-tp7-");
  const run = (args) => spawnSync(process.execPath, [CREW_CLI, ...args], {
    cwd: ws, encoding: "utf8", timeout: 60_000,
  });
  // `crew init` would write a config; the default one is what the test wants.
  const made = run(["new-run", "--label", "cli"]);
  const manifest = (made.stdout ?? "").match(/^manifest\s+(.+)$/m)?.[1];
  t.check("new-run prints a manifest path", Boolean(manifest), true);

  const added = run([
    "add-job", "--manifest", manifest, "--worker", "codex",
    "--role", "owner", "--effort", "medium", "--title", "cli default",
  ]);
  t.check("add-job exits 0", added.status, 0);
  t.check("...and reports the transport it recorded", /transport headless/.test(added.stdout ?? ""), true);

  const refused = run([
    "add-job", "--manifest", manifest, "--worker", "codex",
    "--role", "owner", "--effort", "medium", "--title", "cli app", "--transport", "app",
  ]);
  t.check("--transport app with no --note exits 2", refused.status, 2);

  // A claude job's tier is a fact about a process that never starts, the same
  // reason its transport is null. Requiring it asked for a value nobody could
  // give truthfully.
  const claude = run([
    "add-job", "--manifest", manifest, "--worker", "claude",
    "--role", "assist", "--title", "cli claude",
  ]);
  t.check("a claude job needs no --model", claude.status, 0);
  t.check("...and prints that it has no transport", /transport \(không có/.test(claude.stdout ?? ""), true);
  rmSync(ws, { recursive: true, force: true });
}

t.check("TRANSPORTS is exactly the two supported pipes", [...TRANSPORTS].sort().join(","), "app,headless");

process.exit(t.finish() ? 0 : 1);
