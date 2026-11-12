#!/usr/bin/env node
/**
 * Repo aggressive (10/11):
 * - gate bắt tách việc thành phần, hỏi phần nào giao được — không chọn một tuyến cho cả việc;
 * - tin app tự chèn (task-notification, khối nhắc trơn) không làm gate bắn; tin session
 *   khác vẫn được cân nhắc nhưng không bắt dòng quyết định;
 * - log quyết định không coi tin tự chèn / bản tóm tắt sau nén là mốc đầu lượt;
 * - lượt tự làm phình ra (40 tool call hoặc 3 file) thì PostToolUse chèn lời nhắc.
 *
 * Run: node plugins/agent-crew/tests/turn-nudge-and-split-rule.test.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, promptKind } from "../scripts/lib/routing-gate.mjs";
import { lastTurnDecision, routesOf } from "../scripts/lib/routing-decision-log.mjs";
import { NUDGE_TOOL_CALLS, NUDGE_TOOL_CALLS_AGAIN, step } from "../scripts/lib/turn-nudge.mjs";
import { MODULE_ROOT, makeChecker } from "./helpers.mjs";

const t = makeChecker("turn-nudge-and-split-rule");
const CREW = join(MODULE_ROOT, "bin", "crew.mjs");
const HOOK_SH = join(MODULE_ROOT, "bin", "crew-hook.sh");
const TURN_DIR = realpathSync(mkdtempSync(join(tmpdir(), "turns-")));

// --- nguồn của prompt ---------------------------------------------------------------
const REMINDER = "<system-reminder>\nLinked sessions now: x (idle).\n</system-reminder>\n";
t.check("người gõ, kèm khối nhắc → user", promptKind(`${REMINDER}sửa cái dashboard doanh thu giúp tao`), "user");
t.check("session cha giao việc lúc mở session con → user", promptKind("Background (from the session that started this one): làm phase 2"), "user");
t.check("tin của session khác → peer", promptKind("Another Claude session sent a message: <cross-session-message from=\"x\">xong rồi</cross-session-message>"), "peer");
t.check("task-notification → injected", promptKind("<task-notification><task-id>a</task-id></task-notification>"), "injected");
t.check("khối nhắc trơn → injected", promptKind(`${REMINDER}`), "injected");
const agg = { delegate: "aggressive", routingTriggers: [] };
t.check("aggressive: tin tự chèn không làm gate bắn", classify("<task-notification>job done, output ở file x</task-notification>", agg).branch, "none");
t.check("aggressive: khối nhắc không tính vào độ dài prompt", classify(`${REMINDER}ok luôn`, agg).branch, "none");

// --- tuyến từ dòng quyết định -----------------------------------------------------------
t.check("lý do nhắc Codex không biến tự làm thành giao", routesOf("tự làm — chỉnh toạ độ, Codex đã timeout lần trước").join(), "self");
t.check("...kể cả lý do sau dấu chấm", routesOf("tự làm. Codex không dùng được ở đây (timeout)").join(), "self");
t.check("dạng tách phần: Codex + tự làm → codex", routesOf("Codex: script dựng ảnh · tự làm: chọn ý — cần nhìn ảnh").join(), "codex");
t.check("dạng tách phần: Codex + Anti", routesOf("Codex: parser · Anti: tra 3 thư viện · tự làm: duyệt — lý do").join(), "codex,anti");
t.check("tự làm hết", routesOf("tự làm hết — 2 file, việc nhỏ").join(), "self");
// Đo 11/11: dispatcher giao cho session đang chạy theo tên ("session kit …") bị log thành self.
t.check("dạng tách phần: session có tên + tự làm → session", routesOf("session kit sửa cổng mũi tên · session 365 dựng lại ảnh · tự làm: kiểm nguyên nhân. Lý do: mỗi việc có session riêng").join(), "session");
t.check("dạng tách phần: phiên <tên>: … → session", routesOf("phiên Bill: dựng lại · tự làm: duyệt — lý do").join(), "session");
t.check("giao … session template (không có dấu ·) → session", routesOf("tự quyết 3 câu kit hỏi, rồi giao kit và 4 session template dựng lại. Phần phán đoán do tao giữ").join(), "session");
t.check("tự làm nhắc tới session trong phần việc → vẫn self", routesOf("tự làm: kiểm session cũ — lý do").join(), "self");

// --- mốc đầu lượt trong transcript -------------------------------------------------------
{
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "turns-tr-")));
  const tr = join(ws, "t.jsonl");
  const u = (content, extra = {}) => ({ type: "user", message: { content }, ...extra });
  const a = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
  writeFileSync(tr, [
    u("làm cái dashboard"),
    a("Định tuyến: Codex: build script · tự làm: duyệt — nhiều file"),
    u("<task-notification><task-id>x</task-id></task-notification>"),
    a("Job xong."),
    u(`${REMINDER}`),
    u("This session is being continued from a previous conversation that ran out of context.", { isCompactSummary: true }),
    u("Another Claude session sent a message: hi", { isMeta: true }),
    u("[Request interrupted by user]"),
    a("Tiếp tục."),
  ].map((e) => JSON.stringify(e)).join("\n"));
  t.check("tin tự chèn / tóm tắt sau nén không cắt lượt: vẫn thấy dòng quyết định", lastTurnDecision(tr), "Codex: build script · tự làm: duyệt — nhiều file");
  writeFileSync(tr, [u("cũ"), a("Định tuyến: tự làm — lượt cũ"), u("Background (from the session that started this one): làm phase 2"), a("Bắt đầu.")].map((e) => JSON.stringify(e)).join("\n"));
  t.check("việc cha giao cho con là mốc mới: không lấy dòng lượt cũ", lastTurnDecision(tr), null);
}

// --- bộ đếm nhắc giữa lượt (thuần) --------------------------------------------------------
const fresh = () => ({ tools: 0, files: [], delegated: false, nudges: 0 });
{
  const s = fresh();
  let first = null;
  for (let i = 1; i <= NUDGE_TOOL_CALLS && !first; i += 1) first = step(s, { tool_name: "Read", tool_input: { file_path: "/a" } });
  t.check(`nhắc ở lượt gọi tool thứ ${NUDGE_TOOL_CALLS}`, s.tools, NUDGE_TOOL_CALLS);
  t.check("...lời nhắc nêu số tool call và cách ghi 'vẫn tự làm'", /đã 40 lượt gọi tool/.test(first) && /Định tuyến: vẫn tự làm/.test(first), true);
  let again = null;
  while (s.tools < NUDGE_TOOL_CALLS_AGAIN - 1) again = step(s, { tool_name: "Bash", tool_input: { command: "ls" } }) ?? again;
  t.check("không nhắc lại trước mốc thứ hai", again, null);
  t.check(`nhắc lần cuối ở ${NUDGE_TOOL_CALLS_AGAIN}`, /lần cuối/.test(step(s, { tool_name: "Bash", tool_input: { command: "ls" } }) ?? ""), true);
  for (let i = 0; i < 200; i += 1) again = step(s, { tool_name: "Bash", tool_input: { command: "ls" } }) ?? again;
  t.check("tối đa hai lần một lượt", s.nudges, 2);
}
{
  const s = fresh();
  const edit = (f) => step(s, { tool_name: "Edit", tool_input: { file_path: f } });
  edit("/a"); edit("/a"); edit("/b");
  t.check("sửa lại cùng file không tính thêm", s.files.length, 2);
  t.check("file thứ 3 → nhắc dù mới vài tool call", /sửa 3 file/.test(edit("/c") ?? ""), true);
}
{
  const s = fresh();
  for (let i = 0; i < 50; i += 1) step(s, { tool_name: "mcp__ccd_turn__update_plan" });
  t.check("công cụ ghi sổ không tính", s.tools, 0);
  step(s, { tool_name: "Bash", tool_input: { command: "crew run codex --manifest m.json --job 1 --prompt-file b.md" } });
  let n = null;
  for (let i = 0; i < 150; i += 1) n = step(s, { tool_name: "Edit", tool_input: { file_path: `/f${i}` } }) ?? n;
  t.check("đã giao Codex trong lượt → thôi nhắc", n, null);
  const s2 = fresh();
  step(s2, { tool_name: "mcp__ccd_session__start_session" });
  t.check("mở session con cũng tính là đã giao", s2.delegated, true);
}

// --- hook thật ------------------------------------------------------------------------
function repo(prefix, config) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "-q"], { cwd: ws });
  if (config) writeFileSync(join(ws, "crew.config.json"), JSON.stringify(config));
  return ws;
}
const env = () => {
  const e = { ...process.env, CREW_TURN_DIR: TURN_DIR };
  for (const k of ["CLAUDE_PROJECT_DIR", "CREW_ROLE", "MWG_CREW_ROLE", "CREW_GATE_LOG"]) delete e[k];
  return e;
};
const prompt = (ws, text, sid) => spawnSync(process.execPath, [CREW, "hook", "prompt"], {
  cwd: ws, encoding: "utf8", env: env(), input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: ws, prompt: text, session_id: sid }),
});
const tool = (sid, name, input) => spawnSync("sh", [HOOK_SH, "tool"], {
  encoding: "utf8", env: env(), input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: sid, tool_name: name, tool_input: input }),
}).stdout;
const counter = (sid) => join(TURN_DIR, `${sid}.json`);
{
  const AGG = repo("turns-agg-", { delegate: "aggressive" });
  const out = prompt(AGG, "làm lại bộ ảnh listing theo luật mũi tên mới", "n1").stdout;
  t.check("gate bắt tách việc thành phần", /tách việc thành các phần/.test(out) && /làm hình\/video/.test(out), true);
  t.check("...dòng quyết định dạng Codex: · Anti: · tự làm:", /Codex: <phần> · Anti: <phần> · tự làm: <phần>/.test(out), true);
  t.check("...nói worker từng lỗi không phải lý do bỏ giao", /từng lỗi không phải lý do/.test(out), true);
  t.check("...không in tên script hay lệnh dispatch", /\.mjs|crew run|codex-run|anti-run/.test(out), false);
  t.check("lượt mới ở repo aggressive mở bộ đếm", existsSync(counter("n1")), true);
  tool("n1", "Edit", { file_path: "/x/a.py" });
  tool("n1", "Edit", { file_path: "/x/b.py" });
  const nudge = tool("n1", "Write", { file_path: "/x/c.py" });
  const ctx = (() => { try { return JSON.parse(nudge).hookSpecificOutput; } catch { return null; } })();
  t.check("PostToolUse trả additionalContext khi sửa tới file thứ 3", ctx?.hookEventName === "PostToolUse" && /sửa 3 file/.test(ctx.additionalContext), true);
  t.check("...chỉ nhắc một lần trước mốc thứ hai", tool("n1", "Edit", { file_path: "/x/d.py" }), "");
  prompt(AGG, "<task-notification><task-id>b1</task-id></task-notification>", "n1");
  t.check("tin tự chèn giữa lượt giữ nguyên bộ đếm", JSON.parse(readFileSync(counter("n1"), "utf8")).tools, 4);
  prompt(AGG, "làm hết luôn", "n1");
  t.check("prompt ngắn (gate im) vẫn mở lượt mới, đếm lại từ 0", JSON.parse(readFileSync(counter("n1"), "utf8")).tools, 0);

  prompt(AGG, "Another Claude session sent a message: <cross-session-message from=\"c\">làm thêm phase 3 giúp nhé, đổi cả parser</cross-session-message>", "peer1");
  t.check("tin session khác: không bắt dòng quyết định (không để dấu chờ)", existsSync(join(AGG, ".crew", "logs", ".gate-pending-peer1")), false);

  const PLAIN = repo("turns-plain-", { delegate: "default" });
  prompt(PLAIN, "làm lại bộ ảnh listing theo luật mũi tên mới", "n1");
  t.check("session chuyển sang repo không aggressive: bỏ bộ đếm", existsSync(counter("n1")), false);
  t.check("không có bộ đếm → PostToolUse im", tool("n1", "Edit", { file_path: "/x/e.py" }), "");
  t.check("session id lạ → im, không đẻ file", tool("../x", "Edit", { file_path: "/x" }) === "" && !existsSync(join(TURN_DIR, "..", "x.json")), true);
}

process.exit(t.finish() ? 0 : 1);
