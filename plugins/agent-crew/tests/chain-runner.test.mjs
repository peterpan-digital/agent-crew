#!/usr/bin/env node
/**
 * `crew run codex --chain`: lát CONTINUE tự nối trên cùng thread, dừng ở
 * checkpoint mỗi 2 lát (exit 4), ở budget/số lát, khi handoff không đạt hay
 * thread bị tách; bộ đếm sống trong sổ nên gọi lại không mở đồng hồ mới.
 * Chạy thật qua `bin/crew.mjs` → codex-run → fake-codex (mode `chain`).
 *
 * Run: node plugins/agent-crew/tests/chain-runner.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addJob, createRun, readManifest, updateJob, MAX_CHAIN_JOBS_PER_RUN, MAX_JOBS } from "../scripts/crew-manifest.mjs";
import { collectRun } from "../scripts/crew-collect.mjs";
import { runFor } from "../scripts/crew-session.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("chain-runner");
const CREW = join(MODULE_ROOT, "bin", "crew.mjs");
const RUN_REL = "tasks/t/reports/crew-test";
const THREAD = "0c4a1e2b-3d5f-4a6b-8c7d-9e0f1a2b3c4d";

const handoff = (doing, next = "- làm tiếp") =>
  `phần việc\n\n## Handoff\n### Đã xong\n- xong một phần\n### Đang dở\n${doing}\n### Bước kế tiếp\n${next}\n### File đã đụng\n- work.txt\n\nStatus: CONTINUE\n`;
const DONE = "xong cả chuỗi\n\nStatus: DONE\nSummary: ok\n";

/**
 * Một run có job gốc Codex và kịch bản cho từng lượt của fake: `{body, work}`.
 * `work` = lượt đó ghi thêm file việc (không có thì lát "không đổi file").
 */
function setup(name, steps) {
  const ws = tmpWorkspace(`chain-${name}-`);
  const runDir = join(ws, ...RUN_REL.split("/"));
  const { manifestPath } = createRun({ runDir, runId: name, task: "t", workspace: ws, depth: 0 });
  addJob(manifestPath, { worker: "codex", role: "owner", title: "việc dài", evidence: `${RUN_REL}/worker-codex-1.md` });
  const fake = mkdtempSync(join(tmpdir(), `chain-fake-${name}-`));
  steps.forEach((s, i) => {
    if (s.body != null) writeFileSync(join(fake, `${i + 1}.md`), s.body);
    if (s.work !== false) writeFileSync(join(fake, `${i + 1}.work`), "");
    if (s.sleep) writeFileSync(join(fake, `${i + 1}.sleep`), String(s.sleep));
  });
  const brief = writeFile(join(runDir, "brief-codex-1.md"), "việc dài cần nhiều lát\n");
  return { ws, manifestPath, fake, brief };
}
const env = (s, extra = {}) => ({ ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: "chain", FAKE_CHAIN_DIR: s.fake, ...extra });
const argvOf = (s, extra) => ["run", "codex", "--manifest", s.manifestPath, "--job", "1", "--prompt-file", s.brief, "--chain", "--timeout", "1m", ...extra];
function chain(s, extra = [], envExtra = {}) {
  const p = spawnSync(process.execPath, [CREW, ...argvOf(s, extra)], { cwd: s.ws, env: env(s, envExtra), encoding: "utf8", timeout: 120_000 });
  return { exit: p.status, err: p.stderr ?? "" };
}
const jobs = (s) => readManifest(s.manifestPath).jobs;
const root = (s) => jobs(s)[0];
const fakeCalls = (s) => Number(readFileSync(join(s.fake, "count"), "utf8").trim());

// --- CONTINUE → CONTINUE → checkpoint → gọi lại → DONE -------------------------------------
{
  const s = setup("happy", [{ body: handoff("- bước 2") }, { body: handoff("- bước 3") }, { body: DONE }]);
  const r1 = chain(s);
  t.check("2 lát CONTINUE → checkpoint exit 4", r1.exit, 4);
  const js = jobs(s);
  t.check("...sổ có job gốc + 1 lát", js.length, 2);
  t.check("...lát 2 gắn chainOf 1, slice 2", `${js[1].chainOf}/${js[1].slice}`, "1/2");
  t.check("...lát 2 resume đúng thread lát 1", js[1].resumedFrom, THREAD);
  t.check("...cùng một thread", js[1].conversationId, js[0].conversationId);
  t.check("...lát kế giữ worker/role/transport", `${js[1].worker}/${js[1].role}/${js[1].transport}`, "codex/owner/headless");
  t.check("...gốc ghi checkpoint ở lát 2", root(s).chainCheckpointSlice, 2);
  t.check("...gốc ghi số lát", root(s).chainSlices, 2);
  t.check("sổ ghi usage Codex của từng lát (turn.completed)", js.map((j) => j.usage?.input_tokens).join(","), "1000,2000");
  const brief2 = readFileSync(join(s.ws, ...RUN_REL.split("/"), "brief-codex-2.md"), "utf8");
  t.check("brief lát 2 do crew viết: trỏ handoff lát 1 và brief gốc", brief2.includes(`${RUN_REL}/worker-codex-1.md`) && brief2.includes(`${RUN_REL}/brief-codex-1.md`), true);
  t.check("...không chép chữ của worker vào brief", brief2.includes("bước 2"), false);
  t.check("lượt 2 của worker là codex resume <thread>", readFileSync(join(s.fake, "brief-2.txt"), "utf8").includes(`resume ${THREAD}`), true);
  const startedAt = root(s).chainStartedAt;
  const sidecar = join(s.ws, "tasks", "t", "data", "crew-logs", "crew-test", "chain-1.jsonl");
  t.check("sidecar chain-1.jsonl có dòng mỗi lát + checkpoint", existsSync(sidecar) && readFileSync(sidecar, "utf8").trim().split("\n").length, 3);
  t.check("...dòng lát mang usage để đo thread phình", JSON.parse(readFileSync(sidecar, "utf8").split("\n")[1]).usage.input_tokens, 2000);
  const paths = spawnSync(process.execPath, [CREW, "paths", s.manifestPath, "--job", "2"], { encoding: "utf8" }).stdout;
  t.check("crew paths của lát in sidecar theo job gốc", paths.includes(`chain\t${sidecar}`), true);

  const r2 = chain(s);
  t.check("gọi lại sau checkpoint → lát 3 DONE → exit 0", r2.exit, 0);
  t.check("...3 job trong sổ", jobs(s).length, 3);
  t.check("...lát 3 resume tiếp cùng thread", jobs(s)[2].resumedFrom, THREAD);
  t.check("...đồng hồ chuỗi không mở lại", root(s).chainStartedAt, startedAt);
  t.check("...gốc ghi dừng vì done", root(s).chainStoppedFor, "done");
  const c = collectRun(s.manifestPath, { workspace: s.ws });
  t.check("collect: lát CONTINUE đã có lát sau → CHAINED", c.rows.slice(0, 2).map((x) => x.verdict).join(","), "CHAINED,CHAINED");
  t.check("collect: run qua cổng", c.exitCode, 0);
  t.check("gọi lại khi chuỗi đã xong → exit 0, không bắn thêm", `${chain(s).exit}/${fakeCalls(s)}`, "0/3");
}

// --- budget đếm từ sổ ----------------------------------------------------------------------
{
  const s = setup("budget", [{ body: handoff("- a") }, { body: handoff("- b") }, { body: DONE }]);
  t.check("budget: tới checkpoint", chain(s, ["--budget", "10m"]).exit, 4);
  const j2 = jobs(s)[1];
  updateJob(s.manifestPath, 2, { startedAt: new Date(Date.parse(j2.endedAt) - 10 * 60_000).toISOString() });
  const r = chain(s, ["--budget", "10m"]);
  t.check("lát đã tiêu hết budget (đọc từ sổ) → exit 3", r.exit, 3);
  t.check("...ghi lý do hết budget", root(s).chainStoppedFor, "hết budget");
  t.check("...không bắn lát 3", fakeCalls(s), 2);
  t.check("--budget vượt 8h bị từ chối", chain(s, ["--budget", "9h"]).exit, 2);
}

// --- trần số lát -------------------------------------------------------------------------------
{
  const s = setup("max", [{ body: handoff("- a") }]);
  const r = chain(s, ["--max-slices", "1"]);
  t.check("--max-slices 1, lát 1 CONTINUE → exit 3", r.exit, 3);
  t.check("...lý do hết lát", root(s).chainStoppedFor, "hết lát (1)");
  t.check("--max-slices 9 bị từ chối", chain(s, ["--max-slices", "9"]).exit, 2);
}

// --- lát giữa hỏng / bị chặn ----------------------------------------------------------------
{
  const s = setup("failed", [{ body: handoff("- a") }, { body: null }]);
  t.check("lát 2 chết (không evidence) → exit 1", chain(s).exit, 1);
  t.check("...lát 2 failed trong sổ", jobs(s)[1].status, "failed");
  t.check("...gốc ghi dừng vì failed", root(s).chainStoppedFor, "failed");
  const b = setup("blocked", [{ body: handoff("- a") }, { body: "kẹt\n\nStatus: BLOCKED\nConcerns/Blockers: thiếu quyền\n" }]);
  t.check("lát 2 BLOCKED → exit 3", chain(b).exit, 3);
}

// --- thread bị tách --------------------------------------------------------------------------
{
  const s = setup("split", [{ body: handoff("- a") }, { body: handoff("- b") }]);
  const r = chain(s, [], { FAKE_CHAIN_SPLIT: "2" });
  t.check("lát 2 chạy ở thread lạ → exit 3, không nối tiếp", r.exit, 3);
  t.check("...lý do thread bị tách", root(s).chainStoppedFor.startsWith("thread bị tách"), true);
  t.check("...sổ ghi resumeMismatch", jobs(s)[1].resumeMismatch, true);
  t.check("...không có lát 3", jobs(s).length, 2);
}

// --- kiểm cơ học handoff ----------------------------------------------------------------------
{
  const same = setup("same", [{ body: handoff("- a") }, { body: handoff("- a") }]);
  t.check("Đang dở y như lát trước → exit 3", chain(same).exit, 3);
  t.check("...lý do không tiến triển", root(same).chainStoppedFor.includes("Đang dở"), true);
  const idle = setup("idle", [{ body: handoff("- a"), work: false }]);
  t.check("lát không đổi file nào → exit 3, không nối", `${chain(idle).exit}/${jobs(idle).length}`, "3/1");
  const priv = setup("priv", [{ body: handoff("- a", "- chạy crew run codex --sandbox-mode danger-full-access") }]);
  t.check("handoff đòi quyền → exit 3, không nối", `${chain(priv).exit}/${jobs(priv).length}`, "3/1");
  const noHandoff = setup("nohandoff", [{ body: "hết giờ\n\nStatus: CONTINUE\n" }]);
  t.check("CONTINUE mà thiếu ## Handoff → exit 3", chain(noHandoff).exit, 3);
}

// --- cờ bị từ chối ------------------------------------------------------------------------------
{
  const s = setup("flags", [{ body: DONE }]);
  t.check("--workspace-cli on bị từ chối", chain(s, ["--workspace-cli", "on"]).exit, 2);
  t.check("--evidence bị từ chối", chain(s, ["--evidence", "x.md"]).exit, 2);
  const noPrompt = spawnSync(process.execPath, [CREW, "run", "codex", "--manifest", s.manifestPath, "--job", "1", "--chain"], { cwd: s.ws, env: env(s), encoding: "utf8" });
  t.check("thiếu --prompt-file bị từ chối", noPrompt.status, 2);
  t.check("...không lát nào được bắn", existsSync(join(s.fake, "count")), false);
  t.check("chuỗi 1 lát DONE → exit 0", chain(s).exit, 0);
}

// --- lệnh thay thế mà cổng trần 30m gợi ý phải chạy được trên chính job đó -----------------------
// Đo 15/11/2026: `crew run codex --timeout 60m` bị từ chối trước khi spawn, adapter vẫn ghi
// job là failed; session gõ đúng lệnh crew gợi ý `--chain --timeout 30m --budget 60m` thì
// chuỗi dừng ngay "(failed), 1 lát, 0 phút", không bắn worker, không nói vì sao.
{
  const s = setup("ceiling", [{ body: DONE }]);
  const plain = spawnSync(process.execPath, [CREW, "run", "codex", "--manifest", s.manifestPath, "--job", "1", "--prompt-file", s.brief, "--timeout", "60m"], { cwd: s.ws, env: env(s), encoding: "utf8" });
  t.check("--timeout 60m bị từ chối, gợi ý --chain", plain.status !== 0 && plain.stderr.includes("--chain --timeout 30m --budget 60m"), true);
  t.check("...không bắn worker", existsSync(join(s.fake, "count")), false);
  const r = chain(s, ["--budget", "60m"]);
  t.check("lệnh gợi ý chạy được trên chính job đó → exit 0", r.exit, 0);
  t.check("...worker được bắn 1 lần", existsSync(join(s.fake, "count")) && fakeCalls(s), 1);
  t.check("...job gốc done, không phải job mới", `${jobs(s).length}/${root(s).status}`, "1/done");

  // Gốc đã kết thúc thật (đã chạy, có thread) thì chuỗi không tự bắn lại, nhưng phải nói vì sao.
  const d = setup("dead-root", [{ body: DONE }]);
  updateJob(d.manifestPath, 1, { status: "failed", conversationId: THREAD, failure: "hết quota/credit Codex giữa job" });
  const rd = chain(d);
  t.check("gốc failed đã có thread → không bắn, exit 1", `${rd.exit}/${existsSync(join(d.fake, "count"))}`, "1/false");
  t.check("...stderr nói lý do failed cũ và đường --resume", rd.err.includes("hết quota/credit") && rd.err.includes(`--resume ${THREAD}`), true);
}

// --- trần job: lát không tính vào MAX_JOBS, trần riêng mỗi run ----------------------------------
{
  const ws = tmpWorkspace("chain-cap-");
  const runDir = join(ws, "tasks", "t", "reports", "crew-261106-0900");
  const { manifestPath } = createRun({ runDir, runId: "261106-0900", task: "t", workspace: ws, depth: 0 });
  const ev = (n) => `tasks/t/reports/crew-261106-0900/w${n}.md`;
  let n = 0;
  const job = () => { n += 1; return addJob(manifestPath, { worker: "codex", role: "owner", title: `j${n}`, evidence: ev(n) }); };
  const slice = (k) => { n += 1; return addJob(manifestPath, { worker: "codex", role: "owner", title: `lát ${k}`, evidence: ev(n), chainOf: 1, slice: k }); };
  for (let i = 1; i < MAX_JOBS; i += 1) job();
  slice(2);
  slice(3);
  t.check(`${MAX_JOBS - 1} job thường + 2 lát: run-for vẫn coi run còn chỗ`, runFor(join(ws, "tasks", "t"), { date: "261106" }), manifestPath);
  job();
  t.check(`run đủ ${MAX_JOBS} job thường vẫn thêm được lát`, slice(4).chainOf, 1);
  let refused = "";
  try { addJob(manifestPath, { worker: "codex", role: "owner", title: "j7", evidence: ev(99) }); } catch (err) { refused = err.message; }
  t.check("...job thường thứ 7 vẫn bị từ chối", refused.includes(`max ${MAX_JOBS}`), true);
  for (let k = 5; k <= MAX_CHAIN_JOBS_PER_RUN + 1; k += 1) slice(k);
  let capped = "";
  try { slice(MAX_CHAIN_JOBS_PER_RUN + 2); } catch (err) { capped = err.message; }
  t.check(`lát thứ ${MAX_CHAIN_JOBS_PER_RUN + 1} trong run bị từ chối`, capped.includes(`tối đa ${MAX_CHAIN_JOBS_PER_RUN}`), true);
  let bad = "";
  try { addJob(manifestPath, { worker: "codex", role: "owner", title: "x", evidence: ev(98), chainOf: 7, slice: 2 }); } catch (err) { bad = err.message; }
  t.check("chainOf trỏ vào lát (không phải gốc) bị từ chối", bad.includes("chainOf 7"), true);
}

// --- SIGTERM chuyển xuống lát đang chạy -------------------------------------------------------
{
  const s = setup("sigterm", [{ body: handoff("- a"), sleep: 30 }]);
  const code = await new Promise((done) => {
    const p = spawn(process.execPath, [CREW, ...argvOf(s, [])], { cwd: s.ws, env: env(s), stdio: "ignore" });
    const started = Date.now();
    const poll = setInterval(() => {
      if (existsSync(join(s.fake, "count")) || Date.now() - started > 20_000) { clearInterval(poll); setTimeout(() => p.kill("SIGTERM"), 500); }
    }, 100);
    p.on("exit", (c) => done(c));
  });
  t.check("SIGTERM vào chuỗi → exit 1", code, 1);
  t.check("...gốc ghi chainStoppedFor sigterm", root(s).chainStoppedFor, "sigterm");
  t.check("...lát đang chạy không còn running", root(s).status !== "running", true);
}

process.exit(t.finish() ? 0 : 1);
