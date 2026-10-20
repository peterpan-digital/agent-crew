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
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCrewConfig } from "../lib/crew-config.mjs";
import { CONFIG_NAME, DEFAULT_LAYOUT, loadLayout } from "../lib/crew-layout.mjs";
import { CliError, parseFlags, workspaceRoot } from "./run-commands.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CREW_BIN = join(PLUGIN_ROOT, "bin", "crew.mjs");
/** Dòng nhận diện shim do `crew install` sinh — shim không có dòng này là của người khác, không ghi đè. */
const SHIM_MARK = "# crew-shim: sinh bởi `crew install`";

const run = (cmd, args, timeout = 15_000) => {
  const p = spawnSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: p.status === 0, out: `${p.stdout ?? ""}`.trim(), err: p.error?.message ?? `${p.stderr ?? ""}`.trim() };
};

/** Tên model `agy models` còn liệt kê: cột đầu mỗi dòng, bỏ dòng thông báo. */
export function parseAgyModels(text) {
  return String(text).split("\n").map((l) => l.split("\t")[0].trim()).filter((s) => /^[a-z0-9][a-z0-9.-]+$/.test(s));
}

/** Model Codex đang đặt trong config máy, hoặc null. */
export function codexConfigModel(home = homedir()) {
  try {
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(home, ".codex", "config.toml"), "utf8"));
    return m ? m[1] : null;
  } catch {
    return null;
  }
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

  try {
    const { layout, routingTriggers, routingLog, costGate, redactConfig } = loadCrewConfig(workspace);
    const custom = existsSync(join(workspace, CONFIG_NAME));
    say("layout", `${custom ? CONFIG_NAME : "mặc định (chưa có crew.config.json)"} — run ở ${layout.runDir}, evidence trong ${layout.evidenceRoot}/`);
    say("routing", routingTriggers.length
      ? `${routingTriggers.length} trigger (${[...new Set(routingTriggers.map((t) => t.kind))].join(", ")})${routingLog ? `, log ${routingLog}` : ""}`
      : "không khai trigger — hook chỉ nói khi owner gõ @anti/@codex");
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
  const agy = run("agy", ["--version"]);
  if (agy.ok) {
    workers.push("anti");
    say("agy", agy.out.split("\n")[0]);
    const models = run("agy", ["models"], 30_000);
    const names = models.ok ? parseAgyModels(models.out) : [];
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

  // Transport app là ngoại lệ có tên, không phải điều kiện: báo, không tính là lỗi.
  try {
    const { resolveCompanion } = await import("../codex-companion-path.mjs");
    say("codex app", `companion ${resolveCompanion()}`);
  } catch (err) {
    say("codex app", `không dùng được transport app: ${String(err.message).split("\n")[0]}`);
  }
  try {
    const { resolveAntiEnv } = await import("../anti-env.mjs");
    const env = resolveAntiEnv(workspace);
    say("anti app", `app pid ${env.pid}`);
  } catch (err) {
    say("anti app", `không dùng được transport app: ${String(err.message).split("\n")[0]}`);
  }

  const shim = shimPath();
  const onPath = (process.env.PATH ?? "").split(delimiter).includes(dirname(shim));
  if (!existsSync(shim)) say("shim", `chưa cài (${shim}) — chạy: node "${CREW_BIN}" install`);
  else {
    const body = readFileSync(shim, "utf8");
    const mine = body.includes(SHIM_MARK) && body.includes(CREW_BIN);
    say("shim", `${shim}${mine ? " → bản này" : " — trỏ sang bản KHÁC hoặc không phải của crew"}${onPath ? "" : `; ${dirname(shim)} KHÔNG có trong PATH`}`);
  }

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
    ({ flags } = parseFlags(argv, ["state"]));
    if (flags.state !== undefined && flags.state !== "on") throw new CliError(`--state chỉ nhận "on", nhận "${flags.state}"`);
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
    `Thứ máy phải đọc (hook, brief) khai ở ${CONFIG_NAME}: routingTriggers, routingLog, costGate, redactConfig.`,
    "",
  ].join("\n"));
  return 0;
}

export const shimPath = () => join(homedir(), ".local", "bin", "crew");

/**
 * Shim gọi node bằng đường tuyệt đối lấy lúc cài, và đưa thư mục node lên đầu
 * PATH: app GUI chỉ cho PATH `/usr/bin:/bin:/usr/sbin:/sbin`, nơi không có node
 * (bài học devtools hub 18/10: 111/111 lần bật chết code 127). Nó trỏ vào bản
 * nguồn đang chạy lệnh này, không vào cache của plugin: đường cache đổi theo
 * version, còn hook của Codex/Antigravity cần một đường đứng yên.
 */
/**
 * Đường node ổn định cho shim. `process.execPath` của Homebrew là đường có số
 * version (`.../Cellar/node/25.2.1/bin/node`): ghi cứng nó thì `brew upgrade
 * node` xong là shim gãy, đúng lúc PATH tối thiểu không còn chỗ nào để dò lại.
 * Lấy symlink ổn định nào trỏ về cùng file node đang chạy.
 */
export function stableNode(execPath = process.execPath, envPath = process.env.PATH ?? "") {
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
  const target = real(execPath);
  const candidates = [
    ...envPath.split(delimiter).filter(Boolean).map((d) => join(d, "node")),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  return candidates.find((c) => !c.includes("/Cellar/") && existsSync(c) && real(c) === target) ?? execPath;
}

export function shimScript(nodeBin = stableNode(), crewBin = CREW_BIN) {
  const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  return [
    "#!/bin/sh",
    SHIM_MARK,
    `NODE=${q(nodeBin)}`,
    '[ -x "$NODE" ] || for c in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do [ -x "$c" ] && NODE="$c" && break; done',
    '[ -x "$NODE" ] || { echo "crew: không tìm thấy node" >&2; exit 127; }',
    'PATH="$(dirname "$NODE"):$PATH"; export PATH',
    `exec "$NODE" ${q(crewBin)} "$@"`,
    "",
  ].join("\n");
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
  writeFileSync(target, shimScript(), { mode: 0o755 });
  chmodSync(target, 0o755);
  const onPath = (process.env.PATH ?? "").split(delimiter).includes(dirname(target));
  process.stdout.write(`${JSON.stringify({ shim: target, node: stableNode(), crew: CREW_BIN, onPath }, null, 2)}\n`);
  if (!onPath) process.stdout.write(`\n${dirname(target)} chưa có trong PATH: thêm vào shell profile để gõ được \`crew\`\n`);
  return 0;
}
