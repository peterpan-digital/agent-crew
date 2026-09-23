#!/usr/bin/env node
/**
 * Crew routing gate.
 *
 * Bộ test này canh một thứ quan trọng hơn "phân loại có đúng không": gate phải
 * KHÔNG BAO GIỜ mở được lối tắt vòng qua cổng chi phí. Bản gate đầu tiên trigger
 * đúng vào Ahrefs / DataForSEO / Gemini API và inject vào mọi prompt một chỉ thị
 * tự gọi chúng — trái `CLAUDE.md` non-negotiable #6, và một bộ test chỉ kiểm
 * "phân nhánh đúng" sẽ xanh y hệt cho bản đó.
 *
 * Đặt ở đây, không ở `.agents/hooks/__tests__/` như phase file viết: `tests/run.mjs`
 * chỉ nhặt `*.test.mjs` trong thư mục này, nên test nằm chỗ kia sẽ không ai chạy.
 *
 * Run: node mwg-agent-crew/tests/crew-routing-gate.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODULE_ROOT, makeChecker } from "./helpers.mjs";

const t = makeChecker("crew-routing-gate");
const WS = join(MODULE_ROOT, "..");
const HOOK = join(WS, ".agents", "hooks", "crew-routing-gate.cjs");
const REAL_LOG = join(WS, ".agents", "logs", "crew-routing-gate.jsonl");

/**
 * Log riêng cho bộ test. Trước 23/09 test spawn hook mà không rẽ đường, nên nó
 * ghi thẳng vào log thật: một lần test crash giữa chừng đã bỏ lại 12 dòng giả
 * không phân biệt được với lượt thật, và teardown "snapshot rồi đè" còn xoá mất
 * lượt thật nào bắn trúng lúc test chạy. Log đó là nguồn duy nhất để chấm gate
 * nên nó phải sạch; test không được có quyền ghi vào đấy.
 */
const LOG = join(tmpdir(), `crew-routing-gate-test-${process.pid}.jsonl`);

const fire = (prompt, event = "UserPromptSubmit") =>
  spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: event, prompt }),
    encoding: "utf8",
    env: { ...process.env, MWG_CREW_GATE_LOG: LOG },
  });

// Ảnh chụp log thật: cuối bài phải chứng minh bộ test không đụng vào nó.
const realBefore = existsSync(REAL_LOG) ? readFileSync(REAL_LOG, "utf8") : null;

// ------------------------------------------------- 4 prompt mẫu của phase file
{
  const plain = fire("giải thích giúp tao chỗ này chạy sao");
  t.check("việc thường → không nói gì", plain.stdout.trim(), "");

  const free = fire("chèn link nội bộ cho 40 bài giúp tao");
  t.check("1 việc rule-based miễn phí → đề xuất", /Định tuyến crew/.test(free.stdout), true);
  t.check("...và là nhánh đề xuất, không phải nhánh đủ ngưỡng", /một nhóm việc có rule/.test(free.stdout), true);

  const two = fire("tối ưu html bài này xong rồi research đối thủ luôn");
  t.check("2 loại đầu việc → nhánh đủ ngưỡng", /2 loại đầu việc/.test(two.stdout), true);
}

// --------------------------- ca quan trọng nhất: việc tốn tiền KHÔNG được gợi ý
{
  // Mỗi câu dưới đây đều là việc Antigravity làm được, và bản gate đầu tiên đã
  // trigger đúng vào chúng. Cả bốn phải im lặng: đường duy nhất là seo-crew +
  // COST_GATE, nơi người dùng được hỏi trước khi tiêu tiền.
  for (const p of [
    "chạy keyword research trên Ahrefs cho nhóm laptop",
    "rank check bulk qua DataForSEO 1728 keyword",
    "chạy image pipeline sinh alt bằng Gemini API",
    "batch llm cho 500 dòng mô tả",
  ]) {
    t.check(`việc tốn tiền im lặng: ${p.slice(0, 26)}…`, fire(p).stdout.trim(), "");
  }
}

// ----------------------------------------- gate phân loại, gate không điều khiển
{
  const out = fire("tối ưu html bài này xong rồi research đối thủ luôn").stdout
    + fire("chèn link nội bộ cho 40 bài").stdout;
  // Nêu tên script là mở lại đúng ba tầng hỏng mà red team đã chứng minh.
  for (const banned of ["anti-run", "codex-run", "crew-collect", ".mjs", "MWG_CREW_ROLE"]) {
    t.check(`không in tên script/biến dispatch: ${banned}`, out.includes(banned), false);
  }
  t.check("có nói rõ là gợi ý, không phải lệnh", /không phải lệnh/.test(out), true);
}

// ------------------------------------------------------ không bao giờ chặn prompt
{
  for (const [name, args] of [
    ["payload rỗng", ""],
    ["prompt null", null],
    ["prompt là số", 12345],
    ["prompt siêu dài", "chèn link nội bộ ".repeat(5000)],
  ]) {
    t.check(`${name} → exit 0`, fire(args).status, 0);
  }
  const bad = spawnSync("node", [HOOK], { input: "{khong-phai-json", encoding: "utf8" });
  t.check("stdin hỏng → exit 0", bad.status, 0);
  t.check("sự kiện khác → im lặng", fire("chèn link nội bộ", "PreToolUse").stdout.trim(), "");
}

// ------------------------------------------------------------------- tốc độ
{
  const t0 = Date.now();
  for (let i = 0; i < 5; i += 1) fire("tối ưu html bài này xong rồi research đối thủ luôn");
  const per = (Date.now() - t0) / 5;
  // Ngưỡng nới cho chi phí khởi động node của chính bài test; phần phân loại là micro giây.
  t.check(`mỗi lượt < 250ms kể cả boot node (${Math.round(per)}ms)`, per < 250, true);
}

// ------------------------------------------------- log: schema chốt, không prompt
{
  const secret = "chèn link nội bộ cho bài BÍ_MẬT_KHÔNG_ĐƯỢC_LỌT_VÀO_LOG";
  fire(secret);
  const body = readFileSync(LOG, "utf8");
  const last = JSON.parse(body.trim().split("\n").pop());
  t.check("log KHÔNG chứa nội dung prompt", body.includes("BÍ_MẬT_KHÔNG_ĐƯỢC_LỌT_VÀO_LOG"), false);
  t.check("log đúng schema", Object.keys(last).sort().join(","), "branch,decision,triggers,ts");
  t.check("log ghi id trigger", last.triggers.includes("internal-link"), true);

  const ignored = spawnSync("git", ["-C", WS, "check-ignore", "-q", REAL_LOG]);
  t.check("đường dẫn log được .gitignore che", ignored.status, 0);
}

// ------------------------------------------------- log thật phải y nguyên
{
  const realAfter = existsSync(REAL_LOG) ? readFileSync(REAL_LOG, "utf8") : null;
  t.check("bộ test KHÔNG ghi gì vào log production", realAfter, realBefore);
}

rmSync(LOG, { force: true });

process.exit(t.finish() ? 0 : 1);
