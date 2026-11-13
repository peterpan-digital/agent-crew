/**
 * Đo routing gate bằng quyết định thật của Claude, không chỉ bằng lần gate bắn.
 *
 * Gate (UserPromptSubmit) bắt Claude ghi một dòng `Định tuyến: …` trước khi làm.
 * Gate để lại một dấu theo session; hook Stop thấy dấu thì đọc transcript của
 * lượt vừa xong, lấy dòng đó, quy về tuyến (codex/anti/session/self) và ghi một
 * dòng log cạnh dòng của gate. Nhờ vậy log trả lời được "gate bắn bao nhiêu lần,
 * Claude giao bao nhiêu, tự làm bao nhiêu, quên ghi bao nhiêu".
 *
 * Log KHÔNG BAO GIỜ chứa nội dung prompt hay câu trả lời: chỉ nhãn tuyến.
 * Mọi hàm ở đây không throw — hook là tiện ích, không được làm hỏng lượt.
 */
import { closeSync, existsSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DECISION_LABEL, promptKind, stripReminders } from "./routing-gate.mjs";

/** Transcript dài cả chục MB; lượt cuối luôn nằm ở đuôi. */
const TAIL_BYTES = 4 * 1024 * 1024;
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Dấu "gate vừa bắn cho session này", nằm cạnh file log. null khi session id lạ. */
export function pendingMarker(logPath, sessionId) {
  return typeof sessionId === "string" && SID_RE.test(sessionId)
    ? join(dirname(logPath), `.gate-pending-${sessionId}`)
    : null;
}

export function markPending(logPath, sessionId, gateBranch) {
  const marker = pendingMarker(logPath, sessionId);
  if (!marker) return;
  try {
    writeFileSync(marker, gateBranch, { mode: 0o600 });
  } catch { /* thiếu dấu thì chỉ mất một dòng đo */ }
}

/** Đọc rồi xoá dấu: `gateBranch` hoặc null khi lượt này gate không bắn. */
export function takePending(logPath, sessionId) {
  const marker = pendingMarker(logPath, sessionId);
  if (!marker || !existsSync(marker)) return null;
  try {
    const { size } = statSync(marker);
    const buf = Buffer.alloc(Math.min(size, 64));
    const fd = openSync(marker, "r");
    readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    rmSync(marker, { force: true });
    return buf.toString("utf8").trim() || "unknown";
  } catch {
    return null;
  }
}

/**
 * Dòng quyết định → danh sách tuyến. Chỉ đọc phần trước lý do (trước " — ", không
 * có gạch thì trước dấu chấm đầu): "tự làm — Codex đã timeout" là self, không phải
 * codex. "Codex: parser · tự làm: doc" → ["codex"]: có giao là tính giao; "tự làm"
 * chỉ đứng một mình mới là self.
 */
export function routesOf(line) {
  if (!line) return ["missing"];
  const parts = line.split(/\s[—–]\s/);
  const head = parts.length > 1 ? parts[0] : line.split(/\.\s/)[0];
  const routes = [];
  if (/codex/i.test(head)) routes.push("codex");
  if (/\banti\b|antigravity/i.test(head)) routes.push("anti");
  // Session đang chạy được gọi theo tên ("session kit: …", "phiên Bill …", "giao kit
  // và 4 session template"), không chỉ "session con". Đo 11/11: dispatcher chia 3 việc
  // cho 3 session có tên, log ghi self. Chỉ tính khi "session" mở đầu một phần hoặc đi
  // sau "giao", để "tự làm: kiểm session cũ" vẫn là self.
  const namedSession = head.split("·").some((p) => /^\s*(session|phiên)\s+\S/i.test(p))
    || /\bgiao\b[^·]*?(?:\bsession|phiên)\b/i.test(head);
  if (namedSession || /session\s*con|phiên\s*con|sub-?session/i.test(head)) routes.push("session");
  if (!routes.length && /tự\s*làm|tu\s*lam/i.test(head)) routes.push("self");
  return routes.length ? routes : ["other"];
}

function tailLines(path) {
  const { size } = statSync(path);
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // dòng đầu bị cắt giữa chừng
  return lines;
}

/**
 * Mốc đầu lượt: tin mang việc mới. Không tính tin app tự chèn — khối nhắc hệ thống
 * trơn, `<task-notification>`, tin của session khác (isMeta), bản tóm tắt sau khi
 * nén ngữ cảnh, "[Request interrupted…]". Đo 08–09/11: các tin đó bị coi là prompt
 * nên dòng quyết định viết trước chúng bị bỏ sót, log đếm `missing` 77/92 lượt.
 * Tin session cha giao việc lúc mở session con là việc thật, vẫn tính.
 */
function isUserPrompt(e) {
  if (e?.type !== "user" || e.isMeta || e.isCompactSummary) return false;
  const c = e.message?.content;
  let text;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c) && !c.some((b) => b?.type === "tool_result")) text = c.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  else return false;
  if (promptKind(text) !== "user") return false;
  return !/^(This session is being continued from a previous conversation|\[Request interrupted)/.test(stripReminders(text));
}

/** Lượt ít lượt gọi tool hơn ngần này mà không có dòng quyết định → câu hỏi/trao đổi, không tính là quên. */
export const NO_TASK_MAX_TOOL_CALLS = 3;

/**
 * Tool ghi sổ của app desktop (task list, ô next-step): app bắt gọi ở gần như mọi
 * lượt, không phải việc. Đếm vào thì lượt xác nhận 2 lệnh + wrap_up thành `missing`
 * (đo 12/11: Digital Project, lượt owner "duyệt ok hết" ghi memory 2 lệnh → missing/3).
 */
const BOOKKEEPING_TOOL = /^mcp__ccd_turn__/;

/**
 * Lượt vừa xong: dòng `Định tuyến: …` đầu tiên Claude viết từ prompt cuối (hoặc
 * null) và số lượt gọi tool. Gate bắn ở mọi prompt đủ dài, kể cả câu hỏi; Claude
 * đúng khi không ghi dòng cho câu hỏi, nên "không có dòng" chỉ là quên khi lượt
 * đó thật sự làm việc (đo 11/11: 6/6 `missing` sau 2.6.0 là câu hỏi).
 */
export function lastTurnSummary(transcriptPath) {
  try {
    const entries = tailLines(transcriptPath).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    let i = entries.length - 1;
    while (i >= 0 && !isUserPrompt(entries[i])) i -= 1;
    let line = null;
    let toolCalls = 0;
    for (const e of entries.slice(i + 1)) {
      if (e?.type !== "assistant") continue;
      for (const b of e.message?.content ?? []) {
        if (b?.type === "tool_use" && !BOOKKEEPING_TOOL.test(b.name ?? "")) toolCalls += 1;
        if (line || b?.type !== "text" || typeof b.text !== "string") continue;
        const at = b.text.indexOf(DECISION_LABEL);
        if (at >= 0) line = b.text.slice(at + DECISION_LABEL.length).split("\n")[0].replace(/[`*]/g, "").trim();
      }
    }
    return { line, toolCalls };
  } catch {
    return { line: null, toolCalls: 0 };
  }
}

/** Dòng `Định tuyến: …` đầu tiên Claude viết từ prompt cuối tới hết transcript, hoặc null. */
export function lastTurnDecision(transcriptPath) {
  return lastTurnSummary(transcriptPath).line;
}

/** Tuyến ghi log cho một lượt: có dòng thì theo dòng; không có thì `missing`, trừ lượt gần như không làm gì. */
export function turnRoutes({ line, toolCalls }) {
  if (line) return routesOf(line);
  return toolCalls < NO_TASK_MAX_TOOL_CALLS ? ["no-task"] : ["missing"];
}
