#!/usr/bin/env node
/**
 * crew-session (run-for, latest) và guard "conversation đang bận" ở claimRunSlot.
 *
 * Run: node mwg-agent-crew/tests/crew-session.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addJob, claimRunSlot, createRun, readManifest, updateJob, updateManifest, MAX_JOBS } from "../scripts/crew-manifest.mjs";
import { latestConversation, runFor, todayStamp } from "../scripts/crew-session.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("crew-session");
const CLI = join(MODULE_ROOT, "scripts", "crew-session.mjs");
const ANTI = join(MODULE_ROOT, "scripts", "anti-run.mjs");
const UUID_A = "58cb7084-ef1e-468e-af6b-b25062aea6fe";
const UUID_B = "11111111-2222-4333-8444-555555555555";

function newTask() {
  const ws = tmpWorkspace("session-");
  return { ws, task: join(ws, "tasks", "t") };
}
function run(task, runId, jobs = []) {
  const runDir = join(task, "reports", `crew-${runId}`);
  mkdirSync(runDir, { recursive: true });
  const { manifestPath } = createRun({ runDir, runId, task: "t", workspace: join(task, "..", ".."), depth: 0 });
  for (const j of jobs) {
    const { seq } = addJob(manifestPath, { worker: j.worker ?? "antigravity", role: "owner", title: j.title ?? "j", ...(j.add ?? {}), evidence: join("tasks", "t", "reports", `crew-${runId}`, `w${Math.random().toString(36).slice(2)}.md`) });
    if (j.patch) updateJob(manifestPath, seq, j.patch);
  }
  return manifestPath;
}
const cli = (args) => {
  const p = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { exit: p.status, out: (p.stdout ?? "").trim(), err: p.stderr ?? "" };
};

// ------------------------------------------------------------------ run-for
{
  const { task } = newTask();
  t.check("task chưa có run nào → new", cli(["run-for", "--task", task, "--date", "261007"]).out, "new");
  const open = run(task, "261007-0900", [{}]);
  run(task, "261006-2300", [{}]);
  t.check("run hôm nay còn chỗ → in manifest đó", runFor(task, { date: "261007" }), open);
  t.check("ngày khác → new", runFor(task, { date: "261008" }), null);

  const newer = run(task, "261007-1400", [{}]);
  t.check("hai run cùng ngày → lấy run mới hơn", runFor(task, { date: "261007" }), newer);
  updateManifest(newer, (m) => { m.lastCollect = { at: "x", exitCode: 0 }; return m; });
  t.check("run đã qua cổng (exit 0) → không nhét thêm, lùi về run còn mở", runFor(task, { date: "261007" }), open);
  updateManifest(open, (m) => { m.reports = [{ path: "r.md", at: "x" }]; return m; });
  t.check("run đã viết report tổng → new", runFor(task, { date: "261007" }), null);

  run(task, "261007-1500", Array.from({ length: MAX_JOBS }, () => ({})));
  t.check("run đủ MAX_JOBS job → new", runFor(task, { date: "261007" }), null);
  t.check("lastCollect exit 1 vẫn là run mở", (() => { const p = run(task, "261007-1600", [{}]); updateManifest(p, (m) => { m.lastCollect = { at: "x", exitCode: 1 }; return m; }); return runFor(task, { date: "261007" }) === p; })(), true);
  t.check("--date sai dạng bị từ chối", cli(["run-for", "--task", task, "--date", "2026-10-07"]).exit, 2);
  t.check("không --date thì lấy hôm nay", todayStamp(new Date(2026, 9, 7)), "261007");
}

// ------------------------------------------------------------------- latest
{
  const { task } = newTask();
  t.check("chưa có conversation → exit 1", `${cli(["latest", "--task", task, "--worker", "anti"]).exit}`, "1");
  run(task, "261006-1000", [{ patch: { conversationId: UUID_B, startedAt: "2026-10-06T03:00:00Z", status: "done" }, add: { transport: "app", note: "test cần job app" } }]);
  run(task, "261007-1000", [
    { patch: { conversationId: UUID_A, startedAt: "2026-10-07T03:00:00Z", status: "done" }, add: { transport: "app", note: "test cần job app" }, title: "mới nhất" },
    { patch: { conversationId: "conv-other", startedAt: "2026-10-07T05:00:00Z", resumeMismatch: true } },
    { worker: "codex", patch: { conversationId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", startedAt: "2026-10-07T06:00:00Z", status: "done" } },
    { patch: { conversationId: "../../etc", startedAt: "2026-10-07T07:00:00Z" } },
  ]);
  const hit = latestConversation(task, "anti");
  t.check("lấy job mới nhất qua mọi run, bỏ resumeMismatch và id sai dạng", `${hit.conversationId}:${hit.title}:${hit.status}:${hit.transport}`, `${UUID_A}:mới nhất:done:app`);
  t.check("codex tách riêng worker", latestConversation(task, "codex").conversationId, "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
  const out = cli(["latest", "--task", task, "--worker", "anti"]);
  t.check("CLI in JSON một dòng", JSON.parse(out.out).conversationId, UUID_A);
  t.check("worker lạ bị từ chối", cli(["latest", "--task", task, "--worker", "gemini"]).exit, 2);
}

// ---------------------------------------------- guard: conversation đang bận
{
  const { task } = newTask();
  const now = new Date().toISOString();
  const other = run(task, "261007-0800", [{ patch: { conversationId: UUID_A, status: "running", startedAt: now, timeoutMs: 15 * 60_000 } }]);
  const mp = run(task, "261007-0900", [{}, {}]);
  const refused = (() => { try { claimRunSlot(mp, 1, { startedAt: now, timeoutMs: 60_000, resumeId: UUID_A }); return null; } catch (e) { return e.message; } })();
  t.check("resume vào conversation đang chạy ở run khác cùng task → từ chối", /đang có job 261007-0800#1 chạy/.test(refused ?? ""), true);
  t.check("...job bị từ chối vẫn pending (chưa gửi gì)", readManifest(mp).jobs[0].status, "pending");

  claimRunSlot(mp, 1, { startedAt: now, timeoutMs: 60_000, resumeId: UUID_B });
  t.check("conversation rảnh → claim được, ghi resumedFrom trong khoá", readManifest(mp).jobs[0].resumedFrom, UUID_B);
  // conversationId là bằng chứng runtime đã trả lời (collect đọc nó); claim không được điền sẵn.
  t.check("...conversationId để null tới khi runtime trả lời", readManifest(mp).jobs[0].conversationId, null);
  const same = (() => { try { claimRunSlot(mp, 2, { startedAt: now, timeoutMs: 60_000, resumeId: UUID_B }); return null; } catch (e) { return e.message; } })();
  t.check("job thứ hai cùng run resume cùng id → từ chối nhờ resumedFrom", /đang có job 261007-0900#1/.test(same ?? ""), true);

  updateJob(other, 1, { status: "done" });
  claimRunSlot(mp, 2, { startedAt: now, timeoutMs: 60_000, resumeId: UUID_A });
  t.check("job kia xong → resume được", readManifest(mp).jobs[1].status, "running");

  // Xác: running quá timeout + grace thì không giữ conversation nữa.
  const { task: t2 } = newTask();
  run(t2, "261007-0100", [{ patch: { conversationId: UUID_A, status: "running", startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), timeoutMs: 60_000 } }]);
  const mp2 = run(t2, "261007-0900", [{}]);
  claimRunSlot(mp2, 1, { startedAt: now, timeoutMs: 60_000, resumeId: UUID_A });
  t.check("job chết (quá timeout + grace) không chặn resume", readManifest(mp2).jobs[0].status, "running");

  const mp3 = run(newTask().task, "261007-0900", [{}]);
  claimRunSlot(mp3, 1, { startedAt: now, timeoutMs: 60_000 });
  t.check("không --resume: claim như cũ, resumedFrom null", readManifest(mp3).jobs[0].resumedFrom ?? null, null);

  // Reviewer tái hiện: seq 1 resume X rồi fail; chạy lại seq 1 KHÔNG resume; seq 2 xin
  // resume X bị từ chối nhầm vì seq 1 vẫn mang X suốt lượt mới.
  const { task: t4 } = newTask();
  const mp4 = run(t4, "261007-1000", [{}, {}]);
  claimRunSlot(mp4, 1, { startedAt: now, timeoutMs: 60_000, resumeId: UUID_A });
  updateJob(mp4, 1, { status: "failed", conversationId: UUID_A });
  claimRunSlot(mp4, 1, { startedAt: now, timeoutMs: 60_000 });
  const j1 = readManifest(mp4).jobs[0];
  t.check("claim lại không resume: xoá conversation lượt trước", `${j1.conversationId}:${j1.resumedFrom}`, "null:null");
  t.check("...id cũ còn trong note để resume được", (j1.notes ?? []).some((n) => n.includes(UUID_A)), true);
  t.check("...latest không trả id cũ như đang chạy", latestConversation(t4, "anti"), null);
  claimRunSlot(mp4, 2, { startedAt: now, timeoutMs: 60_000, resumeId: UUID_A });
  t.check("...seq 2 resume X được", readManifest(mp4).jobs[1].status, "running");
}

// ------------------------------------------- adapter thật: từ chối trước khi gửi
{
  const { ws, task } = newTask();
  const now = new Date().toISOString();
  run(task, "261007-0800", [{ patch: { conversationId: UUID_A, status: "running", startedAt: now, timeoutMs: 15 * 60_000 } }]);
  const mp = run(task, "261007-0900", []);
  const ev = join("tasks", "t", "reports", "crew-261007-0900", "w-busy.md");
  addJob(mp, { worker: "antigravity", role: "owner", title: "resume khi bận", evidence: ev });
  const brief = writeFile(join(ws, "brief.md"), "x\n");
  const p = spawnSync("node", [ANTI, "--prompt-file", brief, "--evidence", ev, "--workspace", ws, "--timeout", "60s",
    "--manifest", mp, "--job", "1", "--resume", UUID_A], {
    encoding: "utf8", env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: "argvdump", FAKE_EVIDENCE: join(ws, ev), FAKE_CONVERSATION_ID: UUID_A }, timeout: 60_000,
  });
  t.check("anti-run từ chối, exit khác 0", p.status !== 0, true);
  t.check("...nói conversation đang bận", /đang có job/.test(p.stderr ?? ""), true);
  const j = readManifest(mp).jobs[0];
  t.check("...agy không được gọi (không có argv dump)", existsSync(join(ws, ev)), false);
  t.check("...job ghi failed kèm lý do bận, conversationId vẫn null", `${j.status}:${/đang có job/.test(j.failure ?? "")}:${j.conversationId}`, "failed:true:null");
}

// ------------------------------------------- codex-run cũng từ chối trước khi gửi
{
  const { ws, task } = newTask();
  const CODEX = join(MODULE_ROOT, "scripts", "codex-run.mjs");
  const CID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  run(task, "261007-0800", [{ worker: "codex", patch: { conversationId: CID, status: "running", startedAt: new Date().toISOString(), timeoutMs: 15 * 60_000 } }]);
  const mp = run(task, "261007-0900", []);
  const ev = join("tasks", "t", "reports", "crew-261007-0900", "w-codex-busy.md");
  addJob(mp, { worker: "codex", role: "assist", title: "resume khi bận", evidence: ev });
  const brief = writeFile(join(ws, "brief-c.md"), "x\n");
  const p = spawnSync("node", [CODEX, "--prompt-file", brief, "--evidence", ev, "--workspace", ws, "--timeout", "60s", "--effort", "low",
    "--manifest", mp, "--job", "1", "--resume", CID], {
    encoding: "utf8", env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: "ok", FAKE_EVIDENCE: join(ws, ev) }, timeout: 60_000,
  });
  t.check("codex-run từ chối resume vào thread đang chạy", p.status !== 0 && /đang có job/.test(p.stderr ?? ""), true);
  t.check("...không chạy worker (không có evidence)", existsSync(join(ws, ev)), false);
}

process.exit(t.finish() ? 0 : 1);
