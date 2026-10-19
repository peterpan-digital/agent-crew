/**
 * Định dạng và I/O của file trạng thái dùng chung.
 *
 * Mỗi phiên ghi đúng MỘT đường dẫn của riêng nó. Không có hai thằng nào ghi
 * cùng một file, nên va chạm không tồn tại -- không phải "được xử lý", mà là
 * không phát sinh. Tài khoản Claude này dùng chung nhiều người (đo 21/09: 8
 * phiên một ngày, 75 phiên ngày 13/09), nên một file phẳng sẽ mất bản ghi.
 *
 * Cố ý KHÔNG dùng khoá file: ba runtime, ba ngôn ngữ, và một tiến trình chết
 * khi đang giữ khoá là treo cả hệ. `crew-manifest.mjs` đã phải làm khoá-có-chủ
 * cộng ghi atomic để giải đúng bài đó; ở đây không cần trả giá ấy.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_DIR_REL = join("tasks", "_state");
/** Trần cỡ. Trong `.agents/` đang có đúng một file 31 KB nhồi vào mỗi phiên -- đừng đẻ cái thứ hai. */
export const MAX_BYTES = 4096;
/** Quá ngưỡng này thì đánh dấu cũ. File 3 ngày trước mà đọc như đang chạy thì tệ hơn không có file. */
export const STALE_HOURS = 12;
export const PRUNE_DAYS = 7;

export const AGENTS = new Set(["claude", "codex", "anti"]);

export function stateDir(workspace) {
  return join(workspace, STATE_DIR_REL);
}

/**
 * Một file cho một (agent, phiên).
 *
 * Phần rút gọn là để người đọc dễ nhìn; phần băm là thứ giữ lời hứa của cả
 * kiến trúc. Bản đầu chỉ cắt 12 ký tự đầu, và một session id dài dạng
 * `rollout-2026-09-20T21-08-41-...` rút lại thành `rollout-2026` — **mọi phiên
 * Codex năm 2026 sẽ ghi đè lên nhau**. Đó đúng là cái va chạm mà thiết kế này
 * tuyên bố không thể xảy ra, nên nó phải được đóng bằng code chứ không bằng
 * giả định "id nào cũng là uuid".
 */
export function statePath(workspace, agent, sessionId) {
  const id = String(sessionId ?? "unknown");
  const safe = id.replace(/[^A-Za-z0-9-]/g, "");
  const head = safe.slice(0, 12).replace(/-+$/, "") || "unknown";
  const needsHash = safe.length > 12 || head === "unknown";
  const tag = needsHash ? `-${createHash("sha256").update(id).digest("hex").slice(0, 8)}` : "";
  return join(stateDir(workspace), `${agent}-${head}${tag}.md`);
}

function clip(text, max) {
  const s = String(text ?? "").trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Nội dung file.
 *
 * Tách bạch cái suy ra được và cái không: script đọc transcript thì biết "đã
 * làm gì", nhưng KHÔNG biết "định làm gì tiếp" -- nghiệm thu Phase 2 đã lộ đúng
 * chỗ này, phiên bị ngắt giữa lượt thì ý định người dùng không nằm trong
 * transcript. Ghi "bước kế" như thể chắc chắn là nói dối con agent đọc sau.
 */
export function renderState({ agent, session, task, written, lastDid, files, blocked, note }) {
  const lines = [
    "---",
    `agent: ${agent}`,
    `session: ${session ?? "unknown"}`,
    `task: ${task ?? "(chưa rõ)"}`,
    `written: ${written ?? new Date().toISOString()}`,
    "source: suy từ transcript — không phải lời khai của agent",
    "---",
    "",
    `# ${agent} · ${task ?? "(chưa rõ task)"}`,
    "",
    "## Vừa làm gì (suy được)",
    "",
    clip(lastDid, 1200) || "_(không đọc được lượt trả lời nào)_",
    "",
  ];
  if (files?.length) {
    lines.push("## File vừa đụng", "", ...files.slice(0, 8).map((f) => `- \`${f}\``), "");
  }
  if (blocked) lines.push("## Đang kẹt", "", clip(blocked, 300), "");
  lines.push(
    "## Bước kế",
    "",
    "_Không suy ra được từ transcript._ Phiên có thể đã dừng giữa chừng, và ý định",
    "của người dùng không nằm trong bản ghi. Hỏi người dùng, đừng đoán.",
    "",
  );
  if (note) lines.push(`> ${note}`, "");
  return lines.join("\n");
}

/** tmp + rename: người đọc không bao giờ thấy file ghi dở. */
export function writeStateAtomic(path, body) {
  const capped = Buffer.byteLength(body, "utf8") > MAX_BYTES
    ? `${Buffer.from(body, "utf8").subarray(0, MAX_BYTES - 40).toString("utf8").replace(/�+$/, "")}\n…[cắt cho vừa trần]\n`
    : body;
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, capped, { mode: 0o600 });
  renameSync(tmp, path);
  return Buffer.byteLength(capped, "utf8");
}

export function ageMs(path) {
  return Date.now() - statSync(path).mtimeMs;
}

export function formatAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} giờ trước` : `${Math.round(h / 24)} ngày trước`;
}

/** Dọn khi ghi. Không có bước này thì thư mục thành bãi rác như `.agents/`. */
export function pruneOld(dir, days = PRUNE_DAYS) {
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 86400_000;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") && !f.includes(".tmp-")) continue;
    const p = join(dir, f);
    try {
      if (statSync(p).mtimeMs < cutoff) { rmSync(p); n += 1; }
    } catch { /* biến mất giữa chừng thì thôi */ }
  }
  return n;
}

/** Mới nhất trước. Tuổi đi kèm để người đọc không tin nhầm file cũ. */
export function readStates(dir, { limit = 3, exclude = null } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== exclude)
    .map((f) => {
      const p = join(dir, f);
      return { name: f, path: p, age: ageMs(p), body: readFileSync(p, "utf8") };
    })
    .sort((a, b) => a.age - b.age)
    .slice(0, limit)
    .map((s) => ({ ...s, stale: s.age > STALE_HOURS * 3600_000 }));
}
