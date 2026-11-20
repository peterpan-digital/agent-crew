/**
 * `crew doctor`, `crew init`, `crew install`.
 *
 * `doctor` tồn tại vì mọi điều kiện của crew nằm ngoài nó: hai CLI của bên thứ
 * ba, git, Node, và tên model mà hai CLI đó còn nhận. Thiếu một thứ thì lỗi lộ
 * ra giữa lúc dispatch, nói bằng ngôn ngữ của lệnh hỏng đầu tiên. Đo 16/10: hai
 * job đầu của một run chết ngay lượt đầu vì tên model trong tài liệu đã hết hạn.
 * Một lệnh trả lời "máy này chạy được gì" rẻ hơn dạy mọi đường lỗi giải thích.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DELEGATE_MODES, loadCrewConfig } from "../lib/crew-config.mjs";
import { TIERS, TierError, codexConfigModel, liveCodexModels, parseAgyModels, resolveTier } from "../lib/model-tiers.mjs";
import { CONFIG_NAME, DEFAULT_LAYOUT, loadLayout, usesTask } from "../lib/crew-layout.mjs";
import { CliError, nestedRepoWarning, parseFlags, workspaceRoot } from "./run-commands.mjs";
import { SHIM_MARK, pluginInstallOf, readShim, shimPath, shimScript, stableNode } from "./crew-shim.mjs";

export { shimPath, shimScript, stableNode };

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CREW_BIN = join(PLUGIN_ROOT, "bin", "crew.mjs");

const run = (cmd, args, timeout = 15_000) => {
  const p = spawnSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: p.status === 0, out: `${p.stdout ?? ""}`.trim(), err: p.error?.message ?? `${p.stderr ?? ""}`.trim() };
};

export { codexConfigModel, parseAgyModels };

/**
 * Mỗi bậc `--tier` đang ra gì trên máy này: Anti headless (theo `agy models`),
 * Anti app, Codex. Bậc không khớp thì in lý do, không tính là lỗi của doctor.
 */
export function tierTable(names, overrides = {}, codexModels = []) {
  const cell = (args) => {
    try {
      const r = resolveTier({ ...args, overrides });
      return r.effort ? `${r.model} ${r.effort}` : r.model;
    } catch (err) {
      if (!(err instanceof TierError)) throw err;
      return "—";
    }
  };
  return TIERS.map((tier) => `${tier.padEnd(10)} anti ${cell({ worker: "antigravity", tier, liveAgyModels: names })}` +
    ` · anti app ${cell({ worker: "antigravity", transport: "app", tier })}` +
    ` · codex ${cell({ worker: "codex", tier, liveCodexModels: codexModels })}`);
}

/** Slug model trong cache của Codex. Cache liệt kê model của nhà cung cấp, không nói tài khoản này được dùng cái nào. */
export function codexCachedModels(home = homedir()) {
  try {
    const j = JSON.parse(readFileSync(join(home, ".codex", "models_cache.json"), "utf8"));
    return (j.models ?? []).map((m) => m.slug).filter(Boolean);
  } catch {
    return [];
  }
}

export async function doctor(argv, { cwd }) {
  try {
    parseFlags(argv, []);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const lines = [];
  const problems = [];
  const say = (label, text) => lines.push(`  ${label.padEnd(12)} ${text}`);

  const major = Number(process.versions.node.split(".")[0]);
  say("plugin", PLUGIN_ROOT);
  say("node", `${process.versions.node} (${stableNode()})`);
  if (major < 20) problems.push(`Node ${process.versions.node} quá cũ — cần 20+`);

  const git = run("git", ["--version"]);
  say("git", git.ok ? git.out : "KHÔNG có");
  if (!git.ok) problems.push("không có git — cổng phạm vi ghi cần git status");
  const workspace = workspaceRoot(cwd);
  const inRepo = git.ok && run("git", ["rev-parse", "--is-inside-work-tree"]).out === "true";
  say("workspace", `${workspace}${inRepo ? "" : " — KHÔNG phải git repo"}`);
  if (!inRepo) problems.push("thư mục này không phải git repo — crew new-run sẽ từ chối (chạy git init)");

  let modelTiers = {};
  try {
    const { layout, routingTriggers, routingLog, costGate, redactConfig, delegate, ...rules } = loadCrewConfig(workspace);
    modelTiers = rules.modelTiers;
    const custom = existsSync(join(workspace, CONFIG_NAME));
    say("layout", `${custom ? CONFIG_NAME : "mặc định (chưa có crew.config.json)"} — run ở ${layout.runDir}, evidence trong ${layout.evidenceRoot}/`);
    // Nói thẳng có cần --task không. Đo 19/11/2026: session chạy doctor ngay trước rồi vẫn
    // gõ `crew new-run --task …` ở layout không task, lần thứ 3 trong một tuần.
    say("task", usesTask(layout)
      ? `cần --task: crew new-run --task <tên> (thư mục task: ${layout.taskDir})`
      : "layout không task — crew new-run không --task");
    const nestedWarn = nestedRepoWarning(workspace);
    if (nestedWarn) problems.push(nestedWarn);
    say("routing", routingTriggers.length
      ? `${routingTriggers.length} trigger (${[...new Set(routingTriggers.map((t) => t.kind))].join(", ")})${routingLog ? `, log ${routingLog}` : ""}`
      : "không khai trigger — hook chỉ nói khi owner gõ @anti/@codex");
    say("delegate", delegate === "aggressive"
      ? "aggressive — gate gợi ý giao code/research từ 1 đầu việc"
      : "default — gate chỉ gợi ý khi ≥2 loại đầu việc (bật: crew init --delegate aggressive)");
    say("cost gate", costGate.length ? costGate.map((c) => c.api).join(", ") : "không khai — brief không có dòng cổng chi phí");
    say("redact", !redactConfig
      ? "không khai redactConfig — state phiên/export chỉ che theo hình dạng chung"
      : existsSync(join(workspace, redactConfig))
        ? redactConfig
        : `${redactConfig} — CHƯA CÓ FILE, chỉ che theo hình dạng chung`);
  } catch (err) {
    say("layout", "HỎNG");
    problems.push(err.message);
  }

  const workers = [];
  let agyNames = [];
  const agy = run("agy", ["--version"]);
  if (agy.ok) {
    workers.push("anti");
    say("agy", agy.out.split("\n")[0]);
    const models = run("agy", ["models"], 30_000);
    const names = models.ok ? parseAgyModels(models.out) : [];
    agyNames = names;
    say("", names.length ? `model còn sống: ${names.join(", ")}` : `không đọc được \`agy models\`: ${models.err.split("\n")[0]}`);
  } else {
    say("agy", "không có trên PATH — worker Antigravity không chạy được");
  }
  const codex = run("codex", ["--version"]);
  if (codex.ok) {
    workers.push("codex");
    say("codex", codex.out.split("\n")[0]);
    const cfg = codexConfigModel();
    say("", `model trong ~/.codex/config.toml: ${cfg ?? "(chưa đặt)"}`);
    const cached = codexCachedModels();
    if (cached.length) say("", `cache của Codex liệt kê: ${cached.join(", ")} (không chắc tài khoản được dùng hết)`);
  } else {
    say("codex", "không có trên PATH — worker Codex không chạy được");
  }
  if (!workers.length) problems.push("không có worker nào: cài agy hoặc codex");

  // Một chữ `--tier` ra model nào trên máy này. "—" là bậc không dành cho đường đó
  // (hoặc không khớp model còn sống); add-job sẽ báo lý do đầy đủ.
  let codexModels = [];
  if (workers.includes("codex")) try { codexModels = liveCodexModels(); } catch { /* bậc Codex in "—" */ }
  tierTable(agyNames, modelTiers, codexModels).forEach((row, i) => say(i ? "" : "tier", row));

  // Anti app là ngoại lệ có tên, không phải điều kiện: báo, không tính là lỗi.
  try {
    const { resolveAntiEnv } = await import("../anti-env.mjs");
    const env = resolveAntiEnv(workspace);
    say("anti app", `app pid ${env.pid}`);
  } catch (err) {
    say("anti app", `không dùng được transport app: ${String(err.message).split("\n")[0]}`);
  }

  const shim = shimPath();
  const onPath = (process.env.PATH ?? "").split(delimiter).includes(dirname(shim));
  const st = readShim(shim);
  const reinstall = `chạy: node "${CREW_BIN}" install`;
  const where = {
    none: `chưa cài — ${reinstall}`,
    foreign: "không phải shim của crew (crew install không ghi đè; --force on nếu chắc)",
    follow: st.key === pluginInstallOf(CREW_BIN)?.key
      ? `theo bản plugin đang cài (${st.key}) — /plugin update là lệnh crew lên theo`
      : `theo plugin ${st.key}, không phải bản đang chạy — ${reinstall}`,
    pinned: st.target === CREW_BIN
      ? `ghim vào bản này${pluginInstallOf(CREW_BIN) ? " (cache có số version: /plugin update sẽ không kéo theo — " + reinstall + ")" : ""}`
      : `ghim vào bản KHÁC (${st.target ?? "?"}) — ${reinstall}`,
  }[st.kind];
  say("shim", `${shim}: ${where}${onPath ? "" : `; ${dirname(shim)} KHÔNG có trong PATH`}`);

  process.stdout.write(`crew doctor\n${lines.join("\n")}\n`);
  if (problems.length) {
    process.stdout.write(`\nVẤN ĐỀ:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write("\nok\n");
  return 0;
}

/**
 * Chuẩn bị `.crew/` cho repo dùng layout mặc định. Không tự viết vào CLAUDE.md
 * hay AGENTS.md của repo: đó là luật của dự án, người của dự án viết.
 */
export function init(argv, { cwd }) {
  let flags;
  try {
    ({ flags } = parseFlags(argv, ["state", "delegate"]));
    if (flags.state !== undefined && flags.state !== "on") throw new CliError(`--state chỉ nhận "on", nhận "${flags.state}"`);
    if (flags.delegate !== undefined && !DELEGATE_MODES.includes(flags.delegate)) {
      throw new CliError(`--delegate chỉ nhận ${DELEGATE_MODES.join(" | ")}, nhận "${flags.delegate}"`);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const workspace = workspaceRoot(cwd);
  let layout;
  try {
    layout = loadLayout(workspace);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
  const created = [];
  if (flags.delegate !== undefined) {
    // Ghi đúng một khoá, giữ nguyên mọi khoá khác của config đã có.
    const path = join(workspace, CONFIG_NAME);
    let raw = {};
    try {
      raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    } catch (err) {
      process.stderr.write(`${CONFIG_NAME} không đọc được (${err.message}) — sửa tay rồi chạy lại\n`);
      return 1;
    }
    raw.delegate = flags.delegate;
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    created.push(`${CONFIG_NAME} (delegate: ${flags.delegate})`);
  }
  if (layout.evidenceRoot === DEFAULT_LAYOUT.evidenceRoot) {
    const root = join(workspace, layout.evidenceRoot);
    mkdirSync(root, { recursive: true });
    // Log thô và trạng thái phiên là đồ của máy này; manifest, brief, evidence là hồ sơ.
    const ignore = join(root, ".gitignore");
    if (!existsSync(ignore)) {
      writeFileSync(ignore, "# log thô của worker và trạng thái phiên: của máy này, không phải hồ sơ\nlogs/\nstate/\n");
      created.push(`${layout.evidenceRoot}/.gitignore`);
    }
  } else {
    process.stdout.write(`${CONFIG_NAME} đặt run ở ${layout.runDir}: workspace tự lo .gitignore cho ${layout.logDir}\n`);
  }
  if (flags.state === "on") {
    const dir = join(workspace, ...layout.stateDir.split("/"));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(layout.stateDir);
    }
  }
  process.stdout.write(created.length ? `đã tạo: ${created.join(", ")}\n` : "không có gì cần tạo\n");
  process.stdout.write(`run sẽ nằm ở: ${layout.runDir}\n\n`);
  process.stdout.write([
    "Crew đọc luật riêng của dự án ở CLAUDE.md / AGENTS.md. Nên có:",
    "  - mục tiêu và đơn vị đo của dự án (để xếp ưu tiên job)",
    "  - cách tạo task, nếu dự án có sổ task",
    "  - công cụ crew KHÔNG được tự gọi (chấm công, đóng task, ghi hệ thống ngoài)",
    "  - skill nào giao Antigravity / Codex / Claude",
    "",
    `Thứ máy phải đọc (hook, brief) khai ở ${CONFIG_NAME}: routingTriggers, routingLog, costGate, redactConfig, delegate.`,
    "",
  ].join("\n"));
  return 0;
}

export function install(argv) {
  let flags;
  try {
    ({ flags } = parseFlags(argv, ["force"]));
    if (flags.force !== undefined && flags.force !== "on") throw new CliError(`--force chỉ nhận "on", nhận "${flags.force}"`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const target = shimPath();
  if (existsSync(target) && !readFileSync(target, "utf8").includes(SHIM_MARK) && flags.force !== "on") {
    process.stderr.write(`${target} đã có và không phải shim của crew — không ghi đè (thêm --force on nếu chắc)\n`);
    return 1;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, shimScript(stableNode(), CREW_BIN), { mode: 0o755 });
  chmodSync(target, 0o755);
  const onPath = (process.env.PATH ?? "").split(delimiter).includes(dirname(target));
  const follows = pluginInstallOf(CREW_BIN)?.key ?? null;
  process.stdout.write(`${JSON.stringify({ shim: target, node: stableNode(), crew: CREW_BIN, follows, onPath }, null, 2)}\n`);
  if (!onPath) process.stdout.write(`\n${dirname(target)} chưa có trong PATH: thêm vào shell profile để gõ được \`crew\`\n`);
  return 0;
}
