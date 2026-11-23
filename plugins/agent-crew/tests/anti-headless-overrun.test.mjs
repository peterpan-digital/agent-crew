#!/usr/bin/env node
/**
 * agy chạy quá --print-timeout mà không tự dừng thì crew tự cắt (sau thêm 30s).
 * 22/11 (Digital Project): job Anti 20m chạy 1558s rồi bị cắt, nhưng adapter báo
 * "could not run agy: spawn agy ETIMEDOUT — check that agy is on PATH". agy vẫn
 * nằm trên PATH; session mất một lượt đi kiểm PATH, và evidence (nếu có) không
 * được chấm vì adapter ném lỗi trước judgeJob.
 *
 * Ở đây: agy giả treo qua timeout. Không evidence → lỗi nói đúng là bị cắt vì quá
 * hạn, không nhắc PATH. Có evidence Status DONE → job được chấm theo evidence,
 * việc cắt ghi vào runtimeVerdict.
 *
 * Chậm (~32s) vì ngưỡng cắt là timeout + 30s; hai ca chạy song song.
 * Run: node plugins/agent-crew/tests/anti-headless-overrun.test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { addJob, createRun, readManifest } from "../scripts/crew-manifest.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("anti-headless-overrun");
const ANTI = join(MODULE_ROOT, "scripts", "anti-run.mjs");

function startCase(mode) {
  const ws = tmpWorkspace("antiover-");
  const rel = join("tasks", "t", "reports", "crew-over");
  mkdirSync(join(ws, rel), { recursive: true });
  const brief = writeFile(join(ws, "brief.md"), "do the thing\n");
  const { manifestPath } = createRun({ runDir: join(ws, rel), runId: "crew-over", task: "t", workspace: ws, depth: 0 });
  const evidence = join(rel, "over-1.md");
  addJob(manifestPath, { worker: "antigravity", role: "owner", title: "hang", evidence });
  const child = spawn("node", [ANTI, "--prompt-file", brief, "--evidence", evidence, "--workspace", ws,
    "--timeout", "1s", "--manifest", manifestPath, "--job", "1"], {
    env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: mode, FAKE_EVIDENCE: join(ws, evidence) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  return new Promise((r) => child.on("close", (code) => r({ code, stderr, job: readManifest(manifestPath).jobs[0] })));
}

const [bare, done] = await Promise.all([startCase("hang_past_timeout"), startCase("hang_past_timeout_done")]);

t.check("không evidence: adapter thoát 1", bare.code, 1);
t.check("...không đổ cho PATH", /on PATH|could not run agy/.test(bare.stderr), false);
t.check("...nói rõ agy quá --print-timeout và crew đã cắt", /quá --print-timeout/.test(bare.stderr) && /crew đã cắt/.test(bare.stderr), true);
t.check("...sổ ghi failed với cùng lý do", `${bare.job.status}/${/quá --print-timeout/.test(bare.job.failure ?? "")}`, "failed/true");

t.check("evidence DONE: adapter thoát 3 (runtime lệch evidence, cần người đọc)", done.code, 3);
t.check("...job chấm theo evidence", done.job.status, "done");
t.check("...việc cắt ghi vào runtimeVerdict", /quá --print-timeout/.test(done.job.runtimeVerdict ?? ""), true);

process.exit(t.finish() ? 0 : 1);
