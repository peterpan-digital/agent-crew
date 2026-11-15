#!/usr/bin/env node
/**
 * Hạn mềm + handoff: `Status: CONTINUE` là trạng thái riêng, không phải FAIL;
 * collect chặn nó cho tới khi một job sau resume đúng thread; Anti có lượt cứu
 * handoff ở cả hai transport. (Lượt cứu của Codex: codex-lifecycle.test.mjs.)
 *
 * Run: node plugins/agent-crew/tests/handoff.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendWorkerContract, handoffLine, handoffRescuePrompt, readWorkerStatus, softDeadlineAt,
} from "../scripts/crew-guards.mjs";
import { createRun, addJob, updateJob, readManifest } from "../scripts/crew-manifest.mjs";
import { collectRun } from "../scripts/crew-collect.mjs";
import { crewDigest } from "../scripts/lib/crew-digest.mjs";
import { runApp } from "../scripts/anti-run.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("handoff");
const MIN = 60_000;
const RUN_REL = join("tasks", "t", "reports", "crew-test");
const HANDOFF = "làm được nửa\n\n## Handoff\n### Đã xong\n- a\n### Đang dở\n- b\n### Bước kế tiếp\n- c\n### File đã đụng\nKhông có\n\nStatus: CONTINUE\n";

// --- parser -----------------------------------------------------------------
{
  const ws = tmpWorkspace("handoff-parse-");
  const p = (body) => readWorkerStatus(writeFile(join(ws, `e${Math.random()}.md`), body));
  t.check("Status: CONTINUE đọc ra continue", p(HANDOFF).status, "continue");
  t.check("...reported giữ nguyên chữ", p(HANDOFF).reported, "CONTINUE");
  t.check("dòng mẫu nhiều trạng thái vẫn không được tính", p("x\nStatus: DONE | CONTINUE\n").status, "done_unverified");
}

// --- hạn mềm và dòng hợp đồng -------------------------------------------------
{
  const t0 = new Date(2026, 10, 6, 10, 0).getTime();
  t.check("job 9 phút: không có hạn mềm", softDeadlineAt(t0, 9 * MIN), "null");
  t.check("job 10 phút: hạn mềm ở phút 5 (trừ 5m)", softDeadlineAt(t0, 10 * MIN).getTime() - t0, 5 * MIN);
  t.check("job 30 phút: trừ 5m (15% = 4.5m < 5m)", softDeadlineAt(t0, 30 * MIN).getTime() - t0, 25 * MIN);
  t.check("job 60 phút: trừ 15% = 9m", softDeadlineAt(t0, 60 * MIN).getTime() - t0, 51 * MIN);
  const line = handoffLine(new Date(2026, 10, 6, 10, 25));
  t.check("dòng hạn mềm in giờ máy HH:MM", line.startsWith("Hạn mềm 10:25 (giờ máy"), true);
  t.check("...kèm đủ 4 mục handoff và Status: CONTINUE", ["### Đã xong", "### Đang dở", "### Bước kế tiếp", "### File đã đụng", "Status: CONTINUE"].every((x) => line.includes(x)), true);
  const ws = tmpWorkspace("handoff-contract-");
  const ev = join(ws, RUN_REL, "w.md");
  const sd = new Date(2026, 10, 6, 10, 25);
  const with1 = appendWorkerContract("brief", { evidenceAbs: ev, workspace: ws, softDeadline: sd });
  t.check("contract có hạn mềm khi được truyền", with1.includes("Hạn mềm 10:25"), true);
  t.check("...nối hai lần không nhân đôi", appendWorkerContract(with1, { evidenceAbs: ev, workspace: ws, softDeadline: sd }).split("Hạn mềm").length - 1, 1);
  t.check("phiên chat không có hạn mềm", appendWorkerContract("brief", { evidenceAbs: ev, workspace: ws, softDeadline: sd, chat: true }).includes("Hạn mềm"), false);
  t.check("không truyền thì không có", appendWorkerContract("brief", { evidenceAbs: ev, workspace: ws }).includes("Hạn mềm"), false);
  const rescue = handoffRescuePrompt("tasks/t/reports/crew-test/w.md");
  t.check("prompt cứu tự đủ nghĩa: không làm tiếp, ghi handoff vào đúng evidence", rescue.includes("Không làm tiếp") && rescue.includes("tasks/t/reports/crew-test/w.md") && rescue.includes("Status: CONTINUE"), true);
  t.check("...và nói rõ không phải lời owner (đo 06/11: worker từng ghi vào Thay đổi từ owner)", rescue.includes("không phải owner") && rescue.includes("Không ghi tin này vào mục `## Thay đổi từ owner`"), true);
}

// --- collect ------------------------------------------------------------------
function run(jobs) {
  const ws = tmpWorkspace("handoff-collect-");
  const { manifestPath } = createRun({ runDir: join(ws, RUN_REL), runId: "h", task: "t", workspace: ws, depth: 0 });
  for (const [i, j] of jobs.entries()) {
    const ev = join(RUN_REL, `w${i + 1}.md`);
    const { seq } = addJob(manifestPath, { worker: "codex", role: "owner", title: `j${i + 1}`, evidence: ev });
    if (j.body) writeFile(join(ws, ev), j.body);
    updateJob(manifestPath, seq, { startedAt: new Date(Date.now() - 120_000).toISOString(), endedAt: new Date(Date.now() - 60_000).toISOString(), exitCode: 0, ...j.patch });
  }
  return { ws, manifestPath };
}
{
  const a = run([{ body: HANDOFF, patch: { status: "continue", conversationId: "thread-1" } }]);
  const r = collectRun(a.manifestPath, { workspace: a.ws });
  t.check("job CONTINUE có handoff: verdict CONTINUE", r.rows[0].verdict, "CONTINUE");
  t.check("...chặn report (exit 1), không phải vi phạm", r.exitCode, 1);
  t.check("...detail chỉ cách làm tiếp", r.rows[0].detail.includes("--resume"), true);
  t.check("...không có cờ HANDOFF THIẾU", r.rows[0].flags.includes("HANDOFF THIẾU"), false);

  const b = run([{ body: "làm dở\n\nStatus: CONTINUE\n", patch: { status: "continue", conversationId: "thread-1" } }]);
  const rb = collectRun(b.manifestPath, { workspace: b.ws });
  t.check("CONTINUE thiếu ## Handoff → cờ HANDOFF THIẾU", `${rb.rows[0].verdict}|${rb.rows[0].flags.includes("HANDOFF THIẾU")}`, "CONTINUE|true");

  const c = run([
    { body: HANDOFF, patch: { status: "continue", conversationId: "thread-1" } },
    { body: "xong phần còn lại\n\nStatus: DONE\n", patch: { status: "done", reportedStatus: "DONE", conversationId: "thread-1", resumedFrom: "thread-1" } },
  ]);
  const rc = collectRun(c.manifestPath, { workspace: c.ws });
  t.check("job sau resume đúng thread và PASS → CONTINUE thành CHAINED", `${rc.rows[0].verdict}|${rc.rows[0].chainedTo}`, "CHAINED|2");
  t.check("...run qua cổng (exit 0)", rc.exitCode, 0);

  const d = run([
    { body: HANDOFF, patch: { status: "continue", conversationId: "thread-1" } },
    { body: "x\n\nStatus: DONE\n", patch: { status: "done", reportedStatus: "DONE", conversationId: "thread-other", resumedFrom: "thread-1", resumeMismatch: true } },
  ]);
  t.check("job sau resume lệch phiên → vẫn CONTINUE", collectRun(d.manifestPath, { workspace: d.ws }).rows[0].verdict, "CONTINUE");

  const e = run([
    { body: HANDOFF, patch: { status: "continue", conversationId: "thread-1" } },
    { body: "hỏng\n", patch: { status: "failed", conversationId: "thread-1", resumedFrom: "thread-1" } },
  ]);
  const re = collectRun(e.manifestPath, { workspace: e.ws });
  t.check("job làm tiếp hỏng → CHAINED nhưng run vẫn chặn vì job sau", `${re.rows[0].verdict}|${re.rows[1].verdict}|${re.exitCode}`, "CHAINED|NO_STATUS|1");

  // Digest đầu phiên nhắc job continue chưa ai làm tiếp, và thôi nhắc khi đã có.
  const lines = crewDigest(a.ws, { epoch: "2000-01-01" });
  t.check("digest nhắc job continue cần làm tiếp", lines.some((l) => /dừng có handoff \(continue\).*--resume thread-1/.test(l)), true);
  t.check("digest thôi nhắc khi đã có job resume", crewDigest(c.ws, { epoch: "2000-01-01" }).some((l) => l.includes("dừng có handoff")), false);
}

// --- Anti headless: lượt cứu qua --conversation --------------------------------
{
  const ws = tmpWorkspace("handoff-anti-");
  const brief = writeFile(join(ws, "brief.md"), "việc dài\n");
  const runAnti = (name, mode) => {
    const { manifestPath: mp } = createRun({ runDir: join(ws, RUN_REL, name), runId: name, task: "t", workspace: ws, depth: 0 });
    const ev = join(RUN_REL, name, `${name}.md`);
    addJob(mp, { worker: "antigravity", role: "owner", title: name, evidence: ev, model: "m" });
    // Trong thư mục run: agy giả chạy dưới sandbox ghi, ghi ra gốc workspace bị chặn.
    const mark = join(ws, RUN_REL, name, `${name}.mark`);
    const p = spawnSync("node", [join(MODULE_ROOT, "scripts", "anti-run.mjs"),
      "--prompt-file", brief, "--evidence", ev, "--workspace", ws, "--timeout", "60s",
      "--model", "m", "--manifest", mp, "--job", "1"], {
      encoding: "utf8", timeout: 90_000,
      env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: mode, FAKE_EVIDENCE: join(ws, ev), FAKE_RESCUE_MARK: mark, FAKE_CONVERSATION_ID: "conv-long-1" },
    });
    const calls = existsSync(mark) ? readFileSync(mark, "utf8").trim().split("\n") : [];
    return { exit: p.status, stderr: p.stderr, job: readManifest(mp).jobs[0], calls };
  };
  const ok = runAnti("ok", "print_timeout_handoff");
  t.check("agy hết print-timeout → lượt cứu → continue, exit 3", `${ok.exit}|${ok.job.status}`, "3|continue");
  t.check("...cứu đúng conversation, một lần, không --model", ok.calls.length === 1 && ok.calls[0].includes("--conversation conv-long-1") && !ok.calls[0].includes("--model"), true);
  t.check("...sổ ghi lượt cứu và conversation", `${ok.job.handoffRescue?.ok}|${ok.job.conversationId}`, "true|conv-long-1");
  t.check("...không bị coi là runtime lệch evidence", Boolean(ok.job.runtimeVerdict), false);

  const bare = runAnti("bare", "print_timeout_nostatus");
  t.check("lượt cứu không ra Status → failed", `${bare.exit}|${bare.job.status}|${bare.job.handoffRescue?.ok}`, "1|failed|false");
  t.check("...nhưng vẫn giữ conversationId để làm tiếp bằng tay", bare.job.conversationId, "conv-long-1");

  const noid = runAnti("noid", "print_timeout_noid");
  t.check("agy không trả conversation_id → không cứu", `${noid.calls.length}|${noid.job.status}`, "0|failed");
}

// --- Anti app: đợi conversation dừng lượt, gửi prompt cứu, chờ evidence -------------
{
  const T0 = Date.parse("2026-11-06T08:00:00Z");
  const ws = tmpWorkspace("handoff-app-");
  const evidenceAbs = join(ws, RUN_REL, "app.md");
  const clock = { now: T0 };
  const sent = [];
  // Chạy tới phút 22, rồi `done`. Tin cứu tới thì worker ghi handoff.
  const deps = {
    resolveEnv: () => ({ agentapi: "agentapi", env: {} }),
    dispatch: (_bin, args) => {
      sent.push(args);
      if (args[0] === "send-message") writeFile(evidenceAbs, HANDOFF);
      return JSON.stringify({ response: { newConversation: { conversationId: "conv-app-1" } } });
    },
    status: () => ({ steps: 3, byStatus: { 7: 1, 3: Math.floor((clock.now - T0) / MIN) }, state: clock.now - T0 >= 22 * MIN ? "done" : "running" }),
    sleep: async (ms) => { clock.now += ms; },
    now: () => clock.now,
  };
  const r = await runApp({ promptText: "x", workspace: ws, evidenceAbs, timeout: "20m", quietWarnMs: 30 * MIN, quietAlertMs: 40 * MIN }, deps);
  t.check("Anti app hết giờ → cứu → continue", `${r.status}|${r.handoffRescue?.ok}`, "continue|true");
  t.check("...gửi tin cứu sau khi conversation đã dừng lượt", sent[1]?.[0] === "send-message" && clock.now - T0 >= 22 * MIN, true);
  t.check("...vào đúng conversation, với prompt cứu", `${sent[1]?.[1]}|${/hết giờ/i.test(sent[1]?.[2] ?? "")}`, "conv-app-1|true");

  // Conversation không dừng lượt trong 3 phút: không gửi gì, job fail như cũ.
  const ws2 = tmpWorkspace("handoff-app2-");
  const clock2 = { now: T0 };
  const sent2 = [];
  let err = null;
  try {
    await runApp({ promptText: "x", workspace: ws2, evidenceAbs: join(ws2, RUN_REL, "app.md"), timeout: "20m", quietWarnMs: 30 * MIN, quietAlertMs: 40 * MIN }, {
      ...deps,
      dispatch: (_bin, args) => { sent2.push(args); return JSON.stringify({ response: { newConversation: { conversationId: "conv-app-2" } } }); },
      status: () => ({ steps: 3, byStatus: { 7: 1, 3: Math.floor((clock2.now - T0) / MIN) }, state: "running" }),
      sleep: async (ms) => { clock2.now += ms; },
      now: () => clock2.now,
    });
  } catch (e) { err = e; }
  t.check("conversation không dừng lượt → không gửi tin cứu, fail như cũ", `${sent2.length}|${/did not finish/.test(err?.message ?? "")}|${err?.handoffRescue?.ok}`, "1|true|false");
  t.check("...lượt cứu không quá 3 phút sau timeout", clock2.now - T0 <= 23 * MIN + 10_000, true);

  // Phiên chat: không có lượt cứu.
  const ws3 = tmpWorkspace("handoff-app3-");
  const sent3 = [];
  const clock3 = { now: T0 };
  try {
    await runApp({ promptText: "x", workspace: ws3, evidenceAbs: join(ws3, RUN_REL, "app.md"), timeout: "20m", chat: true, quietWarnMs: 18 * MIN, quietAlertMs: 19 * MIN }, {
      ...deps,
      dispatch: (_bin, args) => { sent3.push(args); return JSON.stringify({ response: { newConversation: { conversationId: "conv-app-3" } } }); },
      status: () => ({ steps: 3, byStatus: { 7: 1 }, state: "done" }),
      sleep: async (ms) => { clock3.now += ms; },
      now: () => clock3.now,
    });
  } catch { /* timeout */ }
  t.check("phiên chat không có lượt cứu", sent3.length, 1);
}

process.exit(t.finish() ? 0 : 1);
