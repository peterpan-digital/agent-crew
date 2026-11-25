#!/usr/bin/env node
/**
 * `crew quota` và cổng quota của `crew run`.
 *
 * Hình dữ liệu của hai CLI lấy từ lần đọc thật 07/11 (bỏ accountId và id
 * credit). Cổng được kiểm qua `bin/crew.mjs` thật với worker giả: cạn thì adapter
 * không chạy và sổ không đổi; thấp hay không đọc được thì vẫn bắn.
 *
 * Run: node plugins/agent-crew/tests/worker-quota.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addJob, createRun, readManifest } from "../scripts/crew-manifest.mjs";
import { normalizeAgyQuota, normalizeCodexQuota } from "../scripts/lib/worker-quota-readers.mjs";
import { QUOTA_EXIT, antiFamily, formatReset, labelMatchesModel, quotaVerdict } from "../scripts/lib/worker-quota-verdict.mjs";
import { takeQuotaFlag } from "../scripts/cli/quota-command.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("worker-quota");
const CREW = join(MODULE_ROOT, "bin", "crew.mjs");
const NOW = new Date("2026-11-07T03:30:00+07:00");
const IN_3H = Math.floor(NOW.getTime() / 1000) + 3 * 3600;
const IN_7D = Math.floor(NOW.getTime() / 1000) + 7 * 86400;
const AGO = Math.floor(NOW.getTime() / 1000) - 60;

// Phép phán thuần dùng NOW cố định; dữ liệu đưa qua `crew run` thật thì giờ hồi
// phải tính từ đồng hồ thật, không thì tới quá NOW + 3h là "đã hồi" và cổng cho bắn.
const LIVE = Math.floor(Date.now() / 1000);
const codexLimits = (used5h, usedWeek, extra = {}, base = NOW.getTime() / 1000) => ({
  limitId: "codex", limitName: null, normalModelSlug: null,
  primary: { usedPercent: used5h, windowDurationMins: 300, resetsAt: Math.floor(base) + 3 * 3600 },
  secondary: { usedPercent: usedWeek, windowDurationMins: 10080, resetsAt: Math.floor(base) + 7 * 86400 },
  credits: { hasCredits: false, unlimited: false, balance: null },
  spendControlReached: false, rateLimitReachedType: null, ...extra,
});
const codexResult = (rl, more = {}) => ({
  ordinaryUsageAllowed: true, rateLimits: rl, rateLimitsByLimitId: { codex: rl },
  rateLimitResetCredits: { availableCount: 2, credits: [] }, ...more,
});
const agyJson = (gemini5h, geminiWeek, claude5h = 1, claudeWeek = 0.98, base = NOW.getTime() / 1000) => {
  const IN_3H = Math.floor(base) + 3 * 3600;
  const IN_7D = Math.floor(base) + 7 * 86400;
  return {
  conversation_id: "", status: "SUCCESS", usage: { total_tokens: 0 },
  response: "",
  command: {
    name: "usage",
    data: {
      groups: [
        { name: "Gemini Models", buckets: [
          { id: "gemini-weekly", window: "weekly", remaining_fraction: geminiWeek, reset_time: new Date(IN_7D * 1000).toISOString() },
          { id: "gemini-5h", window: "5h", remaining_fraction: gemini5h, reset_time: new Date(IN_3H * 1000).toISOString() },
        ] },
        { name: "Claude and GPT models", buckets: [
          { id: "claude-weekly", window: "weekly", remaining_fraction: claudeWeek, reset_time: new Date(IN_7D * 1000).toISOString() },
          { id: "claude-5h", window: "5h", remaining_fraction: claude5h, reset_time: new Date(IN_3H * 1000).toISOString() },
        ] },
      ],
    },
  },
  };
};

// --- đọc hình dữ liệu --------------------------------------------------------

{
  const q = normalizeCodexQuota(codexResult(codexLimits(86, 13)));
  t.check("codex: đọc được", q.ok, true);
  t.check("codex: 5h còn 14%", Math.round(q.groups[0].buckets[0].remaining * 100), 14);
  t.check("codex: cửa sổ 300 phút là 5h, 10080 là tuần", q.groups[0].buckets.map((b) => b.window).join(","), "5h,tuần");
  t.check("codex: số lượt reset miễn phí", q.resetCredits, 2);
  t.check("codex: thiếu rateLimits → không đọc được", normalizeCodexQuota({}).ok, false);
}
{
  const q = normalizeAgyQuota(agyJson(0.99, 0.49));
  t.check("anti: 2 nhóm", q.groups.map((g) => g.name).join("|"), "Gemini Models|Claude and GPT models");
  t.check("anti: weekly → tuần", q.groups[0].buckets[0].window, "tuần");
  const tsv = normalizeAgyQuota({ response: "Gemini Models\tWeekly Limit Remaining\t49%\t2026-11-07T04:14:51Z\nGemini Models\tFive Hour Limit Remaining\t99%\t2026-11-06T22:30:33Z\n" });
  t.check("anti: không có command.data thì đọc dòng TSV", tsv.ok && tsv.groups[0].buckets.map((b) => `${b.window}=${Math.round(b.remaining * 100)}`).join(","), "tuần=49,5h=99");
  t.check("anti: JSON lạ → không đọc được", normalizeAgyQuota({ status: "SUCCESS" }).ok, false);
}

// --- phán --------------------------------------------------------------------

const codexV = (rl, opts = {}, more = {}) => quotaVerdict(normalizeCodexQuota(codexResult(rl, more)), { now: NOW, ...opts });
t.check("codex 40% đã dùng → ok", codexV(codexLimits(40, 10)).level, "ok");
t.check("codex còn 5% → thấp, vẫn bắn", codexV(codexLimits(95, 10)).level, "low");
t.check("codex 100% → cạn", codexV(codexLimits(100, 10)).level, "empty");
t.check("codex tuần cạn dù 5h còn → cạn", codexV(codexLimits(10, 100)).level, "empty");
t.check("codex tự báo chạm trần → cạn dù % còn", codexV(codexLimits(50, 10, { rateLimitReachedType: "primary" })).level, "empty");
t.check("ordinaryUsageAllowed=false → cạn", codexV(codexLimits(50, 10), {}, { ordinaryUsageAllowed: false }).level, "empty");
t.check("cạn nhưng có credits → chỉ cảnh báo",
  codexV(codexLimits(100, 10, { credits: { hasCredits: true, unlimited: false, balance: "5" } })).level, "low");
t.check("qua giờ hồi rồi → coi như đầy",
  codexV(codexLimits(100, 10, { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: AGO } })).level, "ok");
t.check("lời từ chối nhắc lượt reset miễn phí", /2 lượt reset miễn phí/.test(codexV(codexLimits(100, 10)).message), true);
t.check("lời từ chối nói sổ không đổi", /job vẫn pending/.test(codexV(codexLimits(100, 10)).message), true);
{
  const perModel = codexLimits(100, 10, { limitId: "sol-only", normalModelSlug: "gpt-6-sol" });
  const q = normalizeCodexQuota({ ...codexResult(codexLimits(20, 10)), rateLimitsByLimitId: { codex: codexLimits(20, 10), "sol-only": perModel } });
  t.check("codex: model có hạn mức riêng đã cạn → cạn", quotaVerdict(q, { model: "gpt-6-sol", now: NOW }).level, "empty");
  t.check("codex: model khác vẫn đi hạn mức chung", quotaVerdict(q, { model: "gpt-6-terra", now: NOW }).level, "ok");
}
t.check("không đọc được → unknown, không chặn", quotaVerdict({ ok: false, worker: "codex", error: "x" }).level, "unknown");

t.check("họ model: gemini", antiFamily("gemini-3.8-flash-medium"), "gemini");
t.check("họ model: bậc app flash là gemini", antiFamily("flash_lite"), "gemini");
t.check("họ model: claude", antiFamily("claude-opus-4-6-thinking"), "claude-gpt");
t.check("họ model: gpt-oss", antiFamily("gpt-oss-120b-medium"), "claude-gpt");
t.check("họ model: inherit không biết", antiFamily("inherit"), null);
{
  const q = normalizeAgyQuota(agyJson(0, 0.49));
  t.check("anti: Gemini cạn, job Gemini → cạn", quotaVerdict(q, { model: "gemini-3.8-flash-medium", now: NOW }).level, "empty");
  t.check("anti: Gemini cạn, job Claude → ok", quotaVerdict(q, { model: "claude-sonnet-4-6", now: NOW }).level, "ok");
  t.check("anti: Gemini cạn, không rõ model → chỉ cảnh báo", quotaVerdict(q, { model: null, now: NOW }).level, "low");
  const both = normalizeAgyQuota(agyJson(0, 0.5, 0, 0.5));
  t.check("anti: mọi nhóm cạn, không rõ model → cạn", quotaVerdict(both, { model: null, now: NOW }).level, "empty");
}
{
  // Hình JSON thật đo 23/11: danh sách model nằm trong description, nhóm Argon riêng.
  const g = (name, description, rem) => ({ name, description, buckets: [
    { id: `${name}-w`, window: "weekly", remaining_fraction: rem, reset_time: new Date(IN_7D * 1000).toISOString() },
  ] });
  const q = normalizeAgyQuota({ command: { data: { groups: [
    g("Gemini Models", "Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon), Gemini 3.8 Flash", 0.9),
    g("Claude and GPT models", "Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B", 0.9),
    g("Gemini 4 Argon", "For paid Pro plans, Argon quota is separate. Higher Argon quota is available on Ultra plans.", 0),
  ] } } });
  t.check("anti: nhãn nhóm lấy từ description", q.groups[0].labels.join("|"), "Gemini 4 Neon|Gemini 4 Hydrogen|Orchestrator (Neon)|Gemini 3.8 Flash");
  t.check("anti: nhóm không có danh sách → tên nhóm là nhãn", q.groups[2].labels.join("|"), "Gemini 4 Argon");
  t.check("anti: Argon cạn, job Hydrogen → ok (không bị nhóm Argon chặn)", quotaVerdict(q, { model: "gemini-4-hydrogen-medium", now: NOW }).level, "ok");
  t.check("anti: Argon cạn, job Flash 3.8 → ok", quotaVerdict(q, { model: "gemini-3.8-flash-low", now: NOW }).level, "ok");
  t.check("anti: Argon cạn, job Argon → cạn", quotaVerdict(q, { model: "gemini-4-argon-high", now: NOW }).level, "empty");
  t.check("anti: Orchestrator (Neon) thuộc nhóm Gemini", quotaVerdict(q, { model: "gemini-pro-orchestrator-neon", now: NOW }).lines.join("|").startsWith("Gemini Models:"), true);
  t.check("anti: Claude 5.5 thuộc nhóm Claude/GPT", quotaVerdict(q, { model: "claude-opus-5-5-high", now: NOW }).lines.join("|").startsWith("Claude and GPT models:"), true);
  t.check("anti: gpt-oss thuộc nhóm Claude/GPT", quotaVerdict(q, { model: "gpt-oss-120b-medium", now: NOW }).lines.length, 1);
  t.check("nhãn khớp theo ranh giới chữ: Gemini 4 Neon không khớp gemini-4-neonx-high", labelMatchesModel("Gemini 4 Neon", "gemini-4-neonx-high"), false);
}
t.check("giờ hồi trong ngày chỉ in giờ", formatReset(new Date(IN_3H * 1000), NOW), "06:30");
t.check("giờ hồi khác ngày in cả ngày", formatReset(new Date(IN_7D * 1000), NOW), "14/11 03:30");

// --- cờ ----------------------------------------------------------------------

t.check("--quota-check off bị bỏ khỏi argv", takeQuotaFlag(["--a", "1", "--quota-check", "off", "--b"]).argv.join(" "), "--a 1 --b");
{
  let threw = false;
  try { takeQuotaFlag(["--quota-check", "maybe"]); } catch { threw = true; }
  t.check("--quota-check giá trị lạ bị từ chối", threw, true);
}

// --- cổng qua crew run thật --------------------------------------------------

const RUN_REL = "tasks/t/reports/crew-test";
function setup(name, worker = "codex") {
  const ws = tmpWorkspace(`quota-${name}-`);
  const runDir = join(ws, ...RUN_REL.split("/"));
  const { manifestPath } = createRun({ runDir, runId: name, task: "t", workspace: ws, depth: 0 });
  const short = worker === "codex" ? "codex" : "anti";
  addJob(manifestPath, {
    worker, role: "owner", title: "việc", evidence: `${RUN_REL}/worker-${short}-1.md`,
    ...(worker === "antigravity" ? { model: "gemini-3.8-flash-medium" } : {}),
  });
  const brief = writeFile(join(runDir, `brief-${short}-1.md`), "làm việc\n");
  return { ws, manifestPath, brief, evidence: join(ws, ...`${RUN_REL}/worker-${short}-1.md`.split("/")) };
}
function crewRun(s, worker, { extra = [], env = {} } = {}) {
  const p = spawnSync(process.execPath, [CREW, "run", worker, "--manifest", s.manifestPath, "--job", "1", "--prompt-file", s.brief, "--timeout", "60s", ...extra], {
    cwd: s.ws, encoding: "utf8", timeout: 90_000,
    env: { ...process.env, CREW_QUOTA_CHECK: "", PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: "ok", FAKE_EVIDENCE: s.evidence, ...env },
  });
  return { exit: p.status, err: p.stderr ?? "" };
}
const status = (s) => readManifest(s.manifestPath).jobs[0].status;
const EMPTY_CODEX = JSON.stringify(codexResult(codexLimits(100, 10, {}, LIVE)));
const FULL_CODEX = JSON.stringify(codexResult(codexLimits(10, 10, {}, LIVE)));

{
  const s = setup("empty");
  const r = crewRun(s, "codex", { env: { FAKE_CODEX_QUOTA: EMPTY_CODEX } });
  t.check("codex cạn → crew run exit 5", r.exit, QUOTA_EXIT);
  t.check("...nói rõ chưa bắn", /CHƯA BẮN/.test(r.err), true);
  t.check("...job vẫn pending", status(s), "pending");
  t.check("...worker không chạy (không có evidence)", existsSync(s.evidence), false);
}
{
  const s = setup("off");
  const r = crewRun(s, "codex", { extra: ["--quota-check", "off"], env: { FAKE_CODEX_QUOTA: EMPTY_CODEX } });
  t.check("--quota-check off → bắn dù cạn, adapter nhận argv sạch", r.exit, 0);
  t.check("...job xong", status(s), "done");
}
{
  const s = setup("envoff");
  const r = crewRun(s, "codex", { env: { FAKE_CODEX_QUOTA: EMPTY_CODEX, CREW_QUOTA_CHECK: "off" } });
  t.check("CREW_QUOTA_CHECK=off → bắn", r.exit, 0);
}
{
  const s = setup("full");
  const r = crewRun(s, "codex", { env: { FAKE_CODEX_QUOTA: FULL_CODEX } });
  t.check("codex còn nhiều → bắn, không cảnh báo", r.exit === 0 && !/quota/.test(r.err), true);
}
{
  const s = setup("unreadable");
  const r = crewRun(s, "codex");
  t.check("không đọc được quota → vẫn bắn", r.exit, 0);
  t.check("...kèm cảnh báo", /không đọc được quota Codex/.test(r.err), true);
}
{
  const s = setup("badflag");
  const r = crewRun(s, "codex", { extra: ["--quota-check", "maybe"] });
  t.check("--quota-check lạ → exit 2, không bắn", r.exit === 2 && status(s) === "pending", true);
}
{
  const s = setup("anti-empty", "antigravity");
  const r = crewRun(s, "anti", { env: { FAKE_AGY_QUOTA: JSON.stringify(agyJson(0, 0.5, 1, 0.98, LIVE)) } });
  t.check("anti job Gemini, nhóm Gemini cạn → exit 5", r.exit, QUOTA_EXIT);
  t.check("...model lấy từ sổ", /Gemini Models/.test(r.err) && !/không rõ model/.test(r.err), true);
  t.check("...job vẫn pending", status(s), "pending");
}

// --- --chain: lát bị từ chối thì chuỗi dừng gọn ------------------------------

{
  const s = setup("chain");
  const fake = mkdtempSync(join(tmpdir(), "quota-chain-fake-"));
  writeFileSync(join(fake, "1.md"), "xong\n\nStatus: DONE\nSummary: ok\n");
  const p = spawnSync(process.execPath, [CREW, "run", "codex", "--manifest", s.manifestPath, "--job", "1", "--prompt-file", s.brief, "--chain", "--timeout", "1m"], {
    cwd: s.ws, encoding: "utf8", timeout: 90_000,
    env: { ...process.env, CREW_QUOTA_CHECK: "", PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: "chain", FAKE_CHAIN_DIR: fake, FAKE_CODEX_QUOTA: EMPTY_CODEX },
  });
  t.check("--chain: lát đầu bị từ chối → exit 5", p.status, QUOTA_EXIT);
  const root = readManifest(s.manifestPath).jobs[0];
  t.check("...sổ ghi lý do dừng là quota", /cạn quota/.test(root.chainStoppedFor ?? ""), true);
  t.check("...job gốc vẫn pending để gọi lại", root.status, "pending");
}

process.exit(t.finish() ? 0 : 1);
