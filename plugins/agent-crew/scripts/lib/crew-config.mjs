/**
 * Phần luật của `crew.config.json` — những gì máy phải đọc được, ngoài layout:
 *
 *   routingTriggers  việc nào hook gợi ý chia cho worker (regex trên prompt)
 *   routingLog       nơi hook ghi lượt bắn để chấm gate (không có = không ghi)
 *   costGate         API tính tiền theo lượt: worker gặp thì dừng, trả COST_GATE
 *
 * Luật viết bằng lời (task tạo ở đâu, đóng task thế nào, connector nào cấm) nằm
 * ở CLAUDE.md/AGENTS.md của dự án — agent đọc được văn xuôi, hook thì không.
 *
 * Một trigger khớp tên API trong costGate bị từ chối ngay lúc nạp: bản gate đầu
 * tiên trigger đúng vào API tốn tiền và inject vào mọi prompt một chỉ thị tự gọi
 * chúng. Đó là đường lách cổng chi phí, không phải tối ưu token.
 */
import { CONFIG_NAME, LayoutError, assertRelPath, loadLayout, readConfigRaw } from "./crew-layout.mjs";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function fail(msg) {
  throw new LayoutError(`${CONFIG_NAME}: ${msg}`);
}

/** `[{api, via?}]` hoặc `["Tên API"]` → `[{api, via}]`. */
function normalizeCostGate(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("costGate phải là mảng");
  const seen = new Set();
  return value.map((e, i) => {
    const entry = typeof e === "string" ? { api: e } : e;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`costGate[${i}] phải là chuỗi hoặc {api, via}`);
    const extra = Object.keys(entry).filter((k) => k !== "api" && k !== "via");
    if (extra.length) fail(`costGate[${i}]: khoá lạ ${extra.join(", ")} (nhận: api, via)`);
    const api = typeof entry.api === "string" ? entry.api.trim() : "";
    // Tên API là thứ collect đọc sau `COST_GATE — ` (cắt ở , ; . ( :), nên tên
    // có mấy ký tự đó sẽ không bao giờ khớp lại được.
    if (!api || /[,;.(:\n]/.test(api)) fail(`costGate[${i}].api phải là tên ngắn, không có , ; . ( : — nhận ${JSON.stringify(entry.api)}`);
    if (seen.has(api.toLowerCase())) fail(`costGate: "${api}" khai hai lần`);
    seen.add(api.toLowerCase());
    if (entry.via !== undefined && (typeof entry.via !== "string" || !entry.via.trim())) fail(`costGate[${i}].via phải là chuỗi`);
    return Object.freeze({ api, via: entry.via?.trim() ?? null });
  });
}

function compileTriggers(value, costGate) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("routingTriggers phải là mảng");
  const ids = new Set();
  return value.map((t, i) => {
    if (!t || typeof t !== "object" || Array.isArray(t)) fail(`routingTriggers[${i}] phải là {id, kind, pattern}`);
    const extra = Object.keys(t).filter((k) => !["id", "kind", "pattern"].includes(k));
    if (extra.length) fail(`routingTriggers[${i}]: khoá lạ ${extra.join(", ")} (nhận: id, kind, pattern)`);
    if (typeof t.id !== "string" || !ID_RE.test(t.id)) fail(`routingTriggers[${i}].id phải là chữ thường-gạch nối: ${JSON.stringify(t.id)}`);
    if (ids.has(t.id)) fail(`routingTriggers: id "${t.id}" khai hai lần`);
    ids.add(t.id);
    if (typeof t.kind !== "string" || !ID_RE.test(t.kind)) fail(`routingTriggers[${i}].kind phải là chữ thường-gạch nối: ${JSON.stringify(t.kind)}`);
    if (t.kind === "mention") fail(`routingTriggers[${i}].kind "mention" là nhánh có sẵn, không khai được`);
    if (typeof t.pattern !== "string" || !t.pattern) fail(`routingTriggers[${i}].pattern phải là regex dạng chuỗi`);
    let re;
    try {
      re = new RegExp(t.pattern, "i");
    } catch (err) {
      fail(`routingTriggers[${i}].pattern không phải regex hợp lệ: ${err.message}`);
    }
    if (re.test("")) fail(`routingTriggers[${i}].pattern khớp cả chuỗi rỗng — sẽ bắn vào mọi prompt`);
    const paid = costGate.find(({ api }) => re.test(api));
    if (paid) fail(`routingTriggers[${i}] ("${t.id}") khớp API tốn tiền "${paid.api}" — việc tốn tiền không được gợi ý chia việc`);
    return Object.freeze({ id: t.id, kind: t.kind, re });
  });
}

/**
 * Layout + luật của workspace. Không có config thì mọi luật rỗng: hook routing
 * im lặng, worker contract không có dòng cost gate.
 */
export function loadCrewConfig(workspace) {
  const layout = loadLayout(workspace);
  const raw = readConfigRaw(workspace) ?? {};
  const costGate = normalizeCostGate(raw.costGate);
  const routingTriggers = compileTriggers(raw.routingTriggers, costGate);
  let routingLog = null;
  if (raw.routingLog !== undefined && raw.routingLog !== null) {
    try {
      assertRelPath("routingLog", raw.routingLog);
    } catch (err) {
      fail(err.message);
    }
    if (/[{}]/.test(raw.routingLog)) fail(`routingLog không nhận {task}/{run}: "${raw.routingLog}"`);
    routingLog = raw.routingLog;
  }
  return Object.freeze({ layout, routingTriggers: Object.freeze(routingTriggers), routingLog, costGate: Object.freeze(costGate) });
}

/** Prompt có nhắc API tốn tiền nào không (so tên, không phân biệt hoa thường). */
export function mentionsPaidApi(text, costGate) {
  const lower = String(text ?? "").toLowerCase();
  return costGate.find(({ api }) => lower.includes(api.toLowerCase())) ?? null;
}
