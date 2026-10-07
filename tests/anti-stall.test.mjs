#!/usr/bin/env node
/**
 * Job Anti app im lặng: báo sớm, không giết.
 *
 * Bốn job app chạy đủ 30 phút không evidence, cả bốn mất `conversationId`, và
 * adapter không bắt signal nên bị kill là không kiểm credential. Test này canh ba
 * thứ, và thứ quan trọng nhất là cái thứ ba: adapter KHÔNG được tự dừng job khi
 * im lặng (rào credential nằm ở chỗ nó còn sống tới hết timeout).
 *
 *   1. tín hiệu "còn sống" không tự reset được bởi chính hệ thống crew;
 *   2. id conversation vào manifest trước vòng poll;
 *   3. cảnh báo đi ra sidecar, còn adapter vẫn chạy tới timeout.
 *
 * Run: node mwg-agent-crew/tests/anti-stall.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addJob, claimRunSlot, createRun, readManifest, updateJob } from "../scripts/crew-manifest.mjs";
import { newestOwnMtime, progressVerdict, statusFingerprint } from "../scripts/lib/progress-watch.mjs";
import { AntiRunError, antiRun, chatQuietDefaults, makeStopHandler, makeWatchSink, runApp } from "../scripts/anti-run.mjs";
import { CHAT_LINE } from "../scripts/crew-guards.mjs";
import { MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("anti-stall");
const MIN = 60_000;
const T0 = Date.parse("2026-10-03T08:00:00Z");

// ------------------------------------------------------------- progressVerdict
const base = { warnMs: 5 * MIN, alertMs: 10 * MIN, level: "ok", lastProgressAt: T0, newestOwnMtime: null };
const fp = (o) => statusFingerprint(o);
const poll = (o) => progressVerdict({ ...base, ...o });

{
  t.check("vân tay không phụ thuộc thứ tự khoá", fp({ 3: 2, 7: 1 }), fp({ 7: 1, 3: 2 }));
  const first = poll({ prevFingerprint: null, byStatus: { 7: 1 }, now: T0 + 5_000 });
  t.check("lần poll đầu là mốc, không phải tiến triển", `${first.progressed}:${first.level}:${first.lastProgressAt === T0}`, "false:ok:true");

  const moved = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: { 3: 1, 7: 1 }, now: T0 + 4 * MIN });
  t.check("byStatus đổi → tiến triển, đồng hồ reset", `${moved.progressed}:${moved.lastProgressAt === T0 + 4 * MIN}`, "true:true");

  const quiet = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: { 7: 1 }, now: T0 + 4 * MIN });
  t.check("đứng yên dưới ngưỡng: ok, không báo", `${quiet.level}:${quiet.emit}`, "ok:null");
  const warn = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: { 7: 1 }, now: T0 + 5 * MIN });
  t.check("im đúng 5 phút → warn", `${warn.level}:${warn.emit}`, "warn:warn");
  const alert = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: { 7: 1 }, level: "warn", now: T0 + 10 * MIN });
  t.check("im đúng 10 phút → alert", `${alert.level}:${alert.emit}`, "alert:alert");
  const again = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: { 7: 1 }, level: "alert", now: T0 + 15 * MIN });
  t.check("đã alert thì không báo lại mỗi poll", `${again.level}:${again.emit}`, "alert:null");
  const jump = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: { 7: 1 }, now: T0 + 12 * MIN });
  t.check("poll thưa nhảy thẳng qua cả hai ngưỡng → báo alert", `${jump.level}:${jump.emit}`, "alert:alert");
  t.check("quietMs là khoảng im tính theo đồng hồ", alert.quietMs, 10 * MIN);

  const recovered = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: { 3: 1 }, level: "alert", now: T0 + 12 * MIN });
  t.check("đang alert mà byStatus đổi → hết báo, có sự kiện recovered", `${recovered.level}:${recovered.emit}`, "ok:recovered");

  const noDb = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: null, now: T0 + 6 * MIN });
  t.check("chưa đọc được trạng thái: không tính là tiến triển, đồng hồ vẫn chạy", `${noDb.progressed}:${noDb.level}`, "false:warn");
}

// ------------------------------------- tín hiệu phụ: chỉ hoãn, không xoá mức đã báo
{
  const deferred = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: { 7: 1 }, newestOwnMtime: T0 + 4 * MIN, now: T0 + 6 * MIN });
  t.check("file của chính job mới ghi → hoãn warn", `${deferred.level}:${deferred.emit}`, "ok:null");
  t.check("...nhưng không phải tiến triển của byStatus", deferred.progressed, false);
  const later = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: { 7: 1 }, newestOwnMtime: T0 + 4 * MIN, now: T0 + 9 * MIN });
  t.check("hoãn không phải miễn: tới ngưỡng tính từ mtime vẫn báo", `${later.level}:${later.emit}`, "warn:warn");
  const kept = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: { 7: 1 }, level: "alert", newestOwnMtime: T0 + 14 * MIN, now: T0 + 14 * MIN });
  t.check("mức đã báo không bị xoá bởi mtime mới", `${kept.level}:${kept.emit}`, "alert:null");
  const stale = poll({ prevFingerprint: fp({ 7: 1 }), byStatus: { 7: 1 }, newestOwnMtime: T0 - 60 * MIN, now: T0 + 5 * MIN });
  t.check("mtime cũ hơn mốc tiến triển không có tác dụng", stale.level, "warn");
}

// ---------------------------------------------------------------- newestOwnMtime
{
  const ws = tmpWorkspace("stall-");
  const touch = (rel, sec) => {
    const p = writeFile(join(ws, rel), "x");
    utimesSync(p, sec, sec);
    return p;
  };
  touch("mine/a.html", 1_000);
  touch("mine/sub/b.html", 3_000);
  touch("mine/reports/crew-run1/manifest.json", 9_000);        // của hệ thống crew, không tính
  touch("elsewhere/c.html", 8_000);                            // không khai cho job
  touch("tasks/t/reports/crew-test/manifest.json", 8_500);     // manifest của run, không khai
  const outside = touch("outside/secret.html", 7_000);
  symlinkSync(outside, join(ws, "mine", "link.html"));         // symlink: bỏ, không theo
  t.check("lấy mtime mới nhất trong prefix khai riêng", newestOwnMtime(ws, ["mine/"]), 3_000_000);
  t.check("file job khác và manifest không tính", newestOwnMtime(ws, ["mine/"]) === 3_000_000, true);
  t.check("prefix là một file cũng được", newestOwnMtime(ws, ["elsewhere/c.html"]), 8_000_000);
  t.check("không khai gì → null", newestOwnMtime(ws, []), null);
  t.check("prefix không tồn tại → null", newestOwnMtime(ws, ["nope/"]), null);
  t.check("nhiều prefix → lấy mới nhất", newestOwnMtime(ws, ["mine/", "elsewhere/"]), 8_000_000);
  const linkOnly = join(ws, "linkdir");
  mkdirSync(linkOnly);
  symlinkSync(outside, join(linkOnly, "l"));
  t.check("chỉ có symlink → null", newestOwnMtime(ws, ["linkdir/"]), null);
}

// -------------------------------------------------- addJob chặn filesMayModify bậy
{
  const ws = tmpWorkspace("stall-addjob-");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { manifestPath } = createRun({ runDir: join(ws, "tasks", "t", "reports", "crew-test"), runId: "test", task: "t", workspace: ws, depth: 0 });
  const add = (filesMayModify) => {
    try {
      addJob(manifestPath, { worker: "antigravity", role: "assist", title: "j", evidence: join("tasks", "t", "reports", "crew-test", `e${Math.random()}.md`), filesMayModify });
      return "ok";
    } catch (err) { return err.message; }
  };
  t.check("filesMayModify có `..` bị từ chối", /\.\./.test(add(["mine/../../etc/"])), true);
  t.check("filesMayModify tuyệt đối bị từ chối", /tuyệt đối|absolute/i.test(add(["/etc/"])), true);
  t.check("filesMayModify hợp lệ vẫn được nhận", add(["mwg-content-editor/content-workspaces/x/"]), "ok");
}

// ----------------------------------------------------------- vòng poll (đồng hồ giả)
const APP_ENV = { agentapi: "fake-agentapi", env: {} };
function appWorkspace() {
  const ws = tmpWorkspace("stall-app-");
  const evidenceRel = join("tasks", "t", "reports", "crew-test", "worker-anti-1.md");
  return { ws, evidenceRel, evidenceAbs: join(ws, evidenceRel) };
}
/** deps giả: không agentapi, không đọc DB, đồng hồ do sleep() đẩy. */
function fakeDeps({ statuses, onSleep, conv = "conv-new-0001" } = {}) {
  const clock = { now: T0 };
  const log = [];
  return {
    clock, log,
    deps: {
      resolveEnv: () => APP_ENV,
      dispatch: () => { log.push("dispatch"); return JSON.stringify({ response: { newConversation: { conversationId: conv } } }); },
      status: () => { log.push("status"); return statuses(clock.now - T0); },
      sleep: async (ms) => { clock.now += ms; onSleep?.(clock.now - T0); },
      now: () => clock.now,
    },
  };
}
const runOpts = (w, extra = {}) => ({
  promptText: "x", workspace: w.ws, evidenceAbs: w.evidenceAbs, timeout: "20m",
  quietWarnMs: 5 * MIN, quietAlertMs: 10 * MIN, ...extra,
});

{
  // Đứng yên cả 20 phút: warn, alert, rồi VẪN chạy tới timeout.
  const w = appWorkspace();
  const events = [];
  const f = fakeDeps({ statuses: () => ({ steps: 3, byStatus: { 7: 1, 3: 2 }, state: "running" }) });
  const conversations = [];
  let err = null;
  try {
    await runApp(runOpts(w, {
      onWatch: (e) => events.push({ ...e, atMs: f.clock.now - T0 }),
      onConversation: (c) => { conversations.push({ ...c, afterPolls: f.log.filter((x) => x === "status").length }); },
    }), f.deps);
  } catch (e) { err = e; }
  t.check("im 20 phút: ném lỗi hết timeout như hôm nay", err instanceof AntiRunError && /did not finish within 20m/.test(err.message), true);
  t.check("sự kiện: warn rồi alert", events.map((e) => e.level).join(","), "warn,alert");
  t.check("warn ra trong 1 chu kỳ poll kể từ ngưỡng 5m", events[0].atMs >= 5 * MIN && events[0].atMs <= 5 * MIN + 5_000, true);
  t.check("alert ra trong 1 chu kỳ poll kể từ ngưỡng 10m", events[1].atMs >= 10 * MIN && events[1].atMs <= 10 * MIN + 5_000, true);
  t.check("alert mang conversationId và quietSec", `${events[1].conversationId}:${events[1].quietSec >= 600}`, "conv-new-0001:true");
  t.check("adapter vẫn canh tới timeout (đồng hồ chạm 20m)", f.clock.now - T0 >= 20 * MIN, true);
  t.check("conversationId báo ra đúng một lần, trước poll đầu tiên", `${conversations.length}:${conversations[0]?.afterPolls}:${conversations[0]?.conversationId}`, "1:0:conv-new-0001");
  t.check("lỗi hết timeout mang quietMaxSec để ghi vào job", err.quietMaxSec >= 19 * 60, true);
}
{
  // byStatus đổi liên tục: không báo gì.
  const w = appWorkspace();
  const events = [];
  const f = fakeDeps({ statuses: (ms) => ({ steps: 3, byStatus: { 7: 1, 3: Math.floor(ms / (4 * MIN)) }, state: "running" }) });
  try { await runApp(runOpts(w, { onWatch: (e) => events.push(e) }), f.deps); } catch { /* timeout */ }
  t.check("byStatus đổi mỗi 4 phút: không có sự kiện nào", events.length, 0);
}
{
  // Đứng yên 7 phút (warn), rồi nhúc nhích: recovered, và đồng hồ đếm lại từ đó.
  const w = appWorkspace();
  const events = [];
  const f = fakeDeps({ statuses: (ms) => ({ steps: 3, byStatus: ms < 7 * MIN ? { 7: 1 } : { 7: 1, 3: 1 }, state: "running" }) });
  try { await runApp(runOpts(w, { timeout: "16m", onWatch: (e) => events.push(e.level) }), f.deps); } catch { /* timeout */ }
  t.check("warn → recovered → warn lại sau 5 phút im kế tiếp", events.join(","), "warn,recovered,warn");
}
{
  // Ghi file của chính job hoãn warn; ghi manifest/dispatch log/evidence job khác thì không.
  const w = appWorkspace();
  const own = writeFile(join(w.ws, "mine", "a.html"), "x");
  // Đồng hồ trong test là giả (T0), nên mtime ban đầu của file phải cũ hơn T0.
  utimesSync(own, (T0 - 3_600_000) / 1000, (T0 - 3_600_000) / 1000);
  const events = [];
  const f = fakeDeps({
    statuses: () => ({ steps: 3, byStatus: { 7: 1 }, state: "running" }),
    onSleep: (ms) => {
      // Ở phút 4 job ghi file khai riêng; mọi chỗ khác chỉ là nhiễu của hệ thống crew.
      const at = (T0 + ms) / 1000;
      if (ms === 4 * MIN) utimesSync(join(w.ws, "mine", "a.html"), at, at);
      writeFile(join(w.ws, "tasks", "t", "reports", "crew-test", "manifest.json"), `{"n":${ms}}`);
      writeFile(join(w.ws, "tasks", "t", "reports", "crew-test", "worker-codex-2.md"), `job khác ${ms}`);
    },
  });
  try { await runApp(runOpts(w, { timeout: "9m", filesMayModify: ["mine/"], onWatch: (e) => events.push(`${e.level}@${Math.round((f.clock.now - T0) / MIN)}`) }), f.deps); } catch { /* timeout */ }
  const warnAt = Number(events.find((e) => e.startsWith("warn"))?.split("@")[1]);
  t.check("mtime file của chính job hoãn warn (không phải ở phút 5)", warnAt >= 9, true);
}
{
  const w = appWorkspace();
  const events = [];
  const f = fakeDeps({
    statuses: () => ({ steps: 3, byStatus: { 7: 1 }, state: "running" }),
    onSleep: (ms) => {
      writeFile(join(w.ws, "tasks", "t", "reports", "crew-test", "manifest.json"), `{"n":${ms}}`);
      writeFile(join(w.ws, "tasks", "t", "data", "crew-logs", "crew-test", "dispatch.log"), `n ${ms}`);
      writeFile(join(w.ws, "tasks", "t", "reports", "crew-test", "worker-codex-2.md"), `job khác ${ms}`);
    },
  });
  try { await runApp(runOpts(w, { timeout: "7m", onWatch: (e) => events.push(e.level) }), f.deps); } catch { /* timeout */ }
  t.check("ghi manifest, log dispatch, evidence job khác KHÔNG reset đồng hồ", events[0], "warn");
}
{
  // Job xong bình thường: không báo, trả kết quả, có quietMaxSec.
  const w = appWorkspace();
  const events = [];
  const f = fakeDeps({
    statuses: () => ({ steps: 3, byStatus: { 7: 1 }, state: "running" }),
    onSleep: (ms) => { if (ms >= 3 * MIN) writeFile(w.evidenceAbs, "xong\n\nStatus: DONE\nSummary: ok\n"); },
  });
  const result = await runApp(runOpts(w, { onWatch: (e) => events.push(e) }), f.deps);
  t.check("xong trước ngưỡng: không sự kiện", events.length, 0);
  t.check("...trả kết quả đúng", `${result.status}:${result.conversationId}:${result.mode}`, "done:conv-new-0001:app");
  t.check("...có quietMaxSec", typeof result.quietMaxSec, "number");
}
{
  // Resume: id có sẵn, không cần agentapi trả về; vẫn báo ra trước poll đầu, kèm resumedFrom.
  const w = appWorkspace();
  const seen = [];
  const f = fakeDeps({ statuses: () => ({ steps: 3, byStatus: { 7: 1 }, state: "running" }), onSleep: () => writeFile(w.evidenceAbs, "x\n\nStatus: DONE\nSummary: ok\n") });
  await runApp(runOpts(w, { resumeId: "conv-old-9", onConversation: (c) => seen.push(c) }), f.deps);
  t.check("resume: onConversation mang cả resumedFrom", `${seen[0]?.conversationId}:${seen[0]?.resumedFrom}`, "conv-old-9:conv-old-9");
}

// ---------------------------------------------------------- sidecar + manifest note
function claimedRun() {
  const w = appWorkspace();
  execFileSync("git", ["init", "-q"], { cwd: w.ws });
  const { manifestPath } = createRun({ runDir: join(w.ws, "tasks", "t", "reports", "crew-test"), runId: "test", task: "t", workspace: w.ws, depth: 0 });
  addJob(manifestPath, { worker: "antigravity", role: "assist", transport: "app", note: "test cần app", title: "j", evidence: w.evidenceRel });
  claimRunSlot(manifestPath, 1, { startedAt: new Date(T0).toISOString(), timeoutMs: 20 * MIN });
  return { ...w, manifestPath };
}
{
  const r = claimedRun();
  const sidecar = join(r.ws, "tasks", "t", "data", "crew-logs", "crew-test", "worker-anti-1.anti-watch.jsonl");
  const sink = makeWatchSink({ manifestPath: r.manifestPath, seq: 1, sidecarPath: sidecar });
  sink({ type: "anti.watch", level: "warn", at: "x", quietSec: 300, conversationId: "c" });
  sink({ type: "anti.watch", level: "alert", at: "y", quietSec: 600, conversationId: "c" });
  sink({ type: "anti.watch", level: "alert", at: "z", quietSec: 900, conversationId: "c" });
  const lines = readFileSync(sidecar, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  t.check("sidecar: mỗi sự kiện một dòng JSON", lines.map((l) => l.level).join(","), "warn,alert,alert");
  t.check("sidecar nằm ngoài reports/ (trong data/crew-logs)", sidecar.includes(join("data", "crew-logs")), true);
  const notes = readManifest(r.manifestPath).jobs[0].notes;
  t.check("alert ghi note vào job đúng 1 lần", notes.filter((n) => /alert/.test(n)).length, 1);
  t.check("warn không ghi note", notes.some((n) => /warn/.test(n)), false);
}

// ------------------------------------------------- done mà chưa có evidence → idle
{
  // Đo 07/10: worker thôi lượt (conversation done) mà không ghi evidence, adapter chờ
  // tới timeout. Giờ báo `idle` sau 2 phút, một lần mỗi đợt done, và vẫn không dừng.
  const w = appWorkspace();
  const events = [];
  const f = fakeDeps({ statuses: (ms) => ({ steps: 4, byStatus: { 3: 4 }, state: ms < 3 * MIN ? "running" : "done" }) });
  let err = null;
  try { await runApp(runOpts(w, { timeout: "10m", onWatch: (e) => events.push({ ...e, atMs: f.clock.now - T0 }) }), f.deps); } catch (e) { err = e; }
  const idle = events.filter((e) => e.level === "idle");
  t.check("done không evidence: đúng một sự kiện idle", idle.length, 1);
  t.check("idle ra sau ~2 phút kể từ lúc done (trong 1 chu kỳ poll)", idle[0].atMs >= 5 * MIN && idle[0].atMs <= 5 * MIN + 5_000, true);
  t.check("idle mang conversationId, state, evidence=false", `${idle[0].conversationId}:${idle[0].state}:${idle[0].evidence}`, "conv-new-0001:done:false");
  t.check("idle không dừng job: vẫn tới timeout", err instanceof AntiRunError && f.clock.now - T0 >= 10 * MIN, true);
}
{
  // Chờ lệnh nền hợp lệ: done 1 phút rồi app đánh thức lại → không báo.
  const w = appWorkspace();
  const events = [];
  const f = fakeDeps({ statuses: (ms) => ({ steps: 4, byStatus: { 3: Math.floor(ms / MIN) }, state: ms >= 2 * MIN && ms < 3 * MIN ? "done" : "running" }) });
  try { await runApp(runOpts(w, { timeout: "6m", onWatch: (e) => events.push(e.level) }), f.deps); } catch { /* timeout */ }
  t.check("done ngắn hơn ngưỡng rồi chạy tiếp: không idle", events.includes("idle"), false);
}
{
  // Hai đợt done dài, xen giữa là lúc worker dậy: mỗi đợt báo một lần.
  const w = appWorkspace();
  const events = [];
  const doneAt = (ms) => (ms >= 1 * MIN && ms < 5 * MIN) || ms >= 7 * MIN;
  const f = fakeDeps({ statuses: (ms) => ({ steps: 4, byStatus: { 3: 1 }, state: doneAt(ms) ? "done" : "running" }) });
  try { await runApp(runOpts(w, { timeout: "12m", onWatch: (e) => events.push(e.level) }), f.deps); } catch { /* timeout */ }
  t.check("hai đợt done: hai sự kiện idle", events.filter((l) => l === "idle").length, 2);
}
{
  // Evidence đã có (thiếu Status): đường fallback cũ lo, không báo idle.
  const w = appWorkspace();
  writeFile(w.evidenceAbs, "chưa xong\n");
  const events = [];
  const f = fakeDeps({ statuses: () => ({ steps: 4, byStatus: { 3: 4 }, state: "done" }) });
  try { await runApp(runOpts(w, { timeout: "6m", onWatch: (e) => events.push(e.level) }), f.deps); } catch { /* không quan trọng */ }
  t.check("done có evidence: không idle", events.includes("idle"), false);
}
{
  const r = claimedRun();
  const sidecar = join(r.ws, "tasks", "t", "data", "crew-logs", "idle.watch");
  const sink = makeWatchSink({ manifestPath: r.manifestPath, seq: 1, sidecarPath: sidecar });
  sink({ type: "anti.watch", level: "idle", at: "x", idleSec: 120, conversationId: "c" });
  sink({ type: "anti.watch", level: "idle", at: "y", idleSec: 130, conversationId: "c" });
  const notes = readManifest(r.manifestPath).jobs[0].notes;
  t.check("idle ghi note vào job đúng 1 lần, nêu conversation", notes.filter((n) => /done .* chưa có evidence/.test(n) && /conversation c /.test(n)).length, 1);
}

// ------------------------------------------------------------------ stopHandler
{
  const r = claimedRun();
  const exits = [];
  const stop = makeStopHandler({
    manifestPath: r.manifestPath, seq: 1, dispatchedAt: new Date(T0).toISOString(),
    credentialPatch: () => ({ credentialTamper: [{ file: "credentials.enc", change: "deleted", dir: "~/.config/gws" }] }),
    holdsPatch: () => ({ holdsTamper: { at: "x", holdIdsAtExit: [] } }),
    exit: (code) => exits.push(code),
  });
  stop("SIGTERM", 15);
  const j = readManifest(r.manifestPath).jobs[0];
  t.check("SIGTERM: job ghi failed", j.status, "failed");
  t.check("...lý do là dispatcher dừng sau cảnh báo", /dispatcher dừng sau cảnh báo/.test(j.failure ?? ""), true);
  t.check("...có kết quả kiểm credential", j.credentialTamper?.[0]?.file, "credentials.enc");
  t.check("...có kết quả kiểm holds", Boolean(j.holdsTamper), true);
  t.check("...exit 1", exits.join(","), "1");
  let again = null;
  try { claimRunSlot(r.manifestPath, 1, { startedAt: new Date().toISOString(), timeoutMs: 10 * MIN }); again = "claimed"; } catch (e) { again = e.message; }
  t.check("job failed claim lại được ngay (retry/resume không phải đợi)", again, "claimed");
}

// ------------------------------ tiến trình thật: SIGTERM đến được vòng poll bất đồng bộ
{
  // Job chưa claim: harness tự claim như adapter thật.
  const w = appWorkspace();
  execFileSync("git", ["init", "-q"], { cwd: w.ws });
  const { manifestPath } = createRun({ runDir: join(w.ws, "tasks", "t", "reports", "crew-test"), runId: "test", task: "t", workspace: w.ws, depth: 0 });
  addJob(manifestPath, { worker: "antigravity", role: "assist", transport: "app", note: "test cần app", title: "j", evidence: w.evidenceRel });
  const brief = writeFile(join(w.ws, "brief.md"), "do the thing\n");
  const harness = join(MODULE_ROOT, "tests", "fixtures", "anti-app-harness.mjs");
  const child = spawn("node", [
    harness, "--mode", "app", "--prompt-file", brief, "--evidence", w.evidenceRel, "--workspace", w.ws,
    "--timeout", "10m", "--manifest", manifestPath, "--job", "1",
  ], { env: { ...process.env, HARNESS_POLL_MS: "200", GOOGLE_WORKSPACE_CLI_CONFIG_DIR: join(w.ws, "cred") }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((res) => setTimeout(res, 50)); } return false; };
  const gotId = await waitFor(() => readManifest(manifestPath).jobs[0].conversationId === "conv-harness-1", 8_000);
  t.check("tiến trình thật: conversationId vào manifest khi job còn đang chạy", gotId, true);
  t.check("...job đang running", readManifest(manifestPath).jobs[0].status, "running");
  child.kill("SIGTERM");
  const code = await new Promise((res) => child.on("exit", (c) => res(c)));
  const j = readManifest(manifestPath).jobs[0];
  t.check("SIGTERM thật: adapter exit 1", code, 1);
  t.check("...job failed, giữ nguyên conversationId", `${j.status}:${j.conversationId}`, "failed:conv-harness-1");
  t.check("...lý do dispatcher dừng", /dispatcher dừng sau cảnh báo/.test(j.failure ?? ""), true);
  if (!gotId) console.log(`        stderr: ${stderr.slice(0, 400)}`);
}

// ----------------------------------------------------------------- cờ --quiet-*
{
  const w = appWorkspace();
  const brief = writeFile(join(w.ws, "brief.md"), "x\n");
  const cli = (args) => spawnSync("node", [join(MODULE_ROOT, "scripts", "anti-run.mjs"), "--prompt-file", brief, "--evidence", w.evidenceRel, "--workspace", w.ws, ...args], { encoding: "utf8" });
  const head = cli(["--mode", "headless", "--quiet-alert", "10m"]);
  t.check("--quiet-alert ở headless bị từ chối", head.status, 1);
  t.check("...nói rõ là cờ của app mode", /--quiet-alert is not available on antigravity --mode headless/.test(head.stderr), true);
  t.check("--quiet-warn ở headless cũng bị từ chối", /--quiet-warn is not available/.test(cli(["--mode", "headless", "--quiet-warn", "1m"]).stderr), true);
  const inverted = cli(["--mode", "app", "--quiet-warn", "10m", "--quiet-alert", "5m"]);
  t.check("warn ≥ alert bị từ chối", /quiet-warn.*nhỏ hơn.*quiet-alert|quiet-warn must be/i.test(inverted.stderr), true);
  t.check("giá trị sai bị từ chối", cli(["--mode", "app", "--quiet-alert", "abc"]).status, 1);

  // --chat: chỉ app mode, chỉ giá trị "on".
  const chatHead = cli(["--mode", "headless", "--chat", "on"]);
  t.check("--chat ở headless bị từ chối", `${chatHead.status}:${/--chat is not available on antigravity --mode headless/.test(chatHead.stderr)}`, "1:true");
  t.check("--chat giá trị lạ bị từ chối", /--chat chỉ nhận "on"/.test(cli(["--mode", "app", "--chat", "yes"]).stderr), true);
  const tooShort = cli(["--mode", "app", "--chat", "on", "--timeout", "2m"]);
  t.check("--chat với timeout < 3m: mặc định im không hợp lệ, báo rõ", /phiên chat mặc định warn = timeout − 2m/.test(tooShort.stderr), true);
  const codex = spawnSync("node", [join(MODULE_ROOT, "scripts", "codex-run.mjs"), "--prompt-file", brief, "--evidence", w.evidenceRel, "--workspace", w.ws, "--chat", "on"], { encoding: "utf8" });
  t.check("codex không có --chat", `${codex.status !== 0}:${/unknown flag --chat/.test(codex.stderr)}`, "true:true");
}

// ------------------------------------------------- --chat: prompt + ngưỡng im
{
  t.check("mặc định chat: alert = timeout − 1m, warn = timeout − 2m", JSON.stringify(chatQuietDefaults(20 * MIN)), JSON.stringify({ warnMs: 18 * MIN, alertMs: 19 * MIN }));
  const run = async (extra) => {
    const w = appWorkspace();
    const events = [];
    let prompt = null;
    const f = fakeDeps({ statuses: () => ({ steps: 3, byStatus: { 7: 1 }, state: "running" }) });
    const deps = { ...f.deps, dispatch: (bin, args) => { prompt = args.at(-1); return f.deps.dispatch(bin, args); } };
    try {
      await antiRun({ mode: "app", prompt: "brief chat", evidence: w.evidenceRel, workspace: w.ws, timeout: "20m",
        onWatch: (e) => events.push({ level: e.level, atMin: Math.round((f.clock.now - T0) / MIN) }), ...extra }, deps);
    } catch { /* hết timeout: đúng như mong đợi */ }
    return { events, prompt };
  };
  const chat = await run({ chat: "on" });
  t.check("chat: prompt mang câu phiên chat", chat.prompt?.includes(CHAT_LINE), true);
  t.check("chat: owner im 18 phút mới warn, 19 phút mới alert", chat.events.map((e) => `${e.level}@${e.atMin}`).join(","), "warn@18,alert@19");
  const manual = await run({ chat: "on", quietWarn: "3m", quietAlert: "6m" });
  t.check("chat: --quiet-* truyền tay vẫn thắng", manual.events.map((e) => `${e.level}@${e.atMin}`).join(","), "warn@3,alert@6");
  const plain = await run({});
  t.check("job thường: không có câu phiên chat, ngưỡng 5m/10m như cũ",
    `${plain.prompt?.includes(CHAT_LINE)}:${plain.events.map((e) => `${e.level}@${e.atMin}`).join(",")}`, "false:warn@5,alert@10");
}

process.exit(t.finish() ? 0 : 1);
