/**
 * Suy trạng thái từ transcript trên đĩa — KHÔNG hỏi model.
 *
 * Đây là ràng buộc gốc: để model tự kể lại là tốn token mỗi lượt, đúng thứ cơ
 * chế này sinh ra để tiết kiệm. Đo 21/09 cho thấy suy được: transcript Claude
 * và transcript Codex đều phân biệt được lượt user / trả lời assistant / tool.
 *
 * Hai định dạng, nhận diện bằng cách ngửi dòng đầu thay vì tin phần mở rộng:
 *
 *   Claude  {"type":"assistant","message":{"content":[{"type":"text",...}]}}
 *   Codex   {"type":"response_item","payload":{"type":"message","role":"assistant",
 *            "content":[{"type":"output_text","text":...}]}}
 */
import { existsSync, readFileSync } from "node:fs";

const TASK_RE = /(?:^|[\s"'`(])((?:tasks\/[0-9]{6}-[a-z0-9-]+)(?:\/work-items\/[0-9]{6}-[a-z0-9-]+)?)/g;

export function sniffFormat(firstLine) {
  try {
    const d = JSON.parse(firstLine);
    if (d.type === "response_item" || d.type === "session_meta" || d.payload) return "codex";
    if (d.type || d.message) return "claude";
  } catch { /* dòng hỏng thì để caller quyết */ }
  return "unknown";
}

function textOfClaude(entry) {
  const c = entry.message?.content;
  if (!Array.isArray(c)) return null;
  const parts = c.filter((b) => b?.type === "text" && b.text?.trim()).map((b) => b.text);
  return parts.length ? parts.join("\n\n") : null;
}

function textOfCodex(payload) {
  const c = payload?.content;
  if (!Array.isArray(c)) return null;
  const parts = c.filter((b) => typeof b?.text === "string" && b.text.trim()).map((b) => b.text);
  return parts.length ? parts.join("\n\n") : null;
}

/**
 * @returns {{lastDid: string|null, files: string[], task: string|null, lines: number, format: string}}
 */
export function deriveFromTranscript(path) {
  const empty = { lastDid: null, files: [], task: null, lines: 0, format: "unknown" };
  if (!path || !existsSync(path)) return empty;

  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return empty; }
  const rows = raw.split("\n").filter((l) => l.trim());
  if (!rows.length) return empty;

  const format = sniffFormat(rows[0]);
  const fileHits = new Map();
  const taskHits = new Map();
  const texts = [];

  for (const line of rows) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    if (format === "codex") {
      const p = d.payload;
      if (!p || typeof p !== "object") continue;
      if (p.type === "message" && p.role === "assistant") push(texts, textOfCodex(p));
      // Codex gói tham số tool thành chuỗi JSON; quét thô là đủ để nhặt đường dẫn.
      if (p.type === "function_call" && typeof p.arguments === "string") collect(p.arguments, fileHits, taskHits);
    } else {
      if (d.type === "assistant") push(texts, textOfClaude(d));
      const c = d.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type !== "tool_use" || !b.input) continue;
          const v = b.input.file_path ?? b.input.path ?? b.input.command ?? "";
          collect(String(v), fileHits, taskHits);
        }
      }
    }
  }

  return {
    lastDid: pickSubstantial(texts),
    files: top(fileHits, 8),
    task: top(taskHits, 1)[0] ?? null,
    lines: rows.length,
    format,
  };
}

function collect(text, fileHits, taskHits) {
  if (!text) return;
  for (const m of text.matchAll(TASK_RE)) bump(taskHits, m[1]);
  for (const m of text.matchAll(/(?:^|[\s"'`(])((?:[\w.-]+\/){1,}[\w.-]+\.\w{1,6})/g)) {
    const f = m[1];
    if (f.startsWith("node_modules/") || f.includes("/.git/")) continue;
    bump(fileHits, f);
  }
}

const bump = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);

/** Giữ 6 đoạn cuối là đủ; không cần ôm cả phiên trong bộ nhớ. */
function push(arr, text) {
  if (!text) return;
  arr.push(text);
  if (arr.length > 6) arr.shift();
}

const SUBSTANTIAL = 200;

/**
 * Đoạn cuối cùng KHÔNG phải lúc nào cũng là bản tóm tắt.
 *
 * Khi lượt kết thúc bình thường thì đoạn cuối chính là câu trả lời, lấy nó là
 * đúng. Nhưng hook `interrupt` của Codex và ca phiên chết giữa chừng lại bắn
 * đúng vào lúc đoạn cuối là một câu dẫn kiểu "Giờ chạy thử:" trước một lệnh
 * tool — và đó chính là ca mà cơ chế này sinh ra để lo. Đo thật 21/09 trên
 * phiên đang chạy: đoạn cuối dài 92 ký tự và không nói được gì.
 *
 * Nên: lấy đoạn cuối nếu nó đủ dày, không thì lấy đoạn dày nhất trong 6 đoạn
 * gần đây. Ca bình thường không đổi, vì bản tóm tắt vừa là đoạn cuối vừa dày.
 */
function pickSubstantial(texts) {
  if (!texts.length) return null;
  const last = texts[texts.length - 1];
  if (last.length >= SUBSTANTIAL) return last;
  const fattest = texts.reduce((a, b) => (b.length > a.length ? b : a), last);
  return fattest.length > last.length ? fattest : last;
}
const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
