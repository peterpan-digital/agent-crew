#!/usr/bin/env node
/**
 * Ba lỗi đo được ở Digital Project 11/11:
 * - Codex hết credit giữa job, crew ghi lý do là log lỗi token MCP ở stderr;
 *   giờ lấy lỗi Codex tự báo trong stream, hết quota thì nói thẳng và chỉ `--resume`.
 * - Cổng quota im vì lúc bắn còn > 10%, rồi job effort high ăn hết giữa chừng;
 *   giờ job lớn (chain, effort high/xhigh) được cảnh báo từ dưới 30%.
 * - Reconcile chạy muộn nên job Anti 15 phút bị ghi 71 phút; giờ giờ kết thúc
 *   suy ra là lúc evidence được ghi.
 *
 * Run: node plugins/agent-crew/tests/codex-failure-quota-and-reconcile-time.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { codexExitDetail, collectCodexError } from "../scripts/lib/codex-failure.mjs";
import { quotaVerdict } from "../scripts/lib/worker-quota-verdict.mjs";
import { isBigJob } from "../scripts/cli/quota-command.mjs";
import { addJob, createRun, readManifest, updateJob } from "../scripts/crew-manifest.mjs";
import { reconcileRun } from "../scripts/crew-reconcile.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("codex-failure-quota-and-reconcile-time");
const THREAD = "01a04169-2763-79d1-9037-6dc85981fad1";

// --- lỗi Codex tự báo ------------------------------------------------------------------
{
  const credits = '{"type":"turn.failed","error":{"message":"Your workspace is out of credits. Add credits to continue."}}';
  t.check("đọc turn.failed", collectCodexError(credits), "Your workspace is out of credits. Add credits to continue.");
  t.check("đọc event error", collectCodexError('{"type":"error","message":"stream disconnected"}'), "stream disconnected");
  t.check("dòng thường giữ lỗi trước", collectCodexError('{"type":"item.completed","item":{"type":"agent_message","text":"error handling done"}}', "x"), "x");
  const q = codexExitDetail({ code: 1, streamError: "Your workspace is out of credits.", stderrTail: ["ERROR rmcp invalid_token"], threadId: THREAD });
  t.check("hết credit → nói thẳng hết quota", /^hết quota\/credit Codex giữa job/.test(q), true);
  t.check("...chỉ crew quota và --resume <thread>", /crew quota/.test(q) && q.includes(`--resume ${THREAD}`), true);
  t.check("...không in log MCP ở stderr", /rmcp|invalid_token/.test(q), false);
  t.check("lỗi khác trong stream thắng stderr", codexExitDetail({ code: 1, streamError: "model not found", stderrTail: ["noise"] }), "codex exited 1: model not found");
  t.check("không có lỗi trong stream → đuôi stderr như cũ", codexExitDetail({ code: 2, stderrTail: ["a", "b"] }), "codex exited 2: a | b");
}

// --- codex-run thật với codex giả hết credit ---------------------------------------------
{
  const ws = tmpWorkspace("codexcredits-");
  const runRel = join("tasks", "t", "reports", "crew-credits");
  mkdirSync(join(ws, runRel), { recursive: true });
  const brief = writeFile(join(ws, "brief.md"), "do the thing\n");
  const evidence = join(runRel, "credits.md");
  const p = spawnSync("node", [join(MODULE_ROOT, "scripts", "codex-run.mjs"), "--prompt-file", brief, "--evidence", evidence, "--workspace", ws, "--timeout", "60s"], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: "out_of_credits", FAKE_EVIDENCE: join(ws, evidence) },
  });
  t.check("codex hết credit → job fail", p.status, 1);
  t.check("...lý do là hết quota, kèm --resume", /hết quota\/credit Codex/.test(p.stderr) && p.stderr.includes(`--resume ${THREAD}`), true);
  t.check("...lý do không phải log MCP", /hết quota[^\n]*invalid_token/.test(p.stderr), false);
}

// --- cổng quota cho job lớn ---------------------------------------------------------------
{
  const now = new Date("2026-11-11T10:00:00Z");
  const quota = { ok: true, worker: "codex", resetCredits: 0, groups: [{ name: "chung", models: null, isDefault: true, blocked: false, overflow: false, buckets: [{ window: "5h", remaining: 0.2, resetsAt: new Date("2026-11-11T12:00:00Z") }] }] };
  t.check("còn 20%, job thường → ok", quotaVerdict(quota, { now }).level, "ok");
  const big = quotaVerdict(quota, { now, bigJob: true });
  t.check("còn 20%, job lớn → cảnh báo thấp", big.level, "low");
  t.check("...gợi ý chẻ nhỏ / hạ effort / đổi worker", /Job lớn/.test(big.message), true);
  t.check("job lớn vẫn bắn (không chặn)", big.level === "empty", false);

  const ws = tmpWorkspace("bigjob-");
  const runDir = join(ws, "tasks", "t", "reports", "crew-big");
  mkdirSync(runDir, { recursive: true });
  const { manifestPath } = createRun({ runDir, runId: "crew-big", task: "t", workspace: ws, depth: 0 });
  addJob(manifestPath, { worker: "codex", role: "owner", title: "a", evidence: join("tasks", "t", "reports", "crew-big", "a.md"), effort: "high" });
  addJob(manifestPath, { worker: "codex", role: "owner", title: "b", evidence: join("tasks", "t", "reports", "crew-big", "b.md") });
  t.check("cờ --chain → job lớn", isBigJob(["--chain"], { cwd: ws }), true);
  t.check("--effort xhigh → job lớn", isBigJob(["--effort", "xhigh"], { cwd: ws }), true);
  t.check("sổ ghi effort high → job lớn", isBigJob(["--manifest", manifestPath, "--job", "1"], { cwd: ws }), true);
  t.check("job thường → không", isBigJob(["--manifest", manifestPath, "--job", "2"], { cwd: ws }), false);
  updateJob(manifestPath, 2, { chainStartedAt: new Date().toISOString() });
  t.check("lát của chuỗi (sổ có chainStartedAt) → job lớn", isBigJob(["--manifest", manifestPath, "--job", "2"], { cwd: ws }), true);
}

// --- reconcile: giờ kết thúc theo lúc evidence được ghi -------------------------------------
{
  const ws = tmpWorkspace("reconciletime-");
  const runRel = join("tasks", "t", "reports", "crew-time");
  const runDir = join(ws, runRel);
  mkdirSync(runDir, { recursive: true });
  const { manifestPath } = createRun({ runDir, runId: "crew-time", task: "t", workspace: ws, depth: 0 });
  const evidence = join(runRel, "late.md");
  addJob(manifestPath, { worker: "antigravity", role: "assist", title: "a", evidence });
  const started = new Date(Date.now() - 70 * 60_000);
  updateJob(manifestPath, 1, { status: "running", startedAt: started.toISOString() });
  const ev = writeFile(join(ws, evidence), "# r\n\nStatus: DONE\nSummary: ok\n");
  const wroteAt = new Date(started.getTime() + 15 * 60_000);
  utimesSync(ev, wroteAt, wroteAt);
  reconcileRun(manifestPath);
  const job = readManifest(manifestPath).jobs[0];
  t.check("reconcile: job → done", job.status, "done");
  t.check("...giờ kết thúc là lúc evidence được ghi, không phải lúc reconcile", Math.abs(Date.parse(job.endedAt) - wroteAt.getTime()) < 2000, true);
  t.check("...vẫn đánh dấu là suy ra", job.endedAtInferred, true);
}

process.exit(t.finish() ? 0 : 1);
