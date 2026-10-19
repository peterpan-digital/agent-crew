/**
 * Bố cục thư mục của crew trong một workspace: run nằm đâu, evidence được phép
 * nằm đâu, report và log thô đi đâu, repo lồng nào cổng phạm vi phải đọc thêm.
 *
 * Luật của crew không phụ thuộc repo ("worker tự khai xong không phải bằng
 * chứng" đúng ở mọi nơi), nhưng chỗ đặt file thì có. Module ra đời trong một
 * workspace có sổ task `tasks/{task}/reports/crew-{run}/`, và chỗ đó từng viết
 * cứng ở guard evidence, cổng phạm vi, cổng report, bảng crew còn dở. Giờ nó là
 * dữ liệu: `crew.config.json` ở gốc workspace, không có thì dùng `.crew/`.
 *
 * Manifest chép layout vào lúc tạo run, nên đổi config giữa chừng không làm lệch
 * run đang chạy. Manifest ghi trước khi có field `layout` thì đọc theo
 * `LEGACY_LAYOUT` — layout của workspace gốc, nơi duy nhất từng sinh ra chúng.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_NAME = "crew.config.json";

export class LayoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "LayoutError";
  }
}

/**
 * Không config. `.crew/` vì run phải ghi sổ, brief và evidence ở đâu đó TRONG
 * repo (cổng phạm vi cần chỗ neo), và thư mục chấm là chỗ duy nhất không đụng
 * bố cục riêng của dự án.
 */
export const DEFAULT_LAYOUT = Object.freeze({
  runDir: ".crew/runs/{run}",
  taskDir: null,
  taskNesting: null,
  reportDir: null,
  logDir: ".crew/logs/{run}",
  evidenceRoot: ".crew",
  nestedRepos: Object.freeze([]),
  stateDir: ".crew/state",
  protectedPaths: Object.freeze([]),
  controlPlanePaths: Object.freeze([]),
});

/** Layout của workspace gốc — và của mọi manifest ghi trước khi có field `layout`. */
export const LEGACY_LAYOUT = Object.freeze({
  runDir: "tasks/{task}/reports/crew-{run}",
  taskDir: "tasks/{task}",
  taskNesting: "work-items",
  reportDir: "tasks/{task}/reports",
  logDir: "tasks/{task}/data/crew-logs/crew-{run}",
  evidenceRoot: "tasks",
  nestedRepos: Object.freeze(["tasks"]),
  stateDir: "tasks/_state",
  // Protected Files và control plane riêng của workspace gốc, cộng thêm vào danh
  // sách chung trong crew-scope.mjs. Đường kết thúc bằng "/" là thư mục.
  protectedPaths: Object.freeze([
    "mwg-workflow-n8n/.env", "mwg-workflow-n8n/.claude/.mcp.json",
    "mwg-workflow-n8n/.codex/config.toml", "mwg-workflow-n8n/.gemini/settings.json",
    "mwg-workflow-n8n/.agents/mcp_config.json",
    "mwg-seo-analytics/.env", "mwg-seo-analytics/config/client_secret.json",
    "mwg-workflow-n8n/.agents/skills/", "mwg-workflow-n8n/.codex/skills/",
    "mwg-workflow-n8n/.claude/skills/", "mwg-workflow-n8n/.gemini/skills/",
  ]),
  controlPlanePaths: Object.freeze(["harness/", "harness.config.json", "harness.config.example.json", "mwg-agent-crew/scripts/"]),
});

export const LAYOUT_KEYS = Object.freeze(Object.keys(DEFAULT_LAYOUT));
const PATH_KEYS = ["runDir", "taskDir", "reportDir", "logDir", "evidenceRoot", "stateDir"];

/** Đường tương đối kiểu posix, không `..`, không `/` đầu/cuối, không backslash, không đoạn rỗng. */
export function assertRelPath(key, value) {
  if (typeof value !== "string" || value.length === 0) throw new LayoutError(`${key} phải là chuỗi đường dẫn, nhận ${JSON.stringify(value)}`);
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new LayoutError(`${key} phải là đường tương đối kiểu posix, không / ở đầu hay cuối: "${value}"`);
  }
  const segs = value.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) throw new LayoutError(`${key} không được có đoạn rỗng, "." hay "..": "${value}"`);
  const stray = value.replace(/\{task\}|\{run\}/g, "");
  if (/[{}]/.test(stray)) throw new LayoutError(`${key} chỉ nhận {task} và {run}: "${value}"`);
}

const count = (s, needle) => s.split(needle).length - 1;
const under = (path, root) => path.startsWith(`${root}/`);

/** Kiểm và đóng băng một layout. Ném `LayoutError` kèm tên khoá sai. */
export function validateLayout(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LayoutError("layout phải là object");
  const unknown = Object.keys(input).filter((k) => !LAYOUT_KEYS.includes(k));
  if (unknown.length) throw new LayoutError(`khoá layout lạ: ${unknown.join(", ")} (nhận: ${LAYOUT_KEYS.join(", ")})`);
  const l = { ...DEFAULT_LAYOUT, ...input };
  for (const key of PATH_KEYS) {
    if (l[key] === null && (key === "taskDir" || key === "reportDir")) continue;
    assertRelPath(key, l[key]);
  }
  for (const key of ["evidenceRoot", "stateDir"]) {
    if (/[{}]/.test(l[key])) throw new LayoutError(`${key} không nhận {task}/{run}: "${l[key]}"`);
  }
  if (count(l.runDir, "{run}") !== 1 || !l.runDir.split("/").at(-1).includes("{run}")) {
    throw new LayoutError(`runDir phải có đúng một {run}, nằm ở đoạn cuối: "${l.runDir}"`);
  }
  if (count(l.logDir, "{run}") !== 1 || !l.logDir.split("/").at(-1).includes("{run}")) {
    throw new LayoutError(`logDir phải có đúng một {run}, nằm ở đoạn cuối: "${l.logDir}"`);
  }
  if (!under(l.runDir, l.evidenceRoot)) throw new LayoutError(`runDir phải nằm trong evidenceRoot "${l.evidenceRoot}": "${l.runDir}"`);

  const usesTask = l.taskDir !== null;
  for (const key of ["runDir", "logDir", "reportDir"]) {
    const v = l[key];
    if (v === null) continue;
    if (!usesTask && v.includes("{task}")) throw new LayoutError(`${key} có {task} nhưng taskDir là null: "${v}"`);
    // {task} có thể là nhiều đoạn (task lồng), nên nó phải chiếm trọn một đoạn
    // thì mới tách lại được từ đường dẫn.
    if (v.split("/").some((s) => s.includes("{task}") && s !== "{task}")) throw new LayoutError(`{task} phải chiếm trọn một đoạn trong ${key}: "${v}"`);
    if (count(v, "{task}") > 1) throw new LayoutError(`${key} có nhiều hơn một {task}: "${v}"`);
  }
  if (usesTask) {
    if (count(l.taskDir, "{task}") !== 1 || !l.taskDir.endsWith("{task}") || l.taskDir.split("/").some((s) => s.includes("{task}") && s !== "{task}")) {
      throw new LayoutError(`taskDir phải kết thúc bằng một đoạn {task}: "${l.taskDir}"`);
    }
    if (l.taskDir.includes("{run}")) throw new LayoutError(`taskDir không nhận {run}: "${l.taskDir}"`);
    if (!under(l.taskDir, l.evidenceRoot)) throw new LayoutError(`taskDir phải nằm trong evidenceRoot "${l.evidenceRoot}": "${l.taskDir}"`);
    if (!under(l.runDir, l.taskDir)) throw new LayoutError(`runDir phải nằm trong taskDir "${l.taskDir}": "${l.runDir}"`);
    if (l.reportDir !== null) {
      if (l.reportDir.includes("{run}")) throw new LayoutError(`reportDir không nhận {run}: "${l.reportDir}"`);
      if (!under(l.reportDir, l.taskDir)) throw new LayoutError(`reportDir phải nằm trong taskDir "${l.taskDir}": "${l.reportDir}"`);
    }
  } else {
    if (l.reportDir !== null) throw new LayoutError("reportDir chỉ khai được khi có taskDir; không có task thì report nằm trong thư mục run");
    if (l.taskNesting !== null) throw new LayoutError("taskNesting chỉ khai được khi có taskDir");
  }
  if (l.taskNesting !== null && (typeof l.taskNesting !== "string" || !/^[^/{}.][^/{}]*$/.test(l.taskNesting))) {
    throw new LayoutError(`taskNesting phải là tên một thư mục: ${JSON.stringify(l.taskNesting)}`);
  }
  if (!Array.isArray(l.nestedRepos) || l.nestedRepos.some((p) => typeof p !== "string")) {
    throw new LayoutError("nestedRepos phải là mảng đường dẫn");
  }
  for (const p of l.nestedRepos) {
    assertRelPath("nestedRepos", p);
    if (/[{}]/.test(p)) throw new LayoutError(`nestedRepos không nhận {task}/{run}: "${p}"`);
  }
  for (const key of ["protectedPaths", "controlPlanePaths"]) {
    if (!Array.isArray(l[key]) || l[key].some((p) => typeof p !== "string")) throw new LayoutError(`${key} phải là mảng đường dẫn`);
    for (const p of l[key]) {
      // "/" cuối là thư mục -- được phép ở đây, khác các khoá đường dẫn khác.
      assertRelPath(key, p.endsWith("/") ? p.slice(0, -1) : p);
      if (/[{}]/.test(p)) throw new LayoutError(`${key} không nhận {task}/{run}: "${p}"`);
    }
  }
  return Object.freeze({
    ...l,
    nestedRepos: Object.freeze([...l.nestedRepos]),
    protectedPaths: Object.freeze([...l.protectedPaths]),
    controlPlanePaths: Object.freeze([...l.controlPlanePaths]),
  });
}

/**
 * Nội dung thô của `crew.config.json`, hoặc `null` khi không có file. Ném
 * `LayoutError` khi file hỏng hay có khoá lạ: gõ sai tên khoá là config âm thầm
 * không có tác dụng, nên nó phải lỗi to.
 */
export function readConfigRaw(workspace) {
  const path = join(workspace, CONFIG_NAME);
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new LayoutError(`${CONFIG_NAME} không đọc được: ${err.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LayoutError(`${CONFIG_NAME} phải là một object JSON`);
  const unknown = Object.keys(raw).filter((k) => !CONFIG_KEYS.has(k));
  if (unknown.length) throw new LayoutError(`${CONFIG_NAME}: khoá lạ ${unknown.join(", ")} (nhận: ${[...CONFIG_KEYS].join(", ")})`);
  return raw;
}

/**
 * Layout của workspace: `crew.config.json` nếu có, không thì mặc định. Chỉ lấy
 * các khoá layout; khoá khác trong file thuộc về `crew-config.mjs`.
 */
export function loadLayout(workspace) {
  const raw = readConfigRaw(workspace);
  if (!raw) return validateLayout({});
  const picked = Object.fromEntries(LAYOUT_KEYS.filter((k) => k in raw).map((k) => [k, raw[k]]));
  try {
    return validateLayout(picked);
  } catch (err) {
    throw new LayoutError(`${CONFIG_NAME}: ${err.message}`);
  }
}

/** Khoá không thuộc layout; kiểm ở `crew-config.mjs`. */
export const RULE_KEYS = Object.freeze(["routingTriggers", "routingLog", "costGate", "redactConfig"]);

/** Mọi khoá `crew.config.json` nhận. */
export const CONFIG_KEYS = new Set([...LAYOUT_KEYS, ...RULE_KEYS]);

/** Layout mà một run đã chép lúc tạo; manifest cũ không có thì là `LEGACY_LAYOUT`. */
export function layoutOf(manifest) {
  return manifest?.layout ? validateLayout(manifest.layout) : LEGACY_LAYOUT;
}

export const usesTask = (l) => l.taskDir !== null;

/** Phần chữ cố định của taskDir đứng trước {task}: `tasks/` với layout gốc. */
const taskPrefix = (l) => l.taskDir.slice(0, l.taskDir.indexOf("{task}"));

/**
 * Task theo dạng layout lưu: tương đối với taskDir. Dispatcher hay truyền cả
 * tiền tố (`tasks/260615-x`): 7 run thật đã ghi như vậy, và gate đọc thành
 * `tasks/tasks/...`, nên người ghi lẫn người đọc đều chuẩn hoá.
 */
export function normalizeTask(l, task) {
  if (!usesTask(l)) return "";
  let t = String(task ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  const prefix = taskPrefix(l);
  while (prefix && t.startsWith(prefix)) t = t.slice(prefix.length);
  return t;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEG = "[^/.][^/]*";
const taskPattern = (l) => (l.taskNesting ? `${SEG}(?:/${esc(l.taskNesting)}/${SEG})*` : SEG);

export function isValidTask(l, task) {
  return usesTask(l) && new RegExp(`^${taskPattern(l)}$`).test(task);
}

/** Điền {task}/{run}. Thiếu giá trị mà template cần thì ném, không để lọt chuỗi "{task}" ra đĩa. */
export function fill(template, { task, run } = {}) {
  if (template.includes("{task}") && !task) throw new LayoutError(`thiếu task để điền "${template}"`);
  if (template.includes("{run}") && !run) throw new LayoutError(`thiếu run để điền "${template}"`);
  return template.replace("{task}", task ?? "").replace("{run}", run ?? "");
}

export const runDirRel = (l, vars) => fill(l.runDir, vars);
/** Chỗ mọi job của run được ghi mà không cần khai: thư mục task, hoặc thư mục run khi không có task. */
export const homeRel = (l, vars) => fill(usesTask(l) ? l.taskDir : l.runDir, vars);
export const reportDirRel = (l, vars) => fill(l.reportDir ?? l.runDir, vars);

function templateRegex(l, template, suffix = "") {
  const body = template.split(/(\{task\}|\{run\})/).map((part) => {
    if (part === "{task}") return `(?<task>${taskPattern(l)})`;
    if (part === "{run}") return "(?<run>[^/]+)";
    return esc(part);
  }).join("");
  return new RegExp(`^${body}${suffix}$`);
}

/** `{task, run}` nếu `rel` chính là một thư mục run, không thì null. */
export function parseRunDir(l, rel) {
  const m = templateRegex(l, l.runDir).exec(rel);
  return m ? { task: m.groups.task ?? "", run: m.groups.run } : null;
}

/** `{task, run, rest}` nếu `rel` nằm trong một thư mục run. */
export function parseInRun(l, rel) {
  const m = templateRegex(l, l.runDir, "/(?<rest>.+)").exec(rel);
  return m ? { task: m.groups.task ?? "", run: m.groups.run, rest: m.groups.rest } : null;
}

/**
 * Thư mục log thô của một evidence. Log mang nội dung file worker đọc nên nó
 * thuộc chỗ git đã bỏ qua (`data/` của task ở layout gốc, `.crew/logs/` ở mặc
 * định), không nằm cạnh evidence. Evidence không nằm trong thư mục run (job
 * chạy lẻ) thì run là `loose`.
 */
export function logDirRel(l, evidenceRel) {
  const inRun = parseInRun(l, evidenceRel);
  if (inRun) return fill(l.logDir, inRun);
  // Job lẻ: đoạn cuối (đoạn mang {run}) thay bằng đúng chữ `loose`.
  const loose = (vars) => [...fill(l.logDir, { ...vars, run: "x" }).split("/").slice(0, -1), "loose"].join("/");
  if (!l.logDir.includes("{task}")) return loose({});
  let task = null;
  if (l.reportDir) {
    const m = templateRegex(l, l.reportDir, "/[^/]+").exec(evidenceRel);
    if (m) task = m.groups.task;
  }
  if (!task) {
    const rest = evidenceRel.slice(taskPrefix(l).length).split("/");
    task = rest.length > 1 && evidenceRel.startsWith(taskPrefix(l)) ? rest[0] : "loose";
  }
  return loose({ task });
}

const isDir = (p) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};
const subdirs = (p) => {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
};
/** Task lồng sâu tối đa bấy nhiêu cấp: đủ cho `x/work-items/y`, chặn đi lạc vào cây dữ liệu. */
const MAX_TASK_NEST = 4;

/**
 * Mọi thư mục run có `manifest.json` trong workspace, đi theo template thay vì
 * quét đệ quy: bảng crew còn dở chạy ở đầu MỌI phiên, và cây task có thể chứa
 * hàng nghìn file dữ liệu. `task` (đã chuẩn hoá) lọc về một task.
 */
export function listRuns(workspace, l, { task } = {}) {
  const segs = l.runDir.split("/");
  const out = [];
  const walk = (abs, rel, i, vars) => {
    if (i === segs.length) {
      if (existsSync(join(abs, "manifest.json"))) out.push({ dir: abs, rel: rel.join("/"), task: vars.task ?? "", run: vars.run });
      return;
    }
    const seg = segs[i];
    if (seg === "{task}") return walkTask(abs, rel, i, vars, [], 0);
    if (!seg.includes("{")) {
      const next = join(abs, seg);
      if (isDir(next)) walk(next, [...rel, seg], i + 1, vars);
      return;
    }
    const re = templateRegex(l, seg);
    for (const name of subdirs(abs)) {
      const m = re.exec(name);
      if (m) walk(join(abs, name), [...rel, name], i + 1, { ...vars, ...m.groups });
    }
  };
  const walkTask = (abs, rel, i, vars, taskSegs, depth) => {
    for (const name of subdirs(abs)) {
      if (name.startsWith(".")) continue;
      const t = [...taskSegs, name];
      const dir = join(abs, name);
      walk(dir, [...rel, name], i + 1, { ...vars, task: t.join("/") });
      if (l.taskNesting && depth < MAX_TASK_NEST && isDir(join(dir, l.taskNesting))) {
        walkTask(join(dir, l.taskNesting), [...rel, name, l.taskNesting], i, vars, [...t, l.taskNesting], depth + 1);
      }
    }
  };
  walk(workspace, [], 0, {});
  const want = task === undefined ? null : normalizeTask(l, task);
  return want === null ? out : out.filter((r) => r.task === want);
}

/**
 * True khi thư mục `dir` (đã chuẩn hoá chữ thường) là manifest của một run,
 * thư mục run, hay tổ tiên của chúng — tức khai quyền ghi ở đó là với tới sổ
 * của run khác. Bên trong một thư mục run, chỉ `manifest.json*` tính (cả
 * `manifest.json.lock/`: giữ khoá đó là treo mọi adapter).
 */
export function reachesRunManifest(l, dir) {
  const want = dir.split("/");
  const tpl = l.runDir.toLowerCase().split("/");
  const nest = l.taskNesting?.toLowerCase() ?? null;
  const match = (di, ti) => {
    if (di === want.length) return true;
    if (ti === tpl.length) return want[di].startsWith("manifest.json");
    const seg = tpl[ti];
    if (seg === "{task}") return matchTask(di, ti);
    if (!seg.includes("{")) return want[di] === seg && match(di + 1, ti + 1);
    return new RegExp(templateRegex(l, seg).source, "i").test(want[di]) && match(di + 1, ti + 1);
  };
  // Không loại tên bắt đầu bằng ".": ở chiều chặn, khớp rộng hơn là an toàn hơn.
  const matchTask = (di, ti) => {
    if (match(di + 1, ti + 1)) return true;
    if (!nest || want[di + 1] !== nest) return false;
    if (di + 2 === want.length) return true;
    return matchTask(di + 2, ti);
  };
  return want.length > 0 && want[0] !== "" && match(0, 0);
}
