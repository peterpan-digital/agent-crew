/**
 * Job FAIL đã có job khác làm thay: `replacedJobs[]` trong manifest.
 *
 * Ca thật lặp lại ở 4/6 run để dở (05-07/10): job đầu chết không evidence (brief
 * quá trần, SIGTERM, timeout), dispatcher bắn một job mới làm đúng việc đó và job
 * mới PASS. Không có đường nào đóng run: `--abandon` cố ý chỉ nhận STALE, hold
 * `cost_gate` chỉ cho job BLOCKED. Kết quả là report viết tay, manifest đỏ mãi,
 * và bảng "Crew còn dở" đầu phiên không bao giờ sạch.
 *
 * Khác `cover` của hold ở hai chỗ, đều có lý do:
 *   - Không đòi cùng `conversationId`. Lần thử lại thường là phiên mới (brief gọn
 *     hơn, model khác), nên nối theo conversation thì ca thật không đi được.
 *   - Không đòi lời owner. Đây không phải chuyện cho phép chi tiêu mà là chuyện
 *     người đọc xác nhận job sau làm đủ phạm vi job trước — cùng loại câu với
 *     `--ack-runtime`, nên cũng chỉ cần `--reason` của người đọc.
 *
 * Ba rào giữ cho bản ghi nói đúng điều người đọc đã thấy:
 *   - Ghim lần chạy và evidence: mỗi bản ghi mang `startedAt` của cả hai job và sha
 *     evidence job thay lúc khai. Một trong ba đổi thì bản ghi hết tác dụng — câu
 *     "đã đọc" không bảo lãnh được bản chưa ai đọc.
 *   - Vân tay: worker ghi được manifest, nên claim chụp vân tay `replacedJobs`, adapter
 *     giữ một bản trong bộ nhớ và so lại ở mọi đường thoát
 *     (`crew-manifest.holdsTamperPatch`). Khai mới bị từ chối khi run còn job chạy, nên
 *     mọi thay đổi giữa claim và thoát là của worker.
 *
 * Rủi ro còn lại, chung cho mọi sổ trong manifest (`holds`, `runtimeAcks`,
 * `dismissedPaths`): worker app chạy tiếp SAU khi adapter thoát (đã đo: ghi evidence
 * 28 giây sau) thì không còn ai so. Bản ghi giả đủ ghim lúc đó qua được cổng. Muốn chặn
 * phải giữ vân tay ngoài workspace — chưa làm. Người đọc report thấy dòng "Job X hỏng,
 * job Y làm thay" mà không nhớ đã khai thì coi là sự cố.
 *   - Một job thay chỉ dùng được một lần, tính cả `coveredBy` của hold.
 *
 * Job hỏng vẫn nằm trong sổ với verdict REPLACED (không biến mất như CANCELLED), và
 * mọi điều kiện được tính lại ở mỗi lần collect.
 *
 * Hàm thuần trên object manifest, giống `holds.mjs`; người gọi bọc trong lock.
 */
import { createHash } from "node:crypto";
import { liveJobs } from "./holds.mjs";

export const REASON_MAX = 500;

/** Vân tay `replacedJobs`. Vắng thì giống mảng rỗng. */
export function replacedFingerprint(list) {
  return createHash("sha256").update(JSON.stringify(list ?? [])).digest("hex");
}

/** Lý do để in: một dòng, có trần. Bản ghi tay hoặc giả có thể chứa xuống dòng. */
export function cleanReason(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
}

/** `1=3` → { seq: 1, by: 3 }. */
export function parseReplaceSpec(v) {
  if (v && typeof v === "object") return { seq: v.seq, by: v.by };
  const m = /^(\d+)=(\d+)$/.exec(String(v ?? "").trim());
  if (!m) throw new Error(`--replaced cần <seq job hỏng>=<seq job làm thay>, nhận "${v}"`);
  return { seq: Number(m[1]), by: Number(m[2]) };
}

/**
 * Vì sao `by` không thay được `seq`, hoặc null. Chỉ kiểm hình dạng; verdict tính
 * riêng vì nó đổi theo từng lần collect.
 *
 * Một job làm thay chỉ thay được MỘT việc: không có rào này thì một job PASS xoá đỏ
 * được cả run. "Việc" tính cả hold đã được job đó cover.
 */
export function replaceProblem(m, seq, by) {
  const failed = m.jobs.find((j) => j.seq === seq);
  const sub = m.jobs.find((j) => j.seq === by);
  if (!failed) return `run không có job ${seq}`;
  if (!sub) return `run không có job ${by}`;
  if (!(by > seq)) return `job làm thay (${by}) phải có seq lớn hơn job hỏng (${seq})`;
  if (sub.worker !== failed.worker) return `job ${by} là ${sub.worker}, job ${seq} là ${failed.worker} — chỉ cùng worker mới thay được`;
  const taken = (m.replacedJobs ?? []).find((r) => r.by === by && r.seq !== seq);
  if (taken) return `job ${by} đã làm thay job ${taken.seq} — một job chỉ thay được một job hỏng`;
  const hold = (m.holds ?? []).find((h) => h.status !== "superseded" && h.coveredBy === by);
  if (hold) return `job ${by} đã cover hold ${hold.id} của job ${hold.seq} — một job chỉ thay được một việc`;
  return null;
}

/**
 * Kiểm và dựng bản ghi mới. `verdictOf(seq)` là verdict gốc của gate (chụp trước
 * khi dòng nào bị sửa), để job COVERED/REPLACED không được dùng làm job thay.
 * `digestOf(seq)` là sha evidence hiện tại của job.
 *
 * Từ chối khi run còn job pending/running: job thay có thể đang bị chính worker
 * sửa evidence, và câu "đã đọc" phải nói về bản cuối.
 */
export function buildReplacements(m, specs, reason, verdictOf, digestOf, now = new Date()) {
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error(
      "--replaced cần --reason \"<đã đọc evidence job làm thay, nó phủ đủ việc của job hỏng vì sao>\"\n" +
      "  → không có câu này thì lần sau không ai biết job hỏng bị bỏ qua dựa trên cái gì",
    );
  }
  const r = reason.replace(/\s+/g, " ").trim();
  if (r.length > REASON_MAX) throw new Error(`--reason dài ${r.length} ký tự, tối đa ${REASON_MAX}`);
  const out = [];
  const seenBy = new Map();
  for (const spec of specs) {
    const { seq, by } = parseReplaceSpec(spec);
    const v = verdictOf(seq);
    if (v !== "FAIL") {
      const hint = v === "STALE" ? " — job treo không evidence thì bỏ bằng --abandon"
        : v === "BLOCKED" ? " — job BLOCKED đi qua hold (crew-hold answer/cover), vì đó là câu của owner"
        : "";
      throw new Error(`--replaced ${seq}=${by}: job ${seq} đang là ${v ?? "không rõ"}, chỉ job FAIL mới thay được${hint}`);
    }
    if (verdictOf(by) !== "PASS") throw new Error(`--replaced ${seq}=${by}: job ${by} đang là ${verdictOf(by) ?? "không rõ"}, job làm thay phải PASS`);
    const problem = replaceProblem(m, seq, by);
    if (problem) throw new Error(`--replaced ${seq}=${by}: ${problem}`);
    if (seenBy.has(by) && seenBy.get(by) !== seq) {
      throw new Error(`--replaced ${seq}=${by}: job ${by} đã được khai thay job ${seenBy.get(by)} trong cùng lệnh`);
    }
    seenBy.set(by, seq);
    const failed = m.jobs.find((j) => j.seq === seq);
    const sub = m.jobs.find((j) => j.seq === by);
    out.push({
      seq, by, reason: r, at: now.toISOString(),
      seqAttempt: failed.startedAt ?? null, byAttempt: sub.startedAt ?? null, bySha: digestOf(by) ?? null,
    });
  }
  // Sau phần kiểm từng cặp: job STALE cũng mang status `running`, và nó cần được chỉ
  // sang --abandon chứ không phải nghe "đợi job chạy xong".
  const live = liveJobs(m);
  if (live.length) {
    throw new Error(
      `--replaced: run còn job đang chạy hoặc chờ chạy (${live.map((j) => `${j.seq}:${j.status}`).join(", ")})\n` +
      "  → đợi các job đó xong rồi mới nhận",
    );
  }
  return out;
}

/** Gộp vào manifest: cùng seq thì bản mới thay bản cũ. */
export function mergeReplacements(existing, fresh) {
  return [...(existing ?? []).filter((e) => !fresh.some((f) => f.seq === e.seq)), ...fresh];
}

/**
 * Verdict của job hỏng khi có bản ghi thay. Trả null khi bản ghi không áp dụng
 * (job gốc giờ không FAIL nữa, ví dụ evidence đã xuất hiện) để dòng giữ nguyên.
 */
export function replacedVerdict(m, entry, verdictOf, digestOf) {
  if (verdictOf(entry.seq) !== "FAIL") return null;
  const problem = replaceProblem(m, entry.seq, entry.by);
  if (problem) return { verdict: "FAIL", detail: `job làm thay không còn hợp lệ: ${problem}` };
  const failed = m.jobs.find((j) => j.seq === entry.seq);
  const sub = m.jobs.find((j) => j.seq === entry.by);
  if ((failed.startedAt ?? null) !== (entry.seqAttempt ?? null) || (sub.startedAt ?? null) !== (entry.byAttempt ?? null)) {
    return { verdict: "FAIL", detail: `job ${entry.seq} hoặc ${entry.by} đã chạy lại sau lần khai --replaced, khai lại sau khi đọc` };
  }
  if (!entry.bySha || digestOf(entry.by) !== entry.bySha) {
    return { verdict: "FAIL", detail: `evidence job ${entry.by} khác bản đã đọc lúc khai --replaced, đọc lại rồi khai lại` };
  }
  const v = verdictOf(entry.by);
  if (v !== "PASS") return { verdict: "FAIL", detail: `job làm thay ${entry.by} giờ là ${v ?? "không rõ"}, không còn PASS` };
  return { verdict: "REPLACED", detail: `job ${entry.by} làm thay — "${cleanReason(entry.reason)}"` };
}
