#!/usr/bin/env node
/**
 * Dừng job Anti headless phải dừng cả agy (11/11, Digital Project): dispatcher
 * `pkill` adapter để giao lại job, nhưng adapter đợi agy bằng spawnSync nên
 * signal chỉ giết adapter; `agy -p` mồ côi chạy thêm ~20 phút, ghi đè file của
 * run mới, và reconcile ghi job đã huỷ là `done`.
 *
 * Ở đây: agy giả còn đang làm và đã sinh một lệnh con sẽ ghi file sau vài giây.
 * SIGTERM vào adapter → agy và lệnh con chết, file muộn không bao giờ xuất hiện,
 * sổ ghi `failed` kèm lý do, adapter thoát 1.
 *
 * Run: node plugins/agent-crew/tests/anti-headless-stop.test.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addJob, createRun, readManifest } from "../scripts/crew-manifest.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("anti-headless-stop");
const ANTI = join(MODULE_ROOT, "scripts", "anti-run.mjs");
const ws = tmpWorkspace("antistop-");
const RUN_DIR_REL = join("tasks", "t", "reports", "crew-stop");
const runDir = join(ws, RUN_DIR_REL);
mkdirSync(runDir, { recursive: true });
const brief = writeFile(join(ws, "brief.md"), "do the thing\n");
const { manifestPath } = createRun({ runDir, runId: "crew-stop", task: "t", workspace: ws, depth: 0 });
const evidence = join(RUN_DIR_REL, "stop-1.md");
addJob(manifestPath, { worker: "antigravity", role: "owner", title: "slow", evidence });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lateFile = join(ws, "late.txt");
const pidFile = join(ws, "agy.pid");

const child = spawn("node", [ANTI, "--prompt-file", brief, "--evidence", evidence, "--workspace", ws,
  "--timeout", "60s", "--manifest", manifestPath, "--job", "1"], {
  env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: "slow_with_child",
    FAKE_EVIDENCE: join(ws, evidence), FAKE_LATE_FILE: lateFile, FAKE_LATE_SEC: "4", FAKE_PID_FILE: pidFile },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => { stderr += c; });
const exited = new Promise((r) => child.on("close", (code) => r(code)));

for (let i = 0; i < 50 && !existsSync(pidFile); i += 1) await sleep(100);
const agyPid = Number(readFileSync(pidFile, "utf8").trim());
t.check("agy giả đã chạy", alive(agyPid), true);
t.check("sổ ghi job đang running", readManifest(manifestPath).jobs[0].status, "running");

child.kill("SIGTERM");
const code = await exited;
t.check("adapter thoát 1 sau SIGTERM", code, 1);
t.check("...báo đã giết agy", /đã giết agy/.test(stderr), true);
t.check("agy không còn sống", alive(agyPid), false);
await sleep(5000);
t.check("lệnh con của agy cũng chết: file muộn không xuất hiện", existsSync(lateFile), false);
const job = readManifest(manifestPath).jobs[0];
t.check("sổ ghi failed, nêu lý do dừng", `${job.status}/${/dispatcher dừng job, đã giết agy/.test(job.failure ?? "")}`, "failed/true");

process.exit(t.finish() ? 0 : 1);
