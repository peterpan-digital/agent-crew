/**
 * `crew hook <sự kiện>` — chỗ hook của plugin gọi vào.
 *
 *   session-start  trạng thái phiên khác + bảng crew còn dở   (SessionStart)
 *   stop           ghi trạng thái phiên này                    (Stop)
 *   prompt         routing gate + mở bộ đếm nhắc giữa lượt     (UserPromptSubmit)
 *
 * PostToolUse (nhắc giữa lượt) không đi qua đây: `bin/crew-hook.sh tool` gọi thẳng
 * `turn-nudge-hook.mjs` để mỗi lượt gọi tool chỉ tốn một lần khởi động node.
 *
 * Plugin cài cấp máy nên hook bắn ở MỌI repo. Mỗi nhánh tự im khi workspace
 * chưa bật crew: state chỉ ghi khi thư mục state đã có, bảng crew chỉ in khi có
 * run, gate chỉ nói khi có `crew.config.json` hoặc `.crew/` — ở chính workspace,
 * hoặc ở repo chính khi workspace là một git worktree (session con).
 *
 * Luôn exit 0. Hook là tiện ích; nó không có quyền chặn lượt của người dùng.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCrewConfig } from "../lib/crew-config.mjs";
import { CONFIG_NAME } from "../lib/crew-layout.mjs";
import { isWorkerRole } from "../lib/crew-role.mjs";
import { classify, promptKind, render } from "../lib/routing-gate.mjs";
import { endTurn, startTurn } from "../lib/turn-nudge.mjs";
import { lastTurnSummary, markPending, takePending, turnRoutes } from "../lib/routing-decision-log.mjs";
import { workspaceRoot } from "./run-commands.mjs";
import { upgradePinnedShim } from "./crew-shim.mjs";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREW_BIN = join(SCRIPTS, "..", "bin", "crew.mjs");
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

/** Thư mục repo chính của một git worktree; null khi không phải worktree hay repo bare. */
function mainWorktree(ws) {
  const p = spawnSync("git", ["-C", ws, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 400, stdio: ["ignore", "pipe", "ignore"] });
  const common = p.status === 0 ? p.stdout.trim() : "";
  if (!common || basename(common) !== ".git") return null;
  const main = dirname(common);
  return main === ws ? null : main;
}

/**
 * Workspace mang config crew cho phiên này. Session con của app thường chạy
 * trong một worktree mới, nơi chỉ có file đã commit; `crew init` ghi
 * `crew.config.json` mà không commit, nên worktree "quên" repo đã bật crew.
 * Workspace chưa bật thì mượn config của repo chính.
 */
export function crewWorkspace(ws) {
  if (optedIn(ws)) return ws;
  const main = mainWorktree(ws);
  return main && optedIn(main) ? main : ws;
}

function gitBranch(ws) {
  const p = spawnSync("git", ["-C", ws, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 400, stdio: ["ignore", "pipe", "ignore"] });
  return p.status === 0 ? p.stdout.trim() : null;
}

/**
 * Schema chốt: thời điểm, branch git, quyết định, nguồn prompt, id trigger.
 * KHÔNG BAO GIỜ ghi nội dung prompt.
 *
 * `from` là `user` (owner gõ) hay `peer` (tin chéo từ session khác). Đo 11–12/11:
 * hai nguồn ghi lẫn nhau nên 24h log ra 39 `consider` / 2 `turn` — chỉ prompt owner
 * mới bắt ghi dòng quyết định, nên tỉ lệ đọc như nhau là sai. Tách nguồn ra thì
 * mẫu số đúng. Luật bắt ghi không đổi: peer vẫn không bị bắt ghi dòng quyết định.
 */
function logFire(path, ws, decision, hits, from) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch { /* chưa có file */ }
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), branch: gitBranch(ws), decision, from, triggers: hits.map((h) => h.id) })}\n`, { mode: 0o600 });
  } catch { /* log hỏng không được ảnh hưởng lượt của người dùng */ }
}

/**
 * Nơi ghi log gate. Biến môi trường rẽ log cho bộ test: test ghi vào log thật thì
 * log đó hết còn là nguồn để chấm gate (21/09 một lần test crash bỏ lại 12 dòng
 * giả). Repo aggressive không khai `routingLog` vẫn có log mặc định trong
 * `.crew/logs/` (đã gitignore), vì chế độ đó cần đo được giao thừa hay thiếu.
 */
function gateLogPath(config, ws) {
  if (process.env.CREW_GATE_LOG) return isAbsolute(process.env.CREW_GATE_LOG) ? process.env.CREW_GATE_LOG : null;
  if (config.routingLog) return join(ws, config.routingLog);
  if (config.delegate === "aggressive" && config.layout.evidenceRoot === ".crew") return join(ws, ".crew", "logs", "routing-gate.jsonl");
  return null;
}

function promptGate(payload, start) {
  if ((payload.hook_event_name ?? "UserPromptSubmit") !== "UserPromptSubmit") return;
  // Worker không điều phối: gợi ý chia việc cho nó là mời nó dispatch tiếp.
  if (isWorkerRole()) return;
  const prompt = payload.prompt ?? payload.user_prompt ?? "";
  const kind = promptKind(prompt);
  const ws = crewWorkspace(start);
  if (!optedIn(ws)) return;
  const config = loadCrewConfig(ws);
  // Bộ đếm nhắc giữa lượt: mở lại ở mỗi việc mới (kể cả "làm hết luôn", gate im);
  // tin app tự chèn giữa chừng thì giữ bộ đếm của lượt đang chạy.
  if (kind !== "injected") (config.delegate === "aggressive" ? startTurn : endTurn)(payload.session_id);
  const { branch, hits } = classify(prompt, config);
  if (branch === "none") return;
  const logPath = gateLogPath(config, ws);
  if (logPath) {
    logFire(logPath, ws, branch, hits, kind);
    // Tin của session khác vẫn được cân nhắc nhưng không bắt dòng quyết định:
    // phần lớn là báo cáo trạng thái, bắt ghi thì log toàn `missing`.
    if ((branch === "delegate" || branch === "consider") && kind === "user") markPending(logPath, payload.session_id, branch);
  }
  process.stdout.write(render(branch, hits));
}

/**
 * Hook Stop: lượt vừa xong có gate bắt ghi dòng quyết định → đọc nó từ transcript
 * và ghi tuyến vào cùng log. Lượt gate không bắn thì không ghi gì.
 */
function logTurnDecision(payload, start) {
  if (isWorkerRole()) return;
  const ws = crewWorkspace(start);
  if (!optedIn(ws)) return;
  const logPath = gateLogPath(loadCrewConfig(ws), ws);
  if (!logPath) return;
  const gate = takePending(logPath, payload.session_id);
  if (!gate) return;
  const turn = typeof payload.transcript_path === "string" ? lastTurnSummary(payload.transcript_path) : { line: null, toolCalls: 0 };
  try {
    appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), branch: gitBranch(ws), decision: "turn", gate, routes: turnRoutes(turn), toolCalls: turn.toolCalls })}\n`, { mode: 0o600 });
  } catch { /* log hỏng không được ảnh hưởng lượt của người dùng */ }
}

/** Chạy script trạng thái với payload gốc, workspace đã giải sẵn. */
function stateScript(file, raw, ws) {
  const p = spawnSync(process.execPath, [join(SCRIPTS, file), "--agent", "claude", "--workspace", ws], {
    input: raw, encoding: "utf8", timeout: 20_000, stdio: ["pipe", "pipe", "pipe"],
  });
  if (p.stdout) process.stdout.write(p.stdout);
}

const EVENTS = {
  "session-start": (raw, payload, ws) => {
    // Shim cũ ghim vào thư mục cache của một version trước: đổi sang kiểu theo bản
    // đang cài, để `/plugin update` xong là lệnh `crew` lên theo. Im lặng, không throw.
    if (!isWorkerRole()) upgradePinnedShim({ crewBin: CREW_BIN });
    stateScript("agent-state-read.mjs", raw, ws);
  },
  stop: (raw, payload, ws) => {
    try {
      logTurnDecision(payload, ws);
    } catch { /* đo hỏng thì vẫn phải ghi trạng thái phiên */ }
    stateScript("agent-state-write.mjs", raw, ws);
  },
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
