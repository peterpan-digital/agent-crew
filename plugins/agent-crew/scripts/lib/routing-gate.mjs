/**
 * Routing gate — phân loại sớm, KHÔNG điều khiển.
 *
 * Quyết "việc này nên chia cho worker hay tự làm" mà không phải nạp cả skill
 * (vài nghìn token) chỉ để hỏi câu đó. Gate tốn cỡ 150 token mỗi lượt bắn.
 *
 * Gate CHỈ đề xuất và cố ý không bao giờ in tên script hay lệnh dispatch. Bản đầu
 * tiên (21/09) bảo agent gọi thẳng adapter: lệnh phát đầu lỗi vì chưa có run,
 * nó vòng qua sổ manifest và cổng transport, và nó trái luật "skill là cửa vào
 * duy nhất". Đường đúng luôn là kích hoạt skill rồi để skill quyết.
 *
 * Việc nhắc tới API trong `costGate` thì im lặng — kể cả khi trigger khớp. Đường
 * duy nhất cho việc tốn tiền là skill + COST_GATE, nơi người dùng được hỏi trước.
 */
import { mentionsPaidApi } from "./crew-config.mjs";

/**
 * Owner gõ `@anti`/`@codex` là chỉ định trực tiếp: miễn luật ≥2 đầu việc, nên
 * nhánh này thắng nhánh "một việc nhỏ thì làm trực tiếp". Đứng đầu dòng hoặc sau
 * khoảng trắng/ngoặc, để địa chỉ email kiểu `a@codex.vn` không bị nhầm.
 */
export const MENTION = /(^|[\s(])@(anti|antigravity|codex)\b/i;

/** `{branch: none|mention|dispatch|suggest, hits: [{id, kind}]}`. */
export function classify(prompt, { routingTriggers = [], costGate = [] } = {}) {
  if (typeof prompt !== "string") return { branch: "none", hits: [] };
  const m = MENTION.exec(prompt);
  if (m) return { branch: "mention", hits: [{ id: `mention-${m[2].toLowerCase() === "codex" ? "codex" : "anti"}`, kind: "mention" }] };
  if (prompt.length < 8) return { branch: "none", hits: [] };
  if (mentionsPaidApi(prompt, costGate)) return { branch: "none", hits: [] };
  const hits = routingTriggers.filter((t) => t.re.test(prompt)).map(({ id, kind }) => ({ id, kind }));
  if (!hits.length) return { branch: "none", hits: [] };
  return { branch: new Set(hits.map((h) => h.kind)).size >= 2 ? "dispatch" : "suggest", hits };
}

export function render(branch, hits) {
  const ids = hits.map((h) => h.id).join(", ");
  if (branch === "mention") {
    return [
      "## Định tuyến crew",
      "",
      `Owner chỉ định worker trực tiếp (${ids}): miễn luật ≥2 đầu việc, giao đúng 1 job.`,
      "Kích hoạt skill `agent-crew` và đọc `references/phoi-hop-owner.md` trước khi giao:",
      "đọc lướt 4 câu, đụng API tốn tiền hay control plane thì đợi owner xác nhận.",
      "",
    ].join("\n");
  }
  if (branch === "dispatch") {
    return [
      "## Định tuyến crew",
      "",
      `Prompt này chạm **${new Set(hits.map((h) => h.kind)).size} loại đầu việc** (${ids}).`,
      "Đủ ngưỡng chia việc — cân nhắc kích hoạt skill `agent-crew` và để nó quyết.",
      "Đây là **gợi ý dựa trên so khớp từ khoá**, không phải lệnh: đọc yêu cầu thật rồi tự quyết.",
      "",
    ].join("\n");
  }
  if (branch === "suggest") {
    return [
      "## Định tuyến crew",
      "",
      `Prompt này khớp một nhóm việc có rule đã thành văn (${ids}).`,
      "Loại này worker thi hành theo rule nhanh và gọn hơn. Nếu khối lượng đủ lớn,",
      "cân nhắc kích hoạt skill `agent-crew` cho một job thay vì tự làm tay.",
      "Một đầu việc nhỏ thì làm trực tiếp — đừng dispatch cho có.",
      "Đây là **gợi ý dựa trên so khớp từ khoá**, không phải lệnh.",
      "",
    ].join("\n");
  }
  return "";
}
