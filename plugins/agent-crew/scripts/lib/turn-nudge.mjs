/**
 * Nhắc giữa lượt: Claude chọn "tự làm" ở câu đầu rồi lượt phình ra.
 *
 * Gate chỉ hỏi một lần, lúc Claude chưa biết việc dài cỡ nào. Đo ở Digital
 * Project 08–09/11: Claude ghi "tự làm — vài lượt gọi tool" rồi lượt đó kéo tới
 * 100–160 tool call, sửa cả kit lẫn cổng kiểm, không giao phần nào.
 *
 * Cách làm: hook UserPromptSubmit (repo aggressive) mở một bộ đếm theo session;
 * hook PostToolUse tăng bộ đếm, nhớ file đã sửa và việc đã giao chưa. Lượt tự làm
 * vượt ngưỡng thì chèn một lời nhắc vào ngữ cảnh — tối đa hai lần một lượt. Giao
 * rồi (`crew run`, mở session con) thì thôi nhắc.
 *
 * Bộ đếm nằm ở thư mục tạm theo session id, không cần git: PostToolUse bắn ở mọi
 * lượt gọi tool của mọi repo, nên đường "không có bộ đếm" phải là một lần stat.
 * Không throw.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DECISION_LABEL } from "./routing-gate.mjs";

/** Lần nhắc đầu: tự làm tới ngần này lượt gọi tool… */
export const NUDGE_TOOL_CALLS = 40;
/** …hoặc đã sửa ngần này file. */
export const NUDGE_FILES = 3;
/** Lần nhắc thứ hai (cuối) nếu vẫn tự làm. */
export const NUDGE_TOOL_CALLS_AGAIN = 100;
const STALE_MS = 2 * 86_400_000;
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Công cụ ghi sổ của app, không phải làm việc. */
const BOOKKEEPING = /^(mcp__ccd_turn__|ToolSearch$|TodoWrite$|Task(Create|Update|List|Get)$)/;
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
/** Đã giao cho worker hay session con. */
const DELEGATE_CMD = /\bcrew(\.mjs)?\s+(run|dispatch)\b/;
const DELEGATE_TOOL = /start_session$/;

const turnDir = () => process.env.CREW_TURN_DIR || join(tmpdir(), "agent-crew-turns");
const stateFile = (sid) => (typeof sid === "string" && SID_RE.test(sid) ? join(turnDir(), `${sid}.json`) : null);

/** Mở bộ đếm cho lượt mới của session; dọn bộ đếm cũ. */
export function startTurn(sessionId) {
  const file = stateFile(sessionId);
  if (!file) return;
  try {
    mkdirSync(turnDir(), { recursive: true, mode: 0o700 });
    const now = Date.now();
    for (const f of readdirSync(turnDir())) {
      try {
        if (now - statSync(join(turnDir(), f)).mtimeMs > STALE_MS) rmSync(join(turnDir(), f), { force: true });
      } catch { /* file vừa bị xoá */ }
    }
    writeFileSync(file, JSON.stringify({ tools: 0, files: [], delegated: false, nudges: 0 }), { mode: 0o600 });
  } catch { /* không đếm được thì chỉ mất lời nhắc */ }
}

/** Lượt mới ở repo không bật: bỏ bộ đếm cũ (nếu có) để không nhắc nhầm. */
export function endTurn(sessionId) {
  const file = stateFile(sessionId);
  if (file) rmSync(file, { force: true });
}

/** Cập nhật bộ đếm với một lượt gọi tool → câu nhắc hoặc null. Thuần, để test. */
export function step(state, { tool_name: name = "", tool_input: input = {} } = {}) {
  if (BOOKKEEPING.test(name)) return null;
  state.tools += 1;
  if (EDIT_TOOLS.test(name)) {
    const path = input.file_path ?? input.notebook_path;
    if (typeof path === "string" && !state.files.includes(path)) state.files.push(path);
  }
  if ((name === "Bash" && DELEGATE_CMD.test(String(input.command ?? ""))) || DELEGATE_TOOL.test(name)) state.delegated = true;
  if (state.delegated) return null;
  const due = state.nudges === 0
    ? state.tools >= NUDGE_TOOL_CALLS || state.files.length >= NUDGE_FILES
    : state.nudges === 1 && state.tools >= NUDGE_TOOL_CALLS_AGAIN;
  if (!due) return null;
  state.nudges += 1;
  return message(state);
}

function message({ tools, files, nudges }) {
  return [
    `## Định tuyến crew — giữa lượt${nudges > 1 ? " (lần cuối)" : ""}`,
    "",
    `Lượt này đã ${tools} lượt gọi tool, sửa ${files.length} file, chưa giao phần nào.`,
    "Dừng một nhịp: phần **còn lại** có mảng nào Codex hay Anti làm được (code, script, sửa nhiều file,",
    "chạy test, xử lý hàng loạt) hay Anti làm được (tra cứu, việc theo rule)? Có thì giao qua",
    "skill `agent-crew` rồi làm phần cần phán đoán song song. Không thì ghi",
    `\`${DECISION_LABEL} vẫn tự làm — <vì sao phần còn lại không tách được>\` và làm tiếp.`,
    "",
  ].join("\n");
}

/** Hook PostToolUse: payload → câu nhắc hoặc null. Không có bộ đếm thì thoát ngay. */
export function onToolUse(payload) {
  const file = stateFile(payload?.session_id);
  if (!file || !existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    const text = step(state, payload);
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    return text;
  } catch {
    return null;
  }
}
