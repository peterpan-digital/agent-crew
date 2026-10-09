/**
 * Hàng chờ quyết định của một run: `holds[]` trong manifest.
 *
 * Một hold là một câu hỏi chờ owner. Hai loại:
 *
 *   cost_gate  collect tự tạo khi job BLOCKED vì COST_GATE. Là thứ duy nhất có
 *              thể đổi verdict, vì nó thay cho việc "nhớ hỏi user" bằng một dòng
 *              dữ liệu mà gate đọc được.
 *   decision   dispatcher tạo bằng CLI cho việc cần owner chốt mà không phải
 *              cổng chi phí. KHÔNG BAO GIỜ đổi verdict; chỉ hiện ra cho người đọc.
 *
 * Mọi thứ ở đây là hàm thuần trên object manifest (không đọc/ghi file, không lock),
 * để `crew-manifest` (lớp dưới cùng) import được mà không kéo cả gate theo.
 * Người gọi bọc trong `updateManifest`.
 *
 * Quy tắc chặn worker giả câu trả lời nằm ở đây vì nó là điều kiện của dữ liệu,
 * không của CLI: `assertHoldsWritable` từ chối khi run còn job pending/running, và
 * `holdsFingerprint` là thứ adapter so lại ở mọi đường thoát.
 */
import { createHash } from "node:crypto";

export class HoldError extends Error {
  constructor(message) {
    super(message);
    this.name = "HoldError";
  }
}

export const HOLD_LIMITS = { question: 300, options: 5, option: 120, words: 500, deferDays: 14, api: 40 };
export const OUTCOMES = new Set(["drop", "resume"]);

/**
 * Vân tay của `holds`. Vắng thì giống mảng rỗng, để manifest cũ (chưa có field
 * này) và manifest vừa được thêm `holds: []` không bị tính là khác nhau.
 */
export function holdsFingerprint(holds) {
  return createHash("sha256").update(JSON.stringify(holds ?? [])).digest("hex");
}

/**
 * Tên API chờ duyệt, cắt về chữ, số, khoảng trắng và `/`, tối đa 40 ký tự.
 *
 * Đây là chỗ duy nhất text của evidence được phép đi tiếp vào hold (và từ hold vào
 * stdout, vào digest). Cho nên là một giới hạn ký tự + độ dài, không phải danh sách
 * từ cấm: nó đúng với cả những chuỗi chưa ai nghĩ tới. Rỗng thì ghi `unknown`.
 * Không có danh sách API biết trước: module crew công khai, và danh sách thật của
 * workspace nằm ở SKILL.md mục Cost gate.
 */
export function sanitizeApi(raw) {
  const cleaned = String(raw ?? "")
    .replace(/[^\p{L}\p{N} /]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, HOLD_LIMITS.api)
    .trim();
  return cleaned || "unknown";
}

/**
 * Tên API sau `COST_GATE — `, hoặc null nếu `text` không nhắc COST_GATE.
 *
 * Chỉ nhận chỗ có dấu `—`/`:`/`-` theo sau: evidence thật hay chép lại luật của brief
 * ("trả trạng thái `BLOCKED / COST_GATE`.") trước dòng `Concerns/Blockers: COST_GATE —
 * Gemini API ...`, và lấy chỗ nhắc đầu tiên thì ra `unknown` dù tên nằm ngay dưới
 * (đo trên run crew-260918-1136). Tên bị cắt ở dấu ngắt mệnh đề đầu tiên, vì phần sau
 * là lời kể của worker chứ không phải tên API. Khoảng trắng sau dấu gạch chỉ là
 * space/tab: `\s` ăn luôn xuống dòng, và khi tên để trống thì dòng `Status:` kế bên
 * sẽ bị đọc thành tên API. Có nhắc COST_GATE mà không có tên nào thì `unknown`.
 */
export function extractCostGateApi(text) {
  const body = String(text ?? "");
  if (!body.includes("COST_GATE")) return null;
  for (const hit of body.matchAll(/COST_GATE[ \t]*[—–:-][ \t]*([^\n]*)/g)) {
    // `:` cũng cắt: lý do chặn của hook cổng chi phí ("COST_GATE — Ahrefs: lệnh này…") bị worker
    // chép nguyên văn vào evidence, và đọc tới hết câu thì tên API thành cả một mệnh đề (đo 09/10).
    const name = sanitizeApi(hit[1].split(/[,;.(:]/)[0]);
    if (name !== "unknown") return name;
  }
  return "unknown";
}

/**
 * Job dừng ở COST_GATE vì API **hết lượt miễn phí** ("quota") hay vì **sắp tốn tiền**
 * ("cost"). Hai ca hỏi owner hai câu khác nhau: hết lượt thì chưa ai bị tính tiền, và
 * lựa chọn thật là chờ hôm sau, làm cách khác, hay bỏ.
 *
 * Trả về nhãn cố định, không trả chữ nào của evidence. Chỉ đọc chính các dòng có
 * `COST_GATE —`: evidence hay kể chuyện quota ở chỗ khác trong khi job vẫn dừng vì
 * chi phí, và đọc cả file thì một câu kể lạc chỗ đổi được câu hỏi.
 */
const QUOTA_HINT = /quota|\b429\b|resource_exhausted|free[ -]?tier|rate[ -]?limit|\bRP[DM]\b|hết lượt|hạn ngạch/i;

export function costGateKind(text) {
  for (const hit of String(text ?? "").matchAll(/COST_GATE[ \t]*[—–:-][ \t]*([^\n]*)/g)) {
    if (QUOTA_HINT.test(hit[1])) return "quota";
  }
  return "cost";
}

/**
 * Worker hay ghi luôn lý do sau tên API ("Gemini API 20 RPD free tier quota…"), và
 * `api` của hold giữ nguyên chuỗi đó vì nó là khoá của `holdFor`. Chỉ câu hiển thị
 * cắt về tên, để câu hỏi không lặp "quota … hết lượt miễn phí".
 */
export function quotaApiName(api) {
  const name = String(api ?? "").split(/[\s,;(]+(?=\d|quota|free|rate|429|RP[DM]\b|resource|daily|hết|hạn)/i)[0].trim();
  return name || String(api ?? "");
}

/** Câu hỏi của hold cổng chi phí. Hold cũ không có `reason` vẫn đọc như "cost". */
export function costGateQuestion(seq, api, reason) {
  return reason === "quota"
    ? `Job ${seq} dừng vì ${quotaApiName(api)} hết lượt miễn phí, chưa tốn tiền`
    : `Job ${seq} chờ duyệt chi phí ${api}`;
}

const isLiveHold = (h) => h.status !== "superseded";

export const liveJobs = (m) => m.jobs.filter((j) => j.status === "pending" || j.status === "running");

/**
 * Suốt thời gian có job chạy, `holds` không được đổi. Đó là cả cơ chế: worker ghi
 * được manifest (cả `tasks/{task}/` là phạm vi hợp lệ), nên cách duy nhất để một câu
 * trả lời không phải của worker là không cho ai ghi trong lúc worker còn sống.
 */
export function assertHoldsWritable(m) {
  const live = liveJobs(m);
  if (live.length) {
    throw new HoldError(
      `run còn job đang chạy hoặc chờ chạy (${live.map((j) => `${j.seq}:${j.status}`).join(", ")}) — không ghi hold lúc này\n` +
      "  → đợi các job đó xong; job treo không evidence thì bỏ bằng crew-collect --abandon <seq>",
    );
  }
}

function nextId(holds) {
  const max = holds.reduce((n, h) => Math.max(n, Number(/^h(\d+)$/.exec(h.id)?.[1] ?? 0)), 0);
  return `h${max + 1}`;
}

function jobOf(m, seq) {
  const job = m.jobs.find((j) => j.seq === seq);
  if (!job) throw new HoldError(`run không có job ${seq}`);
  return job;
}

/** Chuỗi người gõ: gộp khoảng trắng, bắt buộc không rỗng, quá dài thì từ chối chứ không cắt. */
function text(value, name, max) {
  if (typeof value !== "string" || !value.trim()) throw new HoldError(`${name} không được rỗng`);
  const out = value.replace(/\s+/g, " ").trim();
  if (out.length > max) throw new HoldError(`${name} dài ${out.length} ký tự, tối đa ${max}`);
  return out;
}

/** Hold của đúng lần chạy hiện tại của job, theo khoá `(seq, attempt, api)`. */
export function holdFor(m, job, api) {
  const attempt = job.startedAt ?? null;
  return (m.holds ?? []).find((h) =>
    h.kind === "cost_gate" && h.seq === job.seq && isLiveHold(h) && h.attempt === attempt && h.api === api) ?? null;
}

/**
 * Bảo đảm job BLOCKED vì COST_GATE có hold cho lần chạy hiện tại.
 *
 * Khoá theo `attempt` (= `startedAt` lúc tạo) chứ không theo seq: retry cùng seq mà
 * ăn lại câu trả lời cũ nghĩa là owner đã duyệt chi phí cho một lần chạy khác.
 * Evidence của chính lần chạy này đổi sang API khác thì hold cũ không còn khớp
 * câu hỏi nữa nên bị `superseded`.
 */
export function ensureCostGateHold(m, job, api, now = new Date(), reason = "cost") {
  m.holds = m.holds ?? [];
  const found = holdFor(m, job, api);
  if (found) return { hold: found, created: false };
  const attempt = job.startedAt ?? null;
  for (const h of m.holds) {
    if (h.kind === "cost_gate" && h.seq === job.seq && h.attempt === attempt && isLiveHold(h)) h.status = "superseded";
  }
  const hold = {
    id: nextId(m.holds),
    seq: job.seq,
    attempt,
    kind: "cost_gate",
    api,
    reason,
    question: costGateQuestion(job.seq, api, reason),
    options: [],
    status: "open",
    createdAt: now.toISOString(),
    createdBy: "collect",
  };
  m.holds.push(hold);
  return { hold, created: true };
}

/** Hold `decision`: câu hỏi của dispatcher, không bao giờ đổi verdict. */
export function addDecisionHold(m, { seq, question, options = [] }, now = new Date()) {
  assertHoldsWritable(m);
  const job = jobOf(m, seq);
  const q = text(question, "question", HOLD_LIMITS.question);
  if (options.length > HOLD_LIMITS.options) throw new HoldError(`tối đa ${HOLD_LIMITS.options} option, nhận ${options.length}`);
  m.holds = m.holds ?? [];
  const hold = {
    id: nextId(m.holds),
    seq,
    attempt: job.startedAt ?? null,
    kind: "decision",
    question: q,
    options: options.map((o, i) => text(o, `option ${i + 1}`, HOLD_LIMITS.option)),
    status: "open",
    createdAt: now.toISOString(),
    createdBy: "dispatcher",
  };
  m.holds.push(hold);
  return hold;
}

function holdById(m, id) {
  const hold = (m.holds ?? []).find((h) => h.id === id);
  if (!hold) throw new HoldError(`không có hold ${id}`);
  if (hold.status === "superseded") throw new HoldError(`hold ${id} đã bị thay bằng lần chạy mới của job ${hold.seq}, không còn tác dụng`);
  return hold;
}

/** Ghi nguyên văn câu owner gõ. Một hold chỉ trả lời một lần. */
export function answerHold(m, id, { words, outcome, via = "chat" }, now = new Date()) {
  assertHoldsWritable(m);
  const hold = holdById(m, id);
  if (hold.status === "answered") throw new HoldError(`hold ${id} đã được trả lời`);
  if (!OUTCOMES.has(outcome)) throw new HoldError(`--outcome phải là drop hoặc resume, nhận ${JSON.stringify(outcome ?? null)}`);
  const v = String(via ?? "chat").toLowerCase();
  if (!/^[a-z0-9_-]{1,20}$/.test(v)) throw new HoldError("--via chỉ gồm chữ thường, số, _ và -, tối đa 20 ký tự");
  hold.status = "answered";
  hold.answer = { words: text(words, "--words", HOLD_LIMITS.words), outcome, via: v, at: now.toISOString() };
  return hold;
}

const localDay = (d) => d.toLocaleDateString("sv-SE");
const dayMs = (s) => Date.parse(`${s}T00:00:00Z`);

/**
 * Hoãn tối đa 14 ngày. Chỉ ẩn hold khỏi digest tới ngày đó; gate vẫn chặn, vì
 * "hoãn" mà mở được cổng chi phí thì thành đường lách COST_GATE.
 */
export function deferHold(m, id, { until, words }, now = new Date()) {
  assertHoldsWritable(m);
  const hold = holdById(m, id);
  if (hold.status === "answered") throw new HoldError(`hold ${id} đã được trả lời, không hoãn được nữa`);
  if (typeof until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(until) || new Date(dayMs(until)).toISOString().slice(0, 10) !== until) {
    throw new HoldError(`--until cần dạng YYYY-MM-DD hợp lệ, nhận ${JSON.stringify(until ?? null)}`);
  }
  const days = Math.round((dayMs(until) - dayMs(localDay(now))) / 86_400_000);
  if (days < 1 || days > HOLD_LIMITS.deferDays) {
    throw new HoldError(`--until phải trong 1-${HOLD_LIMITS.deferDays} ngày tới (tính từ ${localDay(now)}), nhận ${until}`);
  }
  hold.status = "deferred";
  hold.until = until;
  hold.deferWords = text(words, "--words", HOLD_LIMITS.words);
  return hold;
}

/**
 * Vì sao `bySeq` không thể cover hold này, hoặc null nếu hợp lệ.
 *
 * Nối bằng `conversationId` trùng chứ không bằng `resumedFrom`: field đó 0/213 job
 * có, nên luật dựa vào nó thì ca thật (job 3/4 resume job 1/2) không bao giờ đi
 * được. `resumedFrom` vẫn được nhận khi adapter có ghi. App mode tự ghi
 * `conversationId` bằng id dispatcher gõ nên liên kết này yếu hơn ở app.
 * Chỉ kiểm hình dạng ở đây; verdict PASS của job cover tính lại ở mỗi lần collect.
 */
export function coverProblem(m, hold, bySeq) {
  if (hold.kind !== "cost_gate") return "chỉ hold cost_gate mới có job cover";
  if (hold.status !== "answered" || hold.answer?.outcome !== "resume") return "hold phải được trả lời --outcome resume trước";
  const blocked = m.jobs.find((j) => j.seq === hold.seq);
  const cover = m.jobs.find((j) => j.seq === bySeq);
  if (!blocked) return `không còn job ${hold.seq}`;
  if (!cover) return `run không có job ${bySeq}`;
  if (cover.worker !== blocked.worker) return `job ${bySeq} là ${cover.worker}, job bị chặn là ${blocked.worker} — chỉ cùng worker mới nối được`;
  if (!(cover.seq > blocked.seq)) return `job cover (${bySeq}) phải có seq lớn hơn job bị chặn (${blocked.seq})`;
  const replacing = (m.replacedJobs ?? []).find((r) => r.by === bySeq);
  if (replacing) return `job ${bySeq} đã làm thay job ${replacing.seq} (--replaced) — một job chỉ thay được một việc`;
  if (cover.resumeMismatch) return `job ${bySeq} có resumeMismatch: runtime không resume đúng phiên, không phải lượt tiếp của job ${blocked.seq}`;
  const sameConv = blocked.conversationId != null && cover.conversationId === blocked.conversationId;
  const sameResume = blocked.conversationId != null && cover.resumedFrom === blocked.conversationId;
  if (!sameConv && !sameResume) {
    return `job ${bySeq} không cùng conversationId với job ${blocked.seq} (và không resumedFrom nó) — không chứng minh được là lượt tiếp`;
  }
  return null;
}

export function coverHold(m, id, bySeq, now = new Date()) {
  assertHoldsWritable(m);
  const hold = holdById(m, id);
  const problem = coverProblem(m, hold, bySeq);
  if (problem) throw new HoldError(problem);
  hold.coveredBy = bySeq;
  hold.coveredAt = now.toISOString();
  return hold;
}

/**
 * Hold làm job BLOCKED vì COST_GATE đổi verdict thành gì. `verdictOf(seq)` là verdict
 * GỐC của từng job (chụp trước khi sửa dòng nào), để chuỗi cover không tự cover nhau.
 *
 * | hold                       | verdict  | chặn |
 * | open                       | BLOCKED  | có   |
 * | deferred                   | DEFERRED | có   |
 * | answered drop              | WAIVED   | không|
 * | answered resume, chưa cover| BLOCKED  | có   |
 * | answered resume + cover PASS | COVERED| không|
 */
export function holdVerdict(m, hold, verdictOf) {
  if (hold.status === "open") return { verdict: "BLOCKED", detail: `${hold.id} chờ owner: ${hold.question}` };
  if (hold.status === "deferred") return { verdict: "DEFERRED", detail: `${hold.id} hoãn tới ${hold.until}, gate vẫn chặn` };
  // `--via` khác chat (dispatcher tự bỏ một job thử chẳng hạn) thì không được in là lời owner.
  const via = hold.answer?.via ?? "chat";
  const said = `${via === "chat" ? "owner nói" : `${via} ghi`}: "${hold.answer?.words ?? ""}"`;
  if (hold.answer?.outcome === "drop") return { verdict: "WAIVED", detail: `${hold.id} bỏ việc này — ${said}` };
  if (hold.coveredBy == null) return { verdict: "BLOCKED", detail: `${hold.id} owner cho chạy tiếp (${said}) nhưng chưa có job cover` };
  const problem = coverProblem(m, hold, hold.coveredBy);
  if (problem) return { verdict: "BLOCKED", detail: `${hold.id} cover job ${hold.coveredBy} không còn hợp lệ: ${problem}` };
  if (verdictOf(hold.coveredBy) !== "PASS") {
    return { verdict: "BLOCKED", detail: `${hold.id} job cover ${hold.coveredBy} chưa PASS (${verdictOf(hold.coveredBy) ?? "không rõ"})` };
  }
  return { verdict: "COVERED", detail: `${hold.id} job ${hold.coveredBy} làm xong — ${said}` };
}

/**
 * Claim lại seq: hold của lần chạy cũ hết tác dụng. Trả về true nếu có hold đổi.
 * Gọi trong lock của `claimRunSlot`, nên không qua `assertHoldsWritable` (job đang
 * được claim chính là job `pending` làm điều kiện đó fail).
 */
export function supersedeSeq(m, seq, newAttempt) {
  let changed = false;
  for (const h of m.holds ?? []) {
    if (h.seq === seq && isLiveHold(h) && h.attempt !== newAttempt) {
      h.status = "superseded";
      changed = true;
    }
  }
  return changed;
}
