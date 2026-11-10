/**
 * Phán quota của một worker đủ để bắn job hay không, và in nó ra cho người đọc.
 *
 * Luật (07/11):
 *   - Chỉ xét nhóm quota mà model của job tiêu. Anti tách nhóm Gemini và nhóm
 *     Claude/GPT: job `--tier light` không nên bị chặn vì nhóm Claude cạn.
 *   - Một cửa sổ (5h hoặc tuần) còn dưới EMPTY_FRACTION, hoặc CLI tự nói đã chạm
 *     trần → "cạn": job sẽ chết ngay lượt đầu, nên `crew run` từ chối.
 *   - Còn dưới LOW_FRACTION → "thấp": vẫn bắn, kèm cảnh báo.
 *   - Cửa sổ đã qua giờ hồi thì coi như đầy, dù con số đọc được còn cũ.
 *   - Không đọc được quota, hoặc không biết model thuộc nhóm nào mà còn nhóm chưa
 *     cạn → không chặn. Chặn nhầm một job tốn hơn để nó fail như trước đây.
 *   - Codex có credits (hoặc gói không giới hạn) thì cạn hạn mức vẫn chạy được,
 *     tiêu credits: hạ xuống "thấp" và nói rõ.
 */
export const EMPTY_FRACTION = 0.01;
export const LOW_FRACTION = 0.1;
/**
 * Ngưỡng "thấp" cho job lớn (`--chain`, effort high/xhigh). Đo 11/11: lúc bắn
 * Codex còn trên 10% nên cổng im, rồi một job effort high (8,1 triệu token vào)
 * cộng job kế tiếp ăn hết cửa sổ 5h giữa chừng.
 */
export const BIG_JOB_LOW_FRACTION = 0.3;
/** Exit của `crew run` khi từ chối vì quota cạn. Sổ không đổi, job vẫn `pending`. */
export const QUOTA_EXIT = 5;

const NAMES = { codex: "Codex", antigravity: "Anti" };

/** Giờ hồi theo giờ máy: "06:31" nếu trong ngày, không thì "14/11 01:31". */
export function formatReset(date, now = new Date()) {
  if (!date) return "không rõ giờ hồi";
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(date.getHours())}:${p(date.getMinutes())}`;
  return date.toDateString() === now.toDateString() ? hm : `${p(date.getDate())}/${p(date.getMonth() + 1)} ${hm}`;
}

/** Họ model của Anti: "gemini" | "claude-gpt" | null (không biết). Bậc app flash/pro là Gemini. */
export function antiFamily(model) {
  if (!model) return null;
  if (/^gemini/i.test(model) || /^(flash|flash_lite|pro)$/.test(model)) return "gemini";
  if (/^(claude|gpt)/i.test(model)) return "claude-gpt";
  return null;
}

/** Nhóm quota mà job sẽ tiêu, và job có biết chắc nhóm đó không. */
export function relevantGroups(quota, model) {
  if (quota.worker === "codex") {
    const own = quota.groups.filter((g) => model && g.models?.includes(model));
    if (own.length) return { groups: own, known: true };
    const dflt = quota.groups.filter((g) => g.isDefault);
    return dflt.length ? { groups: dflt, known: true } : { groups: quota.groups, known: false };
  }
  const family = antiFamily(model);
  const match = { gemini: /gemini/i, "claude-gpt": /claude|gpt/i }[family];
  const own = match ? quota.groups.filter((g) => match.test(g.name)) : [];
  return own.length ? { groups: own, known: true } : { groups: quota.groups, known: false };
}

/** Phần còn lại hiệu lực của một cửa sổ: qua giờ hồi rồi thì đầy. */
const effective = (b, now) => (b.resetsAt && b.resetsAt <= now ? 1 : b.remaining);

function groupState(g, now, low = LOW_FRACTION) {
  const rem = g.buckets.map((b) => effective(b, now));
  const min = rem.length ? Math.min(...rem) : 1;
  const empty = g.blocked || min < EMPTY_FRACTION;
  if (empty && g.overflow) return "overflow";
  if (empty) return "empty";
  return min < low ? "low" : "ok";
}

/** Một dòng cho một nhóm: "Gemini Models: tuần còn 49% (hồi 11:14) · 5h còn 99% (hồi 05:30)". */
export function describeGroup(g, now = new Date()) {
  const parts = g.buckets.map((b) => {
    const pct = Math.round(effective(b, now) * 100);
    const passed = b.resetsAt && b.resetsAt <= now;
    return `${b.window} còn ${pct}%${passed ? " (đã hồi)" : ` (hồi ${formatReset(b.resetsAt, now)})`}`;
  });
  const flags = [g.blocked ? "CLI báo đã chạm trần" : null, g.overflow ? "có credits" : null].filter(Boolean);
  return `${g.name}: ${parts.join(" · ") || "không có cửa sổ nào"}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
}

/**
 * { level: "ok"|"low"|"empty"|"unknown", lines, message }.
 * `message` là câu cho stderr của `crew run` (null khi không có gì đáng nói).
 */
export function quotaVerdict(quota, { model, now = new Date(), bigJob = false } = {}) {
  const name = NAMES[quota.worker] ?? quota.worker;
  if (!quota.ok) {
    return { level: "unknown", lines: [], message: `crew run: không đọc được quota ${name} (${quota.error}) — vẫn bắn` };
  }
  const { groups, known } = relevantGroups(quota, model);
  const states = groups.map((g) => groupState(g, now, bigJob ? BIG_JOB_LOW_FRACTION : LOW_FRACTION));
  const lines = groups.map((g) => describeGroup(g, now));
  const scope = known ? "" : ` (không rõ model${model ? ` ${model}` : ""} tiêu nhóm nào — xét mọi nhóm)`;
  // Không biết nhóm thì chỉ chặn khi mọi nhóm đều cạn.
  const allEmpty = states.length > 0 && states.every((s) => s === "empty");
  if (allEmpty) {
    const credits = quota.resetCredits > 0
      ? `\n  Tài khoản còn ${quota.resetCredits} lượt reset miễn phí — muốn dùng thì bấm trong app/CLI Codex (crew không tự dùng).`
      : "";
    return {
      level: "empty",
      lines,
      message: `crew run: CHƯA BẮN — ${name} cạn quota${scope}:\n  ${lines.join("\n  ")}`
        + "\n  Sổ không đổi, job vẫn pending: bắn lại sau giờ hồi, đổi worker/bậc, hoặc thêm --quota-check off nếu chắc chắn."
        + credits,
    };
  }
  const warn = states.some((s) => s === "low" || s === "overflow" || s === "empty");
  if (!warn) return { level: "ok", lines, message: null };
  const overflow = states.includes("overflow") ? "\n  Hạn mức đã cạn nhưng tài khoản có credits: job sẽ tiêu credits." : "";
  const big = bigJob && states.includes("low")
    ? `\n  Job lớn (chain/effort cao) dễ ăn hết phần còn lại giữa chừng: cân nhắc chẻ nhỏ, hạ effort hoặc giao worker khác.`
    : "";
  return { level: "low", lines, message: `crew run: quota ${name} thấp${scope} — vẫn bắn:\n  ${lines.join("\n  ")}${overflow}${big}` };
}
