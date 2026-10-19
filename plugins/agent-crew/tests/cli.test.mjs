/**
 * `crew` một cửa vào: định tuyến lệnh, giữ exit code của script, tạo run/job theo
 * layout, doctor/init/install, và shim chạy được khi app GUI gọi nó với PATH
 * tối thiểu (`/usr/bin:/bin`, không có node).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { readManifest } from "../scripts/crew-manifest.mjs";
import { expandRunArgs } from "../scripts/cli/run-commands.mjs";
import { parseAgyModels, shimScript, stableNode } from "../scripts/cli/setup.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace } from "./helpers.mjs";

const t = makeChecker("cli");
const CREW = join(MODULE_ROOT, "bin", "crew.mjs");
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function crew(args, { cwd, env } = {}) {
  const p = spawnSync(process.execPath, [CREW, ...args], { cwd, env: env ?? process.env, encoding: "utf8", timeout: 60_000 });
  return { code: p.status, out: (p.stdout ?? "").trim(), err: (p.stderr ?? "").trim() };
}
const gitRepo = (prefix) => {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: ws });
  return realpathSync(ws);
};

// ---- định tuyến ----
{
  t.check("không lệnh → exit 2", crew([]).code, 2);
  const help = crew(["--help"]);
  t.check("--help → exit 0", help.code, 0);
  t.check("...liệt kê new-run, add-job, collect, doctor", ["new-run", "add-job", "collect", "doctor"].every((c) => help.out.includes(c)), true);
  t.check("lệnh lạ → exit 2", crew(["bogus"]).code, 2);
  t.check("run worker lạ → exit 2", crew(["run", "gemini"]).code, 2);
  // Exit code của script phải đi nguyên qua cửa vào, không bị nuốt thành 0.
  const direct = spawnSync(process.execPath, [join(MODULE_ROOT, "scripts", "anti-run.mjs"), "--bogus-flag", "x"], { encoding: "utf8" });
  const via = crew(["run", "anti", "--bogus-flag", "x"]);
  t.check("run anti cờ lạ: exit giống gọi thẳng adapter", via.code, direct.status);
  t.check("...và khác 0", via.code !== 0, true);
}

// ---- new-run / add-job / digest ở layout mặc định ----
{
  const ws = gitRepo("cli-default-");
  const nr = crew(["new-run", "--run", "261019-1200"], { cwd: ws });
  t.check("new-run: exit 0", nr.code, 0);
  t.check("new-run: in đường manifest trong .crew/runs", nr.out, join(ws, ".crew", "runs", "261019-1200", "manifest.json"));
  t.check("new-run trùng run → exit 1", crew(["new-run", "--run", "261019-1200"], { cwd: ws }).code, 1);
  const withTask = crew(["new-run", "--run", "x1", "--task", "t"], { cwd: ws });
  t.check("--task ở layout không task → exit 1", withTask.code, 1);
  t.check("...và không để lại thư mục run rỗng", existsSync(join(ws, ".crew", "runs", "x1")), false);
  t.check("cờ lạ → exit 2", crew(["new-run", "--tsak", "t"], { cwd: ws }).code, 2);
  t.check("--run có ký tự lạ → exit 2", crew(["new-run", "--run", "../x"], { cwd: ws }).code, 2);

  const mp = nr.out;
  const a1 = crew(["add-job", mp, "--worker", "anti", "--role", "assist", "--title", "lọc", "--model", "gemini-3.8-flash-medium"], { cwd: ws });
  t.check("add-job: in seq<TAB>evidence tự đặt", a1.out, "1\t.crew/runs/261019-1200/worker-anti-1.md");
  const a2 = crew(["add-job", mp, "--worker", "codex", "--role", "owner", "--title", "code", "--effort", "medium", "--allow", "src/", "--allow", "docs/"], { cwd: ws });
  t.check("add-job codex: seq 2", a2.out.split("\t")[0], "2");
  t.check("--allow lặp → filesMayModify", JSON.stringify(readManifest(mp).jobs[1].filesMayModify), JSON.stringify(["src/", "docs/"]));
  t.check("worker antigravity ghi đúng tên", readManifest(mp).jobs[0].worker, "antigravity");
  t.check("codex thiếu --effort → exit 2", crew(["add-job", mp, "--worker", "codex", "--role", "assist", "--title", "x"], { cwd: ws }).code, 2);
  t.check("worker lạ → exit 2", crew(["add-job", mp, "--worker", "gemini", "--role", "assist", "--title", "x", "--model", "m"], { cwd: ws }).code, 2);
  t.check("evidence ngoài .crew → exit 1 (luật của sổ, không phải của CLI)",
    crew(["add-job", mp, "--worker", "anti", "--role", "assist", "--title", "x", "--model", "m", "--evidence", "src/w.md"], { cwd: ws }).code, 1);
  t.check("--model khai hai lần → exit 2",
    crew(["add-job", mp, "--worker", "anti", "--role", "assist", "--title", "x", "--model", "a", "--model", "b"], { cwd: ws }).code, 2);

  const d = crew(["digest"], { cwd: join(ws, ".crew") });
  t.check("digest chạy từ thư mục con vẫn thấy run của repo", d.out.includes("crew-261019-1200"), true);

  // run: cờ sổ đã ghi thì lấy từ sổ, cờ truyền tay vẫn thắng.
  const ex = expandRunArgs(["--manifest", ".crew/runs/261019-1200/manifest.json", "--job", "1", "--model", "m"], { cwd: ws });
  t.check("run: --manifest tương đối đổi thành tuyệt đối", ex[1], mp);
  t.check("run: thiếu --evidence → lấy từ sổ", ex[ex.indexOf("--evidence") + 1], join(ws, ".crew", "runs", "261019-1200", "worker-anti-1.md"));
  t.check("run: thiếu --workspace → lấy từ sổ", ex[ex.indexOf("--workspace") + 1], ws);
  t.check("run: thiếu --mode → lấy transport trong sổ", ex[ex.indexOf("--mode") + 1], "headless");
  t.check("run: --model truyền tay không bị nhân đôi", ex.filter((a) => a === "--model").length, 1);
  const auto = expandRunArgs(["--manifest", mp, "--job", "1"], { cwd: ws });
  t.check("run: thiếu --model → lấy model trong sổ", auto[auto.indexOf("--model") + 1], "gemini-3.8-flash-medium");
  const cx = expandRunArgs(["--manifest", mp, "--job", "2"], { cwd: ws });
  t.check("run codex: thiếu --effort → lấy effort trong sổ", cx[cx.indexOf("--effort") + 1], "medium");
  t.check("run: có --resume → không thêm --model (guard chặn cặp đó)", expandRunArgs(["--manifest", mp, "--job", "1", "--resume", "abc"], { cwd: ws }).includes("--model"), false);
  const kept = expandRunArgs(["--manifest", mp, "--job", "1", "--evidence", "x.md", "--mode", "app"], { cwd: ws });
  t.check("run: cờ truyền tay không bị đè", [kept[kept.indexOf("--evidence") + 1], kept[kept.indexOf("--mode") + 1], kept.filter((a) => a === "--evidence").length].join("|"), "x.md|app|1");
  t.check("run: không --manifest/--job → không đụng", JSON.stringify(expandRunArgs(["--model", "m"], { cwd: ws })), '["--model","m"]');
  t.check("run: job không có trong sổ → không đụng", expandRunArgs(["--manifest", mp, "--job", "9"], { cwd: ws }).length, 4);

  // amend: nới phạm vi giữa chừng phải kèm lời owner; control plane vẫn bị chặn.
  t.check("amend --allow thiếu --note → exit 2", crew(["amend", mp, "--job", "2", "--allow", "lib/"], { cwd: ws }).code, 2);
  const am = crew(["amend", mp, "--job", "2", "--allow", "lib/", "--note", "owner ok trong chat"], { cwd: ws });
  t.check("amend: gộp prefix mới vào cái đã khai", am.out, "2\tsrc/,docs/,lib/");
  t.check("amend: ghi lời owner vào note của job", (readManifest(mp).jobs[1].notes ?? []).some((n) => n.includes("owner ok trong chat") && n.includes("lib/")), true);
  t.check("amend vào control plane → exit 1", crew(["amend", mp, "--job", "2", "--allow", ".claude/", "--note", "x"], { cwd: ws }).code, 1);
  t.check("amend dưới vai worker → exit 1", crew(["amend", mp, "--job", "2", "--note", "x"], { cwd: ws, env: { ...process.env, CREW_ROLE: "worker" } }).code, 1);
  t.check("amend chỉ --note: không đổi phạm vi", crew(["amend", mp, "--job", "2", "--note", "review vòng 1 chưa đạt"], { cwd: ws }).out, "2\tsrc/,docs/,lib/");

  const p1 = crew(["paths", mp, "--job", "1"], { cwd: ws });
  const rows = Object.fromEntries(p1.out.split("\n").map((l) => l.split("\t")));
  t.check("paths: brief cạnh manifest", rows.brief, join(ws, ".crew", "runs", "261019-1200", "brief-anti-1.md"));
  t.check("paths: log thô theo layout", rows.logs, join(ws, ".crew", "logs", "261019-1200"));
  t.check("paths: job Anti có sidecar anti-watch", rows["anti-watch"], join(ws, ".crew", "logs", "261019-1200", "worker-anti-1.anti-watch.jsonl"));
  t.check("paths: job Codex không có anti-watch", crew(["paths", mp, "--job", "2"], { cwd: ws }).out.includes("anti-watch"), false);
  t.check("paths: job không có → exit 1", crew(["paths", mp, "--job", "9"], { cwd: ws }).code, 1);

  // collect đi qua cửa vào: exit giống gọi thẳng.
  const viaCollect = crew(["collect", mp, "--dry-run"], { cwd: ws });
  const directCollect = spawnSync(process.execPath, [join(MODULE_ROOT, "scripts", "crew-collect.mjs"), mp, "--dry-run"], { cwd: ws, encoding: "utf8" });
  t.check("collect qua crew: exit giống gọi thẳng", viaCollect.code, directCollect.status);
}

// ---- new-run ở layout sổ task ----
{
  const ws = realpathSync(tmpWorkspace("cli-legacy-"));
  t.check("layout có task mà thiếu --task → exit 2", crew(["new-run"], { cwd: ws }).code, 2);
  const nr = crew(["new-run", "--task", "tasks/t", "--run", "261019-1300"], { cwd: ws });
  t.check("--task có tiền tố tasks/ → run trong tasks/t/reports", nr.out, join(ws, "tasks", "t", "reports", "crew-261019-1300", "manifest.json"));
  t.check("...task trong sổ đã chuẩn hoá", readManifest(nr.out).task, "t");
  crew(["add-job", nr.out, "--worker", "anti", "--role", "assist", "--title", "x", "--model", "m"], { cwd: ws });
  const logs = crew(["paths", nr.out, "--job", "1"], { cwd: ws }).out.split("\n").find((l) => l.startsWith("logs\t"));
  t.check("paths ở layout sổ task: log thô trong data/crew-logs", logs, `logs\t${join(ws, "tasks", "t", "data", "crew-logs", "crew-261019-1300")}`);
}

// ---- thư mục không phải git ----
{
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "cli-nogit-")));
  const nr = crew(["new-run", "--run", "r"], { cwd: ws });
  t.check("không phải git → new-run exit 1", nr.code, 1);
  t.check("...nói cách sửa", /git init/.test(nr.err), true);
  t.check("...không để lại thư mục run", existsSync(join(ws, ".crew", "runs", "r")), false);
}

// ---- init ----
{
  const ws = gitRepo("cli-init-");
  const i1 = crew(["init"], { cwd: ws });
  t.check("init: exit 0", i1.code, 0);
  t.check("init: .crew/.gitignore bỏ logs/ và state/", /logs\/\nstate\//.test(readFileSync(join(ws, ".crew", ".gitignore"), "utf8")), true);
  t.check("init: gợi ý luật dự án nằm ở CLAUDE.md, không tự ghi", existsSync(join(ws, "CLAUDE.md")), false);
  crew(["init", "--state", "on"], { cwd: ws });
  t.check("init --state on: tạo .crew/state", existsSync(join(ws, ".crew", "state")), true);
  t.check("init lần nữa: không có gì cần tạo", crew(["init"], { cwd: ws }).out.includes("không có gì cần tạo"), true);
  t.check("init --state giá trị lạ → exit 2", crew(["init", "--state", "yes"], { cwd: ws }).code, 2);
}

// ---- doctor ----
{
  const home = mkdtempSync(join(tmpdir(), "cli-home-"));
  const env = { ...process.env, HOME: home, PATH: [FIXTURE_BIN, dirname(process.execPath), BARE_PATH].join(delimiter) };
  const ws = gitRepo("cli-doctor-");
  const ok = crew(["doctor"], { cwd: ws, env });
  t.check("doctor: repo git + worker giả → exit 0", ok.code, 0);
  t.check("...báo shim chưa cài kèm lệnh cài", /chưa cài/.test(ok.out), true);
  const nogit = crew(["doctor"], { cwd: realpathSync(mkdtempSync(join(tmpdir(), "cli-doc-nogit-"))), env });
  t.check("doctor ở thư mục không phải git → exit 1", nogit.code, 1);
  writeFileSync(join(ws, "crew.config.json"), '{"runDri": "x"}');
  const broken = crew(["doctor"], { cwd: ws, env });
  t.check("doctor: config gõ sai khoá → exit 1", broken.code, 1);
  t.check("...nêu khoá lạ", broken.out.includes("runDri"), true);
  const noWorker = crew(["doctor"], { cwd: gitRepo("cli-doc-nowork-"), env: { ...env, PATH: [dirname(process.execPath), BARE_PATH].join(delimiter) } });
  t.check("doctor: không có agy lẫn codex → exit 1", noWorker.code, 1);
  t.check("đọc tên model từ `agy models`", parseAgyModels("Fetching available models...\ngemini-3.8-flash-low\tGemini\nclaude-sonnet-4-6\tClaude\n").join(","), "gemini-3.8-flash-low,claude-sonnet-4-6");
}

// ---- install + shim dưới PATH tối thiểu ----
{
  const home = mkdtempSync(join(tmpdir(), "cli-install-"));
  const env = { ...process.env, HOME: home };
  const shim = join(home, ".local", "bin", "crew");
  const ins = crew(["install"], { env });
  t.check("install: exit 0", ins.code, 0);
  t.check("install: shim 755", (statSync(shim).mode & 0o777).toString(8), "755");
  t.check("shim không ghi đường node có số version", readFileSync(shim, "utf8").includes("/Cellar/"), false);
  const bare = spawnSync(shim, ["--help"], { env: { HOME: home, PATH: BARE_PATH }, encoding: "utf8" });
  t.check("shim chạy được khi PATH chỉ có /usr/bin:/bin", bare.status, 0);
  t.check("...và ra đúng crew", (bare.stdout ?? "").includes("dùng: crew"), true);
  t.check("cài lại đè shim của chính nó: exit 0", crew(["install"], { env }).code, 0);
  writeFileSync(shim, "#!/bin/sh\necho người khác\n");
  t.check("file không phải shim của crew → không ghi đè, exit 1", crew(["install"], { env }).code, 1);
  t.check("...file giữ nguyên", readFileSync(shim, "utf8").includes("người khác"), true);
  t.check("--force on → ghi đè", crew(["install", "--force", "on"], { env }).code, 0);
  t.check("shim: đường có dấu nháy đơn vẫn đúng", shimScript("/a'b/node", "/c/crew.mjs").includes("NODE='/a'\\''b/node'"), true);
  t.check("stableNode không bao giờ trả đường Cellar khi có symlink ổn định", stableNode().includes("/Cellar/") && existsSync("/opt/homebrew/bin/node"), false);
}

process.exit(t.finish() ? 0 : 1);
