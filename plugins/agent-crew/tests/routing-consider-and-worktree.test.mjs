#!/usr/bin/env node
/**
 * Repo `delegate: "aggressive"`: gate cân nhắc ở MỌI prompt (không chỉ khi khớp
 * từ khoá), Claude phải ghi dòng `Định tuyến:`, hook Stop đọc dòng đó ghi log;
 * session con chạy trong git worktree vẫn theo config của repo chính.
 *
 * Run: node plugins/agent-crew/tests/routing-consider-and-worktree.test.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "../scripts/lib/routing-gate.mjs";
import { routesOf } from "../scripts/lib/routing-decision-log.mjs";
import { MODULE_ROOT, makeChecker } from "./helpers.mjs";

const t = makeChecker("routing-consider-and-worktree");
const CREW = join(MODULE_ROOT, "bin", "crew.mjs");

function repo(prefix, config) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const git = (...a) => execFileSync("git", a, { cwd: ws, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  if (config) writeFileSync(join(ws, "crew.config.json"), JSON.stringify(config));
  return ws;
}
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ["CLAUDE_PROJECT_DIR", "CREW_ROLE", "MWG_CREW_ROLE", "CREW_GATE_LOG"]) delete env[k];
  return { ...env, ...extra };
}
const hook = (event, ws, payload) => spawnSync(process.execPath, [CREW, "hook", event], {
  cwd: ws, encoding: "utf8", input: JSON.stringify({ cwd: ws, ...payload }), env: cleanEnv(),
});
const prompt = (ws, text, sid = "s1") => hook("prompt", ws, { hook_event_name: "UserPromptSubmit", prompt: text, session_id: sid });
const logOf = (ws) => {
  const p = join(ws, ".crew", "logs", "routing-gate.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

// --- phân loại -----------------------------------------------------------------
{
  const agg = { delegate: "aggressive", routingTriggers: [] };
  t.check("aggressive: việc không khớp từ khoá → consider", classify("làm cái dashboard doanh thu cho team sale", agg).branch, "consider");
  t.check("aggressive: câu ngắn kiểu xác nhận → im", classify("ok merge luôn đi", agg).branch, "none");
  t.check("aggressive: lệnh slash → im", classify("/graphify thư mục docs giúp tao nhé", agg).branch, "none");
  t.check("repo default: việc không khớp vẫn im như cũ", classify("làm cái dashboard doanh thu cho team sale", {}).branch, "none");
}

// --- lời gate --------------------------------------------------------------------
const AGG = repo("consider-", { delegate: "aggressive" });
{
  const out = prompt(AGG, "làm cái dashboard doanh thu cho team sale").stdout;
  t.check("gate chèn bước cân nhắc", /tách việc thành các phần/.test(out), true);
  t.check("...bắt ghi dòng Định tuyến", /`Định tuyến: Codex: <phần> · Anti: <phần> · tự làm: <phần>/.test(out), true);
  t.check("...có tuyến session con", /session con/.test(out), true);
  t.check("...không in tên script hay lệnh dispatch", /\.mjs|crew run|codex-run|anti-run/.test(out), false);
  t.check("câu xác nhận ngắn → im", prompt(AGG, "làm hết luôn").stdout.trim(), "");
}

// --- tuyến từ dòng quyết định ---------------------------------------------------------
t.check("giao Codex → codex", routesOf("giao Codex — viết script lớn").join(), "codex");
t.check("giao một phần + tự làm → vẫn là giao", routesOf("giao Codex phần parser, tự làm phần doc").join(), "codex");
t.check("giao Anti", routesOf("giao Anti — research 5 thư viện").join(), "anti");
t.check("chia session con", routesOf("chia session con — migration riêng một PR").join(), "session");
t.check("tự làm", routesOf("tự làm — 2 file, việc nhỏ").join(), "self");
t.check("không có dòng → missing", routesOf(null).join(), "missing");

// --- log: gate + quyết định của lượt -----------------------------------------------------
{
  const transcript = join(AGG, "transcript.jsonl");
  const write = (assistantText) => writeFileSync(transcript, [
    { type: "user", message: { content: "câu cũ" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Định tuyến: giao Anti — lượt CŨ" }] } },
    { type: "user", message: { content: "làm cái dashboard BÍ_MẬT cho team sale" } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }, { type: "tool_use", name: "Edit" }, { type: "tool_use", name: "Bash" }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "Định tuyến: giao Anti — trong file" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: assistantText }] } },
  ].map((e) => JSON.stringify(e)).join("\n"));

  prompt(AGG, "làm cái dashboard BÍ_MẬT cho team sale", "sess-a");
  write("Định tuyến: **giao Codex** — dashboard nhiều file\n\nĐang giao…");
  hook("stop", AGG, { session_id: "sess-a", transcript_path: transcript });
  const [gate, turn] = logOf(AGG).slice(-2);
  t.check("log aggressive mặc định ở .crew/logs (không khai routingLog)", gate?.decision, "consider");
  t.check("Stop ghi tuyến của lượt vừa xong", `${turn?.decision}/${turn?.gate}/${turn?.routes}`, "turn/consider/codex");
  t.check("log không chứa nội dung prompt", JSON.stringify(logOf(AGG)).includes("BÍ_MẬT"), false);
  t.check("dấu chờ đã xoá sau Stop", existsSync(join(AGG, ".crew", "logs", ".gate-pending-sess-a")), false);

  const before = logOf(AGG).length;
  hook("stop", AGG, { session_id: "sess-a", transcript_path: transcript });
  t.check("Stop lần nữa không có gate bắn → không ghi thêm", logOf(AGG).length, before);

  prompt(AGG, "làm cái dashboard doanh thu cho team sale", "sess-b");
  write("Xong rồi, đây là dashboard.");
  hook("stop", AGG, { session_id: "sess-b", transcript_path: transcript });
  t.check("Claude quên ghi dòng → missing (không lấy dòng của lượt cũ / tool result)", logOf(AGG).at(-1).routes.join(), "missing");

  prompt(AGG, "giải thích giúp tao cái gate này chạy sao nhé", "sess-q");
  writeFileSync(transcript, [
    { type: "user", message: { content: "giải thích giúp tao cái gate này chạy sao nhé" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Gate chạy thế này…" }] } },
  ].map((e) => JSON.stringify(e)).join("\n"));
  hook("stop", AGG, { session_id: "sess-q", transcript_path: transcript });
  t.check("câu hỏi (không gọi tool, không có dòng) → no-task, không tính là quên", `${logOf(AGG).at(-1).routes.join()}/${logOf(AGG).at(-1).toolCalls}`, "no-task/0");

  const quiet = logOf(AGG).length;
  prompt(AGG, "ok merge luôn", "sess-c");
  hook("stop", AGG, { session_id: "sess-c", transcript_path: transcript });
  t.check("lượt gate im → Stop không ghi", logOf(AGG).length, quiet);
  t.check("session id lạ không đẻ file ngoài thư mục log", hook("stop", AGG, { session_id: "../../x", transcript_path: transcript }).status, 0);
}

// --- session con trong git worktree ---------------------------------------------------
{
  const main = repo("wt-main-", { delegate: "aggressive" }); // config chưa commit, như sau `crew init`
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "wt-child-")));
  execFileSync("git", ["worktree", "add", "-q", "--detach", wt], { cwd: main, stdio: "ignore" });
  t.check("worktree không có config (chưa commit)", existsSync(join(wt, "crew.config.json")), false);
  const out = prompt(wt, "làm cái dashboard doanh thu cho team sale", "child-1").stdout;
  t.check("session con trong worktree vẫn được cân nhắc theo config repo chính", /tách việc thành các phần/.test(out), true);
  t.check("...log về repo chính", logOf(main).length, 1);
  const own = repo("wt-plain-");
  t.check("repo thường (không worktree, không config) vẫn im", prompt(own, "làm cái dashboard doanh thu cho team sale").stdout.trim(), "");
  const ownWt = realpathSync(mkdtempSync(join(tmpdir(), "wt-plain-child-")));
  execFileSync("git", ["worktree", "add", "-q", "--detach", ownWt], { cwd: own, stdio: "ignore" });
  t.check("worktree của repo chưa bật crew vẫn im", prompt(ownWt, "làm cái dashboard doanh thu cho team sale").stdout.trim(), "");
}

process.exit(t.finish() ? 0 : 1);
