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
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

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
  // Tắt cổng quota: không thì test hỏi quota của agy thật trên máy.
  const via = crew(["run", "anti", "--bogus-flag", "x"], { env: { ...process.env, CREW_QUOTA_CHECK: "off" } });
  t.check("run anti cờ lạ: exit giống gọi thẳng adapter", via.code, direct.status);
  t.check("...và khác 0", via.code !== 0, true);
}

// ---- `crew <lệnh> --help`: mọi lệnh đều in cách dùng, exit 0 ----
{
  // Đo 12/11: chỉ `hold` chịu --help (vá 11/11); các lệnh khác trả "cờ lạ --help"
  // exit 2, còn `probe`/`anti-env` bỏ qua cờ rồi chạy việc thật. Session phải gõ
  // lại mới biết cú pháp, nên cửa vào xử --help chung trước khi giao xuống.
  for (const cmd of ["new-run", "add-job", "amend", "paths", "digest", "doctor", "quota", "init", "install",
                     "collect", "reconcile", "session", "probe", "anti-env", "anti-status", "export-session",
                     "state-read", "state-write", "hold"]) {
    for (const flag of ["--help", "-h"]) {
      const r = crew([cmd, flag]);
      t.check(`${cmd} ${flag} → exit 0`, r.code, 0);
      t.check(`...in cách dùng có "${cmd}"`, `${r.out}\n${r.err}`.includes(cmd), true);
    }
  }
  const run = crew(["run", "anti", "--help"]);
  t.check("run anti --help → exit 0", run.code, 0);
  t.check("...nhắc --chain", run.out.includes("--chain"), true);
  t.check("run --help (chưa có worker) → exit 0", crew(["run", "--help"]).code, 0);
  // Không nuốt --help nằm ở vị trí giá trị của cờ khác: chỉ cờ đứng ngay sau lệnh mới là hỏi cú pháp.
  t.check("add-job --title --help → không tính là hỏi cú pháp", crew(["add-job", "--title", "--help"]).code !== 0, true);
}

// ---- add-job --tier / --bump-from: một chữ ra model còn sống ----
{
  // `agy models` lấy từ fake trên PATH: mặc định là list thật đo 06/11.
  // HOME giả có ~/.codex/config.toml riêng, để model Codex không phụ thuộc máy chạy test.
  const home = mkdtempSync(join(tmpdir(), "cli-tier-home-"));
  writeFile(join(home, ".codex", "config.toml"), 'model = "gpt-test-1"\n');
  // Catalog Codex giả: hai đời Sol (bản mới phải thắng), một Astra, một model ẩn.
  const lv = (...e) => e.map((effort) => ({ effort }));
  const catalog = { models: [
    { slug: "gpt-7-sol", visibility: "list", supported_reasoning_levels: lv("low", "medium", "high", "xhigh", "max") },
    { slug: "gpt-6-sol", visibility: "list", supported_reasoning_levels: lv("low", "medium", "high", "xhigh", "max") },
    { slug: "gpt-7-astra", visibility: "list", supported_reasoning_levels: lv("low", "medium", "high", "xhigh", "max") },
    { slug: "gpt-9-sol", visibility: "hide", supported_reasoning_levels: lv("low") },
  ] };
  writeFile(join(home, ".codex", "models_cache.json"), JSON.stringify(catalog));
  const env = (extra = {}) => ({ ...process.env, HOME: home, PATH: `${FIXTURE_BIN}${delimiter}${process.env.PATH}`, ...extra });
  const ws = gitRepo("cli-tier-");
  const mp = crew(["new-run", "--run", "261106-0900"], { cwd: ws }).out;
  const add = (args, extra) => crew(["add-job", mp, "--role", "assist", "--title", "t", ...args], { cwd: ws, env: env(extra) });
  const job = (seq) => readManifest(mp).jobs.find((j) => j.seq === seq);

  t.check("--tier standard cho anti: exit 0", add(["--worker", "anti", "--tier", "standard"]).code, 0);
  t.check("...sổ ghi tier và model còn sống", `${job(1).tier}|${job(1).model}`, "standard|gemini-3.8-flash-medium");
  t.check("--tier claude cho anti → model Claude qua agy", (add(["--worker", "anti", "--tier", "claude"]), job(2).model), "claude-sonnet-4-6");
  t.check("--tier code cho codex → Sol mới nhất trong catalog (bỏ model ẩn), effort high", (add(["--worker", "codex", "--tier", "code"]), `${job(3).tier}|${job(3).effort}|${job(3).model}`), "code|high|gpt-7-sol");

  const bumped = add(["--worker", "anti", "--bump-from", "1"]);
  t.check("--bump-from 1: exit 0", bumped.code, 0);
  t.check("...nâng đúng 1 bậc", `${job(4).tier}|${job(4).model}`, "deep|gemini-3.8-flash-high");
  t.check("...note ghi nâng từ job nào", job(4).notes.includes("nâng bậc từ job 1 (standard → deep)"), true);
  t.check("--bump-from job deep → giữ deep, có note", (add(["--worker", "anti", "--bump-from", "4"]), `${job(5).tier}|${job(5).notes[0]}`), "deep|nâng bậc từ job 4: deep không có bậc trên, giữ nguyên");
  t.check("--bump-from job không ghi tier → exit 2", (crew(["add-job", mp, "--worker", "anti", "--role", "assist", "--title", "m", "--model", "gemini-3.8-flash-low"], { cwd: ws }), add(["--worker", "anti", "--bump-from", "6"]).code), 2);
  t.check("--tier và --bump-from cùng lúc → exit 2", add(["--worker", "anti", "--tier", "light", "--bump-from", "1"]).code, 2);
  t.check("--bump-from job không có → exit 2", add(["--worker", "anti", "--bump-from", "99"]).code, 2);

  const before = readManifest(mp).jobs.length;
  const codeAnti = add(["--worker", "anti", "--tier", "code"]);
  t.check("--tier code cho anti → exit khác 0", codeAnti.code !== 0, true);
  t.check("...nói tier code chỉ cho Codex", codeAnti.err.includes("tier code chỉ cho Codex"), true);
  t.check("--tier claude cho codex → exit khác 0", add(["--worker", "codex", "--tier", "claude"]).code !== 0, true);
  t.check("--tier lạ → exit khác 0", add(["--worker", "anti", "--tier", "huge"]).code !== 0, true);
  const dead = add(["--worker", "anti", "--tier", "light"], { FAKE_AGY_MODELS: "gemini-3.8-flash-high" });
  t.check("list không có model của bậc → exit khác 0", dead.code !== 0, true);
  t.check("...liệt kê tên còn sống, không trượt sang bậc khác", dead.err.includes("model còn sống: gemini-3.8-flash-high"), true);
  const noAgy = add(["--worker", "anti", "--tier", "standard"], { FAKE_AGY_MODELS: "fail" });
  t.check("agy models chết → exit khác 0, gợi --model tay", noAgy.code !== 0 && noAgy.err.includes("--model <tên>"), true);
  t.check("...và không job lỗi nào vào sổ", readManifest(mp).jobs.length, before);

  // Run đầu đã đủ MAX_JOBS; phần dưới ghi vào run thứ hai.
  const mp2 = crew(["new-run", "--run", "261106-0901"], { cwd: ws }).out;
  const add2 = (args, extra) => crew(["add-job", mp2, "--role", "assist", "--title", "t", ...args], { cwd: ws, env: env(extra) });
  const last2 = () => readManifest(mp2).jobs.at(-1);
  // Cờ tay thắng --tier, và khi đó không cần gọi agy models.
  const manual = add2(["--worker", "anti", "--tier", "light", "--model", "gemini-3.8-flash-high"], { FAKE_AGY_MODELS: "fail" });
  const mj = last2();
  t.check("--model tay thắng --tier, không cần agy models", `${manual.code}|${mj.tier}|${mj.model}`, "0|light|gemini-3.8-flash-high");
  t.check("...note ghi cờ tay đã thắng", mj.notes.includes("--model tay thắng --tier light"), true);
  // Codex: bậc chọn cả model lẫn effort; cờ tay chỉ đè phần mình khai.
  const cx = add2(["--worker", "codex", "--tier", "max"]);
  t.check("codex --tier max → Astra, effort max", `${cx.code}|${last2().model}|${last2().effort}`, "0|gpt-7-astra|max");
  add2(["--worker", "codex", "--tier", "deep", "--effort", "medium"]);
  t.check("codex --effort tay đè effort, model vẫn theo bậc", `${last2().model}|${last2().effort}|${last2().notes.includes("--effort tay thắng --tier deep")}`, "gpt-7-sol|medium|true");
  add2(["--worker", "codex", "--bump-from", String(last2().seq)]);
  t.check("codex --bump-from job deep → max (Astra)", `${last2().tier}|${last2().model}`, "max|gpt-7-astra");
  const noCat = crew(["add-job", mp2, "--role", "assist", "--title", "t", "--worker", "codex", "--tier", "code"], { cwd: ws, env: { ...env(), HOME: mkdtempSync(join(tmpdir(), "cli-tier-nocat-")) } });
  t.check("không có catalog Codex → exit khác 0, gợi --effort tay", noCat.code !== 0 && noCat.err.includes("--effort"), true);
  const viaCmd = crew(["add-job", mp2, "--role", "assist", "--title", "t", "--worker", "codex", "--tier", "code"],
    { cwd: ws, env: { ...env(), HOME: mkdtempSync(join(tmpdir(), "cli-tier-cmd-")), FAKE_CODEX_MODELS: JSON.stringify(catalog) } });
  t.check("không có cache thì hỏi `codex debug models`", `${viaCmd.code}|${last2().model}`, "0|gpt-7-sol");
  t.check("anti app --tier deep → bậc agentapi pro",
    (add2(["--worker", "anti", "--tier", "deep", "--transport", "app", "--note", "cần người trả prompt permission"]), last2().model), "pro");
  t.check("thiếu cả --tier lẫn --model → exit 2, gợi --tier", (() => { const r = add2(["--worker", "anti"]); return r.code === 2 && r.err.includes("--tier"); })(), true);

  // Job resume vẫn ghi tier/model vào sổ, nhưng crew run không truyền --model.
  const resumed = expandRunArgs(["--manifest", mp, "--job", "1", "--resume", "conv-1"], { cwd: ws });
  t.check("run job có tier + --resume → không thêm --model", resumed.includes("--model"), false);
  t.check("run job có tier, không resume → --model từ sổ", (() => { const a = expandRunArgs(["--manifest", mp, "--job", "1"], { cwd: ws }); return a[a.indexOf("--model") + 1]; })(), "gemini-3.8-flash-medium");
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
  const codexApp = crew(["add-job", mp, "--worker", "codex", "--role", "owner", "--transport", "app", "--note", "x", "--effort", "low", "--title", "t"], { cwd: ws });
  t.check("codex --transport app → exit khác 0", codexApp.code !== 0, true);
  t.check("...câu lỗi chỉ sang headless --resume", /headless/.test(codexApp.err) && /--resume <conversationId>/.test(codexApp.err), true);
  t.check("...và không ghi job nào vào sổ", readManifest(mp).jobs.length, 2);
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
