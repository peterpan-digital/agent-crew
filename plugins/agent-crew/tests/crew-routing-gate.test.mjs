#!/usr/bin/env node
/**
 * Routing gate của plugin (`crew hook prompt`).
 *
 * Bộ test canh một thứ quan trọng hơn "phân loại có đúng không": gate KHÔNG BAO
 * GIỜ được mở lối tắt vòng qua cổng chi phí. Bản gate đầu tiên trigger đúng vào
 * API tốn tiền và inject vào mọi prompt một chỉ thị tự gọi chúng; một bộ test
 * chỉ kiểm "phân nhánh đúng" sẽ xanh y hệt cho bản đó.
 *
 * Plugin cài cấp máy nên hook bắn ở mọi repo: phần cuối kiểm nó im ở repo chưa
 * bật crew, và chạy được khi app GUI gọi nó với PATH không có node.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCrewConfig } from "../scripts/lib/crew-config.mjs";
import { MODULE_ROOT, makeChecker } from "./helpers.mjs";

const t = makeChecker("crew-routing-gate");
const CREW = join(MODULE_ROOT, "bin", "crew.mjs");
const HOOK_SH = join(MODULE_ROOT, "bin", "crew-hook.sh");
const LOG = join(tmpdir(), `crew-routing-gate-test-${process.pid}.jsonl`);
const msg = (fn) => { try { fn(); return "không ném"; } catch (e) { return e.message; } };

/** Bộ trigger mẫu: chép từ workspace gốc, nơi gate ra đời. */
const TRIGGERS = [
  { id: "content-html", kind: "content", pattern: "tối ưu (?:html|nội dung bài)|content[- ]html" },
  { id: "internal-link", kind: "content", pattern: "chèn link nội bộ|internal link|interlink" },
  { id: "sheet-readback", kind: "data", pattern: "đọc (?:lại )?sheet|export sheet" },
  { id: "competitor-research", kind: "research", pattern: "research đối thủ|phân tích đối thủ" },
  { id: "bulk-crawl", kind: "research", pattern: "crawl (?:nhiều|hàng loạt|\\d+)" },
];
const COST_GATE = ["Ahrefs", "DataForSEO", { api: "Gemini API", via: "image pipeline" }, "batch LLM"];

function repo(prefix, config) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "-q"], { cwd: ws });
  if (config) writeFileSync(join(ws, "crew.config.json"), JSON.stringify(config, null, 2));
  return ws;
}
const WS = repo("gate-", { routingTriggers: TRIGGERS, costGate: COST_GATE, routingLog: ".crew/logs/routing-gate.jsonl" });

/** Env sạch: không vai worker, không thư mục dự án của phiên đang chạy test. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, CREW_GATE_LOG: LOG };
  for (const k of ["CLAUDE_PROJECT_DIR", "CREW_ROLE", "MWG_CREW_ROLE"]) delete env[k];
  return { ...env, ...extra };
}

function fire(prompt, { ws = WS, event = "UserPromptSubmit", env = {} } = {}) {
  const input = prompt === "" ? "" : JSON.stringify({ hook_event_name: event, prompt, cwd: ws });
  return spawnSync(process.execPath, [CREW, "hook", "prompt"], { cwd: ws, input, encoding: "utf8", env: cleanEnv(env) });
}

// ------------------------------------------------- 4 prompt mẫu
{
  t.check("việc thường → không nói gì", fire("giải thích giúp tao chỗ này chạy sao").stdout.trim(), "");
  const free = fire("chèn link nội bộ cho 40 bài giúp tao");
  t.check("1 việc rule-based → đề xuất", /Định tuyến crew/.test(free.stdout), true);
  t.check("...và là nhánh đề xuất, không phải nhánh đủ ngưỡng", /một nhóm việc có rule/.test(free.stdout), true);
  t.check("...trỏ tới skill agent-crew", /`agent-crew`/.test(free.stdout), true);
  t.check("2 loại đầu việc → nhánh đủ ngưỡng", /2 loại đầu việc/.test(fire("tối ưu html bài này xong rồi research đối thủ luôn").stdout), true);
  t.check("2 trigger cùng loại vẫn là đề xuất", /một nhóm việc có rule/.test(fire("tối ưu html rồi chèn link nội bộ").stdout), true);
}

// ------------------------------------------- @anti/@codex: owner chỉ định trực tiếp
{
  const anti = fire("@anti sửa bài X giúp tao");
  t.check("@anti → nhánh mention, trỏ tới phoi-hop-owner", /chỉ định worker trực tiếp/.test(anti.stdout) && /phoi-hop-owner\.md/.test(anti.stdout), true);
  t.check("@anti thắng câu 'một việc nhỏ thì làm trực tiếp'", /đừng dispatch cho có/.test(anti.stdout), false);
  t.check("@codex nhận ra, kể cả prompt ngắn", /mention-codex/.test(fire("@codex x").stdout), true);
  t.check("email có @ không bị nhầm là mention", fire("gửi mail cho a@codex.vn giúp tao nhé").stdout.trim(), "");
  t.check("mention nhắc đợi owner khi đụng API tốn tiền", /tốn tiền/.test(fire("@anti chạy keyword research trên Ahrefs").stdout), true);
  t.check("mention không in tên script", /anti-run|codex-run|\.mjs/.test(anti.stdout), false);
}

// --------------------------- ca quan trọng nhất: việc tốn tiền KHÔNG được gợi ý
{
  for (const p of [
    "chạy keyword research trên Ahrefs cho nhóm laptop",
    "rank check bulk qua DataForSEO 1728 keyword",
    "chạy image pipeline sinh alt bằng Gemini API",
    "batch llm cho 500 dòng mô tả",
    // Trigger khớp thật, nhưng prompt nhắc API tốn tiền: vẫn phải im.
    "crawl 200 url rồi đẩy qua Ahrefs lấy volume",
  ]) {
    t.check(`việc tốn tiền im lặng: ${p.slice(0, 28)}…`, fire(p).stdout.trim(), "");
  }
  const ws = repo("gate-paid-");
  const bad = (cfg) => { writeFileSync(join(ws, "crew.config.json"), JSON.stringify(cfg)); return msg(() => loadCrewConfig(ws)); };
  t.check("trigger khớp tên API tốn tiền → config bị từ chối",
    /khớp API tốn tiền "Ahrefs"/.test(bad({ costGate: ["Ahrefs"], routingTriggers: [{ id: "kw", kind: "research", pattern: "ahrefs|keyword" }] })), true);
  t.check("pattern khớp chuỗi rỗng → từ chối", /chuỗi rỗng/.test(bad({ routingTriggers: [{ id: "x", kind: "a", pattern: ".*" }] })), true);
  t.check("regex hỏng → từ chối", /regex hợp lệ/.test(bad({ routingTriggers: [{ id: "x", kind: "a", pattern: "(" }] })), true);
  t.check("kind mention là nhánh có sẵn → từ chối", /mention/.test(bad({ routingTriggers: [{ id: "x", kind: "mention", pattern: "a" }] })), true);
  t.check("trigger thiếu id → từ chối", /\.id/.test(bad({ routingTriggers: [{ kind: "a", pattern: "a" }] })), true);
  t.check("tên API có dấu chấm → từ chối (collect không đọc lại được)", /không có ,/.test(bad({ costGate: ["Gemini v2.5"] })), true);
  t.check("API khai hai lần → từ chối", /hai lần/.test(bad({ costGate: ["Ahrefs", "ahrefs"] })), true);
  t.check("routingLog tuyệt đối → từ chối", /routingLog/.test(bad({ routingLog: "/tmp/x.jsonl" })), true);
  t.check("khoá gõ sai → từ chối", /khoá lạ routingTrigger/.test(bad({ routingTrigger: [] })), true);
  t.check("costGate dạng chuỗi chuẩn hoá thành {api, via}", JSON.stringify(loadCrewConfig(WS).costGate[0]), '{"api":"Ahrefs","via":null}');
}

// ----------------------------------------- gate phân loại, gate không điều khiển
{
  const out = fire("tối ưu html bài này xong rồi research đối thủ luôn").stdout + fire("chèn link nội bộ cho 40 bài").stdout;
  for (const banned of ["anti-run", "codex-run", "crew-collect", ".mjs", "CREW_ROLE", "crew run", "crew new-run"]) {
    t.check(`không in tên script/lệnh dispatch: ${banned}`, out.includes(banned), false);
  }
  t.check("có nói rõ là gợi ý, không phải lệnh", /không phải lệnh/.test(out), true);
}

// ------------------------------------------- im lặng ở nơi không phải việc của nó
{
  const plain = repo("gate-plain-");
  t.check("repo chưa bật crew: kể cả @anti cũng im", fire("@anti sửa bài X", { ws: plain }).stdout.trim(), "");
  mkdirSync(join(plain, ".crew"));
  t.check("có .crew/ nhưng không khai trigger: mention vẫn nói", /mention-anti/.test(fire("@anti sửa bài X", { ws: plain }).stdout), true);
  t.check("...còn việc thường thì im", fire("chèn link nội bộ cho 40 bài", { ws: plain }).stdout.trim(), "");
  t.check("dưới vai worker → im", fire("chèn link nội bộ cho 40 bài", { env: { CREW_ROLE: "worker" } }).stdout.trim(), "");
  t.check("...kể cả tên biến cũ", fire("@codex x", { env: { MWG_CREW_ROLE: "worker" } }).stdout.trim(), "");
  const sub = join(WS, "src", "deep");
  mkdirSync(sub, { recursive: true });
  const fromSub = spawnSync(process.execPath, [CREW, "hook", "prompt"], {
    cwd: sub, encoding: "utf8", input: JSON.stringify({ prompt: "chèn link nội bộ cho 40 bài", cwd: sub }), env: cleanEnv(),
  });
  t.check("cwd là thư mục con: vẫn tìm được config ở gốc git", /internal-link/.test(fromSub.stdout), true);
  const viaProjectDir = fire("chèn link nội bộ cho 40 bài", { ws: plain, env: { CLAUDE_PROJECT_DIR: WS } });
  t.check("CLAUDE_PROJECT_DIR thắng cwd của payload", /internal-link/.test(viaProjectDir.stdout), true);
}

// ------------------------------------------------------ không bao giờ chặn prompt
{
  for (const [name, args] of [["payload rỗng", ""], ["prompt null", null], ["prompt là số", 12345], ["prompt siêu dài", "chèn link nội bộ ".repeat(5000)]]) {
    t.check(`${name} → exit 0`, fire(args).status, 0);
  }
  t.check("stdin hỏng → exit 0", spawnSync(process.execPath, [CREW, "hook", "prompt"], { cwd: WS, input: "{khong-phai-json", encoding: "utf8", env: cleanEnv() }).status, 0);
  t.check("sự kiện khác → im lặng", fire("chèn link nội bộ", { event: "PreToolUse" }).stdout.trim(), "");
  const broken = repo("gate-broken-", { routingTriggers: "x" });
  const b = fire("chèn link nội bộ cho 40 bài", { ws: broken });
  t.check("config hỏng → exit 0, stdout im", [b.status, b.stdout.trim()].join("|"), "0|");
  t.check("...và cảnh báo ở stderr", /failed open/.test(b.stderr), true);
  t.check("sự kiện hook lạ → exit 2 (lỗi gõ lệnh, không phải lượt người dùng)", spawnSync(process.execPath, [CREW, "hook", "bogus"], { input: "" }).status, 2);
}

// ------------------------------------------------------------------- tốc độ
{
  const t0 = Date.now();
  for (let i = 0; i < 5; i += 1) fire("tối ưu html bài này xong rồi research đối thủ luôn");
  const per = (Date.now() - t0) / 5;
  t.check(`mỗi lượt < 250ms kể cả boot node (${Math.round(per)}ms)`, per < 250, true);
}

// ------------------------------------------------- log: schema chốt, không prompt
{
  rmSync(LOG, { force: true });
  fire("chèn link nội bộ cho bài BÍ_MẬT_KHÔNG_ĐƯỢC_LỌT_VÀO_LOG");
  const body = readFileSync(LOG, "utf8");
  const last = JSON.parse(body.trim().split("\n").pop());
  t.check("log KHÔNG chứa nội dung prompt", body.includes("BÍ_MẬT_KHÔNG_ĐƯỢC_LỌT_VÀO_LOG"), false);
  t.check("log đúng schema", Object.keys(last).sort().join(","), "branch,decision,triggers,ts");
  t.check("log ghi id trigger", last.triggers.includes("internal-link"), true);
  t.check("có CREW_GATE_LOG thì không ghi vào routingLog của repo", existsSync(join(WS, ".crew/logs/routing-gate.jsonl")), false);

  const env = cleanEnv();
  delete env.CREW_GATE_LOG;
  spawnSync(process.execPath, [CREW, "hook", "prompt"], { cwd: WS, encoding: "utf8", env, input: JSON.stringify({ prompt: "chèn link nội bộ cho 40 bài", cwd: WS }) });
  t.check("không rẽ log → ghi vào routingLog khai trong config", existsSync(join(WS, ".crew/logs/routing-gate.jsonl")), true);
  const quiet = repo("gate-nolog-", { routingTriggers: TRIGGERS });
  spawnSync(process.execPath, [CREW, "hook", "prompt"], { cwd: quiet, encoding: "utf8", env, input: JSON.stringify({ prompt: "chèn link nội bộ cho 40 bài", cwd: quiet }) });
  t.check("không khai routingLog → không ghi log nào", existsSync(join(quiet, ".crew")), false);
}

// ------------------------------------------------- hook thật: wrapper + hooks.json
{
  const bare = spawnSync("/bin/sh", [HOOK_SH, "prompt"], {
    cwd: WS, encoding: "utf8", input: JSON.stringify({ prompt: "chèn link nội bộ cho 40 bài", cwd: WS }),
    env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin", CREW_GATE_LOG: LOG },
  });
  t.check("wrapper chạy được khi PATH chỉ có /usr/bin:/bin", /internal-link/.test(bare.stdout), true);
  const hooks = JSON.parse(readFileSync(join(MODULE_ROOT, "hooks", "hooks.json"), "utf8")).hooks;
  const cmds = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  t.check("hooks.json đăng ký đủ 3 sự kiện", Object.keys(hooks).sort().join(","), "SessionStart,Stop,UserPromptSubmit");
  t.check("mọi hook đi qua wrapper, không gọi thẳng node", cmds.every((c) => c.includes("${CLAUDE_PLUGIN_ROOT}/bin/crew-hook.sh") && !/^node /.test(c)), true);
  t.check("wrapper có quyền chạy", execFileSync("stat", ["-f", "%Lp", HOOK_SH], { encoding: "utf8" }).trim(), "755");
}

// ------------------------------------------------- session-start / stop đi qua cùng cửa
{
  const ws = repo("gate-state-");
  const run = (event, payload) => spawnSync(process.execPath, [CREW, "hook", event], { cwd: ws, encoding: "utf8", input: JSON.stringify(payload), env: cleanEnv() });
  t.check("session-start ở repo chưa bật crew → im", run("session-start", { session_id: "s1", cwd: ws }).stdout.trim(), "");
  run("stop", { session_id: "s1", cwd: ws });
  t.check("stop ở repo không có thư mục state → không đẻ ra .crew", existsSync(join(ws, ".crew")), false);
  const mp = execFileSync(process.execPath, [CREW, "new-run", "--run", "261019-1500"], { cwd: ws, encoding: "utf8" }).trim();
  execFileSync(process.execPath, [CREW, "add-job", mp, "--worker", "anti", "--role", "assist", "--title", "x", "--model", "m"], { cwd: ws });
  const opened = run("session-start", { session_id: "s1", cwd: join(ws, ".crew") });
  t.check("session-start: repo có run dở → in bảng crew còn dở", opened.stdout.includes("crew-261019-1500"), true);
  t.check("...exit 0", opened.status, 0);
}

rmSync(LOG, { force: true });
process.exit(t.finish() ? 0 : 1);
