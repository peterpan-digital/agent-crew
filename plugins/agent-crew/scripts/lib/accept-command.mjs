/**
 * Lệnh nghiệm thu (`--accept-cmd`) do gate `crew collect` tự chạy thay vì tin
 * dòng `Status:` worker tự khai.
 *
 * `collectRun` là API đồng bộ nên phần chạy `/bin/sh -c` tách sang tiến trình
 * node con (`--exec-child`): tiến trình con spawn shell ở nhóm tiến trình riêng
 * (`detached: true`) để khi quá hạn giết trọn cả nhóm (kể cả tiến trình cháu),
 * gom stdout+stderr theo thứ tự thật và chỉ giữ 20 dòng cuối (≤ 300 ký tự/dòng).
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceDigest } from "../crew-guards.mjs";
import { resolveEvidence } from "../crew-reconcile.mjs";
import { ROLE_VARS } from "./crew-role.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const MAX_TAIL_LINES = 20;
const MAX_LINE_CHARS = 300;
const KILL_GRACE_MS = 300;
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

export const DEFAULT_ACCEPT_TIMEOUT = "15m";
export const DEFAULT_ACCEPT_TIMEOUT_MS = 15 * 60_000;

/** Đọc hạn thời gian kiểu Go ("90s", "10m", "1h", "1h30m"), không bị trần 30m của job. */
export function parseAcceptTimeout(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:\d+(?:\.\d+)?[hms])+$/.test(text)) {
    throw new Error(`không đọc được --accept-timeout "${value}" (dùng dạng "90s", "10m", "1h")`);
  }
  const unit = { h: 3_600_000, m: 60_000, s: 1000 };
  const ms = [...text.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)]
    .reduce((sum, [, n, u]) => sum + Number(n) * unit[u], 0);
  if (!(ms > 0) || !Number.isFinite(ms)) {
    throw new Error(`--accept-timeout "${value}" phải dương`);
  }
  return ms;
}

/** Đổi số giây sang nhãn gọn khi dùng lại kết quả quá hạn đã lưu trong sổ. */
export function formatAcceptDuration(sec) {
  const n = Number.isFinite(sec) && sec >= 0 ? Math.round(sec) : 0;
  if (n >= 3600 && n % 3600 === 0) return `${n / 3600}h`;
  if (n >= 60 && n % 60 === 0) return `${n / 60}m`;
  return `${n}s`;
}

/** Thư mục chạy lệnh: `workspace` + `acceptCwd` (không khai thì dùng `workspace`). */
export function resolveAcceptCwd(workspace, acceptCwd) {
  return acceptCwd ? resolve(workspace, acceptCwd) : resolve(workspace);
}

/** Dòng cuối không rỗng của tail (nhận cả mảng dòng lẫn chuỗi). */
export function lastNonEmptyLine(tail) {
  const lines = Array.isArray(tail) ? tail : String(tail ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const s = String(lines[i] ?? "").trim();
    if (s) return s;
  }
  return null;
}

/** Bỏ biến vai worker khỏi env để test của chính crew không bị guard chặn. */
export function acceptanceEnv(baseEnv = process.env) {
  const out = { ...baseEnv };
  for (const k of ROLE_VARS) delete out[k];
  return out;
}

/** Chạy đồng bộ `/bin/sh -c "<cmd>"` qua tiến trình con quản lý nhóm tiến trình + timeout. */
export function runAcceptanceCommand({ cmd, cwd, timeoutMs = DEFAULT_ACCEPT_TIMEOUT_MS, env = process.env }) {
  const ranAt = new Date().toISOString();
  const proc = spawnSync(process.execPath, [SELF_PATH, "--exec-child"], {
    input: JSON.stringify({ cmd, cwd, timeoutMs }),
    env: acceptanceEnv(env),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    // Trần dự phòng lớn hơn timeout của con để nhánh giết nhóm tiến trình luôn kết thúc trước.
    timeout: timeoutMs + 10_000,
  });
  if (proc.status === 0 && proc.stdout) {
    const res = JSON.parse(proc.stdout);
    return {
      cmd,
      cwd,
      exitCode: res.exitCode,
      timedOut: Boolean(res.timedOut),
      durationSec: res.durationSec,
      ranAt,
      tail: Array.isArray(res.tail) ? res.tail : [],
    };
  }
  const msg = String(proc.stderr || proc.error?.message || "lỗi chạy tiến trình nghiệm thu").trim().slice(0, MAX_LINE_CHARS);
  return {
    cmd,
    cwd,
    exitCode: proc.status ?? 1,
    timedOut: proc.error?.code === "ETIMEDOUT",
    durationSec: 0,
    ranAt,
    tail: msg ? [msg] : [],
  };
}

/** Áp kết quả `acceptance` lên `row` theo luật chấm của gate. */
export function applyAcceptanceVerdict(row, acceptance, { timeoutLabel = null } = {}) {
  if (acceptance.timedOut) {
    const dur = timeoutLabel || formatAcceptDuration(acceptance.durationSec);
    const last = lastNonEmptyLine(acceptance.tail);
    row.verdict = "FAIL";
    row.detail = last ? `lệnh nghiệm thu quá hạn ${dur}: ${last}` : `lệnh nghiệm thu quá hạn ${dur}`;
    return;
  }
  if (acceptance.exitCode === 0) {
    row.detail = row.detail ? `${row.detail}; ACCEPT OK` : "ACCEPT OK";
    return;
  }
  const last = lastNonEmptyLine(acceptance.tail);
  row.verdict = "FAIL";
  row.detail = last
    ? `lệnh nghiệm thu exit ${acceptance.exitCode}: ${last}`
    : `lệnh nghiệm thu exit ${acceptance.exitCode}`;
}

/** Khớp cache `job.acceptance` theo đúng bộ ba (cmd, cwd, evidenceSha256 lúc collect). */
function cachedAcceptance(job, cwd, evidenceSha256) {
  const prev = job.acceptance;
  if (!prev || typeof prev !== "object") return null;
  if (prev.cmd !== job.acceptCmd || prev.cwd !== cwd || prev.evidenceSha256 !== evidenceSha256) return null;
  return prev;
}

/**
 * Dùng cho `verdictOfJob` (chỉ đọc, không chạy lệnh): nếu job đã có kết quả nghiệm thu
 * khớp bản evidence hiện tại thì phản ánh đúng verdict (để `crew hold --failed` nhận ra FAIL).
 */
export function applyCachedAcceptance(job, row, workspace) {
  if (row.verdict !== "PASS" || !job?.acceptCmd) return;
  if (!job.writeSandbox?.kind) {
    row.verdict = "NEEDS_HUMAN";
    row.detail = `không có sandbox ghi, không tự chạy: ${job.acceptCmd} — kiểm tra lệnh rồi chạy với --accept-run ${job.seq}`;
    return;
  }
  const evidenceAbs = resolveEvidence(job, workspace);
  if (!evidenceAbs) return;
  const cwd = resolveAcceptCwd(workspace, job.acceptCwd);
  const hit = cachedAcceptance(job, cwd, evidenceDigest(evidenceAbs));
  if (hit) applyAcceptanceVerdict(row, hit);
}

/**
 * Đánh giá lệnh nghiệm thu cho một job đã ra `PASS`:
 *   1. Không có sandbox ghi và không có `--accept-run <seq>` → NEEDS_HUMAN, không chạy.
 *   2. Sổ đã có `job.acceptance` khớp (cmd, cwd, sha evidence lúc collect) → dùng lại.
 *   3. Còn lại → chạy `/bin/sh -c`, chấm, trả `acceptance` để collect lưu sổ (trừ `--dry-run`).
 */
export function evaluateJobAcceptance(
  job,
  row,
  { workspace, acceptRunSet = new Set(), acceptTimeoutMs = DEFAULT_ACCEPT_TIMEOUT_MS, acceptTimeoutLabel = DEFAULT_ACCEPT_TIMEOUT, env = process.env },
) {
  if (row.verdict !== "PASS" || !job?.acceptCmd) return { ran: false, acceptance: null };

  // Job không sandbox ghi: worker đã có thể tự sửa lệnh trong manifest nên không tự chạy.
  if (!job.writeSandbox?.kind && !acceptRunSet.has(job.seq)) {
    row.verdict = "NEEDS_HUMAN";
    row.detail = `không có sandbox ghi, không tự chạy: ${job.acceptCmd} — kiểm tra lệnh rồi chạy với --accept-run ${job.seq}`;
    return { ran: false, acceptance: null };
  }

  const evidenceAbs = resolveEvidence(job, workspace);
  const currentSha = evidenceDigest(evidenceAbs);
  const cwd = resolveAcceptCwd(workspace, job.acceptCwd);

  const hit = cachedAcceptance(job, cwd, currentSha);
  if (hit) {
    applyAcceptanceVerdict(row, hit);
    return { ran: false, acceptance: hit };
  }

  const ran = runAcceptanceCommand({ cmd: job.acceptCmd, cwd, timeoutMs: acceptTimeoutMs, env });
  const acceptance = {
    cmd: ran.cmd,
    cwd: ran.cwd,
    exitCode: ran.exitCode,
    timedOut: ran.timedOut,
    durationSec: ran.durationSec,
    ranAt: ran.ranAt,
    evidenceSha256: currentSha,
    tail: ran.tail,
  };
  applyAcceptanceVerdict(row, acceptance, { timeoutLabel: acceptTimeoutLabel });
  return { ran: true, acceptance };
}

// --- Tiến trình con (--exec-child): chạy /bin/sh -c trong nhóm tiến trình riêng ---

function killGroup(pid, sig) {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch { /* nhóm đã thoát */ }
  try { process.kill(pid, sig); } catch { /* tiến trình đã thoát */ }
}

function execChild() {
  const { cmd, cwd, timeoutMs } = JSON.parse(readFileSync(0, "utf8"));
  const lines = [];
  let partial = "";
  const pushLine = (raw) => {
    const clean = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    lines.push(clean.slice(0, MAX_LINE_CHARS));
    if (lines.length > MAX_TAIL_LINES) lines.shift();
  };
  const onData = (buf) => {
    const s = buf.toString("utf8");
    let start = 0;
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === "\n") {
        pushLine(partial + s.slice(start, i));
        partial = "";
        start = i + 1;
      }
    }
    if (start < s.length && partial.length <= MAX_LINE_CHARS) {
      partial = (partial + s.slice(start)).slice(0, MAX_LINE_CHARS + 1);
    }
  };

  const startedMs = Date.now();
  let timedOut = false;
  let done = false;
  let softTimer = null;
  let hardTimer = null;

  const child = spawn("/bin/sh", ["-c", cmd], {
    cwd,
    env: acceptanceEnv(process.env),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const finish = (exitCode) => {
    if (done) return;
    done = true;
    clearTimeout(softTimer);
    clearTimeout(hardTimer);
    if (partial.length > 0) pushLine(partial);
    const durationSec = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
    process.stdout.write(JSON.stringify({ exitCode, timedOut, durationSec, tail: lines }));
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  softTimer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid, "SIGTERM");
    hardTimer = setTimeout(() => {
      killGroup(child.pid, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, KILL_GRACE_MS);
  }, timeoutMs);

  child.on("error", (err) => {
    pushLine(`không chạy được lệnh nghiệm thu: ${err.message}`);
    finish(127);
  });

  child.on("close", (code, signal) => {
    const exitCode = timedOut
      ? null
      : (code ?? (signal ? 128 + (SIGNALS[signal] ?? 1) : 1));
    finish(exitCode);
  });
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes("--exec-child")) {
  execChild();
}
