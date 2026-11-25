#!/usr/bin/env node
/**
 * Lệnh nghiệm thu (`--accept-cmd`) do `crew collect` tự chạy:
 *   - exit 0 / exit khác 0 / quá hạn (giết cả nhóm tiến trình);
 *   - dùng lại kết quả theo (cmd, cwd, sha evidence lúc collect), đổi evidence thì chạy lại;
 *   - `--dry-run` vẫn chạy và chấm nhưng không ghi vào sổ;
 *   - job không sandbox ghi → NEEDS_HUMAN và không chạy, `--accept-run` thì chạy;
 *   - bỏ `CREW_ROLE` và `MWG_CREW_ROLE` khỏi env của lệnh;
 *   - `acceptCwd` và kiểm tra đầu vào ở `addJob`;
 *   - `crew add-job --accept-cmd` / `--accept-cwd` lưu vào sổ;
 *   - `--chain` chép `acceptCmd` / `acceptCwd` từ job gốc sang lát mới;
 *   - job không có `acceptCmd` hoặc verdict khác `PASS` không bị ảnh hưởng.
 *
 * Run: node tests/accept-command.test.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addJob, createRun, readManifest, updateJob } from "../scripts/crew-manifest.mjs";
import { evidenceDigest } from "../scripts/crew-guards.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("accept-command");
const COLLECT = join(MODULE_ROOT, "scripts", "crew-collect.mjs");
const CREW = join(MODULE_ROOT, "bin", "crew.mjs");
const RUN_REL = join("tasks", "t", "reports", "crew-test");
const DONE = "work\n\nStatus: DONE\nSummary: ok\n";
const SANDBOX = { kind: "codex-permissions", writable: ["tasks/t"], readOnly: [join(RUN_REL, "manifest.json")] };

function cli(manifestPath, args = [], { env } = {}) {
  const p = spawnSync(process.execPath, [COLLECT, manifestPath, ...args], {
    encoding: "utf8",
    env: env ?? process.env,
    timeout: 60_000,
  });
  return { exit: p.status, out: p.stdout ?? "", err: p.stderr ?? "" };
}

function crew(args, { cwd, env } = {}) {
  const p = spawnSync(process.execPath, [CREW, ...args], {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    timeout: 60_000,
  });
  return { exit: p.status, out: (p.stdout ?? "").trim(), err: (p.stderr ?? "").trim() };
}

/** Tạo run một hoặc nhiều job đã xong (hoặc trạng thái chỉ định). */
function newRun(jobs) {
  const ws = tmpWorkspace("accept-cmd-");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { manifestPath } = createRun({ runDir: join(ws, RUN_REL), runId: "test", task: "t", workspace: ws, depth: 0 });
  const now = Date.now();
  jobs.forEach((spec, idx) => {
    const ev = spec.evidence ?? join(RUN_REL, `w${idx + 1}.md`);
    const added = addJob(manifestPath, {
      worker: spec.worker ?? "codex",
      role: spec.role ?? "owner",
      title: spec.title ?? `job ${idx + 1}`,
      evidence: ev,
      ...(spec.acceptCmd !== undefined ? { acceptCmd: spec.acceptCmd } : {}),
      ...(spec.acceptCwd !== undefined ? { acceptCwd: spec.acceptCwd } : {}),
    });
    if (spec.body !== null) writeFile(join(ws, ev), spec.body ?? DONE);
    updateJob(manifestPath, added.seq, {
      status: spec.status ?? "done",
      exitCode: spec.exitCode ?? 0,
      startedAt: new Date(now - 120_000).toISOString(),
      endedAt: new Date(now - 60_000).toISOString(),
      ...(spec.sandboxed === false ? {} : spec.writeSandbox !== undefined ? { writeSandbox: spec.writeSandbox } : { writeSandbox: SANDBOX }),
    });
  });
  return { ws, manifestPath };
}

/** Bắt dòng bảng của job `seq` trong output collect. */
function tableRow(out, seq) {
  return out.split("\n").find((l) => l.startsWith(`| ${seq} |`)) ?? "";
}

// --- 1. Lệnh exit 0 + cắt tail ≤20 dòng, ≤300 ký tự/dòng -----------------------------------
{
  const longCmd = `node -e 'for (let i = 1; i <= 30; i += 1) console.log("line-" + i + "-" + "x".repeat(350))'`;
  const { ws, manifestPath } = newRun([{ acceptCmd: longCmd }]);
  const evAbs = join(ws, RUN_REL, "w1.md");
  const r = cli(manifestPath);
  t.check("exit 0: collect trả exit 0", r.exit, 0);
  const row = tableRow(r.out, 1);
  t.check("...bảng giữ PASS và thêm ACCEPT OK vào cột ghi chú", row.includes("| PASS |") && row.endsWith("| ACCEPT OK |"), true);
  const acc = readManifest(manifestPath).jobs[0].acceptance;
  t.check("...sổ ghi job.acceptance đủ trường cơ bản",
    `${acc?.cmd === longCmd}|${acc?.cwd === resolve(ws)}|${acc?.exitCode}|${acc?.timedOut}|${Number.isFinite(acc?.durationSec)}|${typeof acc?.ranAt}`,
    "true|true|0|false|true|string");
  t.check("...evidenceSha256 khớp file evidence lúc collect", acc?.evidenceSha256, evidenceDigest(evAbs));
  t.check("...tail tối đa 20 dòng cuối", Array.isArray(acc?.tail) && acc.tail.length === 20 && acc.tail[0].startsWith("line-11-") && acc.tail[19].startsWith("line-30-"), true);
  t.check("...mỗi dòng tail ≤ 300 ký tự", acc.tail.every((l) => l.length <= 300), true);
}

// --- 2. Lệnh exit khác 0 (gom stdout + stderr) ---------------------------------------------
{
  const { manifestPath } = newRun([{
    acceptCmd: `echo "stdout line 1"; echo "stderr boom 42" >&2; echo ""; exit 7`,
  }]);
  const r = cli(manifestPath);
  t.check("exit khác 0: collect trả exit 1", r.exit, 1);
  const row = tableRow(r.out, 1);
  t.check("...verdict thành FAIL", row.includes("| FAIL |"), true);
  t.check("...detail bắt đầu bằng 'lệnh nghiệm thu exit 7' kèm dòng output cuối không rỗng",
    row.includes("| lệnh nghiệm thu exit 7: stderr boom 42 |"), true);
  const acc = readManifest(manifestPath).jobs[0].acceptance;
  t.check("...sổ ghi exitCode=7, timedOut=false", `${acc?.exitCode}/${acc?.timedOut}`, "7/false");
}

// --- 3. Lệnh quá hạn: giết cả nhóm tiến trình ----------------------------------------------
{
  const scratch = mkdtempSync(join(tmpdir(), "accept-timeout-"));
  const pidFile = join(scratch, "grandchild.pid");
  const lateFile = join(scratch, "late.txt");
  // Sinh tiến trình cháu ngủ 10s rồi ghi file; khi quá hạn 1s cả nhóm phải chết ngay.
  const cmd = `sh -c 'sleep 10 && echo late > "${lateFile}"' & echo $! > "${pidFile}"; echo "dang-chay"; wait`;
  const { manifestPath } = newRun([{ acceptCmd: cmd }]);
  const t0 = Date.now();
  const r = cli(manifestPath, ["--accept-timeout", "1s"]);
  const elapsed = Date.now() - t0;
  t.check("quá hạn: collect trả exit 1", r.exit, 1);
  t.check("...dừng sớm, không đợi hết 10s", elapsed < 6000, true);
  const row = tableRow(r.out, 1);
  t.check("...verdict FAIL và detail bắt đầu bằng 'lệnh nghiệm thu quá hạn 1s'",
    row.includes("| FAIL |") && row.includes("| lệnh nghiệm thu quá hạn 1s"), true);
  const acc = readManifest(manifestPath).jobs[0].acceptance;
  t.check("...sổ ghi timedOut=true", acc?.timedOut, true);
  // Tiến trình cháu phải đã bị giết cùng nhóm.
  const childPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
  let alive = false;
  if (childPid > 0) {
    try { process.kill(childPid, 0); alive = true; } catch { alive = false; }
  }
  t.check("...tiến trình cháu trong nhóm đã bị giết", childPid > 0 && !alive && !existsSync(lateFile), true);
  // Kiểm tra nhận dạng duration `1h` và từ chối giá trị hỏng.
  t.check("--accept-timeout nhận '1h'", cli(manifestPath, ["--dry-run", "--accept-timeout", "1h"]).exit, 1); // reuse cached timedOut FAIL
  t.check("--accept-timeout sai định dạng → exit 2", cli(manifestPath, ["--accept-timeout", "bogus"]).exit, 2);
}

// --- 4. Dùng lại kết quả theo sha evidence, chạy lại khi evidence đổi ----------------------
{
  const scratch = mkdtempSync(join(tmpdir(), "accept-cache-"));
  const counter = join(scratch, "runs.log");
  const { ws, manifestPath } = newRun([{ acceptCmd: `echo ran >> "${counter}"` }]);
  const count = () => (existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0);

  const r1 = cli(manifestPath);
  t.check("cache: lần 1 chạy lệnh → exit 0, đếm = 1", `${r1.exit}/${count()}`, "0/1");
  const sha1 = readManifest(manifestPath).jobs[0].acceptance.evidenceSha256;

  const r2 = cli(manifestPath);
  t.check("cache: lần 2 evidence giữ nguyên → dùng lại, không chạy lại", `${r2.exit}/${count()}`, "0/1");
  t.check("...vẫn gắn ACCEPT OK", tableRow(r2.out, 1).includes("ACCEPT OK"), true);

  // Sửa file evidence → sha lúc collect đổi → phải chạy lại.
  writeFile(join(ws, RUN_REL, "w1.md"), "work updated\n\nStatus: DONE\nSummary: ok v2\n");
  const r3 = cli(manifestPath);
  const sha3 = readManifest(manifestPath).jobs[0].acceptance.evidenceSha256;
  t.check("cache: evidence đổi → chạy lại (đếm = 2) và cập nhật sha", `${r3.exit}/${count()}/${sha3 !== sha1}`, "0/2/true");
}

// --- 5. --dry-run vẫn chạy và chấm, nhưng không ghi sổ -------------------------------------
{
  const scratch = mkdtempSync(join(tmpdir(), "accept-dry-"));
  const marker = join(scratch, "ran.txt");
  const { manifestPath } = newRun([{ acceptCmd: `echo ok > "${marker}"` }]);
  const r = cli(manifestPath, ["--dry-run"]);
  t.check("--dry-run: vẫn chạy lệnh và exit 0", `${r.exit}/${existsSync(marker)}`, "0/true");
  t.check("...bảng vẫn có ACCEPT OK", tableRow(r.out, 1).includes("ACCEPT OK"), true);
  t.check("...nhưng không ghi job.acceptance vào manifest", readManifest(manifestPath).jobs[0].acceptance, undefined);
}

// --- 6. Job không sandbox → NEEDS_HUMAN và không chạy; --accept-run thì chạy ---------------
{
  const scratch = mkdtempSync(join(tmpdir(), "accept-nosandbox-"));
  const m1 = join(scratch, "j1.ran");
  const m2 = join(scratch, "j2.ran");
  const cmd1 = `echo one > "${m1}"`;
  const cmd2 = `echo two > "${m2}"`;
  const { manifestPath } = newRun([
    { acceptCmd: cmd1, sandboxed: false },
    { acceptCmd: cmd2, writeSandbox: { kind: null, reason: "tắt trong config" } },
  ]);

  const r1 = cli(manifestPath);
  t.check("không sandbox: collect trả exit 1", r1.exit, 1);
  t.check("...không tự chạy lệnh của cả 2 job", `${existsSync(m1)}/${existsSync(m2)}`, "false/false");
  const row1 = tableRow(r1.out, 1);
  const row2 = tableRow(r1.out, 2);
  t.check("...job 1 ra NEEDS_HUMAN, detail chứa lệnh nguyên văn và --accept-run 1",
    row1.includes("| NEEDS_HUMAN |") && row1.includes(cmd1) && row1.includes("--accept-run 1"), true);
  t.check("...job 2 (writeSandbox.kind=null) ra NEEDS_HUMAN và chỉ --accept-run 2",
    row2.includes("| NEEDS_HUMAN |") && row2.includes(cmd2) && row2.includes("--accept-run 2"), true);

  // Chỉ cấp --accept-run 1 → job 1 chạy, job 2 vẫn NEEDS_HUMAN.
  const r2 = cli(manifestPath, ["--accept-run", "1"]);
  t.check("--accept-run 1: job 1 chạy, job 2 chưa chạy, exit vẫn 1", `${r2.exit}/${existsSync(m1)}/${existsSync(m2)}`, "1/true/false");
  t.check("...job 1 thành PASS + ACCEPT OK", tableRow(r2.out, 1).includes("| PASS |") && tableRow(r2.out, 1).includes("ACCEPT OK"), true);

  // Cờ lặp được --accept-run 1 --accept-run 2 → cả hai qua, exit 0.
  const r3 = cli(manifestPath, ["--accept-run", "1", "--accept-run", "2"]);
  t.check("--accept-run lặp cho cả hai → exit 0, job 2 đã chạy", `${r3.exit}/${existsSync(m2)}`, "0/true");
}

// --- 7. CREW_ROLE và MWG_CREW_ROLE bị bỏ khỏi env của lệnh ---------------------------------
{
  const { manifestPath } = newRun([{
    acceptCmd: `test -z "$CREW_ROLE" && test -z "$MWG_CREW_ROLE" && echo "env-clean"`,
  }]);
  const r = cli(manifestPath, [], {
    env: { ...process.env, CREW_ROLE: "worker", MWG_CREW_ROLE: "worker" },
  });
  t.check("env của lệnh bỏ CREW_ROLE và MWG_CREW_ROLE", r.exit, 0);
  t.check("...output ghi lại vào tail", readManifest(manifestPath).jobs[0].acceptance?.tail?.[0], "env-clean");
}

// --- 8. acceptCwd + kiểm tra đầu vào ở addJob ----------------------------------------------
{
  const { ws, manifestPath } = newRun([{ acceptCmd: "cat marker.txt", acceptCwd: "sub/pkg" }]);
  mkdirSync(join(ws, "sub", "pkg"), { recursive: true });
  writeFileSync(join(ws, "sub", "pkg", "marker.txt"), "from-sub-pkg\n");
  // Đặt mtime cũ hơn cửa sổ job để scope gate không tính file fixture này cho worker.
  const r = cli(manifestPath, ["--not-ours", "sub/pkg/marker.txt", "--reason", "fixture test"]);
  t.check("acceptCwd: chạy đúng trong workspace + acceptCwd", r.exit, 0);
  const acc = readManifest(manifestPath).jobs[0].acceptance;
  t.check("...đọc được file ở thư mục con", acc?.tail?.[0], "from-sub-pkg");
  t.check("...cwd lưu đúng đường tuyệt đối thư mục con", acc?.cwd, resolve(ws, "sub/pkg"));

  const refused = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const errNoCmd = refused(() => addJob(manifestPath, {
    worker: "codex", role: "owner", title: "bad", evidence: join(RUN_REL, "w2.md"), acceptCwd: "sub",
  }));
  t.check("addJob: khai acceptCwd thiếu acceptCmd → ManifestError", errNoCmd?.name, "ManifestError");
  const errEmpty = refused(() => addJob(manifestPath, {
    worker: "codex", role: "owner", title: "bad", evidence: join(RUN_REL, "w3.md"), acceptCmd: "   ",
  }));
  t.check("addJob: acceptCmd rỗng → ManifestError", errEmpty?.name, "ManifestError");
  const errUp = refused(() => addJob(manifestPath, {
    worker: "codex", role: "owner", title: "bad", evidence: join(RUN_REL, "w4.md"), acceptCmd: "echo ok", acceptCwd: "../ngoai",
  }));
  t.check("addJob: acceptCwd chứa '..' → ManifestError", errUp?.name, "ManifestError");
}

// --- 9. `crew add-job --accept-cmd` / `--accept-cwd` lưu vào sổ ----------------------------
{
  const ws = tmpWorkspace("accept-cli-");
  const mp = crew(["new-run", "--task", "t", "--run", "261124-0100"], { cwd: ws }).out;
  const r = crew([
    "add-job", mp, "--worker", "codex", "--role", "owner", "--title", "build", "--model", "gpt-test",
    "--accept-cmd", "npm test", "--accept-cwd", "packages/app",
  ], { cwd: ws });
  t.check("crew add-job --accept-cmd --accept-cwd → exit 0", r.exit, 0);
  const j = readManifest(mp).jobs[0];
  t.check("...lưu đúng acceptCmd và acceptCwd vào sổ", `${j.acceptCmd}|${j.acceptCwd}`, "npm test|packages/app");
  const bad = crew([
    "add-job", mp, "--worker", "codex", "--role", "owner", "--title", "bad", "--model", "gpt-test",
    "--accept-cwd", "packages/app",
  ], { cwd: ws });
  t.check("crew add-job --accept-cwd không có --accept-cmd → bị từ chối", bad.exit !== 0, true);
}

// --- 10. Job không có acceptCmd & job không PASS không bị ảnh hưởng ------------------------
{
  const scratch = mkdtempSync(join(tmpdir(), "accept-noop-"));
  const blockedMarker = join(scratch, "blocked.ran");
  const { manifestPath } = newRun([
    { title: "thuong", sandboxed: false }, // không acceptCmd, không sandbox → vẫn PASS sạch
    {
      title: "bi-chan",
      body: "blocked\n\nConcerns/Blockers: thieu input\nStatus: BLOCKED\n",
      status: "blocked",
      acceptCmd: `echo bad > "${blockedMarker}"`,
    },
  ]);
  const r = cli(manifestPath);
  const row1 = tableRow(r.out, 1);
  const row2 = tableRow(r.out, 2);
  t.check("job không có acceptCmd: vẫn PASS bình thường, không có ACCEPT OK",
    row1.includes("| PASS |") && !row1.includes("ACCEPT OK"), true);
  t.check("job BLOCKED có acceptCmd: giữ BLOCKED và không chạy lệnh",
    row2.includes("| BLOCKED |") && !existsSync(blockedMarker), true);
}

// --- 11. --chain chép acceptCmd/acceptCwd từ job gốc sang lát mới --------------------------
{
  const ws = tmpWorkspace("accept-chain-");
  const runDir = join(ws, ...RUN_REL.split("/"));
  const { manifestPath } = createRun({ runDir, runId: "chain-acc", task: "t", workspace: ws, depth: 0 });
  addJob(manifestPath, {
    worker: "codex", role: "owner", title: "build dài", evidence: `${RUN_REL}/worker-codex-1.md`,
    acceptCmd: "echo chain-ok", acceptCwd: "sub",
  });
  const fake = mkdtempSync(join(tmpdir(), "accept-chain-fake-"));
  const handoff = "lát 1\n\n## Handoff\n### Đã xong\n- a\n### Đang dở\n- b\n### Bước kế tiếp\n- c\n### File đã đụng\n- f.txt\n\nStatus: CONTINUE\n";
  writeFileSync(join(fake, "1.md"), handoff);
  writeFileSync(join(fake, "1.work"), "");
  writeFileSync(join(fake, "2.md"), DONE);
  writeFileSync(join(fake, "2.work"), "");
  const brief = writeFile(join(runDir, "brief-codex-1.md"), "làm bài\n");
  const r = crew(
    ["run", "codex", "--manifest", manifestPath, "--job", "1", "--prompt-file", brief, "--chain", "--timeout", "1m"],
    {
      cwd: ws,
      env: {
        ...process.env,
        PATH: `${FIXTURE_BIN}:${process.env.PATH}`,
        FAKE_MODE: "chain",
        FAKE_CHAIN_DIR: fake,
        CREW_QUOTA_CHECK: "off",
      },
    },
  );
  const js = readManifest(manifestPath).jobs;
  t.check("--chain chạy xong 2 lát → exit 0", r.exit, 0);
  t.check("...lát 2 chép đúng acceptCmd và acceptCwd từ job gốc",
    `${js[1]?.acceptCmd}|${js[1]?.acceptCwd}`, "echo chain-ok|sub");
}

process.exit(t.finish() ? 0 : 1);
