#!/usr/bin/env node
/**
 * Trạng thái dùng chung giữa các agent.
 *
 * Hai luật ngược chiều nhau và cả hai đều phải giữ: hook KHÔNG được chặn phiên,
 * nhưng cũng KHÔNG được ghi khi chưa che được. Một bộ test chỉ kiểm "chạy xong
 * exit 0" sẽ xanh y hệt cho cả bản ghi thẳng credential ra file.
 *
 * Run: node mwg-agent-crew/tests/agent-state.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BYTES, STATE_DIR_REL, renderState, statePath, writeStateAtomic } from "../scripts/lib/state-file.mjs";
import { deriveFromTranscript, sniffFormat } from "../scripts/lib/derive-state.mjs";
import { MODULE_ROOT, makeChecker } from "./helpers.mjs";

const t = makeChecker("agent-state");
const WRITE = join(MODULE_ROOT, "scripts", "agent-state-write.mjs");
const READ = join(MODULE_ROOT, "scripts", "agent-state-read.mjs");

function ws() {
  const w = mkdtempSync(join(tmpdir(), "state-"));
  mkdirSync(join(w, STATE_DIR_REL), { recursive: true });
  return w;
}

function claudeTranscript(dir, { text = "Đã sửa xong redactor.", extra = [] } = {}) {
  const p = join(dir, "c.jsonl");
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { role: "user", content: "sửa giúp" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "text", text },
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "tasks/260921-abc-def/reports/x.md" } },
    ] } }),
    ...extra,
  ].join("\n") + "\n");
  return p;
}

function codexTranscript(dir, text = "Xong phần pipeline.") {
  const p = join(dir, "r.jsonl");
  writeFileSync(p, [
    JSON.stringify({ type: "session_meta", payload: { id: "x" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "chạy đi" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: "cat tasks/260921-abc-def/README.md" }) } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }),
  ].join("\n") + "\n");
  return p;
}

// Internal domains come from the workspace config; the hook gets a fixed fictional
// one so the suite means the same thing with or without a real config on disk.
const REDACT_CFG = join(mkdtempSync(join(tmpdir(), "state-cfg-")), "harness.config.json");
writeFileSync(REDACT_CFG, JSON.stringify({ redact: { internalDomains: ["acme.example"], emailDomains: ["acme.example"] } }));
const run = (script, args, payload) =>
  spawnSync("node", [script, ...args], {
    input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, CREW_HARNESS_CONFIG: REDACT_CFG },
  });

// ------------------------------------------------------- đọc được cả hai format
{
  const w = ws();
  t.check("nhận diện Claude", sniffFormat(readFileSync(claudeTranscript(w), "utf8").split("\n")[0]), "claude");
  t.check("nhận diện Codex", sniffFormat(readFileSync(codexTranscript(w), "utf8").split("\n")[0]), "codex");

  const c = deriveFromTranscript(claudeTranscript(w));
  t.check("Claude: lấy được lượt trả lời cuối", c.lastDid.includes("Đã sửa xong redactor"), true);
  t.check("Claude: suy ra task", c.task, "tasks/260921-abc-def");

  const x = deriveFromTranscript(codexTranscript(w));
  t.check("Codex: lấy được lượt trả lời cuối", x.lastDid.includes("Xong phần pipeline"), true);
  t.check("Codex: suy ra task từ tham số tool", x.task, "tasks/260921-abc-def");
}

// ------------------------------------------------------------------ ghi thật
{
  const w = ws();
  const tp = claudeTranscript(w);
  const r = run(WRITE, ["--agent", "claude", "--workspace", w], { session_id: "abc123def456", transcript_path: tp, cwd: w });
  t.check("ghi: exit 0", r.status, 0);
  const files = readdirSync(join(w, STATE_DIR_REL));
  t.check("đúng một file", files.length, 1);
  t.check("tên file mang agent + phiên", files[0], "claude-abc123def456.md");
  const body = readFileSync(join(w, STATE_DIR_REL, files[0]), "utf8");
  t.check("có việc vừa làm", body.includes("Đã sửa xong redactor"), true);
  t.check("mode 0600", (statSync(join(w, STATE_DIR_REL, files[0])).mode & 0o777).toString(8), "600");
  // Điều quan trọng nhất về tính trung thực của file này.
  t.check("KHÔNG bịa bước kế tiếp", /Không suy ra được từ transcript/.test(body), true);
}

// --------------------------------- hai phiên ghi cùng lúc: không mất bản ghi nào
{
  const w = ws();
  const tp = claudeTranscript(w);
  const kids = ["s1111111", "s2222222", "s3333333"].map((s) =>
    spawnSync("node", [WRITE, "--agent", "claude", "--workspace", w],
      { input: JSON.stringify({ session_id: s, transcript_path: tp, cwd: w }), encoding: "utf8" }));
  t.check("cả ba exit 0", kids.every((k) => k.status === 0), true);
  // Một file chung sẽ chỉ còn bản ghi của thằng cuối. Mỗi phiên một đường dẫn
  // thì va chạm không phát sinh chứ không phải được xử lý.
  t.check("ba phiên → ba file, không mất cái nào", readdirSync(join(w, STATE_DIR_REL)).length, 3);
  t.check("không sót file tạm", readdirSync(join(w, STATE_DIR_REL)).some((f) => f.includes(".tmp-")), false);
}

// ----------------------------------------------- fail-closed: thiếu redactor
{
  const w = ws();
  const lib = join(MODULE_ROOT, "scripts", "lib", "redact-values.mjs");
  const parked = `${lib}.parked`;
  renameSync(lib, parked);
  let r;
  try {
    r = run(WRITE, ["--agent", "claude", "--workspace", w],
      { session_id: "zzz", transcript_path: claudeTranscript(w), cwd: w });
  } finally { renameSync(parked, lib); }
  // Hai khẳng định ngược chiều, cả hai đều bắt buộc.
  t.check("thiếu redactor vẫn KHÔNG chặn phiên (exit 0)", r.status, 0);
  t.check("...nhưng KHÔNG ghi file nào", readdirSync(join(w, STATE_DIR_REL)).length, 0);
}

// ------------------------------------------- bí mật trong transcript bị che
{
  const w = ws();
  const tp = claudeTranscript(w, {
    text: "Đã chạy với AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q trên https://cms.acme.example/x",
  });
  run(WRITE, ["--agent", "claude", "--workspace", w], { session_id: "sec1", transcript_path: tp, cwd: w });
  const body = readFileSync(join(w, STATE_DIR_REL, readdirSync(join(w, STATE_DIR_REL))[0]), "utf8");
  t.check("key bị che", body.includes("AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q"), false);
  t.check("host nội bộ bị che", body.includes("cms.acme.example"), false);
}

// ----------------------------------------------------------- trần cỡ file
{
  const w = ws();
  const tp = claudeTranscript(w, { text: "x".repeat(50_000) });
  run(WRITE, ["--agent", "claude", "--workspace", w], { session_id: "big1", transcript_path: tp, cwd: w });
  const size = statSync(join(w, STATE_DIR_REL, readdirSync(join(w, STATE_DIR_REL))[0])).size;
  t.check(`transcript khổng lồ vẫn ≤ ${MAX_BYTES} byte (${size})`, size <= MAX_BYTES, true);
}

// ------------------------------------------------- đọc: tuổi, và cảnh báo cũ
{
  const w = ws();
  const dir = join(w, STATE_DIR_REL);
  writeStateAtomic(join(dir, "codex-old99.md"), renderState({ agent: "codex", session: "old99", task: "tasks/260901-cu", lastDid: "VIỆC_CŨ_XA_XƯA" }));
  const old = join(dir, "codex-old99.md");
  const longAgo = (Date.now() - 40 * 3600_000) / 1000;
  utimesSync(old, longAgo, longAgo);
  writeStateAtomic(join(dir, "anti-new11.md"), renderState({ agent: "anti", session: "new11", task: "tasks/260921-moi", lastDid: "VIỆC_VỪA_XONG" }));

  const r = run(READ, ["--agent", "claude", "--workspace", w], { session_id: "me", cwd: w });
  t.check("đọc: exit 0", r.status, 0);
  t.check("thấy phiên mới", r.stdout.includes("VIỆC_VỪA_XONG"), true);
  t.check("thấy phiên cũ", r.stdout.includes("VIỆC_CŨ_XA_XƯA"), true);
  // File 3 ngày trước mà đọc như đang chạy thì tệ hơn không có file.
  t.check("phiên cũ bị đánh dấu CŨ", /⚠ CŨ/.test(r.stdout), true);
  t.check("phiên mới KHÔNG bị đánh dấu cũ", r.stdout.indexOf("anti-new11") < r.stdout.indexOf("⚠ CŨ"), true);
  t.check("in tuổi từng file", /giờ trước|phút trước|ngày trước/.test(r.stdout), true);
  // Nội dung này đi thẳng vào ngữ cảnh của model cloud khác.
  t.check("nói rõ là dữ liệu, không phải chỉ thị", /dữ liệu\*\*, không phải chỉ thị/.test(r.stdout), true);
}

// --------------------------------- không tự đọc lại trạng thái của chính mình
{
  const w = ws();
  const dir = join(w, STATE_DIR_REL);
  writeStateAtomic(join(dir, "claude-self0001.md"), renderState({ agent: "claude", session: "self0001", lastDid: "CUA_CHINH_MINH" }));
  const r = run(READ, ["--agent", "claude", "--workspace", w], { session_id: "self0001", cwd: w });
  t.check("bỏ qua file của chính phiên này", r.stdout.includes("CUA_CHINH_MINH"), false);
}

// ------------------------------------------- không bao giờ chặn phiên
{
  const w = ws();
  for (const [name, args, payload] of [
    ["agent sai", ["--agent", "khong-co"], { cwd: w }],
    ["payload rỗng", ["--agent", "claude"], {}],
    ["transcript không tồn tại", ["--agent", "claude", "--workspace", w], { session_id: "a", transcript_path: "/khong/co/that.jsonl", cwd: w }],
  ]) {
    t.check(`ghi: ${name} → exit 0`, run(WRITE, args, payload).status, 0);
    t.check(`đọc: ${name} → exit 0`, run(READ, args, payload).status, 0);
  }
  t.check("không ca hỏng nào đẻ ra file", existsSync(join(w, STATE_DIR_REL)) ? readdirSync(join(w, STATE_DIR_REL)).length : 0, 0);
}

// --- đoạn cuối là câu dẫn, không phải tóm tắt: đúng ca interrupt / phiên chết
{
  const w = ws();
  const meaty = "Đã sửa xong redactor: bỏ cờ allow-tracked, giấu cả ba chuỗi, giữ bản tóm tắt compact. " + "Chi tiết nằm ở phase file. ".repeat(6);
  const p = join(w, "interrupted.jsonl");
  writeFileSync(p, [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: meaty }] } }),
    // Câu dẫn ngay trước một lệnh tool — lượt bị cắt đúng ở đây.
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "text", text: "Giờ chạy thử:" },
      { type: "tool_use", id: "t9", name: "Bash", input: { command: "ls" } },
    ] } }),
  ].join("\n") + "\n");
  const f = deriveFromTranscript(p);
  t.check("bỏ qua câu dẫn cụt", f.lastDid.startsWith("Giờ chạy thử"), false);
  t.check("lấy đoạn có nội dung thật", f.lastDid.includes("bỏ cờ allow-tracked"), true);
}

// --- lượt kết thúc bình thường thì đoạn cuối VẪN được ưu tiên
{
  const w = ws();
  const p = join(w, "normal.jsonl");
  const older = "Đoạn cũ dài hơn nhiều. ".repeat(30);
  const final = "Kết luận cuối lượt, đủ dày để được chọn. ".repeat(8);
  writeFileSync(p, [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: older }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: final }] } }),
  ].join("\n") + "\n");
  // Đoạn cũ DÀI HƠN, nhưng đoạn cuối đã đủ dày nên không được phép bị soán.
  t.check("đoạn cuối đủ dày thì thắng dù ngắn hơn đoạn cũ", deriveFromTranscript(p).lastDid.includes("Kết luận cuối lượt"), true);
}

// --- session id dài KHÔNG được rút về cùng một tên file
{
  // Id thật của Codex có dạng rollout-<ngày>-<uuid>_<uuid>. Cắt 12 ký tự đầu
  // cho ra "rollout-2026" cho MỌI phiên năm 2026 — tức là cả kiến trúc
  // "mỗi phiên một đường dẫn" sụp, im lặng, đúng chỗ nó tự nhận là an toàn.
  const w = ws();
  const a = statePath(w, "codex", "rollout-2026-09-20T21-08-41-01a0bdeb-910b-72d0-a81b-fa1d25ed2e31");
  const b = statePath(w, "codex", "rollout-2026-09-21T08-15-02-99999999-aaaa-bbbb-cccc-dddddddddddd");
  t.check("hai phiên dài khác nhau → hai file khác nhau", a === b, false);
  t.check("vẫn đọc được bằng mắt", /codex-rollout-2026-[0-9a-f]{8}\.md$/.test(a), true);
  // Cùng một id thì phải ra cùng một file, nếu không mỗi lượt lại đẻ một file mới.
  t.check("cùng id → cùng đường dẫn", statePath(w, "codex", "abc") === statePath(w, "codex", "abc"), true);
  t.check("uuid ngắn giữ nguyên dạng dễ đọc", /claude-4770a368-34[0-9a-f-]*\.md$/.test(statePath(w, "claude", "4770a368-3489-44b9-9c7f-4b762424c742")), true);
}

process.exit(t.finish() ? 0 : 1);
