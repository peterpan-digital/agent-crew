/**
 * Layout: cùng một bộ luật chạy được ở `.crew/` (không config) và ở bố cục sổ
 * task của workspace gốc. Kỳ vọng của layout gốc lấy từ chính code cũ
 * (`resolveLogDir`, `reachesRunManifest`) trước khi chúng đọc layout, nên test
 * này đỏ ngay khi bản generic lệch hành vi cũ dù chỉ một đường dẫn.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_NAME, DEFAULT_LAYOUT, LEGACY_LAYOUT, LayoutError, homeRel, isValidTask, layoutOf, listRuns,
  loadLayout, logDirRel, normalizeTask, parseInRun, parseRunDir, reachesRunManifest, reportDirRel, runDirRel, validateLayout,
} from "../scripts/lib/crew-layout.mjs";
import { makeChecker, tmpWorkspace } from "./helpers.mjs";

const t = makeChecker("crew-layout");
const throws = (fn) => { try { fn(); return "không ném"; } catch (e) { return e instanceof LayoutError ? "LayoutError" : e.message; } };

// ---- mặc định & đọc config ----
{
  const ws = tmpWorkspace("crew-layout-");
  // tmpWorkspace ghi config của layout gốc cho các test cũ; ở đây cần cả hai.
  t.check("workspace có config layout gốc → đọc ra layout gốc", JSON.stringify(loadLayout(ws)), JSON.stringify(validateLayout(LEGACY_LAYOUT)));
  writeFileSync(join(ws, CONFIG_NAME), "{}");
  t.check("config rỗng → layout mặc định .crew", loadLayout(ws).runDir, ".crew/runs/{run}");
  writeFileSync(join(ws, CONFIG_NAME), '{"runDri": ".crew/x/{run}"}');
  t.check("khoá gõ sai bị từ chối, không âm thầm rơi về mặc định", throws(() => loadLayout(ws)), "LayoutError");
  writeFileSync(join(ws, CONFIG_NAME), "{ not json");
  t.check("config hỏng → LayoutError", throws(() => loadLayout(ws)), "LayoutError");
  t.check("manifest không có layout → layout gốc (run cũ vẫn đọc được)", layoutOf({ jobs: [] }).runDir, LEGACY_LAYOUT.runDir);
  t.check("manifest có layout → dùng layout đó", layoutOf({ layout: DEFAULT_LAYOUT }).runDir, DEFAULT_LAYOUT.runDir);
}

// ---- kiểm layout ----
{
  const bad = {
    "runDir có ..": { runDir: "../x/{run}" },
    "runDir tuyệt đối": { runDir: "/tmp/{run}" },
    "runDir thiếu {run}": { runDir: ".crew/runs" },
    "{run} không ở đoạn cuối": { runDir: ".crew/{run}/x" },
    "runDir ngoài evidenceRoot": { runDir: "out/{run}" },
    "placeholder lạ": { runDir: ".crew/{date}-{run}" },
    "{task} không có taskDir": { runDir: ".crew/{task}/{run}" },
    "reportDir không có taskDir": { reportDir: ".crew/r" },
    "taskNesting không có taskDir": { taskNesting: "items" },
    "runDir ngoài taskDir": { ...LEGACY_LAYOUT, runDir: "tasks/other/{task}/crew-{run}" },
    "{task} lẫn trong đoạn": { ...LEGACY_LAYOUT, taskDir: "tasks/t-{task}" },
    "logDir {run} không ở cuối": { logDir: ".crew/{run}/logs" },
    "nestedRepos không phải mảng": { nestedRepos: "tasks" },
    "khoá lạ": { maxJobs: 99 },
  };
  for (const [name, input] of Object.entries(bad)) t.check(`từ chối: ${name}`, throws(() => validateLayout(input)), "LayoutError");
  t.check("layout gốc hợp lệ", throws(() => validateLayout(LEGACY_LAYOUT)), "không ném");
  t.check("layout mặc định hợp lệ", throws(() => validateLayout(DEFAULT_LAYOUT)), "không ném");
}

// ---- task, đường dẫn ----
{
  const L = LEGACY_LAYOUT;
  const D = validateLayout({});
  t.check("chuẩn hoá task bỏ tiền tố tasks/", normalizeTask(L, "tasks/260615-x/"), "260615-x");
  t.check("chuẩn hoá task bỏ cả tiền tố lặp", normalizeTask(L, "./tasks/tasks/260615-x"), "260615-x");
  t.check("task lồng hợp lệ", isValidTask(L, "260615-x/work-items/261012-y"), true);
  t.check("task có .. không hợp lệ", isValidTask(L, "x/../y"), false);
  t.check("task lồng sai tên thư mục không hợp lệ", isValidTask(L, "x/items/y"), false);
  t.check("layout không task: không có task hợp lệ", isValidTask(D, "x"), false);
  t.check("runDir gốc", runDirRel(L, { task: "x/work-items/y", run: "261019-1000" }), "tasks/x/work-items/y/reports/crew-261019-1000");
  t.check("home gốc = thư mục task", homeRel(L, { task: "x", run: "r" }), "tasks/x");
  t.check("report gốc = reports của task", reportDirRel(L, { task: "x", run: "r" }), "tasks/x/reports");
  t.check("runDir mặc định", runDirRel(D, { run: "261019-1000" }), ".crew/runs/261019-1000");
  t.check("home mặc định = chính thư mục run", homeRel(D, { run: "r" }), ".crew/runs/r");
  t.check("report mặc định = thư mục run", reportDirRel(D, { run: "r" }), ".crew/runs/r");
  t.check("thiếu task mà template cần → ném", throws(() => runDirRel(L, { run: "r" })), "LayoutError");
  t.check("tách run dir gốc lồng", JSON.stringify(parseRunDir(L, "tasks/x/work-items/y/reports/crew-r1")), JSON.stringify({ task: "x/work-items/y", run: "r1" }));
  t.check("tách file trong run mặc định", JSON.stringify(parseInRun(D, ".crew/runs/r1/worker-codex-1.md")), JSON.stringify({ task: "", run: "r1", rest: "worker-codex-1.md" }));
  t.check("không phải run dir → null", parseRunDir(L, "tasks/x/reports/foo"), null);
}

// ---- log dir: khớp từng đường với resolveLogDir cũ ----
{
  const oracle = {
    "tasks/T/reports/crew-r/worker-anti-1.md": "tasks/T/data/crew-logs/crew-r",
    "tasks/T/work-items/W/reports/crew-r/worker-codex-2.md": "tasks/T/work-items/W/data/crew-logs/crew-r",
    "tasks/T/reports/x.md": "tasks/T/data/crew-logs/loose",
    "tasks/smoke/hello.md": "tasks/smoke/data/crew-logs/loose",
    "tasks/T/work-items/W/reports/x.md": "tasks/T/work-items/W/data/crew-logs/loose",
    "tasks/T/reports/crew-r/sub/x.md": "tasks/T/data/crew-logs/crew-r",
  };
  for (const [ev, want] of Object.entries(oracle)) t.check(`log dir gốc giống bản cũ: ${ev}`, logDirRel(LEGACY_LAYOUT, ev), want);
  const D = validateLayout({});
  t.check("log dir mặc định trong run", logDirRel(D, ".crew/runs/r1/worker-anti-1.md"), ".crew/logs/r1");
  t.check("log dir mặc định job lẻ", logDirRel(D, ".crew/hello.md"), ".crew/logs/loose");
}

// ---- chặn khai quyền ghi với tới manifest: khớp từng thư mục với bản cũ ----
{
  const oracle = {
    tasks: true, "tasks/x": true, "tasks/x/reports": true, "tasks/x/reports/foo": false,
    "tasks/x/reports/crew-r": true, "tasks/x/reports/crew-r/manifest.json": true,
    "tasks/x/reports/crew-r/manifest.json.lock/abc": true, "tasks/x/reports/crew-r/worker.md": false,
    "tasks/x/data": false, "tasks/x/work-items": true, "tasks/x/work-items/y": true,
    "tasks/x/work-items/y/reports/crew-r/manifest.json": true, "tasks/x/work-items/y/data": false,
    src: false, "tasks/.hidden": true,
  };
  for (const [dir, want] of Object.entries(oracle)) t.check(`chặn manifest (gốc) giống bản cũ: ${dir}`, reachesRunManifest(LEGACY_LAYOUT, dir), want);
  const D = validateLayout({});
  const def = { ".crew": true, ".crew/runs": true, ".crew/runs/r": true, ".crew/runs/r/manifest.json": true, ".crew/runs/r/worker.md": false, ".crew/logs": false, src: false };
  for (const [dir, want] of Object.entries(def)) t.check(`chặn manifest (mặc định): ${dir}`, reachesRunManifest(D, dir), want);
}

// ---- liệt kê run ----
{
  const ws = tmpWorkspace("crew-layout-list-");
  const mk = (rel) => { mkdirSync(join(ws, rel), { recursive: true }); writeFileSync(join(ws, rel, "manifest.json"), "{}"); };
  mk("tasks/a/reports/crew-261019-1000");
  mk("tasks/a/work-items/b/reports/crew-261019-1100");
  mkdirSync(join(ws, "tasks/a/reports/crew-empty"), { recursive: true }); // không có manifest: bỏ
  mk("tasks/a/reports/not-a-run");
  mk("tasks/a/data/raw/reports/crew-fake"); // nằm trong data, không đúng template
  const runs = listRuns(ws, LEGACY_LAYOUT).map((r) => `${r.task}|${r.run}`).sort();
  t.check("layout gốc: đúng 2 run, kể cả run của work item", runs.join(","), "a/work-items/b|261019-1100,a|261019-1000");
  t.check("lọc theo task (kèm tiền tố tasks/)", listRuns(ws, LEGACY_LAYOUT, { task: "tasks/a" }).length, 1);
  mk(".crew/runs/261019-1200");
  t.check("layout mặc định: thấy run trong .crew", listRuns(ws, validateLayout({})).map((r) => r.run).join(","), "261019-1200");
}

process.exit(t.finish() ? 0 : 1);
