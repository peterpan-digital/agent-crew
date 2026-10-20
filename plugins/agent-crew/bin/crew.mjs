#!/usr/bin/env node
/**
 * `crew` — một cửa vào cho mọi lệnh của crew.
 *
 * Trước đây skill gọi từng script bằng đường tương đối từ gốc workspace
 * (`mwg-agent-crew/scripts/...`), nên module phải nằm trong đúng repo đang làm.
 * Ở dạng plugin cài cấp máy thì repo nào cũng gọi được `crew <lệnh>`, và đường
 * dẫn thật của script chỉ nằm ở một chỗ: bảng dưới đây.
 *
 * Lệnh nào đã có script thì chạy script đó ở tiến trình con, giữ nguyên tham số,
 * stdio và exit code — không viết lại logic. Script tự từ chối cờ lạ. Tín hiệu
 * dừng chuyển tiếp xuống con, để adapter vẫn kịp ghi cái chết của chính nó.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");

/** Lệnh chạy thẳng một script có sẵn. */
const SCRIPT_COMMANDS = {
  collect: { file: "crew-collect.mjs", help: "nghiệm thu run: <manifest> [--dry-run] [--report <file>] ..." },
  hold: { file: "crew-hold.mjs", help: "hàng chờ quyết định: <manifest> list|add|answer|defer|cover ..." },
  reconcile: { file: "crew-reconcile.mjs", help: "vá sổ từ evidence trên đĩa: <manifest> [--cancel-orphans]" },
  session: { file: "crew-session.mjs", help: "run-for | latest --worker anti|codex [--task <task>]" },
  probe: { file: "crew-runtime-probe.mjs", help: "đọc runtime Codex mà run đang ngồi lên" },
  "anti-env": { file: "anti-env.mjs", help: "runtime của app Antigravity (pid, địa chỉ)" },
  "anti-status": { file: "anti-status.mjs", help: "tiến độ một conversation Antigravity (chỉ đọc)" },
  "export-session": { file: "claude-session-export.mjs", help: "xuất phiên Claude thành bản bàn giao gầy" },
  "state-read": { file: "agent-state-read.mjs", help: "in trạng thái các phiên khác (cho hook SessionStart)" },
  "state-write": { file: "agent-state-write.mjs", help: "ghi trạng thái phiên này (cho hook Stop)" },
};

/** `crew run anti|codex ...` → adapter của worker đó. */
const ADAPTERS = { anti: "anti-run.mjs", antigravity: "anti-run.mjs", codex: "codex-run.mjs" };

/** Lệnh viết trong `scripts/cli/`, nạp lười để `crew --help` không kéo theo cả module. */
const CLI_COMMANDS = {
  "new-run": { load: () => import("../scripts/cli/run-commands.mjs"), fn: "newRun", help: "tạo run: [--task <task>] [--run <id>] → in đường manifest" },
  "add-job": { load: () => import("../scripts/cli/run-commands.mjs"), fn: "addJobCli", help: "ghi job vào sổ trước khi bắn: <manifest> --worker --role --title ... → in seq" },
  amend: { load: () => import("../scripts/cli/run-commands.mjs"), fn: "amend", help: "sửa job đã ghi: <manifest> --job N [--allow <prefix>]... --note \"...\"" },
  paths: { load: () => import("../scripts/cli/run-commands.mjs"), fn: "paths", help: "đường của một job: <manifest> --job N → evidence, brief, logs, anti-watch" },
  digest: { load: () => import("../scripts/cli/run-commands.mjs"), fn: "digest", help: "bảng crew còn dở của workspace này" },
  doctor: { load: () => import("../scripts/cli/setup.mjs"), fn: "doctor", help: "máy này chạy được gì: node, git, config, agy, codex, model còn sống" },
  init: { load: () => import("../scripts/cli/setup.mjs"), fn: "init", help: "chuẩn bị .crew/ trong repo này" },
  install: { load: () => import("../scripts/cli/setup.mjs"), fn: "install", help: "ghi shim ~/.local/bin/crew trỏ vào bản này" },
  hook: { load: () => import("../scripts/cli/hook.mjs"), fn: "hook", help: "cho hook plugin: session-start | stop | prompt (payload qua stdin, luôn exit 0)" },
};

function usage() {
  const rows = [
    ["run anti|codex ...", "bắn một job; có --manifest --job thì evidence/workspace/mode/model lấy từ sổ"],
    ...Object.entries(CLI_COMMANDS).map(([k, v]) => [k, v.help]),
    ...Object.entries(SCRIPT_COMMANDS).map(([k, v]) => [k, v.help]),
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return `dùng: crew <lệnh> [tham số]\n\n${rows.map(([k, h]) => `  ${k.padEnd(w)}  ${h}`).join("\n")}\n`;
}

/** Chạy script ở tiến trình con; trả exit code của nó. Tín hiệu dừng chuyển tiếp xuống. */
function runScript(file, args) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [join(SCRIPTS, file), ...args], { stdio: "inherit" });
    const forward = (sig) => () => child.kill(sig);
    const handlers = ["SIGTERM", "SIGINT", "SIGHUP"].map((sig) => [sig, forward(sig)]);
    for (const [sig, h] of handlers) process.on(sig, h);
    child.on("error", (err) => {
      process.stderr.write(`crew: không chạy được ${file}: ${err.message}\n`);
      resolveExit(127);
    });
    child.on("exit", (code, signal) => {
      for (const [sig, h] of handlers) process.off(sig, h);
      // Con chết vì tín hiệu: trả 128 + số hiệu như shell, đừng đọc thành thành công.
      const signo = signal ? { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[signal] ?? 1 : 0;
      resolveExit(code ?? 128 + signo);
    });
  });
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(usage());
    return cmd ? 0 : 2;
  }
  if (cmd === "run") {
    const [worker, ...args] = rest;
    const file = ADAPTERS[worker];
    if (!file) {
      process.stderr.write(`crew run: worker phải là anti|codex, nhận "${worker ?? ""}"\n`);
      return 2;
    }
    const { expandRunArgs } = await import("../scripts/cli/run-commands.mjs");
    return runScript(file, expandRunArgs(args, { cwd: process.cwd() }));
  }
  if (SCRIPT_COMMANDS[cmd]) return runScript(SCRIPT_COMMANDS[cmd].file, rest);
  if (CLI_COMMANDS[cmd]) {
    const { load, fn } = CLI_COMMANDS[cmd];
    const mod = await load();
    return mod[fn](rest, { cwd: process.cwd() });
  }
  process.stderr.write(`crew: lệnh lạ "${cmd}"\n\n${usage()}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0; },
  (err) => {
    process.stderr.write(`crew: ${err.message}\n`);
    process.exitCode = 1;
  },
);
