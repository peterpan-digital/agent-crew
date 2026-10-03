#!/usr/bin/env node
/**
 * Hàng chờ quyết định (`holds[]`) và dấu nghiệm thu (`lastCollect`, `reports[]`).
 *
 * Fixture dựng theo ĐÚNG hình dạng run thật crew-260918-1136: bốn job, job 1/2
 * BLOCKED vì COST_GATE, job 3/4 là lượt resume làm xong việc đó và trùng
 * `conversationId` với job gốc nhưng KHÔNG có `resumedFrom`. Run thật không
 * được đụng ở đây; mọi ca chạy trên workspace tạm.
 *
 * Run: node mwg-agent-crew/tests/holds.test.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRun, addJob, updateJob, readManifest, claimRunSlot, holdsTamperPatch, MANIFEST_VERSION } from "../scripts/crew-manifest.mjs";
import { collectRun } from "../scripts/crew-collect.mjs";
import { extractCostGateApi, holdsFingerprint } from "../scripts/lib/holds.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("holds");
const TASK = "t";
const RUN_REL = join("tasks", TASK, "reports", "crew-test");
const COLLECT = join(MODULE_ROOT, "scripts", "crew-collect.mjs");
const HOLD = join(MODULE_ROOT, "scripts", "crew-hold.mjs");

const DONE = "work\n\nStatus: DONE\nSummary: ok\n";
const gated = (api) => `dừng\n\nStatus: BLOCKED\nConcerns/Blockers: COST_GATE — ${api}\n`;

function cli(script, manifestPath, args = [], { env = {}, cwd } = {}) {
  const base = { ...process.env };
  delete base.MWG_CREW_ROLE;
  const p = spawnSync("node", [script, manifestPath, ...args], { encoding: "utf8", env: { ...base, ...env }, cwd });
  return { exit: p.status, out: p.stdout ?? "", err: p.stderr ?? "" };
}
const collect = (m, args = [], opts) => cli(COLLECT, m, args, opts);
const hold = (m, args = [], opts) => cli(HOLD, m, args, opts);
const holdsOf = (m) => readManifest(m).holds ?? [];

/**
 * jobs: [{ worker, status, conversationId, body, patch, notes }]. Giờ chạy lùi về
 * quá khứ để mọi job đã "xong" thật và nằm trọn trước lúc collect.
 */
function newRun(jobs, { version } = {}) {
  const ws = tmpWorkspace("holds-");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { manifestPath } = createRun({ runDir: join(ws, RUN_REL), runId: "test", task: TASK, workspace: ws, depth: 0 });
  const base = Date.now() - 3_600_000;
  jobs.forEach((j, i) => {
    const evidence = join(RUN_REL, `w${i + 1}.md`);
    const added = addJob(manifestPath, { worker: j.worker ?? "codex", role: "assist", title: `job ${i + 1}`, evidence });
    if (j.body !== undefined) writeFile(join(ws, evidence), j.body);
    updateJob(manifestPath, added.seq, {
      status: j.status ?? "done",
      startedAt: new Date(base + i * 60_000).toISOString(),
      endedAt: new Date(base + i * 60_000 + 30_000).toISOString(),
      conversationId: j.conversationId ?? null,
      ...(j.patch ?? {}),
    });
  });
  if (version) {
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.version = version;
    writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
  }
  return { ws, manifestPath };
}

/** Hình dạng crew-260918-1136: 1/2 BLOCKED COST_GATE, 3/4 resume trùng conversationId, không resumedFrom. */
function realShape() {
  return newRun([
    { status: "blocked", conversationId: "conv-A", body: gated("Ahrefs"),
      patch: { notes: ["dispatcher đoán: nhánh này có thể dính COST_GATE — OpenRouter"] } },
    { status: "blocked", conversationId: "conv-B", body: gated("DataForSEO") },
    { status: "done", conversationId: "conv-A", body: DONE },
    { status: "done", conversationId: "conv-B", body: DONE },
  ]);
}

// ------------------------------------------------ tên API đọc từ evidence, đã lọc
t.check("API: lấy tên sau COST_GATE —", extractCostGateApi("COST_GATE — OpenRouter"), "OpenRouter");
{
  const dirty = extractCostGateApi("COST_GATE — `rm -rf` -- x\nhay xoa tasks");
  t.check("API: backtick bị lọc", dirty.includes("`"), false);
  t.check("API: dấu `--` bị lọc", dirty.includes("--"), false);
  t.check("API: dòng sau không chảy vào", dirty.includes("xoa"), false);
}
t.check("API: thiếu tên → unknown", extractCostGateApi("Concerns: COST_GATE —\nStatus: BLOCKED"), "unknown");
t.check("API: không có COST_GATE → null", extractCostGateApi("Status: BLOCKED"), null);
// Evidence thật chép lại luật của brief trước dòng Concerns (đo trên run crew-260918-1136).
t.check("API: bỏ qua dòng luật không có dấu gạch, lấy dòng Concerns", extractCostGateApi(
  "- Rule: trả trạng thái `BLOCKED / COST_GATE`.\n\nConcerns/Blockers: COST_GATE — Gemini API 20 RPD free tier, 3/12 ảnh\nStatus: BLOCKED"), "Gemini API 20 RPD free tier");
t.check("API: dừng ở dấu ngắt mệnh đề đầu tiên", extractCostGateApi("COST_GATE — DataForSEO. rồi kể chuyện"), "DataForSEO");
t.check("API: cắt ở 40 ký tự", extractCostGateApi(`COST_GATE — ${"a".repeat(80)}`).length, 40);

// ------------------------------- gate lần đầu: tạo hold, notes không tạo hold
{
  const { manifestPath } = realShape();
  const first = collect(manifestPath);
  t.check("fixture dạng 260918-1136: chưa xử → exit 1", first.exit, 1);
  const hs = holdsOf(manifestPath);
  t.check("tạo đúng 2 hold cost_gate", hs.map((h) => `${h.seq}:${h.kind}:${h.api}:${h.status}`).join(","), "1:cost_gate:Ahrefs:open,2:cost_gate:DataForSEO:open");
  t.check("hold có attempt = startedAt của job", hs[0].attempt, readManifest(manifestPath).jobs[0].startedAt);
  t.check("question theo mẫu cố định", hs[0].question, "Job 1 chờ duyệt chi phí Ahrefs");
  t.check("createdBy = collect", hs[0].createdBy, "collect");
  t.check("câu dự đoán trong notes không thành hold OpenRouter", hs.some((h) => h.api === "OpenRouter"), false);
  t.check("version không bị đổi", readManifest(manifestPath).version, MANIFEST_VERSION);
  t.check("collect lần hai không đẻ thêm hold", (collect(manifestPath), holdsOf(manifestPath).length), 2);
}

// ----------------- notes có COST_GATE nhưng evidence thì không → không hold
{
  const { manifestPath } = newRun([
    { status: "blocked", body: "dừng\n\nStatus: BLOCKED\nConcerns/Blockers: cần người đọc\n",
      patch: { notes: ["COST_GATE — Ahrefs (dispatcher đoán)"] } },
  ]);
  const r = collect(manifestPath);
  t.check("notes một mình không tạo hold", holdsOf(manifestPath).length, 0);
  t.check("...job vẫn BLOCKED, exit 1", r.exit, 1);
}

// ------------------------------------------- answer resume + cover → exit 0
{
  const { manifestPath } = realShape();
  collect(manifestPath);
  t.check("answer cần --words", hold(manifestPath, ["answer", "h1", "--outcome", "resume"]).exit, 2);
  t.check("answer cần --outcome hợp lệ", hold(manifestPath, ["answer", "h1", "--words", "ok", "--outcome", "xong"]).exit, 2);
  t.check("answer h1 resume", hold(manifestPath, ["answer", "h1", "--words", "chạy tiếp Ahrefs", "--outcome", "resume"]).exit, 0);
  t.check("answered resume mà chưa cover → vẫn BLOCKED, exit 1", collect(manifestPath).exit, 1);
  t.check("cover h1 bằng job 3 (cùng conversationId)", hold(manifestPath, ["cover", "h1", "--by", "3"]).exit, 0);
  t.check("cover h2 bằng job 3 (khác conversationId) bị từ chối", (hold(manifestPath, ["answer", "h2", "--words", "ok", "--outcome", "resume"]), hold(manifestPath, ["cover", "h2", "--by", "3"]).exit), 2);
  t.check("cover h2 bằng job 4", hold(manifestPath, ["cover", "h2", "--by", "4"]).exit, 0);
  const done = collect(manifestPath);
  t.check("answer + cover đủ → exit 0", done.exit, 0);
  t.check("...verdict COVERED", /COVERED/.test(done.out), true);
  t.check("...hold ghi nguyên văn lời owner", holdsOf(manifestPath)[0].answer.words, "chạy tiếp Ahrefs");
  t.check("...hold ghi job cover", holdsOf(manifestPath)[0].coveredBy, 3);

  // PASS của job cover tính lại mỗi lần collect, không chốt lúc cover.
  const m = readManifest(manifestPath);
  writeFileSync(join(m.workspace, m.jobs[2].evidence), "hỏng\n\nStatus: FAILED\n");
  const after = collect(manifestPath);
  t.check("job cover rớt sau đó → gate đỏ lại", after.exit, 1);
}

// ------------------------------------------------------- cover: các điều kiện
{
  const { manifestPath } = newRun([
    { status: "blocked", worker: "codex", conversationId: "conv-A", body: gated("Ahrefs") },
    { status: "done", worker: "antigravity", conversationId: "conv-A", body: DONE },       // khác worker
    { status: "done", worker: "codex", conversationId: "conv-Z", body: DONE },               // khác conversationId
    { status: "done", worker: "codex", conversationId: "conv-A", body: DONE, patch: { resumeMismatch: true } },
    { status: "done", worker: "codex", conversationId: "conv-A", body: DONE },
  ]);
  collect(manifestPath);
  hold(manifestPath, ["answer", "h1", "--words", "ok", "--outcome", "resume"]);
  t.check("cover khác worker bị từ chối", hold(manifestPath, ["cover", "h1", "--by", "2"]).exit, 2);
  t.check("cover khác conversationId bị từ chối", hold(manifestPath, ["cover", "h1", "--by", "3"]).exit, 2);
  t.check("cover có resumeMismatch bị từ chối", hold(manifestPath, ["cover", "h1", "--by", "4"]).exit, 2);
  t.check("cover bằng chính job gốc bị từ chối (seq phải lớn hơn)", hold(manifestPath, ["cover", "h1", "--by", "1"]).exit, 2);
  t.check("cover hợp lệ được nhận", hold(manifestPath, ["cover", "h1", "--by", "5"]).exit, 0);
}
{
  // `resumedFrom` trùng cũng nối được khi adapter ghi.
  const { manifestPath } = newRun([
    { status: "blocked", conversationId: "conv-A", body: gated("Ahrefs") },
    { status: "done", conversationId: "conv-A2", body: DONE, patch: { resumedFrom: "conv-A" } },
  ]);
  collect(manifestPath);
  hold(manifestPath, ["answer", "h1", "--words", "ok", "--outcome", "resume"]);
  t.check("cover nối bằng resumedFrom", hold(manifestPath, ["cover", "h1", "--by", "2"]).exit, 0);
  t.check("...gate exit 0", collect(manifestPath).exit, 0);
}

// ---------------------------------------------------------- answer drop → WAIVED
{
  const { manifestPath } = realShape();
  collect(manifestPath);
  hold(manifestPath, ["answer", "h1", "--words", "bỏ Ahrefs", "--outcome", "drop"]);
  hold(manifestPath, ["answer", "h2", "--words", "bỏ DataForSEO", "--outcome", "drop"]);
  const r = collect(manifestPath);
  t.check("drop cả hai → exit 0", r.exit, 0);
  t.check("...verdict WAIVED kèm lời owner", /WAIVED/.test(r.out) && r.out.includes("bỏ Ahrefs"), true);
}

// --------------------------------------------- DEFERRED vẫn chặn, --report bị từ chối
{
  const { manifestPath } = realShape();
  collect(manifestPath);
  const day = (n) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("sv-SE");
  t.check("defer h1", hold(manifestPath, ["defer", "h1", "--until", day(3), "--words", "tuần sau"]).exit, 0);
  hold(manifestPath, ["answer", "h2", "--words", "bỏ", "--outcome", "drop"]);
  const r = collect(manifestPath);
  t.check("DEFERRED vẫn chặn: exit 1", r.exit, 1);
  t.check("...verdict DEFERRED", /DEFERRED/.test(r.out), true);
  const rep = collect(manifestPath, ["--report", join("tasks", TASK, "reports", "261003-0000-nghiem-thu.md")]);
  t.check("--report bị từ chối khi còn DEFERRED", rep.exit, 2);
  const m = readManifest(manifestPath);
  t.check("...lastCollect ghi exit thật (2)", m.lastCollect?.exitCode, 2);
  t.check("...reports[] không có gì", (m.reports ?? []).length, 0);
  t.check("defer quá 14 ngày bị từ chối", hold(manifestPath, ["defer", "h1", "--until", day(20), "--words", "x"]).exit, 2);
  t.check("defer ngày quá khứ bị từ chối", hold(manifestPath, ["defer", "h1", "--until", "2020-01-01", "--words", "x"]).exit, 2);
  t.check("defer sai định dạng ngày bị từ chối", hold(manifestPath, ["defer", "h1", "--until", "03/10/2026", "--words", "x"]).exit, 2);
  t.check("hold đã answered không defer được", hold(manifestPath, ["defer", "h2", "--until", day(2), "--words", "x"]).exit, 2);
}

// ------------------------------- retry cùng seq sang API khác → hold cũ superseded
{
  const { ws, manifestPath } = realShape();
  collect(manifestPath);
  hold(manifestPath, ["answer", "h2", "--words", "bỏ", "--outcome", "drop"]);
  const oldAttempt = readManifest(manifestPath).jobs[0].startedAt;
  const retryAt = new Date().toISOString();
  claimRunSlot(manifestPath, 1, { startedAt: retryAt, timeoutMs: 600_000 });
  t.check("claim lại seq: hold cũ thành superseded", holdsOf(manifestPath)[0].status, "superseded");
  t.check("...hold của seq khác không động tới", holdsOf(manifestPath)[1].status, "answered");
  t.check("job đang chạy lại: hold CLI từ chối (còn job running)", hold(manifestPath, ["answer", "h2", "--words", "x", "--outcome", "drop"]).exit, 2);
  const live = collect(manifestPath);
  t.check("còn job chạy → collect hoãn tạo hold", live.out.includes("sẽ tạo khi run hết job chạy"), true);
  // Lượt retry dừng ở API khác.
  writeFile(join(ws, readManifest(manifestPath).jobs[0].evidence), gated("OpenRouter"));
  updateJob(manifestPath, 1, { status: "blocked", endedAt: new Date().toISOString() });
  const r = collect(manifestPath);
  const hs = holdsOf(manifestPath);
  t.check("hold mới cho API mới, open", `${hs[2]?.api}:${hs[2]?.status}:${hs[2]?.attempt === retryAt}`, "OpenRouter:open:true");
  t.check("...hold cũ vẫn superseded", hs[0].status, "superseded");
  t.check("...exit 1", r.exit, 1);
  t.check("attempt cũ khác attempt mới", oldAttempt === retryAt, false);
}

// --------------------------------------- worker không đổi được holds
{
  const { manifestPath } = realShape();
  collect(manifestPath);
  const r = hold(manifestPath, ["answer", "h1", "--words", "x", "--outcome", "drop"], { env: { MWG_CREW_ROLE: "worker" } });
  t.check("MWG_CREW_ROLE=worker → crew-hold từ chối", r.exit, 2);
  t.check("...và holds không đổi", holdsOf(manifestPath)[0].status, "open");
  t.check("list cũng bị từ chối dưới vai worker", hold(manifestPath, ["list"], { env: { MWG_CREW_ROLE: "worker" } }).exit, 2);
}
{
  // Vân tay lúc claim, so lại lúc thoát: sửa holds giữa job → holdsTamper → exit 2.
  const { ws, manifestPath } = newRun([{ status: "pending", body: undefined }]);
  updateJob(manifestPath, 1, { status: "pending", startedAt: null, endedAt: null });
  claimRunSlot(manifestPath, 1, { startedAt: new Date().toISOString(), timeoutMs: 600_000 });
  t.check("claim ghi vân tay holds", readManifest(manifestPath).jobs[0].holdsFingerprint, holdsFingerprint([]));
  t.check("chưa ai sửa → không có holdsTamper", Object.keys(holdsTamperPatch(manifestPath, 1)).length, 0);

  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.holds = [{ id: "h1", seq: 1, attempt: m.jobs[0].startedAt, kind: "cost_gate", api: "Ahrefs", question: "x", options: [],
    status: "answered", createdAt: "x", createdBy: "collect", answer: { words: "worker tự trả lời", outcome: "drop", via: "chat", at: "x" } }];
  writeFileSync(manifestPath, JSON.stringify(m));
  const patch = holdsTamperPatch(manifestPath, 1);
  t.check("sửa holds giữa job → holdsTamper", Boolean(patch.holdsTamper), true);
  writeFile(join(ws, m.jobs[0].evidence), DONE);
  updateJob(manifestPath, 1, { status: "done", endedAt: new Date().toISOString(), ...patch });
  t.check("collect coi holdsTamper là vi phạm: exit 2", collect(manifestPath).exit, 2);
  t.check("...và nói rõ", /HOLDS BỊ SỬA/.test(collect(manifestPath).out), true);
}
{
  // Claim hợp lệ của job khác (supersede) không được làm job đang chạy bị tính tamper,
  // nhưng một sửa đổi đã có từ trước thì vẫn bị bắt.
  const { manifestPath } = realShape();
  collect(manifestPath);
  updateJob(manifestPath, 3, { status: "pending", startedAt: null, endedAt: null });
  claimRunSlot(manifestPath, 3, { startedAt: new Date().toISOString(), timeoutMs: 600_000 });
  claimRunSlot(manifestPath, 1, { startedAt: new Date(Date.now() + 1000).toISOString(), timeoutMs: 600_000 });
  t.check("supersede hợp lệ không gây holdsTamper cho job đang chạy", Object.keys(holdsTamperPatch(manifestPath, 3)).length, 0);
}
{
  const { manifestPath } = realShape();
  collect(manifestPath);
  updateJob(manifestPath, 3, { status: "pending", startedAt: null, endedAt: null });
  claimRunSlot(manifestPath, 3, { startedAt: new Date().toISOString(), timeoutMs: 600_000 });
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.holds[1].status = "answered";                               // worker tự trả lời h2
  writeFileSync(manifestPath, JSON.stringify(m));
  claimRunSlot(manifestPath, 1, { startedAt: new Date(Date.now() + 1000).toISOString(), timeoutMs: 600_000 });
  t.check("sửa trước một claim hợp lệ vẫn bị bắt", Boolean(holdsTamperPatch(manifestPath, 3).holdsTamper), true);
}

// -------------------------------- quyết định (decision): chỉ do dispatcher thêm
{
  const { manifestPath } = realShape();
  collect(manifestPath);
  hold(manifestPath, ["answer", "h1", "--words", "bỏ", "--outcome", "drop"]);
  hold(manifestPath, ["answer", "h2", "--words", "bỏ", "--outcome", "drop"]);
  const long = "x".repeat(301);
  t.check("add: question quá 300 ký tự bị từ chối", hold(manifestPath, ["add", "--seq", "3", "--question", long]).exit, 2);
  t.check("add: quá 5 option bị từ chối", hold(manifestPath, ["add", "--seq", "3", "--question", "q", ...["a", "b", "c", "d", "e", "f"].flatMap((o) => ["--option", o])]).exit, 2);
  t.check("add: thiếu --seq bị từ chối", hold(manifestPath, ["add", "--question", "q"]).exit, 2);
  t.check("add: seq không tồn tại bị từ chối", hold(manifestPath, ["add", "--seq", "9", "--question", "q"]).exit, 2);
  t.check("add decision", hold(manifestPath, ["add", "--seq", "3", "--question", "Giữ bản nào?", "--option", "A", "--option", "B"]).exit, 0);
  const h = holdsOf(manifestPath).at(-1);
  t.check("...kind decision, createdBy dispatcher", `${h.kind}:${h.createdBy}:${h.status}:${h.options.join("|")}`, "decision:dispatcher:open:A|B");
  const r = collect(manifestPath);
  t.check("decision không bao giờ đổi verdict: exit 0", r.exit, 0);
  t.check("...nhưng hiện ở mục QUYẾT ĐỊNH ĐANG CHỜ", /QUYẾT ĐỊNH ĐANG CHỜ/.test(r.out) && r.out.includes("Giữ bản nào?"), true);
  t.check("unknown subcommand bị từ chối", hold(manifestPath, ["xoa", "h1"]).exit, 2);
  t.check("list chạy được", hold(manifestPath, ["list"]).out.includes("h3"), true);
}

// --------------------------------------------- dấu nghiệm thu, --dry-run, version
{
  const { ws, manifestPath } = newRun([{ status: "done", conversationId: "c", body: DONE }]);
  const before = readFileSync(manifestPath, "utf8");
  const dry = collect(manifestPath, ["--dry-run"]);
  t.check("--dry-run exit 0", dry.exit, 0);
  t.check("--dry-run không ghi gì vào manifest", readFileSync(manifestPath, "utf8"), before);

  const rel = join("tasks", TASK, "reports", "261003-0000-nghiem-thu.md");
  const ok = collect(manifestPath, ["--report", rel]);
  t.check("collect sạch + --report exit 0", ok.exit, 0);
  const m = readManifest(manifestPath);
  t.check("lastCollect ghi exit 0", `${m.lastCollect?.exitCode}:${Boolean(m.lastCollect?.at)}`, "0:true");
  t.check("reports[] ghi đường dẫn", m.reports?.[0]?.path, rel);
  t.check("file report có thật", existsSync(join(ws, rel)), true);
  t.check("report có mục Câu hỏi treo", /## Câu hỏi treo/.test(readFileSync(join(ws, rel), "utf8")), true);
}
for (const v of [1, 2, 3]) {
  const { manifestPath } = newRun([{ status: "blocked", conversationId: "c", body: gated("Ahrefs") }], { version: v });
  collect(manifestPath);
  t.check(`manifest v${v} giữ nguyên version sau khi có hold`, readManifest(manifestPath).version, v);
  t.check(`...và vẫn tạo được hold`, holdsOf(manifestPath).length, 1);
}
t.check("MANIFEST_VERSION không nâng", MANIFEST_VERSION, 3);

// ----------------------------- reader cũ: field lạ không làm manifest hỏng
{
  const { manifestPath } = realShape();
  collect(manifestPath);
  const r = collectRun(manifestPath, { dryRun: true });
  t.check("collectRun --dry-run cũng đọc được manifest có holds", r.rows.length, 4);
}

// ------------- adapter thật: worker sửa holds giữa job → holdsTamper, gate exit 2
{
  const { ws, manifestPath } = newRun([{ status: "pending", body: undefined }]);
  updateJob(manifestPath, 1, { status: "pending", startedAt: null, endedAt: null });
  const brief = writeFile(join(ws, "brief.md"), "do the thing\n");
  const evidence = readManifest(manifestPath).jobs[0].evidence;
  const run = (mode) => spawnSync("node", [
    join(MODULE_ROOT, "scripts", "codex-run.mjs"), "--prompt-file", brief, "--evidence", evidence,
    "--workspace", ws, "--timeout", "60s", "--manifest", manifestPath, "--job", "1",
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: mode,
      FAKE_EVIDENCE: join(ws, evidence), FAKE_MANIFEST: manifestPath },
  });
  const r = run("holds_tamper");
  const job = readManifest(manifestPath).jobs[0];
  t.check("codex-run: job vẫn kết thúc bình thường", `${r.status}:${job.status}`, "0:done");
  t.check("codex-run: ghi vân tay holds lúc claim", typeof job.holdsFingerprint, "string");
  t.check("codex-run: thấy holds bị sửa → holdsTamper", Boolean(job.holdsTamper), true);
  t.check("codex-run: gate đỏ exit 2 dù evidence PASS", collect(manifestPath).exit, 2);
}
{
  const { ws, manifestPath } = newRun([{ status: "pending", body: undefined }]);
  updateJob(manifestPath, 1, { status: "pending", startedAt: null, endedAt: null });
  const brief = writeFile(join(ws, "brief.md"), "do the thing\n");
  const evidence = readManifest(manifestPath).jobs[0].evidence;
  spawnSync("node", [
    join(MODULE_ROOT, "scripts", "codex-run.mjs"), "--prompt-file", brief, "--evidence", evidence,
    "--workspace", ws, "--timeout", "60s", "--manifest", manifestPath, "--job", "1",
  ], { encoding: "utf8", env: { ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, FAKE_MODE: "ok", FAKE_EVIDENCE: join(ws, evidence) } });
  t.check("codex-run: job sạch không có holdsTamper", readManifest(manifestPath).jobs[0].holdsTamper, undefined);
}

process.exit(t.finish() ? 0 : 1);
