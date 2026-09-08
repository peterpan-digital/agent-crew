#!/usr/bin/env node
/**
 * `crew init` and `crew doctor`.
 *
 * `doctor` exists because every prerequisite of this plugin lives outside it:
 * two third-party CLIs, git, and a Node new enough for the directory walk. When
 * one is missing the failure shows up mid-dispatch, worded in terms of whatever
 * call happened to fail first. One command that answers "what will actually run
 * here" is cheaper than teaching every error path to explain the install.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_NAME, DEFAULTS, loadConfig, runsDir } from "../config.mjs";
import { isWindows, resolveBin } from "../platform.mjs";

/** The tools a run needs, and the env var that overrides each one's path. */
const TOOLS = [
  { name: "agy", worker: "antigravity", env: "AGENT_CREW_AGY_BIN" },
  { name: "codex", worker: "codex", env: "AGENT_CREW_CODEX_BIN" },
];

const CONFIG_TEMPLATE = `{
  "runRoot": ".crew",
  "maxParallel": 3,
  "maxJobs": 6,
  "defaultTimeout": "15m",
  "briefMaxBytes": 2048,
  "protectedPaths": [
    ".env",
    ".env.local",
    ".mcp.json",
    ".claude/.mcp.json",
    ".npmrc",
    ".netrc"
  ],
  "protectedDirs": [
    ".claude/skills/",
    ".git/"
  ],
  "defaultFilesMayModify": [],
  "costGate": []
}
`;

export function init(argv, { cwd }) {
  const config = loadConfig({ workspace: cwd });
  const created = [];

  const configPath = join(config.workspace, CONFIG_NAME);
  if (existsSync(configPath)) {
    console.log(`đã có ${CONFIG_NAME}, không ghi đè`);
  } else {
    writeFileSync(configPath, CONFIG_TEMPLATE, "utf8");
    created.push(CONFIG_NAME);
  }

  // The runs directory carries its own .gitignore rather than asking the user
  // to edit the repo's: the two things inside it have opposite fates. Evidence
  // and manifests are the record and belong in a commit; a job's raw stream log
  // is large, noisy and disposable. Writing the rule here puts it next to what
  // it applies to, and means a colleague who never opens the config still gets
  // it right.
  const runs = runsDir(config);
  mkdirSync(runs, { recursive: true });
  const ignorePath = join(config.workspace, config.runRoot, ".gitignore");
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, "# raw job logs: large, noisy, disposable\nruns/*/logs/\n", "utf8");
    created.push(`${config.runRoot}/.gitignore`);
  }

  console.log(created.length ? `đã tạo: ${created.join(", ")}` : "không có gì cần tạo");
  console.log(`run sẽ nằm ở: ${config.runRoot}/runs/`);
  return 0;
}

export function doctor(argv, { cwd }) {
  let config;
  let configError = null;
  try {
    config = loadConfig({ workspace: cwd });
  } catch (err) {
    configError = err.message;
    config = { ...DEFAULTS, workspace: cwd, configPath: null, git: false };
  }

  const lines = [];
  const problems = [];

  lines.push(`platform      ${process.platform} (${process.arch})${isWindows ? " — Windows" : ""}`);
  lines.push(`node          ${process.version}`);
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    problems.push(`node ${process.version} quá cũ — cần Node 20 trở lên`);
  }

  lines.push(`workspace     ${config.workspace}`);
  lines.push(`config        ${config.configPath ?? `(không có ${CONFIG_NAME} — đang dùng mặc định)`}`);
  if (configError) problems.push(`config lỗi: ${configError}`);
  lines.push(`run root      ${config.runRoot}/runs/`);
  lines.push(`ceilings      maxJobs=${config.maxJobs} maxParallel=${config.maxParallel} timeout=${config.defaultTimeout} brief≤${config.briefMaxBytes}B`);

  lines.push(`git           ${config.git ? "có" : "KHÔNG — cổng phạm vi ghi chỉ còn một nửa"}`);
  if (!config.git) {
    problems.push(
      "không phải git repo: `crew collect` không đọc được `git status`, nên chỉ thấy file dưới prefix đã khai",
    );
  }

  let usable = 0;
  for (const tool of TOOLS) {
    try {
      const bin = resolveBin(tool.name, { envOverride: tool.env, cache: false });
      const via = bin.viaCmd ? " (cmd shim — brief sẽ đi qua file thay vì argv)" : "";
      lines.push(`${tool.name.padEnd(13)} ${bin.path}${via}`);
      usable += 1;
    } catch (err) {
      lines.push(`${tool.name.padEnd(13)} KHÔNG THẤY — worker ${tool.worker} không dùng được`);
      lines.push(`              ${String(err.detail ?? err.message).split("\n")[0]}`);
      lines.push(`              đặt ${tool.env}=<đường dẫn tuyệt đối> nếu nó không nằm trên PATH`);
    }
  }
  if (usable === 0) {
    problems.push("không có worker nào chạy được: cần ít nhất `agy` hoặc `codex`");
  }

  console.log(lines.join("\n"));
  if (problems.length) {
    console.log("\nvấn đề cần xử:");
    for (const p of problems) console.log(`  - ${p}`);
    // Exit 1, not 0-with-a-warning: this command is meant to be run before the
    // first dispatch, and a green exit on a broken install is the one answer
    // that costs more than no answer.
    return 1;
  }
  console.log("\nsẵn sàng dispatch.");
  return 0;
}
