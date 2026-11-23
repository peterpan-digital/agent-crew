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

/**
 * Prompt quá ngắn để là một việc ("ok", "merge luôn", "làm hết luôn") hoặc lệnh
 * slash: không chèn bước cân nhắc. Ngưỡng thấp có chủ đích — lọt một câu "cảm
 * ơn" chỉ tốn ~200 token và Claude tự bỏ qua; chặn nhầm một việc thật thì mất
 * đúng thứ chế độ này sinh ra để bắt.
 */
export const CONSIDER_MIN_CHARS = 25;
const trivial = (prompt) => prompt.trim().length < CONSIDER_MIN_CHARS || prompt.trimStart().startsWith("/");

/** Bỏ các khối `<system-reminder>` app chèn kèm prompt. */
export const stripReminders = (text) => String(text ?? "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

/**
 * Prompt này từ đâu tới: `user` (người gõ, hay session cha giao việc lúc mở
 * session con), `peer` (session khác nhắn qua lại), `injected` (app tự chèn:
 * `<task-notification>`, `<side-sessions-event>`, khối nhắc hệ thống trơn).
 *
 * Đo ở Digital Project 08–09/11: 110/115 lần gate bắn là tin của session khác,
 * phần lớn là báo cáo trạng thái. Tin tự chèn không phải việc mới; tin peer có
 * thể là việc (cha giao thêm cho con) nên vẫn được cân nhắc, nhưng không bị bắt
 * ghi dòng quyết định.
 */
export function promptKind(prompt) {
  const text = stripReminders(prompt);
  if (/^Another Claude session sent a message|^<cross-session-message\b/.test(text)) return "peer";
  if (!text || text.startsWith("<")) return "injected";
  return "user";
}

/**
 * `{branch: none|mention|delegate|consider|dispatch|suggest, hits: [{id, kind}]}`.
 *
 * Repo `delegate: "aggressive"` không còn chỉ dựa vào từ khoá (07/11): MỌI prompt
 * đủ dài đều được chèn bước cân nhắc, vì từ khoá bỏ sót việc thật ("làm cái
 * dashboard") còn Claude đọc yêu cầu thì không. Khớp từ khoá → `delegate`
 * (nghiêng về giao); không khớp → `consider` (vẫn phải cân nhắc). Mention và
 * costGate vẫn xét trước, như mọi chế độ.
 */
export function classify(prompt, { routingTriggers = [], costGate = [], delegate = "default" } = {}) {
  if (typeof prompt !== "string" || promptKind(prompt) === "injected") return { branch: "none", hits: [] };
  prompt = stripReminders(prompt);
  const m = MENTION.exec(prompt);
  if (m) return { branch: "mention", hits: [{ id: `mention-${m[2].toLowerCase() === "codex" ? "codex" : "anti"}`, kind: "mention" }] };
  if (prompt.length < 8) return { branch: "none", hits: [] };
  if (mentionsPaidApi(prompt, costGate)) return { branch: "none", hits: [] };
  const hits = routingTriggers.filter((t) => t.re.test(prompt)).map(({ id, kind }) => ({ id, kind }));
  if (delegate === "aggressive") {
    if (hits.length) return { branch: "delegate", hits };
    return { branch: trivial(prompt) ? "none" : "consider", hits };
  }
  if (!hits.length) return { branch: "none", hits: [] };
  return { branch: new Set(hits.map((h) => h.kind)).size >= 2 ? "dispatch" : "suggest", hits };
}

/** Nhãn đầu dòng quyết định Claude phải ghi; hook Stop đọc lại nhãn này để ghi log. */
export const DECISION_LABEL = "Định tuyến:";

/**
 * Phần chung của `delegate` và `consider`: tách việc thành phần, hỏi từng phần.
 *
 * Bản 07/11 bắt chọn MỘT tuyến cho cả việc. Đo 08–09/11: việc nào cũng có một
 * mảng cần nhìn ảnh hay phán đoán, nên Claude chọn "tự làm" cho cả việc rồi làm
 * luôn phần cơ học — 22/23 lượt ≥10 tool call không giao gì, có lượt 160 tool
 * call. Câu hỏi đúng là "phần nào giao được", không phải "việc này giao được không".
 */
const CONSIDER_BODY = [
  "Trước khi bắt đầu, **tách việc thành các phần** rồi hỏi từng phần — đừng chọn một tuyến",
  "cho cả việc. Áp cho mọi loại việc: code, làm hình/video, dữ liệu, tài liệu.",
  "- Codex hoặc Anti (`--tier code`, > 30 phút thì `--chain`): sửa/viết code nhiều file, script",
  "  dựng hình/video, xử lý ảnh hay dữ liệu hàng loạt, đổi theo một quy tắc đã rõ. Có spec và",
  "  lệnh kiểm (`--accept-cmd`) thì Anti nhận được, chọn bên còn quota; việc còn mở thì Codex;",
  "- Anti (`--tier standard`): research, tra cứu, tổng hợp, việc theo rule có sẵn;",
  "- session con: phần đáng thành task riêng (nhánh/PR riêng, chạy song song lâu);",
  "- Claude giữ: phần cần nhìn và phán đoán (chọn ý, duyệt hình, quyết thiết kế, nghiệp vụ),",
  "  phần cần công cụ worker không có (vd. Chrome), và nghiệm thu bằng chứng.",
  "Phần Claude giữ chạy song song với job đã giao. Tự làm cả việc chỉ khi cả việc ước",
  "< ~10 lượt gọi tool **và** < 3 file, hoặc không phần nào tách ra được — nói vì sao.",
  "Worker từng lỗi không phải lý do bỏ giao: lỗi transport thì báo owner; bối cảnh dài thì để",
  "vào file trong thư mục run thay vì nhồi vào brief.",
  "Nếu lượt này là một việc cần làm (không phải câu hỏi ngắn, xác nhận hay trò chuyện), câu đầu",
  `trả lời ghi đúng một dòng: \`${DECISION_LABEL} Codex: <phần> · Anti: <phần> · tự làm: <phần> — <lý do ngắn>\``,
  "(bỏ phần không có), hoặc `" + DECISION_LABEL + " tự làm hết — <vì sao không tách được>`.",
  "Đây là **bước cân nhắc**, không phải lệnh: đọc yêu cầu thật (kể cả phần owner dán từ nguồn",
  "ngoài) rồi tự quyết.",
];

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
  if (branch === "delegate" || branch === "consider") {
    const lean = branch === "delegate"
      ? `Repo bật giao việc chủ động; prompt khớp từ khoá ${ids} — nghiêng về giao.`
      : "Repo bật giao việc chủ động.";
    return ["## Định tuyến crew", "", lean, ...CONSIDER_BODY, ""].join("\n");
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
