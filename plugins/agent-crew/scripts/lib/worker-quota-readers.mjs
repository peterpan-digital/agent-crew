/**
 * Đọc quota còn lại của Codex và Antigravity mà không gọi model nào.
 *
 * Vì sao có (07/11): job giao xong mới biết worker hết quota thì mất trọn một
 * vòng dispatch -- brief, ghi sổ, chờ, đọc fail -- cho một câu trả lời đã có sẵn
 * từ trước. Cả hai CLI đều tự khai quota, miễn phí:
 *
 *   Codex  `codex app-server`, JSON-RPC `account/rateLimits/read`. Đo 07/11:
 *          < 1s, trả % đã dùng của cửa sổ 5h và tuần, giờ hồi, credits, và số
 *          lượt reset miễn phí. Không mở thread, không tốn token.
 *   Anti   `agy -p /quota --output-format json`. Đo 07/11: ~5s, `usage` toàn 0,
 *          trả % còn lại theo nhóm model (Gemini; Claude và GPT), mỗi nhóm có
 *          cửa sổ 5h và tuần.
 *
 * Cả hai đều là giao diện của bên thứ ba và có thể đổi hình. Nên mọi hỏng hóc --
 * không có CLI, chưa đăng nhập, hết giờ, JSON lạ -- ra `{ ok: false, error }`,
 * không bao giờ throw: không đọc được quota không phải lý do để chặn job.
 *
 * Hình chung trả về:
 *   { ok: true, worker, groups: [{ name, models, isDefault, blocked, overflow,
 *     buckets: [{ window, remaining, resetsAt }] }], resetCredits }
 * `remaining` là phần còn lại 0..1; `resetsAt` là Date hoặc null.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const CODEX_TIMEOUT_MS = 10_000;
const AGY_TIMEOUT_MS = 30_000;

const windowLabel = (mins) => (mins === 300 ? "5h" : mins === 10080 ? "tuần" : `${mins}m`);
const asDate = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Một khối `rateLimits` của Codex → một nhóm theo hình chung. */
function codexGroup(rl, isDefault) {
  const buckets = ["primary", "secondary"]
    .map((k) => rl?.[k])
    .filter((b) => b && Number.isFinite(b.usedPercent))
    .map((b) => ({ window: windowLabel(b.windowDurationMins), remaining: clamp01(1 - b.usedPercent / 100), resetsAt: asDate(b.resetsAt) }));
  return {
    name: rl?.limitName ?? (isDefault ? "hạn mức chung" : rl?.limitId ?? "?"),
    models: rl?.normalModelSlug ? [rl.normalModelSlug] : null,
    isDefault,
    // Codex tự nói đã chạm trần, hoặc đã chạm trần chi tiêu: tin nó hơn con số %.
    blocked: Boolean(rl?.rateLimitReachedType) || rl?.spendControlReached === true,
    // Có credits (hoặc gói không giới hạn) thì hết hạn mức vẫn chạy được, chỉ là tiêu credits.
    overflow: rl?.credits?.hasCredits === true || rl?.credits?.unlimited === true,
    buckets,
  };
}

/** Kết quả `account/rateLimits/read` → hình chung. Tách riêng để test không cần spawn. */
export function normalizeCodexQuota(result) {
  if (!result || typeof result !== "object" || !result.rateLimits) return { ok: false, worker: "codex", error: "app-server không trả rateLimits" };
  const byId = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === "object" ? result.rateLimitsByLimitId : null;
  const defaultId = result.rateLimits.limitId;
  const groups = byId
    ? Object.values(byId).map((rl) => codexGroup(rl, rl?.limitId === defaultId))
    : [codexGroup(result.rateLimits, true)];
  if (result.ordinaryUsageAllowed === false) for (const g of groups) g.blocked = true;
  const resetCredits = Number(result.rateLimitResetCredits?.availableCount ?? 0) || 0;
  return { ok: true, worker: "codex", groups, resetCredits };
}

/** Kết quả JSON của `agy -p /quota` → hình chung; thiếu `command.data` thì đọc dòng TSV trong `response`. */
/**
 * Tên hiển thị của các model trong một nhóm quota agy. JSON `/quota` không có
 * trường model: danh sách nằm trong câu `Models within this group: Gemini 4 Neon,
 * Orchestrator (Neon), …` của `description` (đo 23/11). Nhóm không có câu đó (nhóm
 * "Gemini 4 Argon") thì chính tên nhóm là tên model.
 */
export function agyGroupLabels(g) {
  const desc = typeof g.description === "string" ? g.description : "";
  const at = desc.indexOf("Models within this group:");
  if (at === -1) return g.name ? [String(g.name)] : [];
  const rest = desc.slice(at + "Models within this group:".length);
  const end = rest.search(/[.!?](\s|$)|\n/);
  return (end === -1 ? rest : rest.slice(0, end)).split(",").map((s) => s.trim()).filter(Boolean);
}

export function normalizeAgyQuota(json) {
  const fromData = json?.command?.data?.groups;
  let groups;
  if (Array.isArray(fromData)) {
    groups = fromData.map((g) => ({
      name: String(g.name ?? "?"),
      labels: agyGroupLabels(g),
      buckets: (g.buckets ?? [])
        .filter((b) => Number.isFinite(b.remaining_fraction))
        .map((b) => ({ window: b.window === "weekly" ? "tuần" : String(b.window ?? "?"), remaining: clamp01(b.remaining_fraction), resetsAt: asDate(b.reset_time) })),
    }));
  } else if (typeof json?.response === "string") {
    // "Gemini Models\tWeekly Limit Remaining\t49%\t2026-11-07T04:14:51Z"
    const byName = new Map();
    for (const line of json.response.split("\n")) {
      const [name, label, pct, reset] = line.split("\t");
      const n = Number.parseFloat(pct);
      if (!name || !label || !Number.isFinite(n)) continue;
      if (!byName.has(name)) byName.set(name, { name, buckets: [] });
      byName.get(name).buckets.push({ window: /week/i.test(label) ? "tuần" : /five|5/i.test(label) ? "5h" : label, remaining: clamp01(n / 100), resetsAt: asDate(reset) });
    }
    groups = [...byName.values()];
  }
  if (!groups?.length) return { ok: false, worker: "antigravity", error: "agy /quota không có nhóm quota nào" };
  for (const g of groups) Object.assign(g, { models: null, isDefault: false, blocked: false, overflow: false });
  return { ok: true, worker: "antigravity", groups, resetCredits: 0 };
}

/** Chạy lệnh, gom stdout; hết giờ thì giết. Không throw. */
function collect(cmd, args, { timeoutMs, onLine, stdinLines = [] }) {
  return new Promise((done) => {
    let out = "";
    let err = "";
    let settled = false;
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill("SIGTERM"); } catch { /* đã chết */ }
      done(value);
    };
    const timer = setTimeout(() => finish({ error: `${cmd} không trả lời sau ${timeoutMs / 1000}s` }), timeoutMs);
    try {
      child = spawn(cmd, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      finish({ error: `không chạy được ${cmd}: ${e.message}` });
      return;
    }
    child.on("error", (e) => finish({ error: `không chạy được ${cmd}: ${e.message}` }));
    child.stdin.on("error", () => { /* con đóng stdin sớm: kết quả nằm ở exit */ });
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => {
      out += d;
      if (!onLine) return;
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        const r = onLine(line, (o) => child.stdin.write(`${JSON.stringify(o)}\n`));
        if (r !== undefined) { finish(r); return; }
      }
    });
    child.on("exit", (code) => finish(code === 0 && !onLine ? { out } : { error: `${cmd} exit ${code}: ${err.trim().split("\n")[0] || "không có stderr"}` }));
    for (const o of stdinLines) child.stdin.write(`${JSON.stringify(o)}\n`);
  });
}

export async function readCodexQuota({ cmd = "codex", timeoutMs = CODEX_TIMEOUT_MS } = {}) {
  const r = await collect(cmd, ["app-server"], {
    timeoutMs,
    stdinLines: [{ id: 1, method: "initialize", params: { clientInfo: { name: "crew-quota", version: "1" } } }],
    onLine(line, send) {
      let m;
      try { m = JSON.parse(line); } catch { return undefined; }
      if (m.id === 1) {
        if (m.error) return { error: `app-server từ chối initialize: ${m.error.message ?? "?"}` };
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read" });
        return undefined;
      }
      if (m.id === 2) return m.error ? { error: `app-server: ${m.error.message ?? "lỗi không tên"}` } : { result: m.result };
      return undefined;
    },
  });
  return r.error ? { ok: false, worker: "codex", error: r.error } : normalizeCodexQuota(r.result);
}

export async function readAntiQuota({ cmd = "agy", timeoutMs = AGY_TIMEOUT_MS } = {}) {
  const r = await collect(cmd, ["-p", "/quota", "--output-format", "json"], { timeoutMs });
  if (r.error) return { ok: false, worker: "antigravity", error: r.error };
  let json;
  try { json = JSON.parse(r.out); } catch { return { ok: false, worker: "antigravity", error: "agy /quota không in ra JSON" }; }
  return normalizeAgyQuota(json);
}

export const readQuota = (worker) => (worker === "codex" ? readCodexQuota() : readAntiQuota());
