#!/usr/bin/env node
/**
 * Bậc model `--tier`: một chữ đổi ra tên model còn sống hoặc `--effort`.
 *
 * Ca đáng giữ nhất là ca KHÔNG chọn: list thiếu model của bậc thì phải lỗi, không
 * được trượt sang model bậc khác. Một `light` ra `flash-high` vẫn chạy được, nên
 * không ai thấy giá và chất lượng đã đổi.
 *
 * Run: node plugins/agent-crew/tests/model-tiers.test.mjs
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  DEFAULT_TIER_MAP, TIERS, TierError, bumpTier, normalizeModelTiers, parseAgyModels, pickModel, resolveTier,
} from "../scripts/lib/model-tiers.mjs";
import { loadCrewConfig } from "../scripts/lib/crew-config.mjs";
import { makeChecker, tmpWorkspace } from "./helpers.mjs";

const t = makeChecker("model-tiers");

/** `agy models` đo ngày 06/11. Không có Gemini Pro, không có flash-lite. */
const LIST_1106 = [
  "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
  "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium",
];
const anti = (tier, names = LIST_1106, extra = {}) => resolveTier({ worker: "antigravity", tier, liveAgyModels: names, ...extra });
const err = (fn) => {
  try { fn(); return "no throw"; } catch (e) { return e instanceof TierError ? e.message : `wrong error: ${e.message}`; }
};

// --- Anti headless, list 06/11 ---------------------------------------------
t.check("light → flash-low (flash-lite chưa có)", anti("light").model, "gemini-3.8-flash-low");
t.check("standard → flash-medium", anti("standard").model, "gemini-3.8-flash-medium");
t.check("deep → flash-high (không có Pro: regex thứ 3 của chính bậc deep)", anti("deep").model, "gemini-3.8-flash-high");
t.check("claude → claude-sonnet-4-6", anti("claude").model, "claude-sonnet-4-6");
t.check("claude-max → claude-opus-4-6-thinking", anti("claude-max").model, "claude-opus-4-6-thinking");
t.check("...và không ghi effort cho Anti", `${anti("claude").effort}`, "null");
t.check("code ở Anti với list 06/11 (không có neon-high) → lỗi không khớp", err(() => anti("code")).startsWith("tier code không khớp"), true);
t.check("max ở Anti với list 06/11 (không có argon-high/neon-xhigh) → lỗi không khớp", err(() => anti("max")).startsWith("tier max không khớp"), true);
t.check("gpt-oss không vào bậc nào", TIERS.some((tier) => { try { return /gpt-oss/.test(anti(tier).model); } catch { return false; } }), false);

// --- Anti headless, list 23/11 (agy 1.5.15): tên `<dòng>-<effort>` ----------------
// Trước bản vá, list này cho mọi bậc ra Flash 3.8 và hai bậc claude* không khớp gì.
const LIST_1123 = [
  "gemini-4-neon-high", "gemini-4-neon-xhigh", "gemini-4-neon-medium", "gemini-4-neon-low",
  "gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-low",
  "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-low",
  "gemini-pro-orchestrator-neon", "gemini-pro-orchestrator-g1-pro",
  "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
  "claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-opus-5-5-high",
  "claude-sonnet-5-5-low", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-high", "gpt-oss-120b-medium",
];
t.check("1123 light → hydrogen-low", anti("light", LIST_1123).model, "gemini-4-hydrogen-low");
t.check("1123 standard → hydrogen-medium", anti("standard", LIST_1123).model, "gemini-4-hydrogen-medium");
t.check("1123 deep → neon-high", anti("deep", LIST_1123).model, "gemini-4-neon-high");
t.check("1123 code → neon-high, effort null", `${anti("code", LIST_1123).model}|${anti("code", LIST_1123).effort}`, "gemini-4-neon-high|null");
t.check("1123 max → argon-high (ưu tiên trước neon-xhigh), effort null", `${anti("max", LIST_1123).model}|${anti("max", LIST_1123).effort}`, "gemini-4-argon-high|null");
t.check("1123 max: không có argon-high → rơi sang neon-xhigh", anti("max", LIST_1123.filter((m) => !m.includes("argon"))).model, "gemini-4-neon-xhigh");
t.check("1123 max: neon-xhigh in trước argon-high vẫn chọn argon-high", anti("max", ["gemini-4-neon-xhigh", "gemini-4-argon-high"]).model, "gemini-4-argon-high");
t.check("1123 code: thiếu neon-high → lỗi không khớp, không trượt sang neon-xhigh/flash-high",
  err(() => anti("code", ["gemini-4-neon-xhigh", "gemini-3.8-flash-high"])).startsWith("tier code không khớp"), true);
t.check("1123 max: thiếu cả argon-high và neon-xhigh → lỗi không khớp",
  err(() => anti("max", ["gemini-4-neon-high", "gemini-4-argon-medium"])).startsWith("tier max không khớp"), true);
t.check("1123 claude → sonnet-5-5-high", anti("claude", LIST_1123).model, "claude-sonnet-5-5-high");
t.check("1123 claude-max → opus-5-5-high", anti("claude-max", LIST_1123).model, "claude-opus-5-5-high");
t.check("1123 không bậc nào ra Orchestrator",
  TIERS.some((tier) => { try { return /orchestrator/.test(anti(tier, LIST_1123).model); } catch { return false; } }), false);
t.check("1123 Argon chỉ vào bậc max",
  TIERS.filter((tier) => tier !== "max").some((tier) => { try { return /argon/.test(anti(tier, LIST_1123).model); } catch { return false; } }), false);
// Effort không được chọn theo thứ tự in: xhigh in trước high vẫn ra high.
t.check("deep: neon-xhigh in trước neon-high vẫn ra high", anti("deep", ["gemini-4-neon-xhigh", "gemini-4-neon-high"]).model, "gemini-4-neon-high");
t.check("deep: chỉ có neon-xhigh → rơi sang flash-high, không lấy xhigh", anti("deep", ["gemini-4-neon-xhigh", "gemini-3.8-flash-high"]).model, "gemini-3.8-flash-high");
t.check("claude: chỉ có sonnet-medium → lỗi, không tự đổi effort", err(() => anti("claude", ["claude-sonnet-5-5-medium"])).startsWith("tier claude không khớp"), true);
t.check("claude: 5-5-high thắng 4-6-high", anti("claude", ["claude-sonnet-4-6-high", "claude-sonnet-5-5-high"]).model, "claude-sonnet-5-5-high");

// --- không fallback chéo bậc ------------------------------------------------
{
  const noLow = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium"];
  const msg = err(() => anti("light", noLow));
  t.check("list không có flash-low/lite → light lỗi", msg.startsWith("tier light không khớp"), true);
  t.check("...không ra flash-medium hay high", /flash-(medium|high)$/.test(String(msg.split("\n")[0])), false);
  t.check("...và lỗi liệt kê tên còn sống", msg.includes("gemini-3.8-flash-high, gemini-3.8-flash-medium"), true);
  t.check("...gợi --model tay hoặc modelTiers", /--model <tên>/.test(msg) && /modelTiers/.test(msg), true);
  t.check("list rỗng → lỗi, không throw kiểu khác", err(() => anti("standard", [])).startsWith("tier standard không khớp"), true);
  // Regex neo: "flash" không được khớp "flash-lite" khi bảng ghi đè dùng regex lỏng.
  t.check("regex neo: flash-medium không khớp flash-medium-preview", pickModel(DEFAULT_TIER_MAP.standard.agy, ["gemini-3.8-flash-medium-preview"]), "null");
}

// --- chọn bản cao nhất trong một regex, regex trước thắng -----------------------
t.check("hai bản flash-medium → lấy bản cao", anti("standard", ["gemini-3.5-flash-medium", "gemini-3.10-flash-medium", "gemini-3.8-flash-medium"]).model, "gemini-3.10-flash-medium");
t.check("có Pro thì deep ra Pro, không ra flash-high", anti("deep", ["gemini-3.8-flash-high", "gemini-4.0-pro-high"]).model, "gemini-4.0-pro-high");
t.check("flash-lite thắng flash-low (regex trước)", anti("light", ["gemini-3.8-flash-low", "gemini-3.1-flash-lite"]).model, "gemini-3.1-flash-lite");
t.check("claude: bản 4-7 thắng 4-6", anti("claude", ["claude-sonnet-4-6", "claude-sonnet-4-7"]).model, "claude-sonnet-4-7");
t.check("claude-max nhận cả opus không -thinking", anti("claude-max", ["claude-opus-5-0"]).model, "claude-opus-5-0");

// --- Anti app, Codex, Claude ------------------------------------------------
t.check("anti app standard → flash", anti("standard", [], { transport: "app" }).model, "flash");
t.check("anti app deep → pro", anti("deep", [], { transport: "app" }).model, "pro");
t.check("anti app code → lỗi", err(() => anti("code", [], { transport: "app" })).startsWith("tier code không dùng được ở Anti app"), true);
t.check("anti app max → lỗi", err(() => anti("max", [], { transport: "app" })).startsWith("tier max không dùng được ở Anti app"), true);
t.check("anti app claude → lỗi agentapi", err(() => anti("claude", [], { transport: "app" })).includes("agentapi chỉ nhận flash_lite|flash|pro"), true);
t.check("anti app claude-max → lỗi", err(() => anti("claude-max", [], { transport: "app" })).startsWith("tier claude-max không dùng được ở Anti app"), true);
// Catalog Codex đo 07/11 (`codex debug models`, bỏ model ẩn).
const ALL = ["low", "medium", "high", "xhigh", "max", "ultra"];
const CODEX_1107 = [
  { slug: "gpt-6.1-sol", efforts: ALL }, { slug: "gpt-6.1-terra", efforts: ALL }, { slug: "gpt-6-astra", efforts: ALL },
  { slug: "gpt-6-sol", efforts: ALL }, { slug: "gpt-6-luna", efforts: ALL.slice(0, 5) },
  { slug: "gpt-5.6-sol", efforts: ALL }, { slug: "gpt-5.6-terra", efforts: ALL }, { slug: "gpt-5.6-luna", efforts: ALL.slice(0, 5) },
];
const codex = (tier, list = CODEX_1107, extra = {}) => resolveTier({ worker: "codex", tier, liveCodexModels: list, ...extra });
const pair = (tier) => { const r = codex(tier); return `${r.model} ${r.effort}`; };
t.check("codex light → Luna mới nhất, low", pair("light"), "gpt-6-luna low");
t.check("codex standard → Terra mới nhất (6.1 thắng 5.6), medium", pair("standard"), "gpt-6.1-terra medium");
t.check("codex deep → Sol mới nhất (6.1 thắng 6), xhigh", pair("deep"), "gpt-6.1-sol xhigh");
t.check("codex code → Sol mới nhất, high", pair("code"), "gpt-6.1-sol high");
t.check("codex max → Astra, max", pair("max"), "gpt-6-astra max");
t.check("không có dòng của bậc → lỗi liệt kê model còn sống, không rơi sang dòng khác",
  err(() => codex("max", CODEX_1107.filter((m) => !m.slug.includes("astra")))).includes("model Codex còn liệt kê: gpt-6.1-sol"), true);
t.check("model không nhận effort của bậc → lỗi", err(() => codex("light", [{ slug: "gpt-6-luna", efforts: ["low"] }], { overrides: { light: { effort: "max" } } })).includes("không nhận effort max"), true);
t.check("liveCodexModels null chỉ kiểm, không chọn", `${codex("code", null).model}`, "null");
t.check("overrides đặt agy: null cho code/max → lỗi không có model cho Anti headless",
  `${err(() => anti("code", LIST_1123, { overrides: { code: { agy: null } } }))}|${err(() => anti("max", LIST_1123, { overrides: { max: { agy: null } } }))}`,
  "tier code không có model cho Anti headless|tier max không có model cho Anti headless");
t.check("codex claude → lỗi", err(() => codex("claude")).startsWith("tier claude chỉ cho Anti headless"), true);
t.check("codex claude-max → lỗi", err(() => codex("claude-max")).startsWith("tier claude-max chỉ cho Anti headless"), true);
t.check("job Claude không nhận --tier", err(() => resolveTier({ worker: "claude", tier: "deep" })).includes("job Claude không nhận --tier"), true);
t.check("tier lạ → lỗi liệt kê bậc", err(() => anti("huge")).includes("light|standard|deep|code|max|claude|claude-max"), true);
t.check("liveAgyModels null chỉ kiểm, không chọn", `${anti("standard", null).model}|${anti("code", null).model}|${anti("max", null).model}`, "null|null|null");
t.check("...nhưng vẫn chặn bậc sai transport (Anti app)", err(() => anti("code", null, { transport: "app" })).startsWith("tier code không dùng được ở Anti app"), true);

// --- nâng bậc ---------------------------------------------------------------
t.check("bumpTier mặc định (không truyền transport): light→standard→deep→max, code→max",
  ["light", "standard", "deep", "code", "max", "claude", "claude-max"].map((x) => bumpTier(x)).join(","),
  "standard,deep,max,max,max,claude,claude-max");
t.check("Anti headless (bỏ qua transport): deep → max, code → max",
  `${bumpTier("deep", "antigravity")},${bumpTier("code", "antigravity")}`, "max,max");
t.check("Anti headless (truyền rõ transport): light→standard→deep→max, code→max",
  ["light", "standard", "deep", "code", "max", "claude", "claude-max"].map((x) => bumpTier(x, "antigravity", "headless")).join(","),
  "standard,deep,max,max,max,claude,claude-max");
t.check("Anti app: light→standard→deep, nhưng deep đứng yên (không có bậc max)",
  ["light", "standard", "deep"].map((x) => bumpTier(x, "antigravity", "app")).join(","),
  "standard,deep,deep");
t.check("Codex: deep → max, code → max (Astra)", `${bumpTier("deep", "codex")},${bumpTier("code", "codex")}`, "max,max");
t.check("Codex: light → standard → deep như Anti", `${bumpTier("light", "codex")},${bumpTier("standard", "codex")}`, "standard,deep");
t.check("Codex: max là đỉnh, đứng yên", bumpTier("max", "codex"), "max");

// --- modelTiers ghi đè ------------------------------------------------------
{
  const fail = (msg) => { throw new Error(msg); };
  const over = normalizeModelTiers({ standard: { agy: ["^gemini-[\\d.]+-flash-high$"] }, deep: { effort: "high" }, code: { codex: ["^gpt-[\\d.]+-astra$"] } }, fail);
  t.check("ghi đè regex của một bậc", anti("standard", LIST_1106, { overrides: over }).model, "gemini-3.8-flash-high");
  t.check("...các trường khác giữ mặc định", anti("standard", [], { transport: "app", overrides: over }).model, "flash");
  t.check("ghi đè effort Codex", codex("deep", CODEX_1107, { overrides: over }).effort, "high");
  t.check("ghi đè dòng model Codex", codex("code", CODEX_1107, { overrides: over }).model, "gpt-6-astra");
  const bad = (value) => { try { normalizeModelTiers(value, fail); return "no throw"; } catch (e) { return e.message; } };
  t.check("tier lạ trong modelTiers bị từ chối", bad({ huge: {} }).startsWith('modelTiers: tier lạ "huge"'), true);
  t.check("khoá lạ trong một bậc bị từ chối", bad({ light: { model: "x" } }).includes("khoá lạ model"), true);
  t.check("regex không neo bị từ chối", bad({ light: { agy: ["flash"] } }).includes("neo ^...$"), true);
  t.check("regex hỏng bị từ chối", bad({ light: { agy: ["^(flash$"] } }).includes("không phải regex hợp lệ"), true);
  t.check("bậc app lạ bị từ chối", bad({ light: { app: "ultra" } }).includes("flash_lite|flash|pro|inherit"), true);
  t.check("effort lạ bị từ chối", bad({ code: { effort: "ultra" } }).includes("low|medium|high|xhigh|max"), true);
  t.check("regex codex không neo bị từ chối", bad({ code: { codex: ["sol"] } }).includes("modelTiers.code.codex[0] phải là regex neo"), true);
}

// --- crew.config.json nạp modelTiers ------------------------------------------
{
  const ws = tmpWorkspace("tiers-config-");
  const raw = JSON.parse(JSON.stringify(loadCrewConfig(ws).layout));
  writeFileSync(join(ws, "crew.config.json"), JSON.stringify({ ...raw, modelTiers: { light: { agy: ["^gemini-[\\d.]+-flash-medium$"] } } }));
  t.check("config có modelTiers được nạp", loadCrewConfig(ws).modelTiers.light.agy[0], "^gemini-[\\d.]+-flash-medium$");
  writeFileSync(join(ws, "crew.config.json"), JSON.stringify({ ...raw, modelTiers: { light: { agy: ["flash"] } } }));
  let msg = "no throw";
  try { loadCrewConfig(ws); } catch (e) { msg = e.message; }
  t.check("config có regex không neo → lỗi lúc nạp, kèm tên file", msg.startsWith("crew.config.json: modelTiers.light.agy[0]"), true);
  t.check("không khai modelTiers → rỗng", JSON.stringify(loadCrewConfig(tmpWorkspace("tiers-none-")).modelTiers), "{}");
}

t.check("parseAgyModels bỏ dòng thông báo", parseAgyModels("Fetching available models...\ngemini-3.8-flash-low\tGemini\n").join(","), "gemini-3.8-flash-low");

process.exit(t.finish() ? 0 : 1);
