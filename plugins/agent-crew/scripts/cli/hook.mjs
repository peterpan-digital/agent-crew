/**
 * `crew hook <sự kiện>` — chỗ hook của plugin gọi vào.
 *
 *   session-start  trạng thái phiên khác + bảng crew còn dở   (SessionStart)
 *   stop           ghi trạng thái phiên này                    (Stop)
 *   prompt         routing gate                                (UserPromptSubmit)
 *
 * Plugin cài cấp máy nên hook bắn ở MỌI repo. Mỗi nhánh tự im khi workspace
 * chưa bật crew: state chỉ ghi khi thư mục state đã có, bảng crew chỉ in khi có
 * run, gate chỉ nói khi có `crew.config.json` hoặc `.crew/`.
 *
 * Luôn exit 0. Hook là tiện ích; nó không có quyền chặn lượt của người dùng.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCrewConfig } from "../lib/crew-config.mjs";
import { CONFIG_NAME } from "../lib/crew-layout.mjs";
import { isWorkerRole } from "../lib/crew-role.mjs";
import { classify, render } from "../lib/routing-gate.mjs";
import { workspaceRoot } from "./run-commands.mjs";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_MAX_BYTES = 256 * 1024;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parsePayload(raw) {
  try {
    const p = raw.trim() ? JSON.parse(raw) : {};
    return p && typeof p === "object" && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

/** Gốc workspace của phiên: thư mục dự án Claude Code báo, không thì cwd của payload; đi lên gốc git. */
function workspaceOf(payload, cwd) {
  const start = process.env.CLAUDE_PROJECT_DIR || (typeof payload.cwd === "string" && payload.cwd) || cwd;
  return workspaceRoot(resolve(start));
}

export const optedIn = (ws) => existsSync(join(ws, CONFIG_NAME)) || existsSync(join(ws, ".crew"));

function gitBranch(ws) {
  const p = spawnSync("git", ["-C", ws, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 400, stdio: ["ignore", "pipe", "ignore"] });
  return p.status === 0 ? p.stdout.trim() : null;
}

/** Schema chốt: thời điểm, branch git, quyết định, id trigger. KHÔNG BAO GIỜ ghi nội dung prompt. */
function logFire(path, ws, decision, hits) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch { /* chưa có file */ }
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), branch: gitBranch(ws), decision, triggers: hits.map((h) => h.id) })}\n`, { mode: 0o600 });
  } catch { /* log hỏng không được ảnh hưởng lượt của người dùng */ }
}

function promptGate(payload, ws) {
  if ((payload.hook_event_name ?? "UserPromptSubmit") !== "UserPromptSubmit") return;
  // Worker không điều phối: gợi ý chia việc cho nó là mời nó dispatch tiếp.
  if (isWorkerRole() || !optedIn(ws)) return;
  const config = loadCrewConfig(ws);
  const { branch, hits } = classify(payload.prompt ?? payload.user_prompt ?? "", config);
  if (branch === "none") return;
  // Biến môi trường rẽ log cho bộ test: test ghi vào log thật thì log đó hết
  // còn là nguồn để chấm gate (21/09 một lần test crash bỏ lại 12 dòng giả).
  const logPath = process.env.CREW_GATE_LOG || (config.routingLog && join(ws, config.routingLog));
  if (logPath && isAbsolute(logPath)) logFire(logPath, ws, branch, hits);
  process.stdout.write(render(branch, hits));
}

/** Chạy script trạng thái với payload gốc, workspace đã giải sẵn. */
function stateScript(file, raw, ws) {
  const p = spawnSync(process.execPath, [join(SCRIPTS, file), "--agent", "claude", "--workspace", ws], {
    input: raw, encoding: "utf8", timeout: 20_000, stdio: ["pipe", "pipe", "pipe"],
  });
  if (p.stdout) process.stdout.write(p.stdout);
}

const EVENTS = {
  "session-start": (raw, payload, ws) => stateScript("agent-state-read.mjs", raw, ws),
  stop: (raw, payload, ws) => stateScript("agent-state-write.mjs", raw, ws),
  prompt: (raw, payload, ws) => promptGate(payload, ws),
};

export function hook(argv, { cwd }) {
  const event = argv[0];
  if (!EVENTS[event] || argv.length !== 1) {
    process.stderr.write(`crew hook: sự kiện phải là ${Object.keys(EVENTS).join("|")}\n`);
    return 2;
  }
  try {
    const raw = readStdin();
    const payload = parsePayload(raw);
    EVENTS[event](raw, payload, workspaceOf(payload, cwd));
  } catch (err) {
    // Fail open, luôn luôn.
    process.stderr.write(`WARN: crew hook ${event} failed open: ${err.message}\n`);
  }
  return 0;
}
