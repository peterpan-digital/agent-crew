#!/usr/bin/env node
/**
 * Máy ngủ (gập nắp) không tính vào --timeout và giờ im của worker Codex.
 *
 * Đo 24/11 (Digital Project run 261124-2119 job 2): job mới chạy ~22 phút thức
 * thì bị cắt "exceeded 30m" ngay lúc máy thức tạm, vì đồng hồ của setTimeout
 * trên macOS vẫn chạy khi máy ngủ. CI không gập nắp được, nên test tiêm đồng
 * hồ nhảy 40 phút để giả lập giấc ngủ.
 *
 * Run: node plugins/agent-crew/tests/watchdog-sleep-not-counted.test.mjs
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { awakeDeadline, createAwakeClock, sleptSuffix } from "../scripts/lib/awake-clock.mjs";
import { codexRun, parseArgv } from "../scripts/codex-run.mjs";
import { FIXTURE_BIN, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("watchdog-sleep-not-counted");
const MIN = 60_000;

// --- đồng hồ thức, đồng hồ giả -----------------------------------------------------------
{
  let wall = 0;
  const gaps = [];
  const clock = createAwakeClock({ now: () => wall, tickMs: 5_000, gapMs: 30_000, onSleep: (g) => gaps.push(g) });
  wall = 5_000; clock.poll();
  wall = 40_000; t.check("nhịp trễ 35s (≤ 5s + 30s) chưa tính là ngủ", clock.poll(), 0);
  wall = 40_000 + 20 * MIN; const gap = clock.poll();
  t.check("nhảy 20 phút → ngủ 20 phút trừ một nhịp", gap, 20 * MIN - 5_000);
  t.check("...gọi onSleep đúng một lần", gaps.length, 1);
  t.check("giờ thức = giờ tường trừ giờ ngủ", clock.awakeMs(), 45_000);
  t.check("đuôi lý do cắt nêu giờ ngủ", sleptSuffix(clock), " (máy ngủ thêm 1195s, không tính)");
}
{
  // Ca 24/11 thu nhỏ: hạn 30 phút, thức 21 phút, ngủ 20 phút → không được cắt.
  let wall = 0;
  let expired = 0;
  const clock = createAwakeClock({ now: () => wall, tickMs: 5_000 });
  const d = awakeDeadline({ ms: 30 * MIN, clock, tickMs: 5_000, onExpire: () => { expired += 1; } });
  for (wall = 5_000; wall <= 21 * MIN; wall += 5_000) d.check();
  wall += 20 * MIN; d.check();
  t.check("thức 21 phút + ngủ 20 phút, hạn 30 phút → chưa cắt", expired, 0);
  for (; wall <= 50 * MIN; wall += 5_000) d.check();
  t.check("...đủ 30 phút thức thì cắt, đúng một lần", expired, 1);
  d.clear();
}

// --- codex-run thật với fake codex ------------------------------------------------------
const ws = tmpWorkspace("sleep-");
const brief = writeFile(join(ws, "brief.md"), "do the thing\n");
const runDir = join("tasks", "t", "reports", "crew-live");
mkdirSync(join(ws, runDir), { recursive: true });
process.env.PATH = `${FIXTURE_BIN}:${process.env.PATH}`;
process.env.FAKE_MODE = "silent_command";
process.env.FAKE_SILENT_SEC = "3";

async function run(name, { jumpAfterMs, jumpMs, timeout }) {
  const evidence = join(runDir, `${name}.md`);
  process.env.FAKE_EVIDENCE = join(ws, evidence);
  const t0 = Date.now();
  const clock = () => Date.now() + (Date.now() - t0 > jumpAfterMs ? jumpMs : 0);
  const options = { ...parseArgv(["--prompt-file", brief, "--evidence", evidence, "--workspace", ws, "--timeout", timeout, "--idle-timeout", "2s"]), clock, sleepTickMs: 200 };
  try {
    return await codexRun(options);
  } catch (err) {
    return { status: "error", error: err.message, stream: err.stream };
  }
}
{
  // Máy "ngủ" 40 phút ở giây thứ 1 của job 3 giây, hạn 30s: code cũ không biết
  // ngủ; code mới trừ giờ ngủ, job xong DONE và sidecar ghi lại giấc ngủ.
  const r = await run("slept", { jumpAfterMs: 1_000, jumpMs: 40 * MIN, timeout: "30s" });
  t.check("ngủ 40 phút giữa job, hạn 30s → không bị cắt, xong DONE", `${r.status}/${r.killedFor ?? null}`, "done/null");
  const stream = r.stream ? readFileSync(r.stream, "utf8") : "";
  t.check("...sidecar ghi máy ngủ, không tính vào --timeout", /máy ngủ \d+s \(gập nắp\/sleep\) — không tính vào --timeout/.test(stream), true);
}

process.exit(t.finish() ? 0 : 1);
