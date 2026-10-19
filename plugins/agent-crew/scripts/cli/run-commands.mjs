/**
 * `crew new-run`, `crew add-job`, `crew digest`.
 *
 * Hai lệnh đầu thay cho hai đoạn `node -e 'import(...)'` mà skill từng bắt
 * dispatcher gõ: đoạn đó tự dựng đường thư mục run bằng tay, nên nó viết cứng
 * bố cục `tasks/`. Ở đây đường dẫn đi từ layout của workspace.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { addJob, createRun, readManifest } from "../crew-manifest.mjs";
import { resolveLogDir } from "../crew-guards.mjs";
import { crewDigest } from "../lib/crew-digest.mjs";
import { layoutOf, loadLayout, normalizeTask, runDirRel, usesTask } from "../lib/crew-layout.mjs";

export class CliError extends Error {}

/**
 * Cờ dạng `--tên giá trị`. Cờ lạ bị từ chối, không bị bỏ qua: một lần gõ sai
 * `--model` từng làm job chạy âm thầm ở tier mặc định. Cờ trong `repeatable`
 * được lặp và gom thành mảng.
 */
export function parseFlags(argv, allowed, { positional = 0, repeatable = [] } = {}) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const name = a.slice(2);
    if (!allowed.includes(name)) throw new CliError(`cờ lạ --${name} (nhận: ${allowed.map((x) => `--${x}`).join(" ")})`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError(`--${name} thiếu giá trị`);
    i += 1;
    if (repeatable.includes(name)) (flags[name] ??= []).push(value);
    else if (name in flags) throw new CliError(`--${name} khai hai lần`);
    else flags[name] = value;
  }
  if (pos.length !== positional) throw new CliError(`cần ${positional} tham số vị trí, nhận ${pos.length}: ${pos.join(" ") || "(không có)"}`);
  return { pos, flags };
}

/** Gốc workspace: gốc git của thư mục hiện tại, không thì chính nó (createRun sẽ từ chối thư mục không phải git). */
export function workspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return resolve(cwd);
  }
}

/** yymmdd-HHMM theo giờ máy: cùng dạng runId mọi run cũ đã dùng. */
export function runStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(now.getFullYear() % 100)}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

const fail = (err) => {
  process.stderr.write(`${err.message}\n`);
  return err instanceof CliError ? 2 : 1;
};

export function newRun(argv, { cwd }) {
  try {
    const { flags } = parseFlags(argv, ["task", "run", "workspace", "depth"]);
    const workspace = flags.workspace ? resolve(flags.workspace) : workspaceRoot(cwd);
    const layout = loadLayout(workspace);
    if (usesTask(layout) && !flags.task) throw new CliError(`layout của workspace này cần --task (thư mục task: ${layout.taskDir})`);
    const run = flags.run ?? runStamp();
    if (!/^[\w.-]+$/.test(run)) throw new CliError(`--run chỉ nhận chữ, số, ".", "_", "-": "${run}"`);
    const depth = flags.depth === undefined ? 0 : Number(flags.depth);
    // Không bỏ qua --task ở layout không có task: createRun từ chối kèm lý do.
    const task = flags.task;
    // createRun kiểm task lần nữa; ở đây chỉ cần bản chuẩn hoá để dựng đường thư mục.
    const runDir = join(workspace, ...runDirRel(layout, { task: task && normalizeTask(layout, task), run }).split("/"));
    const existed = existsSync(runDir);
    mkdirSync(runDir, { recursive: true });
    try {
      const { manifestPath } = createRun({ runDir, runId: run, task, workspace, depth });
      process.stdout.write(`${manifestPath}\n`);
      return 0;
    } catch (err) {
      // Run không tạo được thì đừng để lại thư mục rỗng trông như một run.
      if (!existed) try { rmdirSync(runDir); } catch { /* không rỗng: không phải của mình */ }
      throw err;
    }
  } catch (err) {
    return fail(err);
  }
}

const WORKER_NAMES = { anti: "antigravity", antigravity: "antigravity", codex: "codex", claude: "claude" };
const SHORT = { antigravity: "anti", codex: "codex", claude: "claude" };

/**
 * In `seq<TAB>evidence`. Không khai `--evidence` thì evidence là
 * `{thư mục run}/worker-{worker}-{seq}.md` — hai job không bao giờ trùng file.
 */
export function addJobCli(argv, { cwd }) {
  try {
    const { pos, flags } = parseFlags(argv,
      ["worker", "role", "title", "evidence", "model", "effort", "transport", "note", "allow"],
      { positional: 1, repeatable: ["allow"] });
    const manifestPath = resolve(cwd, pos[0]);
    const worker = WORKER_NAMES[flags.worker];
    if (!worker) throw new CliError(`--worker phải là anti|codex|claude, nhận "${flags.worker ?? ""}"`);
    if (!flags.title) throw new CliError("thiếu --title");
    if (worker === "codex" ? !flags.effort : !flags.model) {
      throw new CliError(worker === "codex" ? "job Codex cần --effort (low|medium|high)" : "thiếu --model (crew doctor in tên model còn sống)");
    }
    const m = readManifest(manifestPath);
    const runRel = typeof m.runDir === "string" ? m.runDir : relative(m.workspace, dirname(manifestPath)).split(sep).join("/");
    const evidence = flags.evidence ?? `${runRel}/worker-${SHORT[worker]}-${m.jobs.length + 1}.md`;
    const job = addJob(manifestPath, {
      worker, role: flags.role, title: flags.title, evidence,
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags.effort ? { effort: flags.effort } : {}),
      ...(flags.transport ? { transport: flags.transport } : {}),
      ...(flags.note ? { note: flags.note } : {}),
      ...(flags.allow ? { filesMayModify: flags.allow } : {}),
    });
    process.stdout.write(`${job.seq}\t${job.evidence}\n`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

export function digest(argv, { cwd }) {
  try {
    const { flags } = parseFlags(argv, ["workspace"]);
    const lines = crewDigest(flags.workspace ? resolve(flags.workspace) : workspaceRoot(cwd));
    if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

const flagValue = (argv, name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Job `seq` trong sổ, hoặc null khi sổ không đọc được / không có job đó. */
function jobOf(manifestPath, seq) {
  try {
    const m = readManifest(manifestPath);
    const job = m.jobs.find((j) => String(j.seq) === String(seq));
    return job ? { m, job } : null;
  } catch {
    return null;
  }
}

/**
 * `crew run anti|codex --manifest M --job N ...`: cờ nào sổ đã ghi mà lệnh không
 * truyền thì lấy từ sổ — `--evidence`, `--workspace`, `--mode`. Gõ tay ba cờ đó
 * là chỗ lệch hay gặp nhất (evidence khác sổ, mode khác transport), và adapter
 * từ chối khi lệch. Cờ truyền tay vẫn thắng; adapter vẫn kiểm khớp như cũ.
 * Không có `--manifest`/`--job` thì không đụng gì.
 */
export function expandRunArgs(argv, { cwd }) {
  const mp = flagValue(argv, "manifest");
  const seq = flagValue(argv, "job");
  if (!mp || !seq) return argv;
  const manifestPath = resolve(cwd, mp);
  const found = jobOf(manifestPath, seq);
  if (!found) return argv;
  const { m, job } = found;
  const out = [...argv];
  const idx = out.indexOf("--manifest");
  out[idx + 1] = manifestPath;
  if (flagValue(argv, "workspace") === undefined) out.push("--workspace", m.workspace);
  if (flagValue(argv, "evidence") === undefined) out.push("--evidence", join(m.workspace, ...job.evidence.split("/")));
  if (flagValue(argv, "mode") === undefined && job.transport) out.push("--mode", job.transport);
  return out;
}

/**
 * `crew paths <manifest> --job N`: các đường của một job theo layout của run —
 * evidence, brief nên lưu ở đâu, thư mục log thô, sidecar anti-watch. Skill và
 * lệnh Monitor đọc ở đây thay vì tự ghép đường theo một bố cục đoán trước.
 */
export function paths(argv, { cwd }) {
  try {
    const { pos, flags } = parseFlags(argv, ["job"], { positional: 1 });
    if (!flags.job) throw new CliError("thiếu --job");
    const manifestPath = resolve(cwd, pos[0]);
    const found = jobOf(manifestPath, flags.job);
    if (!found) throw new Error(`không đọc được job ${flags.job} trong ${manifestPath}`);
    const { m, job } = found;
    const evidence = join(m.workspace, ...job.evidence.split("/"));
    const logs = resolveLogDir(evidence, m.workspace, layoutOf(m));
    const stem = job.evidence.split("/").pop().replace(/\.[^.]+$/, "");
    const short = SHORT[job.worker] ?? job.worker;
    const rows = [
      ["manifest", manifestPath],
      ["evidence", evidence],
      ["brief", join(dirname(manifestPath), `brief-${short}-${job.seq}.md`)],
      ["logs", logs],
      ...(job.worker === "antigravity" ? [["anti-watch", join(logs, `${stem}.anti-watch.jsonl`)]] : []),
    ];
    process.stdout.write(`${rows.map(([k, v]) => `${k}\t${v}`).join("\n")}\n`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}
