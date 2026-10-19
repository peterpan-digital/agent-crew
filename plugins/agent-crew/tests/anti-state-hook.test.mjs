#!/usr/bin/env node
/**
 * Hook trạng thái của Antigravity app: `crew state-write --agent anti`.
 *
 * Payload của Anti là camelCase (`conversationId`, `workspacePaths`,
 * `transcriptPath`), hook chạy với cwd = `.agents/` chứ không phải gốc repo, và
 * app đòi stdout là JSON — kể cả ở nhánh bỏ qua. Transcript của Anti có hình dạng
 * riêng: lời model nằm ở `PLANNER_RESPONSE`, kết quả tool ở `GENERIC`.
 *
 * Schema `.agents/hooks.json` là của từng workspace, nên test schema nằm ở repo
 * dùng crew, không ở đây.
 *
 * Run: node plugins/agent-crew/tests/anti-state-hook.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LAYOUT } from "../scripts/lib/crew-layout.mjs";
import { deriveFromTranscript, sniffFormat } from "../scripts/lib/derive-state.mjs";
import { MODULE_ROOT, makeChecker } from "./helpers.mjs";

const STATE_DIR_REL = DEFAULT_LAYOUT.stateDir;

const t = makeChecker("anti-state-hook");
const WRITE = join(MODULE_ROOT, "scripts", "agent-state-write.mjs");

/** Một transcript Anti rút gọn, đúng hình dạng đo được ở transcript_full.jsonl. */
function antiTranscript(dir, { reply = "Đã ghi xong evidence cho job.", task = "tasks/261001-demo-task", prefix = "", name = "transcript_full.jsonl" } = {}) {
  const p = join(dir, name);
  writeFileSync(p, [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "làm đi" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "",
      tool_calls: [{ name: "write_to_file", args: { TargetFile: `"${prefix}${task}/reports/x.md"`, CodeContent: "..." } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "tool output không phải lời model" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: reply },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

// ------------------------------------------------ derive-state hiểu transcript Anti
{
  const w = mkdtempSync(join(tmpdir(), "anti-hook-"));
  const p = antiTranscript(w);
  t.check("nhận diện Anti (không nhầm sang Claude)", sniffFormat(readFileSync(p, "utf8").split("\n")[0]), "anti");
  const d = deriveFromTranscript(p);
  t.check("Anti: lấy lời model cuối", d.lastDid, "Đã ghi xong evidence cho job.");
  t.check("Anti: bỏ qua kết quả tool (GENERIC)", d.lastDid.includes("tool output"), false);
  t.check("Anti: nhặt đường dẫn từ tham số tool", d.files.some((f) => f.endsWith("reports/x.md")), true);
  t.check("Anti: nhặt task từ đường dẫn", d.task, "tasks/261001-demo-task");
}

// -------------------------------- agent-state-write: payload camelCase + stdout JSON
function runWrite(payload, args = ["--agent", "anti"]) {
  return spawnSync("node", [WRITE, ...args], { input: JSON.stringify(payload), encoding: "utf8", cwd: tmpdir() });
}
{
  const w = mkdtempSync(join(tmpdir(), "anti-hook-"));
  mkdirSync(join(w, STATE_DIR_REL), { recursive: true });
  const tp = antiTranscript(w);
  // Hook của Anti chạy với cwd = `.agents/`, nên workspace phải lấy từ workspacePaths.
  const r = runWrite({ conversationId: "2d6c5705-20df-466a-9791-bea1e0d9c56e", workspacePaths: [w], transcriptPath: tp, invocationNum: 3 });
  t.check("Anti: exit 0", r.status, 0);
  t.check("Anti: stdout là JSON `{}`", r.stdout, "{}");
  const files = readdirSync(join(w, STATE_DIR_REL));
  t.check("Anti: ghi đúng 1 file trạng thái", files.length, 1);
  t.check("Anti: tên file mang agent + id phiên", /^anti-2d6c5705/.test(files[0] ?? ""), true);
  t.check("Anti: file chứa lời model cuối", readFileSync(join(w, STATE_DIR_REL, files[0]), "utf8").includes("Đã ghi xong evidence"), true);

  // Anti ghi đường dẫn TUYỆT ĐỐI vào tham số tool (đo 01/10); bộ nhặt chỉ khớp dạng
  // tương đối. Thiếu bước cắt tiền tố workspace thì file trạng thái không bao giờ
  // ra, vì lượt đầu chưa có lời model và cũng không có đường dẫn nào nhặt được.
  {
    const w2 = mkdtempSync(join(tmpdir(), "anti-hook-"));
    mkdirSync(join(w2, STATE_DIR_REL), { recursive: true });
    const abs = antiTranscript(w2, { prefix: `${w2}/`, reply: "", name: "abs.jsonl" });
    runWrite({ conversationId: "abs-1", workspacePaths: [w2], transcriptPath: abs });
    const got = readdirSync(join(w2, STATE_DIR_REL));
    t.check("Anti: đường dẫn tuyệt đối vẫn ra file trạng thái", got.length, 1);
    t.check("Anti: ...và nhận đúng task", got.length ? readFileSync(join(w2, STATE_DIR_REL, got[0]), "utf8").includes("tasks/261001-demo-task") : false, true);
    t.check("Anti: ...và không lộ tiền tố máy", got.length ? readFileSync(join(w2, STATE_DIR_REL, got[0]), "utf8").includes(w2) : true, false);
  }

  // Hook chạy trước MỖI lần gọi model: lượt hai phải ghi đè, không đẻ file mới.
  runWrite({ conversationId: "2d6c5705-20df-466a-9791-bea1e0d9c56e", workspacePaths: [w], transcriptPath: tp, invocationNum: 4 });
  t.check("Anti: chạy lặp vẫn một file", readdirSync(join(w, STATE_DIR_REL)).length, 1);
}
{
  // Ca bỏ qua việc ghi vẫn phải in JSON, nếu không app coi hook là lỗi.
  const w = mkdtempSync(join(tmpdir(), "anti-hook-"));      // KHÔNG có thư mục state
  const r = runWrite({ conversationId: "abc", workspacePaths: [w], transcriptPath: antiTranscript(w) });
  t.check("Anti: workspace không opt-in → vẫn exit 0", r.status, 0);
  t.check("Anti: ...và vẫn in `{}`", r.stdout, "{}");
  t.check("Anti: payload rỗng → vẫn in `{}`", runWrite({}).stdout, "{}");
  t.check("Claude: stdout KHÔNG đổi (không in gì)", runWrite({ session_id: "s", cwd: w }, ["--agent", "claude"]).stdout, "");
}

process.exit(t.finish() ? 0 : 1);
