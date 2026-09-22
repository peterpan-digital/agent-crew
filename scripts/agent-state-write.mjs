#!/usr/bin/env node
/**
 * Ghi trạng thái của phiên hiện tại. Chạy trong hook, KHÔNG phải model gọi.
 *
 * Đăng ký (Phase 5 đo được, cả ba runtime cùng một schema hook):
 *   Claude       Stop                     .claude/settings.json
 *   Codex        Stop                     ~/.codex/hooks.json  (GLOBAL — Codex
 *                                         không nạp .codex/hooks.json của repo,
 *                                         đo 22/09; xem rào existsSync bên dưới)
 *   Antigravity  UserPromptSubmit         .agents/hooks.json
 *
 * Payload vào qua stdin, mang sẵn `session_id`, `transcript_path`, `cwd` — nên
 * script không phải đi dò transcript trong thư mục nào cả.
 *
 * Hai luật cứng, ngược chiều nhau:
 *
 *   KHÔNG BAO GIỜ chặn phiên. Trạng thái là tiện ích. Hỏng thì im lặng thoát 0;
 *   một hook làm treo phiên còn tệ hơn nhiều so với việc thiếu file trạng thái.
 *
 *   KHÔNG BAO GIỜ ghi khi chưa che được. File này bị nạp vào ngữ cảnh của
 *   Antigravity (Gemini, cloud Google) và Codex (OpenAI, cloud) — cùng đúng cái
 *   ranh giới của Phase 2. Thiếu module redact thì không ghi gì cả.
 *
 * Run: agent-state-write.mjs --agent claude   (payload JSON qua stdin)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AGENTS, STATE_DIR_REL, pruneOld, renderState, stateDir, statePath, writeStateAtomic } from "./lib/state-file.mjs";
import { deriveFromTranscript } from "./lib/derive-state.mjs";

const quiet = (msg) => { if (process.env.MWG_STATE_DEBUG) process.stderr.write(`agent-state-write: ${msg}\n`); };

function readPayload() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const agent = argv[argv.indexOf("--agent") + 1];
  if (!AGENTS.has(agent)) return quiet(`--agent phải là một trong ${[...AGENTS].join("|")}`);

  const payload = readPayload();
  const workspace = resolve(
    argv.includes("--workspace") ? argv[argv.indexOf("--workspace") + 1] : (payload.cwd || process.cwd()),
  );
  // Opt-in theo thư mục, và đây là điều kiện để đăng ký hook này ở phạm vi
  // global được. Codex KHÔNG nạp `.codex/hooks.json` của repo (đo 22/09: số hook
  // bắn khớp y hệt file global và chỉ file global), nên chỗ đăng ký duy nhất có
  // tác dụng là `~/.codex/hooks.json` — dùng chung cho mọi repo trên máy.
  //
  // `stateDir` là `<cwd>/tasks/_state`, nên nếu không rào thì một phiên Codex mở
  // ở repo bất kỳ sẽ đẻ ra thư mục `tasks/_state/` trong repo đó. Rào bằng "thư
  // mục đã tồn tại" thay vì bằng danh sách đường dẫn cứng: workspace nào muốn
  // thu trạng thái thì tự tạo thư mục, và không có đường dẫn máy nào bị nhúng
  // vào code.
  if (!existsSync(stateDir(workspace))) {
    return quiet(`${workspace} không có ${STATE_DIR_REL} — bỏ qua`);
  }

  const session = payload.session_id ?? payload.sessionId ?? "unknown";
  const transcript = payload.transcript_path ?? payload.transcriptPath ?? null;

  // Fail-closed. Không có bộ che thì không ghi — không có bản "ghi tạm rồi che sau".
  let sanitize;
  try {
    ({ sanitize } = await import(new URL("./lib/redact-values.mjs", import.meta.url).href));
  } catch {
    return quiet("thiếu module redact — không ghi gì");
  }
  if (typeof sanitize !== "function") return quiet("module redact không có sanitize() — không ghi gì");

  const facts = deriveFromTranscript(transcript);
  if (!facts.lastDid && !facts.files.length) return quiet("chưa có gì để ghi");

  const body = renderState({
    agent,
    session,
    task: facts.task,
    written: new Date().toISOString(),
    lastDid: facts.lastDid,
    files: facts.files,
    note: `suy từ ${facts.lines} dòng transcript (định dạng ${facts.format})`,
  });

  const clean = sanitize(body).text;
  const path = statePath(workspace, agent, session);
  try {
    const n = writeStateAtomic(path, clean);
    pruneOld(dirname(path));
    quiet(`đã ghi ${path} (${n} byte)`);
  } catch (e) {
    quiet(`ghi hỏng, bỏ qua: ${e.message}`);
  }
}

// Bọc kín: mọi lỗi đều nuốt. Hook này không có quyền làm hỏng lượt của người dùng.
main().catch((e) => quiet(`lỗi ngoài dự kiến, bỏ qua: ${e.message}`)).finally(() => process.exit(0));
