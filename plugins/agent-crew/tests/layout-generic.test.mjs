/**
 * Một run trọn vẹn ở layout mặc định `.crew/` — repo không có sổ task, không có
 * crew.config.json. Các test khác chạy ở layout gốc (`tasks/`); file này là bằng
 * chứng bộ luật không phụ thuộc vào cái sổ đó.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addJob, createRun, readManifest, updateJob, updateManifest } from "../scripts/crew-manifest.mjs";
import { collectRun, writeRunReport } from "../scripts/crew-collect.mjs";
import { validateEvidencePath } from "../scripts/crew-guards.mjs";
import { isControlPlanePath, isProtectedPath, runHome, touchesControlPlane } from "../scripts/crew-scope.mjs";
import { crewDigest } from "../scripts/lib/crew-digest.mjs";
import { DEFAULT_LAYOUT, LEGACY_LAYOUT, loadLayout } from "../scripts/lib/crew-layout.mjs";
import { MODULE_ROOT, makeChecker, writeFile } from "./helpers.mjs";

const t = makeChecker("layout-generic");
const DONE = "work\n\nStatus: DONE\nSummary: ok\n";
const msg = (fn) => { try { fn(); return "không ném"; } catch (e) { return e.message; } };

function bareRepo(prefix) {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: ws });
  return ws;
}

// ---- tạo run ----
{
  const ws = bareRepo("generic-run-");
  const runRel = ".crew/runs/261019-1000";
  const { manifestPath } = createRun({ runDir: join(ws, runRel), runId: "261019-1000", workspace: ws, depth: 0 });
  const m = readManifest(manifestPath);
  t.check("không config → run chép layout mặc định", m.layout.runDir, DEFAULT_LAYOUT.runDir);
  t.check("manifest ghi runDir tương đối", m.runDir, runRel);
  t.check("không có task", m.task, "");
  t.check("home của run = chính thư mục run", runHome(m), runRel);

  t.check("truyền task ở layout không task → từ chối",
    /layout has no tasks/.test(msg(() => createRun({ runDir: join(ws, ".crew/runs/x"), runId: "x", task: "t", workspace: ws }))), true);
  t.check("runDir ngoài workspace → từ chối",
    /inside the workspace/.test(msg(() => createRun({ runDir: join(tmpdir(), "elsewhere-run"), runId: "y", workspace: ws }))), true);
  t.check("đổi layout trong sổ → từ chối",
    /không được đổi "layout"/.test(msg(() => updateManifest(manifestPath, (x) => { x.layout = { ...x.layout, evidenceRoot: "src", runDir: "src/{run}" }; return x; }))), true);
  t.check("...sổ giữ nguyên layout", readManifest(manifestPath).layout.evidenceRoot, ".crew");

  t.check("evidence dưới tasks/ ở layout này → từ chối",
    /must live under \.crew\//.test(msg(() => addJob(manifestPath, { worker: "codex", role: "assist", title: "x", evidence: "tasks/t/w.md" }))), true);
  t.check("guard của adapter cũng từ chối", /outside the evidence root/.test(msg(() => validateEvidencePath("tasks/t/w.md", ws))), true);
  t.check("guard nhận evidence trong .crew", validateEvidencePath(`${runRel}/w.md`, ws), join(ws, runRel, "w.md"));

  // ---- một job, collect, report ----
  const j = addJob(manifestPath, { worker: "codex", role: "assist", title: "viết file", evidence: `${runRel}/worker-codex-1.md` });
  updateJob(manifestPath, j.seq, { status: "running", startedAt: new Date(Date.now() - 60_000).toISOString() });
  writeFile(join(ws, runRel, "worker-codex-1.md"), DONE);
  writeFile(join(ws, "src", "stray.mjs"), "// job ghi ra ngoài chỗ được ghi\n");
  updateJob(manifestPath, j.seq, { status: "done", endedAt: new Date().toISOString(), exitCode: 0 });

  const red = collectRun(manifestPath, { workspace: ws });
  t.check("evidence trong .crew → PASS", red.rows[0].verdict, "PASS");
  t.check("ghi ra src/ không khai → ngoài phạm vi", red.scope.outOfScope.some((e) => e.path === "src/stray.mjs"), true);
  t.check("...gate đỏ", red.exitCode, 2);

  execFileSync("rm", ["-f", join(ws, "src", "stray.mjs")]);
  const green = collectRun(manifestPath, { workspace: ws });
  t.check("bỏ file lạ → gate xanh", green.exitCode, 0);
  t.check("report ngoài thư mục run → từ chối",
    /report phải nằm trực tiếp trong \.crew\/runs\/261019-1000\//.test(msg(() => writeRunReport(green, readManifest(manifestPath), { path: ".crew/report.md", workspace: ws }))), true);
  writeRunReport(green, readManifest(manifestPath), { path: `${runRel}/report.md`, workspace: ws });
  t.check("report ghi vào thư mục run", existsSync(join(ws, runRel, "report.md")), true);
}

// ---- bảng crew còn dở + crew-session ở layout không task ----
{
  const ws = bareRepo("generic-digest-");
  const runRel = ".crew/runs/261019-1100";
  const { manifestPath } = createRun({ runDir: join(ws, runRel), runId: "261019-1100", workspace: ws });
  addJob(manifestPath, { worker: "antigravity", role: "assist", title: "x", evidence: `${runRel}/worker-anti-1.md` });
  const lines = crewDigest(ws, { epoch: "2000-01-01" });
  t.check("bảng crew còn dở thấy run trong .crew", lines.some((l) => l.includes("crew-261019-1100")), true);

  const cli = spawnSync("node", [join(MODULE_ROOT, "scripts", "crew-session.mjs"), "run-for", "--date", "261019"], { cwd: ws, encoding: "utf8" });
  t.check("crew-session không cần --task ở layout không task", cli.stdout.trim() && realpathSync(cli.stdout.trim()), realpathSync(manifestPath));

  writeFileSync(join(ws, "crew.config.json"), '{"runDri": "x"}');
  const broken = crewDigest(ws);
  t.check("config hỏng → một dòng báo, không ném", broken.length === 1 && broken[0].startsWith("! crew.config.json"), true);
}

// ---- file bảo vệ / control plane: danh sách chung + phần workspace khai ----
{
  t.check("harness/ của workspace gốc không phải control plane ở repo khác", touchesControlPlane("harness/", DEFAULT_LAYOUT), false);
  t.check("...nhưng vẫn là control plane ở layout gốc", touchesControlPlane("harness/", LEGACY_LAYOUT), true);
  t.check("không truyền layout → chặn theo cả hai (rộng hơn là an toàn hơn)", touchesControlPlane("harness/"), true);
  t.check("crew.config.json là control plane ở mọi layout", isControlPlanePath("crew.config.json", DEFAULT_LAYOUT) && isControlPlanePath("crew.config.json", LEGACY_LAYOUT), true);
  t.check("thư mục skill chung được bảo vệ ở mọi layout", isProtectedPath(".claude/skills/x/SKILL.md", DEFAULT_LAYOUT), true);
  t.check("file bảo vệ riêng của workspace gốc không dính repo khác", isProtectedPath("mwg-seo-analytics/.env", DEFAULT_LAYOUT), false);

  const ws = bareRepo("generic-protect-");
  writeFileSync(join(ws, "crew.config.json"), JSON.stringify({ protectedPaths: ["secrets/", "app/.env.local"], controlPlanePaths: ["ops/"] }));
  const l = loadLayout(ws);
  t.check("config khai thư mục bảo vệ", isProtectedPath("secrets/key.pem", l), true);
  t.check("config khai file bảo vệ", isProtectedPath("app/.env.local", l), true);
  t.check("config khai control plane: filesMayModify không với tới", touchesControlPlane("ops/deploy/", l), true);
  writeFileSync(join(ws, "crew.config.json"), JSON.stringify({ protectedPaths: ["/etc/passwd"] }));
  t.check("đường tuyệt đối trong protectedPaths → từ chối", /protectedPaths/.test(msg(() => loadLayout(ws))), true);
  writeFileSync(join(ws, "crew.config.json"), JSON.stringify({ protectedPaths: ["secrets/", "app/.env.local"], controlPlanePaths: ["ops/"] }));

  const runRel = ".crew/runs/261019-1600";
  const { manifestPath } = createRun({ runDir: join(ws, runRel), runId: "261019-1600", workspace: ws });
  const j = addJob(manifestPath, { worker: "codex", role: "assist", title: "x", evidence: `${runRel}/worker-codex-1.md` });
  t.check("khai filesMayModify vào control plane của config → từ chối",
    /control plane|điều khiển/i.test(msg(() => addJob(manifestPath, { worker: "codex", role: "assist", title: "y", evidence: `${runRel}/w2.md`, filesMayModify: ["ops/"] }))), true);
  updateJob(manifestPath, j.seq, { status: "running", startedAt: new Date(Date.now() - 60_000).toISOString() });
  writeFile(join(ws, runRel, "worker-codex-1.md"), DONE);
  writeFile(join(ws, "secrets", "key.pem"), "x\n");
  updateJob(manifestPath, j.seq, { status: "done", endedAt: new Date().toISOString(), exitCode: 0 });
  const r = collectRun(manifestPath, { workspace: ws });
  t.check("worker ghi vào thư mục bảo vệ của config → protected hit, gate đỏ", r.scope.protectedHits.some((e) => e.path === "secrets/key.pem") && r.exitCode === 2, true);
}

// ---- thư mục không phải git: từ chối trước khi tốn token ----
{
  const ws = mkdtempSync(join(tmpdir(), "generic-nogit-"));
  t.check("không phải git repo → createRun từ chối",
    /not a git work tree/.test(msg(() => createRun({ runDir: join(ws, ".crew/runs/r"), runId: "r", workspace: ws }))), true);
  t.check("...và không để lại manifest", existsSync(join(ws, ".crew/runs/r/manifest.json")), false);
}

// ---- manifest cũ (không có layout) vẫn chấm được theo layout gốc ----
{
  const ws = bareRepo("generic-legacy-");
  const runRel = "tasks/t/reports/crew-old";
  writeFile(join(ws, runRel, "worker-anti-1.md"), DONE);
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  writeFile(join(ws, runRel, "manifest.json"), JSON.stringify({
    version: 3, runId: "old", task: "t", workspace: ws, dispatcher: "claude", depth: 0,
    createdAt: startedAt, updatedAt: startedAt, headSha: null,
    jobs: [{ seq: 1, worker: "antigravity", role: "assist", transport: "headless", title: "x", evidence: `${runRel}/worker-anti-1.md`,
      status: "done", startedAt, endedAt: new Date().toISOString(), exitCode: 0 }],
  }, null, 2));
  const r = collectRun(join(ws, runRel, "manifest.json"), { workspace: ws, dryRun: true });
  t.check("manifest cũ không có layout → chấm theo tasks/, PASS", r.rows[0].verdict, "PASS");
  t.check("...report vẫn phải ở tasks/t/reports/", /tasks\/t\/reports\//.test(msg(() => writeRunReport({ ...r, dryRun: false, exitCode: 0 }, readManifest(join(ws, runRel, "manifest.json")), { path: ".crew/x.md", workspace: ws }))), true);
  t.check("...và manifest không bị chép thêm layout khi chỉ đọc", "layout" in JSON.parse(readFileSync(join(ws, runRel, "manifest.json"), "utf8")), false);
}

process.exit(t.finish() ? 0 : 1);
