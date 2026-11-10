/**
 * Codex hỏng vì sao — đọc từ chính stream của nó, không từ stderr.
 *
 * Vì sao (11/11, Digital Project): một job Codex chết vì workspace hết credit.
 * Stream có `{"type":"turn.failed","error":{"message":"Your workspace is out of
 * credits…"}}`, nhưng crew ghi lý do là mấy dòng cuối stderr — toàn log lỗi
 * token của một MCP server trong `~/.codex/config.toml`, không liên quan. Người
 * đọc sổ hiểu sai, và không ai được nhắc rằng job này chờ hồi quota rồi resume
 * là chạy tiếp.
 *
 * Thuần, không throw.
 */

/** Lỗi nghe như hết hạn mức / credit / bị giới hạn tốc độ. */
export const QUOTA_ERROR = /out of credits|usage limit|rate[ _-]?limit|quota|insufficient[_ ]quota|too many requests|\b429\b|spend(ing)? (cap|limit)/i;

/** Một dòng stream → thông điệp lỗi Codex tự báo (giữ cái mới nhất), không thì `prev`. */
export function collectCodexError(line, prev = null) {
  if (!line || !line.includes("error")) return prev;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return prev;
  }
  if (e?.type === "turn.failed") return String(e.error?.message ?? e.message ?? "").trim() || prev;
  if (e?.type === "error") return String(e.message ?? e.error?.message ?? "").trim() || prev;
  return prev;
}

/**
 * Câu lý do cho một lượt Codex thoát lỗi. Ưu tiên lỗi Codex tự báo; không có thì
 * mới dùng đuôi stderr như trước. Hết quota thì nói thẳng và chỉ đường resume.
 */
export function codexExitDetail({ code, signal, streamError, stderrTail = [], threadId }) {
  const head = `codex exited ${code}${signal ? ` on ${signal}` : ""}`;
  if (streamError && QUOTA_ERROR.test(streamError)) {
    const resume = threadId ? `, rồi bắn lại job với \`--resume ${threadId}\` để chạy tiếp` : "";
    return `hết quota/credit Codex giữa job (${head}): ${streamError}\n`
      + `  → \`crew quota\` xem giờ hồi${resume}; hoặc giao phần còn lại cho worker khác`;
  }
  if (streamError) return `${head}: ${streamError}`;
  return `${head}${stderrTail.length ? `: ${stderrTail.join(" | ")}` : ""}`;
}
