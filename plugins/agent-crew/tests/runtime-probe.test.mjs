#!/usr/bin/env node
/**
 * The runtime reading, the app-server count, and the orphan rule.
 *
 * All three exist because a measurement contradicted an assumption, so the
 * cases here are written against what was measured rather than against the
 * shape the plan first described:
 *
 *   - an unqualified app-server count is wrong, because ChatGPT.app and the
 *     VS Code extension each keep one up permanently;
 *   - one app-server is two processes, so counting processes double-counts;
 *   - the broker's command line contains the substring but is not a server;
 *   - a running companion job carries a live pid and a finished one carries
 *     none, which is the only reason the orphan rule is safe.
 *
 * The orphan cases inject a probe rather than calling the companion: the rule
 * is the part worth testing, and a test that needed a live runtime could not
 * cover the case where the runtime has forgotten the job.
 *
 * Run: node mwg-agent-crew/tests/runtime-probe.test.mjs
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  brokerStatePath, readBrokerFile, countAppServers, probeCompanionJob, probeRuntime,
} from "../scripts/crew-runtime-probe.mjs";
import { createRun, addJob, updateJob, readManifest, recordRuntime } from "../scripts/crew-manifest.mjs";
import { reconcileRun, classifyOrphan } from "../scripts/crew-reconcile.mjs";
import { makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("runtime-probe");
const RUN_REL = join("tasks", "t", "reports", "crew-test");
const DONE = "báo cáo\n\nStatus: DONE\n";

/** A broker file in a throwaway home, so nothing reads the user's real state. */
function fakeBroker(workspace, body) {
  const home = mkdtempSync(join(tmpdir(), "crew-home-"));
  const path = brokerStatePath(workspace, home);
  if (body !== null) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return { home, path };
}

// --- where the plugin keeps its state -------------------------------------
{
  const ws = "/Users/someone/Documents/proj";
  const want = `${basename(ws)}-${createHash("sha256").update(ws).digest("hex").slice(0, 16)}`;
  t.check("state dir is basename + sha256[:16]", brokerStatePath(ws, "/h").includes(want), true);
  t.check("...under the plugin's data dir", brokerStatePath(ws, "/h").startsWith("/h/.claude/plugins/data/codex-inline/state/"), true);
}

// --- reading broker.json ---------------------------------------------------
{
  const ws = tmpWorkspace("probe-");
  const missing = fakeBroker(ws, null);
  const r1 = readBrokerFile(ws, { home: missing.home });
  t.check("no broker file reads as absent", r1.present, false);
  // Absent is the ordinary state, not a fault: nothing has started a broker.
  t.check("...and is not reported as an error", r1.error, null);

  const alive = fakeBroker(ws, JSON.stringify({ endpoint: "unix:/tmp/x.sock", pid: process.pid }));
  const r2 = readBrokerFile(ws, { home: alive.home });
  t.check("an endpoint with a live pid reads alive", `${r2.present}/${r2.hasEndpoint}/${r2.alive}`, "true/true/true");

  // The trap: the file outlives the process, so "has an endpoint" alone would
  // report a shared runtime that is gone.
  const dead = fakeBroker(ws, JSON.stringify({ endpoint: "unix:/tmp/x.sock", pid: 21474836 }));
  const r3 = readBrokerFile(ws, { home: dead.home });
  t.check("an endpoint with a dead pid reads not-alive", r3.alive, false);
  t.check("...while still reporting the endpoint", r3.hasEndpoint, true);

  const broken = fakeBroker(ws, "{ this is not json");
  const r4 = readBrokerFile(ws, { home: broken.home });
  t.check("unreadable broker file is an error, not an absence", Boolean(r4.error), true);
  t.check("...and never claims an endpoint", r4.hasEndpoint, false);

  const noPid = fakeBroker(ws, JSON.stringify({ endpoint: "unix:/tmp/x.sock" }));
  // Three-valued on purpose: a caller must not read "unknown" as "dead".
  t.check("a file with no pid leaves aliveness unknown", readBrokerFile(ws, { home: noPid.home }).alive, null);
}

// --- counting app-servers --------------------------------------------------
{
  // The shape measured on 25/08: two foreign servers, one broker, and one of
  // our servers spread across a wrapper and its native child.
  const ps = [
    "    1     0 /sbin/launchd",
    "18185     1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    "18224 18185 /Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
    "55420     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    "55831 55420 /Users/x/.vscode/extensions/openai.chatgpt/bin/codex -c features.code_mode_host=true app-server",
    "65720     1 node /Users/x/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/app-server-broker.mjs serve --endpoint unix:/tmp/b.sock",
    "65736 65720 node /opt/homebrew/bin/codex app-server",
    "65737 65736 /opt/homebrew/lib/node_modules/@openai/codex/.../bin/codex app-server",
    "99999     1 grep codex app-server",
  ].join("\n");

  const c = countAppServers({ psOutput: ps, brokerPid: 65720 });
  t.check("ours is the wrapper only", `${c.servers}:${c.pids.join(",")}`, "1:65736");
  t.check("the native child is not a second server", c.pids.includes(65737), false);
  t.check("the broker is not counted as a server", c.pids.includes(65720), false);
  t.check("foreign servers are reported apart", `${c.foreign}:${c.foreignPids.join(",")}`, "2:18224,55831");
  // Four matching processes: two foreign servers, our wrapper, and its native
  // child. The broker and the grep line are both out.
  t.check("matching processes exclude the broker", c.processes, 4);
  const greppy = countAppServers({ psOutput: "99999     1 grep codex app-server", brokerPid: 65720 });
  t.check("a grep for the pattern is not a server", `${greppy.servers}/${greppy.foreign}/${greppy.processes}`, "0/0/0");

  // Without a broker pid nothing can be attributed, and the honest answer is
  // that none of the live servers are known to be ours.
  const unattributed = countAppServers({ psOutput: ps, brokerPid: null });
  t.check("with no broker pid nothing is claimed as ours", unattributed.servers, 0);
  t.check("...and every server reads as foreign", unattributed.foreign, 3);

  const none = countAppServers({ psOutput: "    1     0 /sbin/launchd", brokerPid: 65720 });
  t.check("an idle machine counts zero", `${none.servers}/${none.foreign}`, "0/0");

  // `app-server` must END the token. A broker child whose name merely starts
  // with it is not an app-server, and it sits under the broker, so a loose
  // boundary would count it as ours -- inflating the number that is supposed
  // to be run evidence. The broker itself is one instance of this family.
  const helper = [
    "65720     1 node /Users/x/.claude/plugins/.../app-server-broker.mjs serve",
    "65740 65720 node /tmp/codex-app-server-healthcheck --once",
  ].join("\n");
  const h = countAppServers({ psOutput: helper, brokerPid: 65720 });
  t.check("an app-server-* helper is not an app-server", `${h.servers}/${h.foreign}/${h.processes}`, "0/0/0");
}

// --- the never-throws contract at the input boundary -----------------------
{
  // A CLI typo (`--workspace` with no value) used to reach resolve()/spawnSync()
  // as undefined and throw a TypeError, killing the probe before any `errors`
  // array could carry the fault. Reporting is the job; dying is not.
  let threw = null;
  let r = null;
  try { r = readBrokerFile(undefined); } catch (err) { threw = String(err); }
  t.check("a missing workspace does not throw", threw, null);
  t.check("...and reads as absent", r?.present, false);

  threw = null;
  let p2 = null;
  try { p2 = probeRuntime({ skipCompanion: true }); } catch (err) { threw = String(err); }
  t.check("probeRuntime with no workspace does not throw", threw, null);
  t.check("...and says why in errors", /workspace không hợp lệ/.test((p2?.errors ?? []).join(" ")), true);
  t.check("...and still returns a reading", typeof p2?.mode, "string");
}

// --- storing the reading ---------------------------------------------------
{
  const ws = tmpWorkspace("probe-rt-");
  const { manifestPath } = createRun({ runDir: join(ws, RUN_REL), runId: "test", task: "t", workspace: ws, depth: 0 });

  recordRuntime(manifestPath, "atDispatch", { mode: "direct", at: "T1" });
  // First writer wins for dispatch: several adapters fire concurrently and the
  // field has to keep meaning "when the run started dispatching".
  recordRuntime(manifestPath, "atDispatch", { mode: "shared", at: "T2" });
  recordRuntime(manifestPath, "atSettle", { mode: "direct", at: "T3" });
  // Last writer wins for settle, so the field means "when the run finished".
  recordRuntime(manifestPath, "atSettle", { mode: "shared", at: "T4" });

  const m = readManifest(manifestPath);
  t.check("atDispatch keeps the first reading", m.codexRuntime.atDispatch.at, "T1");
  t.check("atSettle keeps the last reading", m.codexRuntime.atSettle.at, "T4");
  // The two are stored apart because the reading is not stable: it changed from
  // direct to shared on a live machine with nothing dispatched in between.
  t.check("a run can record two different modes", `${m.codexRuntime.atDispatch.mode}/${m.codexRuntime.atSettle.mode}`, "direct/shared");

  let threw = null;
  try { recordRuntime(manifestPath, "whenever", {}); } catch (err) { threw = err.message; }
  t.check("an unknown moment is refused", /atDispatch or atSettle/.test(threw ?? ""), true);
}

// --- the orphan rule, as a table ------------------------------------------
{
  const job = { seq: 1, companionJobId: "task-x" };
  const kind = (probe) => classifyOrphan(job, probe)?.kind ?? "waiting";

  t.check("runtime has no record → orphan", kind({ known: false, error: null }), "unknown_to_runtime");
  t.check("running with a live pid → still waiting", kind({ known: true, status: "running", pid: 123, alive: true, error: null }), "waiting");
  t.check("queued with a live pid → still waiting", kind({ known: true, status: "queued", pid: 123, alive: true, error: null }), "waiting");
  t.check("running with a dead pid → orphan", kind({ known: true, status: "running", pid: 123, alive: false, error: null }), "active_without_process");
  t.check("running with no pid at all → orphan", kind({ known: true, status: "running", pid: null, alive: null, error: null }), "active_without_process");
  t.check("completed but nothing on disk → orphan", kind({ known: true, status: "completed", pid: null, alive: null, error: null }), "settled_without_evidence");
  t.check("failed with nothing on disk → orphan", kind({ known: true, status: "failed", pid: null, alive: null, error: null }), "settled_without_evidence");
  // Silence is not death. A probe that could not answer must leave the job be,
  // or an unreachable companion would fail every live job in the run.
  t.check("a probe that errored → still waiting", kind({ known: null, error: "companion unreachable" }), "waiting");
  // A partial answer is still not an answer. This is the case that makes the
  // error guard load-bearing rather than decorative: everything else in the
  // shape says orphan, and the recorded error is the only reason not to say so.
  t.check("an answer carrying an error is not acted on",
    kind({ known: true, status: "running", pid: null, alive: null, error: "companion result exit 2" }), "waiting");
  t.check("no probe at all → still waiting", kind(null), "waiting");

  // Measured 25/08 during the concurrent-dispatch race: a companion answer came
  // back with no `status` field while its job was still working. Reading that
  // silence as "settled" would fail a live job -- the worst outcome this
  // function can produce -- so an unrecognised status may never reach a verdict.
  t.check("no status but a live pid → still waiting",
    kind({ known: true, status: null, pid: 123, alive: true, error: null }), "waiting");
  t.check("no status and no pid → still waiting",
    kind({ known: true, status: null, pid: null, alive: null, error: null }), "waiting");
  // A status word this code has never seen is not a settlement either. A future
  // companion adding `starting` must not be read as "finished without evidence".
  t.check("an unfamiliar status → still waiting",
    kind({ known: true, status: "starting", pid: null, alive: null, error: null }), "waiting");
  t.check("an unfamiliar status with a dead pid → still waiting",
    kind({ known: true, status: "starting", pid: 123, alive: false, error: null }), "waiting");
  // The live-pid guard outranks the settled branch too, not only the active one.
  t.check("completed but the process is still alive → still waiting",
    kind({ known: true, status: "completed", pid: 123, alive: true, error: null }), "waiting");
  t.check("cancelled with nothing on disk → orphan",
    kind({ known: true, status: "cancelled", pid: null, alive: null, error: null }), "settled_without_evidence");
}

// --- reconcile acting on it ------------------------------------------------
function orphanRun({ status = "running", companionJobId = "task-x", evidenceBody = undefined } = {}) {
  const ws = tmpWorkspace("probe-rec-");
  const { manifestPath } = createRun({ runDir: join(ws, RUN_REL), runId: "test", task: "t", workspace: ws, depth: 0 });
  const evidence = join(RUN_REL, "w1.md");
  const added = addJob(manifestPath, { worker: "codex", role: "assist", title: "job", evidence });
  if (evidenceBody !== undefined) writeFile(join(ws, evidence), evidenceBody);
  updateJob(manifestPath, added.seq, {
    status,
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    ...(companionJobId ? { companionJobId } : {}),
  });
  return { ws, manifestPath, seq: added.seq };
}

{
  const dead = () => ({ known: true, status: "running", pid: 4242, alive: false, error: null });
  const r = orphanRun();
  const out = reconcileRun(r.manifestPath, { probe: dead });
  t.check("an orphan is reported apart from waiting", `${out.orphans.length}/${out.waiting.length}`, "1/0");
  t.check("...and recorded as failed", readManifest(r.manifestPath).jobs[0].status, "failed");
  t.check("...with the kind kept for later reading", readManifest(r.manifestPath).jobs[0].orphanKind, "active_without_process");
  // Same care as the evidence path: an end time invented at "now" would hand a
  // long-dead job a write window reaching the present.
  t.check("...and its inferred end time says so", readManifest(r.manifestPath).jobs[0].endedAtInferred, true);
  // Detection is a reading; cancelling is a change outside the repo, so it is
  // the dispatcher's call and off by default.
  t.check("...but nothing is cancelled without the flag", out.orphans[0].cancelled, null);
}

{
  const live = () => ({ known: true, status: "running", pid: process.pid, alive: true, error: null });
  const r = orphanRun();
  const out = reconcileRun(r.manifestPath, { probe: live });
  t.check("a live job is never called an orphan", out.orphans.length, 0);
  t.check("...it stays in waiting", out.waiting.length, 1);
  t.check("...and its status is untouched", readManifest(r.manifestPath).jobs[0].status, "running");
}

{
  // Anti and Claude jobs have no companion id, so there is nothing to ask and
  // the old behaviour has to survive unchanged for them.
  let asked = 0;
  const counting = () => { asked += 1; return { known: false, error: null }; };
  const r = orphanRun({ companionJobId: null });
  const out = reconcileRun(r.manifestPath, { probe: counting });
  t.check("a job with no companion id is not probed", asked, 0);
  t.check("...and stays waiting", out.waiting.length, 1);
}

{
  // A job whose manifest already records an outcome is not re-litigated: that
  // is the rule this file was built on.
  let asked = 0;
  const counting = () => { asked += 1; return { known: false, error: null }; };
  const r = orphanRun({ status: "failed" });
  const out = reconcileRun(r.manifestPath, { probe: counting });
  t.check("a job already terminal is not probed", asked, 0);
  t.check("...and is not turned into an orphan", out.orphans.length, 0);
}

{
  const r = orphanRun();
  const before = readManifest(r.manifestPath).jobs[0].status;
  const out = reconcileRun(r.manifestPath, {
    dryRun: true, probe: () => ({ known: false, error: null }),
  });
  t.check("dry run still reports the orphan", out.orphans.length, 1);
  t.check("...and writes nothing", readManifest(r.manifestPath).jobs[0].status, before);
}

{
  // Evidence on disk outranks everything, including a runtime that has
  // forgotten the job. The orphan branch must not be reachable in that case.
  const r = orphanRun({ evidenceBody: DONE });
  const out = reconcileRun(r.manifestPath, { probe: () => ({ known: false, error: null }) });
  t.check("evidence still outranks the runtime", out.orphans.length, 0);
  t.check("...and the job is patched from what it wrote", readManifest(r.manifestPath).jobs[0].status, "done");
}

// --- the read-only probe against a runtime that may not be here -----------
{
  // Not an assertion about the companion, which may be absent on a CI box: the
  // point is that an unanswerable probe returns a shape, never throws.
  const out = probeCompanionJob("task-definitely-not-real", { workspace: process.cwd(), timeoutMs: 20_000 });
  t.check("an unknown job never throws", typeof out, "object");
  t.check("...and never claims to know it", out.known === true, false);
}

process.exit(t.finish() ? 0 : 1);
