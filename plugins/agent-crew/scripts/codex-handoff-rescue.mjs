/**
 * Lượt cứu handoff cho Codex headless: job bị cắt ở hard timeout mà evidence
 * chưa có dòng Status thì resume đúng thread đó một lượt ngắn, chỉ để worker ghi
 * `## Handoff` + `Status: CONTINUE`. Không có lượt này, một job dài bị cắt là mất
 * trắng: thread còn, nhưng không ai biết nó đã làm tới đâu.
 *
 * Tách khỏi `codexRun` vì nó có vòng đời riêng (watchdog riêng, kill riêng) và
 * chạy SAU khi tiến trình gốc đã thoát. `codexRun` await hàm này bên trong
 * `finish()` trước khi chấm job, nên job vẫn được chấm và resolve đúng một lần.
 *
 * Không cấp gì mới: cùng argv (cùng sandbox, model, effort) như job gốc, env
 * worker không token Workspace. Prompt cứu không ép được worker, nên trần ngắn.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { awakeDeadline, createAwakeClock, sleepNote, sleptSuffix } from "./lib/awake-clock.mjs";
import { codexTurnUsage, evidenceHasStatus, readWorkerStatus, workerEnv } from "./crew-guards.mjs";

export { evidenceHasStatus };

const KILL_GRACE_MS = 5_000;
const DRAIN_MS = 2_000;

/**
 * Chạy `codex <args>` với `prompt` trên stdin, ghi stream vào `stream` của job
 * gốc. Không bao giờ reject: lượt cứu hỏng thì job được chấm như chưa từng cứu.
 * → `{ran, ok, durationSec, killedFor?, usage?}`; `ok` = evidence giờ đọc ra CONTINUE.
 */
export function runHandoffRescue({ args, prompt, workspace, evidenceAbs, stream, hardMs, idleMs, now, sleepTickMs }) {
  const started = Date.now();
  stream.note(`handoff rescue: resume thread để worker ghi handoff, tối đa ${Math.round(hardMs / 1000)}s`);
  return new Promise((resolveRescue) => {
    let child;
    try {
      child = spawn("codex", args, { cwd: workspace, env: workerEnv({}), stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (err) {
      stream.note(`handoff rescue could not run: ${err.message}`);
      resolveRescue({ ran: false, ok: false, durationSec: 0, killedFor: `could not run codex: ${err.message}` });
      return;
    }
    let done = false;
    let killedFor = null;
    let idle = null;
    let hard = null;
    let drain = null;
    let residual = "";
    let usage = null;

    const signalGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    const kill = (reason) => {
      if (killedFor) return;
      killedFor = reason;
      stream.note(`crew killed the handoff rescue: ${reason}`);
      signalGroup("SIGTERM");
      hard = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const end = () => {
      if (done) return;
      done = true;
      for (const t of [idle, hard, drain]) if (t) clearTimeout(t);
      overall.clear();
      child.stdout.destroy();
      child.stderr.destroy();
      let ok = false;
      try { ok = existsSync(evidenceAbs) && readWorkerStatus(evidenceAbs).status === "continue"; } catch { /* unreadable = not rescued */ }
      stream.note(`handoff rescue ${ok ? "ghi được handoff" : "không ra Status: CONTINUE"}`);
      resolveRescue({ ran: true, ok, durationSec: Math.round((Date.now() - started) / 1000), ...(killedFor ? { killedFor } : {}), ...(usage ? { usage } : {}) });
    };
    // Giờ máy thức như lượt chính (lib/awake-clock.mjs): 24/11 lượt cứu trần
    // 180s bị cắt sau 1044s vì máy ngủ 17 phút giữa chừng.
    const clock = createAwakeClock({
      now,
      tickMs: sleepTickMs,
      onSleep: (gap) => {
        stream.note(sleepNote(gap));
        if (!killedFor) armIdle();
      },
    });
    const onIdle = () => {
      if (clock.poll() > 0) return; // vừa thức: onSleep đã hẹn lại từ đầu
      kill(`no stdout event for ${Math.round(idleMs / 1000)}s${sleptSuffix(clock)}`);
    };
    function armIdle() {
      if (idle) clearTimeout(idle);
      idle = setTimeout(onIdle, idleMs);
    }
    const overall = awakeDeadline({
      ms: hardMs,
      clock,
      tickMs: sleepTickMs,
      onExpire: () => kill(`exceeded ${Math.round(hardMs / 1000)}s${sleptSuffix(clock)}`),
    });
    armIdle();

    child.stdout.on("data", (chunk) => {
      stream.write(chunk);
      const parts = (residual + chunk).split("\n");
      residual = parts.pop() ?? "";
      for (const line of parts) usage = codexTurnUsage(line, usage);
      armIdle();
    });
    child.stderr.on("data", (chunk) => stream.write(`${JSON.stringify({ type: "crew.stderr", text: String(chunk) })}\n`));
    child.stdin.on("error", (err) => stream.note(`handoff rescue stdin failed: ${err.code ?? err.message}`));
    child.on("error", (err) => {
      stream.note(`handoff rescue could not run: ${err.message}`);
      end();
    });
    child.on("exit", () => {
      if (drain) clearTimeout(drain);
      drain = setTimeout(end, DRAIN_MS);
    });
    child.on("close", end);
    child.stdin.end(prompt);
  });
}
