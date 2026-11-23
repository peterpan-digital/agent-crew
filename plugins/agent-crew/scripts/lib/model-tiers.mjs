/**
 * Bậc model: Claude chọn một chữ, crew đổi ra tên model còn sống hoặc `--effort`.
 *
 * Trước đây dispatcher phải chạy `crew doctor`, đọc danh sách `agy models`, rồi tự
 * ghép tên vào `--model`. Tên ghép từ trí nhớ đã giết job (đo 16/10: hai job đầu
 * của một run chết ngay lượt đầu vì tên trong tài liệu đã hết hạn). Ở đây tên được
 * chọn từ chính danh sách `agy models` trả về lúc ghi sổ, nên không thể là tên chết.
 *
 * Luật chọn tên cho Anti headless:
 *   - mọi regex neo đầu-cuối, để `flash` không khớp nhầm `flash-lite`;
 *   - regex đi lần lượt, regex đầu có khớp thì dừng;
 *   - trong một regex khớp nhiều model thì lấy số phiên bản cao nhất;
 *   - không khớp gì thì báo lỗi kèm tên còn sống. KHÔNG rơi sang model của bậc
 *     khác: `light` mà ra `flash-high` là âm thầm đổi giá và đổi chất lượng.
 *
 * Bậc `claude`/`claude-max` chạy model Claude bằng quota Antigravity (chỉ Anti
 * headless, đo 06/11 trong docs/transport-measurements.md). Chúng nằm ngoài chuỗi
 * nâng bậc: đổi nhà cung cấp là quyết định có chủ ý, không phải bước tự động.
 *
 * Codex: mỗi bậc chọn cả model lẫn effort, theo cùng luật regex trên catalog
 * Codex (`~/.codex/models_cache.json`, thiếu thì `codex debug models`). Trước
 * 2.2.0 bậc Codex chỉ đổi effort và model ăn theo config máy, nên `--tier code`
 * ép `high` lên đúng model mà owner đặt `xhigh` — giao qua crew chạy yếu hơn gõ tay.
 * Bảng dòng → bậc dựa trên mô tả catalog và tài liệu OpenAI (research 07/11,
 * .crew/runs/261107-0030): Luna nhẹ/rẻ, Terra cân bằng, Sol chủ lực cho code,
 * Astra đỉnh cho việc khó nhất. `ultra` (tự chia subagent) cố ý không vào bảng:
 * nó trùng việc chia job của chính crew và nhân token theo số subagent.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class TierError extends Error {}

export const TIERS = Object.freeze(["light", "standard", "deep", "code", "max", "claude", "claude-max"]);

/** Bậc mà `agentapi` (Anti app) nhận. */
export const APP_TIERS = Object.freeze(["flash_lite", "flash", "pro", "inherit"]);
/** Mức Codex khai được trong `modelTiers` (ultra để ép tay bằng --effort, không vào bảng). */
export const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/**
 * `agy`: regex (chuỗi, neo ^...$) theo thứ tự ưu tiên; null = bậc không dành cho
 * Anti headless. `app`: bậc agentapi; null = không dùng được ở Anti app.
 * `codex`: regex trên slug catalog Codex; `effort`: mức Codex. Cả hai null = bậc
 * không dành cho Codex.
 */
const SOL = "^gpt-[\\d.]+-sol$";
/*
 * Anti headless, từ agy 1.5.x tên model là `<dòng>-<effort>` (đo 23/11:
 * gemini-4-hydrogen-medium, gemini-4-neon-high, claude-sonnet-5-5-high). Mỗi regex
 * chỉ khớp ĐÚNG MỘT mức effort: `versionOf` chỉ đọc cụm số, nên neon-high và
 * neon-xhigh cùng là [4] và hoà nhau — khi hoà, `pickModel` giữ tên in trước trong
 * `agy models`, tức là một regex nhiều effort sẽ âm thầm chọn effort theo thứ tự in.
 * Dòng Gemini 4 xếp trước Flash 3.8: Hydrogen là model thi hành nhanh (Executor của
 * Orchestrator), Neon cho việc cần suy luận. Argon không vào bậc nào ở đây: nó tiêu
 * một nhóm quota riêng chỉ hồi theo tuần. Regex tên cũ giữ lại làm dự phòng cho máy
 * còn agy bản trước.
 */
export const DEFAULT_TIER_MAP = Object.freeze({
  light: { agy: ["^gemini-[\\d.]+-hydrogen-low$", "^gemini-[\\d.]+-flash-lite$", "^gemini-[\\d.]+-flash-low$"], app: "flash_lite", codex: ["^gpt-[\\d.]+-luna$"], effort: "low" },
  standard: { agy: ["^gemini-[\\d.]+-hydrogen-medium$", "^gemini-[\\d.]+-flash-medium$"], app: "flash", codex: ["^gpt-[\\d.]+-terra$"], effort: "medium" },
  deep: { agy: ["^gemini-[\\d.]+-neon-high$", "^gemini-[\\d.]+-pro-high$", "^gemini-[\\d.]+-pro$", "^gemini-[\\d.]+-flash-high$"], app: "pro", codex: [SOL], effort: "xhigh" },
  code: { agy: null, app: null, codex: [SOL], effort: "high" },
  max: { agy: null, app: null, codex: ["^gpt-[\\d.]+-astra$"], effort: "max" },
  claude: { agy: ["^claude-sonnet-[\\d-]+-high$", "^claude-sonnet-[\\d-]+$"], app: null, codex: null, effort: null },
  "claude-max": { agy: ["^claude-opus-[\\d-]+-high$", "^claude-opus-[\\d-]+(-thinking)?$"], app: null, codex: null, effort: null },
});

/**
 * Chuỗi nâng bậc khi job trước chưa đạt: `light → standard → deep`, rồi với
 * Codex `deep`/`code → max` (Astra). Anti không có bậc `max` nên dừng ở `deep`.
 * Bậc ngoài chuỗi (`claude*`, `max`) đứng yên.
 */
const BUMP = Object.freeze({ light: "standard", standard: "deep" });
const CODEX_BUMP = Object.freeze({ ...BUMP, deep: "max", code: "max" });

export function bumpTier(tier, worker = null) {
  assertTier(tier);
  return (worker === "codex" ? CODEX_BUMP : BUMP)[tier] ?? tier;
}

function assertTier(tier) {
  if (!TIERS.includes(tier)) throw new TierError(`--tier phải là ${TIERS.join("|")}, nhận "${tier ?? ""}"`);
}

/** Tên model `agy models` còn liệt kê: cột đầu mỗi dòng, bỏ dòng thông báo. */
export function parseAgyModels(text) {
  return String(text).split("\n").map((l) => l.split("\t")[0].trim()).filter((s) => /^[a-z0-9][a-z0-9.-]+$/.test(s));
}

/** Model Codex đang đặt trong config máy, hoặc null. */
export function codexConfigModel(home = homedir()) {
  try {
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(home, ".codex", "config.toml"), "utf8"));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Model Codex dùng được: `[{slug, efforts}]` từ cache catalog của chính Codex
 * (`~/.codex/models_cache.json`, model ẩn bị bỏ). Không có cache thì hỏi
 * `codex debug models`. Không đọc được thì lỗi nói rõ đường tay.
 */
export function liveCodexModels(home = homedir()) {
  const parse = (text) => (JSON.parse(text).models ?? [])
    .filter((m) => m?.slug && m.visibility !== "hide")
    .map((m) => ({ slug: m.slug, efforts: (m.supported_reasoning_levels ?? []).map((l) => l?.effort ?? l).filter(Boolean) }));
  let models = [];
  try { models = parse(readFileSync(join(home, ".codex", "models_cache.json"), "utf8")); } catch { /* thử lệnh */ }
  if (!models.length) {
    const p = spawnSync("codex", ["debug", "models"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    try { if (p.status === 0) models = parse(p.stdout); } catch { /* báo dưới */ }
  }
  if (!models.length) {
    throw new TierError("không đọc được catalog model của Codex (~/.codex/models_cache.json, `codex debug models`) để đổi --tier\n  → truyền --effort <mức> tay; model lấy theo ~/.codex/config.toml");
  }
  return models;
}

/** Gọi `agy models` (30s như doctor). Không đọc được thì lỗi nói rõ đường tay. */
export function liveAgyModels() {
  const p = spawnSync("agy", ["models"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  const names = p.status === 0 ? parseAgyModels(p.stdout) : [];
  if (!names.length) {
    const why = p.error?.message ?? (`${p.stderr ?? ""}`.trim().split("\n")[0] || "không có tên model nào");
    throw new TierError(`không đọc được \`agy models\` để đổi --tier ra tên model: ${why}\n  → truyền --model <tên> tay (crew doctor in tên còn sống)`);
  }
  return names;
}

/** Số phiên bản trong tên: `gemini-3.8-flash-medium` → [3,8]; `claude-sonnet-4-6` → [4,6]. */
const versionOf = (name) => (name.match(/\d+/g) ?? []).map(Number);

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/** Tên đầu tiên khớp theo thứ tự regex, bản cao nhất trong regex đó; không có thì null. */
export function pickModel(patterns, names) {
  for (const p of patterns) {
    const re = new RegExp(p);
    const hits = names.filter((n) => re.test(n));
    if (hits.length) return hits.reduce((best, n) => (compareVersions(versionOf(n), versionOf(best)) > 0 ? n : best));
  }
  return null;
}

/** Bảng mặc định với phần ghi đè `modelTiers` của repo (đã validate ở crew-config). */
export function tierMap(overrides = {}) {
  return Object.fromEntries(TIERS.map((t) => [t, { ...DEFAULT_TIER_MAP[t], ...(overrides[t] ?? {}) }]));
}

/**
 * Đổi một bậc ra thứ adapter nhận: `{tier, model, effort}`. Anti headless cần
 * `liveAgyModels`, Codex cần `liveCodexModels` (`[{slug, efforts}]`). Truyền `null`
 * thì chỉ kiểm bậc có hợp worker/transport không (cờ tay đã chọn), không chọn tên.
 */
export function resolveTier({ worker, transport = "headless", tier, liveAgyModels: names = [], liveCodexModels: codexModels = [], overrides = {} }) {
  assertTier(tier);
  const row = tierMap(overrides)[tier];
  if (worker === "claude") {
    throw new TierError("job Claude không nhận --tier: Claude tự làm bằng model của phiên, truyền --model");
  }
  if (worker === "codex") {
    if (!row.codex || !row.effort) throw new TierError(`tier ${tier} chỉ cho Anti headless (model Claude chạy qua quota Antigravity); Codex nhận light|standard|deep|code|max`);
    if (codexModels === null) return { tier, model: null, effort: null };
    const slugs = codexModels.map((m) => m.slug);
    const model = pickModel(row.codex, slugs);
    if (!model) {
      throw new TierError(
        `tier ${tier} không khớp model Codex nào trong catalog (${row.codex.join(", ")})\n` +
        `  → model Codex còn liệt kê: ${slugs.join(", ") || "(không có)"}\n` +
        "  → truyền --effort tay (model theo config máy), hoặc khai modelTiers trong crew.config.json",
      );
    }
    const efforts = codexModels.find((m) => m.slug === model)?.efforts ?? [];
    if (efforts.length && !efforts.includes(row.effort)) {
      throw new TierError(`tier ${tier}: ${model} không nhận effort ${row.effort} (nhận: ${efforts.join(", ")}) — khai modelTiers.${tier}.effort`);
    }
    return { tier, model, effort: row.effort };
  }
  if ((tier === "code" || tier === "max") && !row.agy && !row.app) throw new TierError(`tier ${tier} chỉ cho Codex`);
  if (transport === "app") {
    if (!row.app) throw new TierError(`tier ${tier} không dùng được ở Anti app: agentapi chỉ nhận ${APP_TIERS.join("|")}`);
    return { tier, model: row.app, effort: null };
  }
  if (!row.agy) throw new TierError(`tier ${tier} không có model cho Anti headless`);
  if (names === null) return { tier, model: null, effort: null };
  const model = pickModel(row.agy, names);
  if (!model) {
    throw new TierError(
      `tier ${tier} không khớp model nào \`agy models\` còn liệt kê (${row.agy.join(", ")})\n` +
      `  → model còn sống: ${names.join(", ") || "(không có)"}\n` +
      "  → truyền --model <tên> tay, hoặc khai modelTiers trong crew.config.json",
    );
  }
  return { tier, model, effort: null };
}

/**
 * Validate `modelTiers` trong crew.config.json: `{ "<tier>": {agy?, app?, codex?, effort?} }`.
 * `fail(msg)` ném lỗi theo kiểu của config loader.
 */
export function normalizeModelTiers(value, fail) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail("modelTiers phải là object {tier: {agy?, app?, codex?, effort?}}");
  const out = {};
  for (const [tier, row] of Object.entries(value)) {
    if (!TIERS.includes(tier)) fail(`modelTiers: tier lạ "${tier}" (nhận: ${TIERS.join(", ")})`);
    if (!row || typeof row !== "object" || Array.isArray(row)) fail(`modelTiers.${tier} phải là {agy?, app?, codex?, effort?}`);
    const extra = Object.keys(row).filter((k) => !["agy", "app", "codex", "effort"].includes(k));
    if (extra.length) fail(`modelTiers.${tier}: khoá lạ ${extra.join(", ")} (nhận: agy, app, codex, effort)`);
    const entry = {};
    for (const key of ["agy", "codex"]) {
      if (!(key in row)) continue;
      const list = row[key];
      if (!Array.isArray(list) || !list.length) fail(`modelTiers.${tier}.${key} phải là mảng regex dạng chuỗi, không rỗng`);
      list.forEach((p, i) => {
        if (typeof p !== "string" || !p.startsWith("^") || !p.endsWith("$")) fail(`modelTiers.${tier}.${key}[${i}] phải là regex neo ^...$: ${JSON.stringify(p)}`);
        try { new RegExp(p); } catch (err) { fail(`modelTiers.${tier}.${key}[${i}] không phải regex hợp lệ: ${err.message}`); }
      });
      entry[key] = Object.freeze([...list]);
    }
    if ("app" in row) {
      if (!APP_TIERS.includes(row.app)) fail(`modelTiers.${tier}.app phải là ${APP_TIERS.join("|")}: ${JSON.stringify(row.app)}`);
      entry.app = row.app;
    }
    if ("effort" in row) {
      if (!EFFORTS.includes(row.effort)) fail(`modelTiers.${tier}.effort phải là ${EFFORTS.join("|")}: ${JSON.stringify(row.effort)}`);
      entry.effort = row.effort;
    }
    out[tier] = Object.freeze(entry);
  }
  return Object.freeze(out);
}
