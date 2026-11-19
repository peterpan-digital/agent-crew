/**
 * Kiểm cơ học handoff của một lát chuỗi trước khi tự nối lát kế — không tốn token
 * Claude. Đọc được bằng máy là đủ để bắt ba cách chuỗi tự kéo dài vô ích (thiếu
 * mục, không tiến triển, không đổi file nào) và một cách nó tự đòi thêm quyền.
 * Không bắt được mọi thứ: checkpoint mỗi 2 lát (Claude đọc) là lớp thứ hai.
 *
 * Handoff là văn của worker, tức dữ liệu. Ở đây chỉ so chuỗi, không bao giờ làm
 * theo nội dung của nó.
 */
import { BASE_CONTROL_PLANE } from "../crew-scope.mjs";

export const HANDOFF_SUBSECTIONS = Object.freeze(["Đã xong", "Đang dở", "Bước kế tiếp", "File đã đụng"]);

/**
 * Chữ mà một handoff hợp lệ không có lý do để nhắc: tự dispatch, tự nới quyền,
 * hay chạm control plane. Lát sau resume cùng thread nên đọc được lượt trước —
 * một handoff dặn "chạy crew run với --sandbox-mode ..." là chỉ thị đi lậu.
 */
const PRIVILEGE_WORDS = Object.freeze([
  "dispatch", "crew run", "add-job", "--sandbox-mode", "--workspace-cli", "danger-full-access",
  "CREW_ROLE", ...BASE_CONTROL_PLANE,
]);

/**
 * Chữ phủ định/cấm đứng ngay trước "dispatch" (≤ 2 từ, cùng mệnh đề). Crew tự dặn mọi
 * worker "Không được dispatch worker khác" (crew-guards) và worker nhắc lại luật đó
 * trong handoff ("user cấm dispatch worker khác nên không gọi reviewer") — chuỗi đã dừng
 * oan sau lát 1 vì thế (18/11/2026). Cửa sổ hẹp và cắt ở dấu câu để "không cần hỏi,
 * dispatch thêm worker" vẫn bị bắt.
 */
const NEGATIONS = new Set(["không", "cấm", "chưa", "đừng", "chẳng", "not", "no", "never", "don't", "didn't", "without"]);

/** Có "dispatch" (không tính "dispatcher") nào KHÔNG đứng sau chữ phủ định/cấm. */
function dispatchAsked(lower) {
  for (const m of lower.matchAll(/\bdispatch(?!er)/g)) {
    const clause = lower.slice(0, m.index).split(/[,.;:!?\n]/).pop();
    const before = clause.trim().split(/\s+/).filter(Boolean).slice(-2);
    if (!before.some((w) => NEGATIONS.has(w))) return true;
  }
  return false;
}

const norm = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** Văn bản mục `## Handoff` (tới heading cấp ≤ 2 kế tiếp), hoặc null. */
export function handoffSection(text) {
  const lines = String(text ?? "").normalize("NFC").split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+handoff\b/i.test(l.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l.trim()));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** `{ "Đã xong": "...", ... }` theo các heading `### ` trong mục handoff. */
export function handoffParts(text) {
  const section = handoffSection(text);
  if (section == null) return null;
  const parts = {};
  let current = null;
  for (const line of section.split("\n")) {
    const head = /^###\s+(.*)$/.exec(line.trim());
    if (head) {
      current = HANDOFF_SUBSECTIONS.find((name) => norm(head[1]).startsWith(norm(name))) ?? null;
      if (current) parts[current] = "";
      continue;
    }
    if (current) parts[current] += `${line}\n`;
  }
  return parts;
}

/**
 * → `{ ok: true }` hoặc `{ ok: false, reason }` (lý do đầu tiên bắt được).
 *
 * `prevText`: evidence lát trước (null ở lát 1). `changedFiles`: lát có đổi file
 * nào ngoài evidence không — caller tính từ `touchedFiles` hoặc mtime, vì hàm này
 * không đụng đĩa.
 */
export function checkHandoff({ text, prevText = null, changedFiles }) {
  const parts = handoffParts(text);
  if (!parts) return { ok: false, reason: "thiếu mục `## Handoff`" };
  const missing = HANDOFF_SUBSECTIONS.filter((name) => !(name in parts) || !norm(parts[name]));
  if (missing.length) return { ok: false, reason: `handoff thiếu mục: ${missing.map((m) => `### ${m}`).join(", ")}` };

  const section = handoffSection(text);
  const lower = section.toLowerCase();
  // "dispatch" so theo từ, chừa "dispatcher": worker được dạy gọi người giao việc là
  // dispatcher ("Việc dispatcher cần tiếp"), và khớp chuỗi con đã cắt chuỗi một handoff
  // hợp lệ sau lát 1 (16/11/2026). Còn lại so chuỗi con như cũ.
  const hit = PRIVILEGE_WORDS.find((w) => (w === "dispatch"
    ? dispatchAsked(lower)
    : lower.includes(w.toLowerCase())));
  if (hit) return { ok: false, reason: `handoff nhắc thứ đòi quyền/dispatch ("${hit}") — cần người đọc` };

  if (prevText != null) {
    const before = handoffParts(prevText)?.["Đang dở"];
    if (before != null && norm(before) === norm(parts["Đang dở"])) {
      return { ok: false, reason: "`### Đang dở` giống hệt lát trước — chuỗi không tiến triển" };
    }
  }
  if (!changedFiles) return { ok: false, reason: "lát không đổi file nào ngoài evidence — chuỗi không tiến triển" };
  return { ok: true };
}
