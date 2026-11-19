#!/usr/bin/env node
/**
 * Sandbox ghi: hệ điều hành chặn worker ghi ra ngoài vùng của job, để cổng phạm
 * vi khỏi phải đoán theo giờ sửa file.
 *
 * Vì sao (15/11/2026): ở workspace đông session, collect bắt bác tay 310 path
 * trong 9/42 run, không path nào là worker ghi sai thật. Đo cùng ngày: Codex
 * (permission profile) và agy (bọc sandbox-exec) đều chặn được ghi ngoài vùng.
 *
 * Seatbelt ở đây là seatbelt thật (máy macOS); Codex là fake, nên phần chặn của
 * Codex chỉ kiểm qua argv + lần tự thử (`FAKE_SANDBOX=enforce` cho fake chặn thật).
 *
 * Run: node plugins/agent-crew/tests/write-sandbox.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addJob, claimRunSlot, createRun, readManifest, updateJob } from "../scripts/crew-manifest.mjs";
import { collectWriteScope, sandboxAllows } from "../scripts/crew-scope.mjs";
import { WRITE_LOCK_LINE } from "../scripts/crew-guards.mjs";
import {
  SEATBELT, codexProfileArgs, planWriteSandbox, probeCodexProfile, probeSeatbelt, sandboxDenials, seatbeltProfile, writeScopeFor,
} from "../scripts/lib/write-sandbox.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("write-sandbox");
const CODEX = join(MODULE_ROOT, "scripts", "codex-run.mjs");
const ANTI = join(MODULE_ROOT, "scripts", "anti-run.mjs");
const RUN_REL = "tasks/t/reports/crew-test";

function newRun(jobs) {
  const ws = tmpWorkspace("wsbx-");
  const { manifestPath } = createRun({ runDir: join(ws, ...RUN_REL.split("/")), runId: "crew-test", task: "t", workspace: ws, depth: 0 });
  for (const j of jobs) addJob(manifestPath, { worker: j.worker ?? "codex", role: "assist", title: "j", evidence: `${RUN_REL}/${j.ev}`, ...(j.allow ? { filesMayModify: j.allow } : {}) });
  const brief = writeFile(join(ws, RUN_REL, "brief.md"), "việc\n");
  return { ws, manifestPath, brief };
}
const env = (extra = {}) => ({ ...process.env, PATH: `${FIXTURE_BIN}:${process.env.PATH}`, ...extra });

// --- vùng ghi = đúng cái cổng collect cho phép --------------------------------------------
{
  const { manifestPath } = newRun([{ ev: "w-1.md", allow: ["src/"] }, { ev: "w-2.md" }]);
  const m = readManifest(manifestPath);
  const s1 = writeScopeFor(m, 1);
  t.check("vùng ghi job 1: thư mục task + --allow", s1.writable.join(","), "tasks/t,src");
  t.check("...job 2 không mượn --allow của job 1", writeScopeFor(m, 2).writable.join(","), "tasks/t");
  t.check("...sổ của run chỉ đọc (worker không tự khai writeSandbox được)", s1.readOnly.includes(`${RUN_REL}/manifest.json`), true);
  const sb = { kind: "seatbelt", ...s1 };
  t.check("sandboxAllows: trong thư mục task", sandboxAllows(sb, "tasks/t/x.md"), true);
  t.check("...trong --allow", sandboxAllows(sb, "src/a/b.js"), true);
  t.check("...tên trùng tiền tố không lọt (srcx/)", sandboxAllows(sb, "srcx/a.js"), false);
  t.check("...ngoài vùng", sandboxAllows(sb, "plans/p.md"), false);
  t.check("...job không sandbox thì coi như ghi được mọi chỗ", sandboxAllows({ kind: null, reason: "x" }, "plans/p.md"), true);
  t.check("...readOnly trong vùng ghi bị chặn", sandboxAllows({ kind: "seatbelt", writable: ["a"], readOnly: ["a/.claude"] }, "a/.claude/x"), false);
  t.check("...so không phân biệt hoa thường, bỏ ./ (đĩa macOS)", sandboxAllows({ kind: "seatbelt", writable: ["./SRC"] }, "src/x.js"), true);
  t.check("workspace bắn khác workspace của sổ → không khoá, nói vì sao",
    /khác workspace của sổ/.test(planWriteSandbox({ manifest: m, seq: 1, workspace: tmpdir(), kind: "seatbelt", probe: () => ({ ok: true }) }).reason ?? ""), true);
}

// --- tham số Codex: đường có dấu cách / ngoặc kép vẫn là TOML hợp lệ -----------------------
{
  const args = codexProfileArgs({ workspace: "/x/Digital Project", writable: ["a \"b\""], readOnly: ["a \"b\"/.git"] });
  const fs = args[args.indexOf("-c", 2) + 1];
  t.check("profile: cả máy chỉ đọc + thư mục tạm ghi được", fs.includes('":root"="read"') && fs.includes('":tmpdir"="write"'), true);
  t.check("...đường có dấu cách và ngoặc kép được escape", fs.includes('"/x/Digital Project/a \\"b\\""="write"'), true);
  t.check("...readOnly trong vùng ghi", fs.includes('"/x/Digital Project/a \\"b\\"/.git"="read"'), true);
  t.check("...mạng mở như trước", args.at(-1).includes("enabled=true"), true);
  t.check("workspace tự khai chỉ đọc (dưới /tmp không bị quyền thư mục tạm phủ)", codexProfileArgs({ workspace: "/w", writable: ["r"] }).join(" ").includes('"/w"="read"'), true);
}

// --- seatbelt thật: chặn ngoài vùng, chặn readOnly trong vùng ------------------------------
if (existsSync(SEATBELT)) {
  const dir = mkdtempSync(join(tmpdir(), "wsbx-sb-"));
  mkdirSync(join(dir, "ok", "locked"), { recursive: true });
  mkdirSync(join(dir, "other"));
  const prof = writeFile(join(dir, "p.sb"), seatbeltProfile({ workspace: dir, writable: ["ok"], readOnly: ["ok/locked"] }));
  const sh = (cmd) => spawnSync(SEATBELT, ["-f", prof, "/bin/sh", "-c", cmd], { cwd: dir, encoding: "utf8" });
  sh("touch ok/a; touch other/b; touch ok/locked/c; python3 -c \"open('other/d','w')\" 2>/dev/null; true");
  t.check("seatbelt: ghi trong vùng được", existsSync(join(dir, "ok", "a")), true);
  t.check("...shell ghi ngoài vùng bị chặn", existsSync(join(dir, "other", "b")), false);
  t.check("...python ghi ngoài vùng bị chặn", existsSync(join(dir, "other", "d")), false);
  t.check("...readOnly trong vùng bị chặn", existsSync(join(dir, "ok", "locked", "c")), false);
  t.check("probeSeatbelt đạt trên máy này", probeSeatbelt().ok, true);
}

// --- tự thử của Codex: không chặn được thì báo không đạt ----------------------------------
{
  const saved = process.env.PATH;
  process.env.PATH = `${FIXTURE_BIN}:${saved}`;
  const loose = probeCodexProfile();
  process.env.FAKE_SANDBOX = "enforce";
  const strict = probeCodexProfile();
  delete process.env.FAKE_SANDBOX;
  process.env.PATH = saved;
  t.check("probe Codex: profile không chặn → không đạt, nói rõ", `${loose.ok}/${/KHÔNG bị chặn/.test(loose.reason)}`, "false/true");
  t.check("probe Codex: chặn đúng → đạt", strict.ok, true);
}

// --- codex-run: có sổ + probe đạt → profile thay --sandbox, sổ ghi vùng --------------------
function codexJob(s, { mode = "argvdump", extra = [], e = {} } = {}) {
  const ev = readManifest(s.manifestPath).jobs[0].evidence;
  const p = spawnSync("node", [CODEX, "--manifest", s.manifestPath, "--job", "1", "--prompt-file", s.brief, "--evidence", ev,
    "--workspace", s.ws, "--timeout", "60s", ...extra], {
    encoding: "utf8", env: env({ FAKE_MODE: mode, FAKE_EVIDENCE: join(s.ws, ev), ...e }), timeout: 90_000,
  });
  return { exit: p.status, err: p.stderr ?? "", body: existsSync(join(s.ws, ev)) ? readFileSync(join(s.ws, ev), "utf8") : "" };
}
{
  const s = newRun([{ ev: "c-1.md", allow: ["src/"] }]);
  const r = codexJob(s, { e: { FAKE_SANDBOX: "enforce" } });
  const job = readManifest(s.manifestPath).jobs[0];
  t.check("codex có sandbox: job chạy", r.exit, 0);
  t.check("...argv có profile của crew", /default_permissions="crew-job"/.test(r.body), true);
  t.check("...không còn --sandbox workspace-write", /--sandbox/.test(r.body), false);
  t.check("...không còn cờ mạng cũ (profile tự mở mạng)", /network_access/.test(r.body), false);
  t.check("...sổ ghi kind + vùng ghi", `${job.writeSandbox?.kind}/${job.writeSandbox?.writable?.join(",")}`, "codex-permissions/tasks/t,src");

  const b = newRun([{ ev: "c-1.md" }]);
  codexJob(b, { mode: "briefdump", e: { FAKE_SANDBOX: "enforce" } });
  t.check("...brief nói với worker vùng ghi bị khoá", readFileSync(join(b.ws, RUN_REL, "c-1.md"), "utf8").includes(WRITE_LOCK_LINE), true);

  const mcp = newRun([{ ev: "c-1.md" }]);
  codexJob(mcp, { mode: "mcp_call", e: { FAKE_SANDBOX: "enforce" } });
  t.check("job gọi MCP: sổ ghi sandboxBypass (MCP nằm ngoài profile)", (readManifest(mcp.manifestPath).jobs[0].sandboxBypass ?? []).join(","), "node_repl.js");

  const resume = newRun([{ ev: "c-1.md" }]);
  const rr = codexJob(resume, { mode: "thread", extra: ["--resume", "01a04169-2763-79d1-9037-6dc85981fad1"], e: { FAKE_SANDBOX: "enforce" } });
  t.check("resume: profile đứng SAU `resume <id>` (đứng trước thì Codex bỏ -c)",
    /resume 01a04169-2763-79d1-9037-6dc85981fad1 -c default_permissions=/.test(rr.body), true);
}
{
  const s = newRun([{ ev: "c-1.md" }]);
  const r = codexJob(s);
  const job = readManifest(s.manifestPath).jobs[0];
  t.check("probe không đạt: chạy như cũ (--sandbox workspace-write)", /--sandbox workspace-write/.test(r.body), true);
  t.check("...sổ ghi kind null + lý do", `${job.writeSandbox?.kind}/${/tự thử chặn không đạt/.test(job.writeSandbox?.reason ?? "")}`, "null/true");
  t.check("...stderr nói collect sẽ đoán như cũ", /không có sandbox ghi/.test(r.err), true);

  const d = newRun([{ ev: "c-1.md" }]);
  codexJob(d, { extra: ["--sandbox-mode", "danger-full-access"], e: { FAKE_SANDBOX: "enforce" } });
  t.check("danger-full-access: không khoá, sổ nói vì sao", /danger-full-access/.test(readManifest(d.manifestPath).jobs[0].writeSandbox?.reason ?? ""), true);

  const off = newRun([{ ev: "c-1.md" }]);
  const cfg = join(off.ws, "crew.config.json");
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), writeSandbox: false }));
  codexJob(off, { e: { FAKE_SANDBOX: "enforce" } });
  t.check("crew.config.json writeSandbox: false → không khoá", /writeSandbox: false/.test(readManifest(off.manifestPath).jobs[0].writeSandbox?.reason ?? ""), true);
}

// --- anti-run: seatbelt thật quanh agy giả ----------------------------------------------
if (existsSync(SEATBELT)) {
  const s = newRun([{ worker: "antigravity", ev: "a-1.md" }]);
  const ev = `${RUN_REL}/a-1.md`;
  const inside = join(s.ws, RUN_REL, "data.txt");
  const outside = join(s.ws, "plans", "x.md");
  mkdirSync(join(s.ws, "plans"));
  const p = spawnSync("node", [ANTI, "--manifest", s.manifestPath, "--job", "1", "--prompt-file", s.brief, "--evidence", ev,
    "--workspace", s.ws, "--timeout", "60s"], {
    encoding: "utf8", env: env({ FAKE_MODE: "write_outside", FAKE_EVIDENCE: join(s.ws, ev), FAKE_INSIDE: inside, FAKE_OUTSIDE: outside }), timeout: 90_000,
  });
  const job = readManifest(s.manifestPath).jobs[0];
  t.check("agy dưới seatbelt: job vẫn xong", `${p.status}/${job.status}`, "0/done");
  t.check("...ghi trong thư mục run được", existsSync(inside), true);
  t.check("...ghi ngoài vùng bị hệ điều hành chặn", existsSync(outside), false);
  t.check("...sổ ghi kind seatbelt", job.writeSandbox?.kind, "seatbelt");
  t.check("...sổ ghi đường bị chặn", (job.sandboxDenied ?? []).some((x) => x.endsWith("plans/x.md")), true);
  t.check("...stderr gợi ý crew amend --allow", /crew amend .* --job 1 --allow/.test(p.stderr), true);
}

// --- collect: job đã sandbox không bị tính file ngoài vùng --------------------------------
{
  const s = newRun([{ ev: "g-1.md" }]);
  const now = Date.now();
  updateJob(s.manifestPath, 1, { status: "done", startedAt: new Date(now - 60_000).toISOString(), endedAt: new Date(now).toISOString() });
  const foreign = writeFile(join(s.ws, "plans", "other-session.md"), "của session khác\n");
  utimesSync(foreign, new Date(now - 30_000), new Date(now - 30_000));
  const before = collectWriteScope(readManifest(s.manifestPath), { workspace: s.ws });
  t.check("không sandbox: file session khác bị tính vi phạm (cách cũ)", before.outOfScope.some((x) => x.path === "plans/other-session.md"), true);
  updateJob(s.manifestPath, 1, { writeSandbox: { kind: "seatbelt", ...writeScopeFor(readManifest(s.manifestPath), 1) } });
  const after = collectWriteScope(readManifest(s.manifestPath), { workspace: s.ws });
  t.check("có sandbox: không còn vi phạm", after.outOfScope.length, 0);
  // Sổ do crew ghi (không phải worker) cũng nằm ngoài vùng ghi của worker: chỉ đọc với nó.
  const env = writeFile(join(s.ws, ".env"), "X=1\n");
  utimesSync(env, new Date(now - 20_000), new Date(now - 20_000));
  const guard = collectWriteScope(readManifest(s.manifestPath), { workspace: s.ws });
  t.check("file bảo vệ đổi trong lúc job sandbox chạy: vẫn bị tính, không bị loại", guard.protectedHits.some((x) => x.path === ".env"), true);
  rmSync(env);
  updateJob(s.manifestPath, 1, { sandboxBypass: ["node_repl.js"] });
  const bypass = collectWriteScope(readManifest(s.manifestPath), { workspace: s.ws });
  t.check("job đã gọi MCP: collect thôi tin sandbox, đoán theo giờ như cũ", bypass.outOfScope.some((x) => x.path === "plans/other-session.md"), true);
  updateJob(s.manifestPath, 1, { sandboxBypass: undefined });
  t.check("...file vào mục sandboxExcluded", after.sandboxExcluded.map((x) => x.path).sort().join(","), `plans/other-session.md,${RUN_REL}/manifest.json`);
}

// --- claim lại xoá sandbox của lượt trước, trong khoá ------------------------------------
{
  const s = newRun([{ ev: "k-1.md" }]);
  updateJob(s.manifestPath, 1, { status: "failed", writeSandbox: { kind: "seatbelt", writable: ["tasks/t"] }, sandboxBypass: ["x.y"], sandboxDenied: ["a"] });
  claimRunSlot(s.manifestPath, 1, { startedAt: new Date().toISOString(), timeoutMs: 60_000 });
  const j = readManifest(s.manifestPath).jobs[0];
  t.check("claim lại: không còn writeSandbox/sandboxBypass/sandboxDenied của lượt trước", `${j.writeSandbox}/${j.sandboxBypass}/${j.sandboxDenied}`, "undefined/undefined/undefined");
}

// --- đọc chữ bị chặn -------------------------------------------------------------------
{
  const d = sandboxDenials('{"aggregated_output":"touch: other/r.txt: Operation not permitted\\n"} 2) patch rejected: writing outside of the project');
  t.check("sandboxDenials: path shell + apply_patch", `${d.paths.join(",")}/${d.patch}`, "other/r.txt/true");
  t.check("...dạng zsh (viết thường, path đứng sau)", sandboxDenials("zsh:1: operation not permitted: .crew/runs/x/manifest.json").paths.join(","), ".crew/runs/x/manifest.json");
  // 16/11: bộ test của dự án gọi sandbox-exec lồng và kill tiến trình con — bị Codex chặn
  // nhưng không phải chặn GHI; sổ ghi sandboxDenied ["sandbox_apply","ps"] và gợi ý `--allow`.
  const nonWrite = sandboxDenials("sandbox-exec: sandbox_apply: Operation not permitted\nps: Operation not permitted\ntouch: r.txt: Operation not permitted");
  t.check("...chữ không phải đường file (sandbox_apply, ps) không tính", nonWrite.paths.join(","), "r.txt");
  // 18/11: dạng zsh lọt bộ lọc trên — sổ job ghi sandboxDenied ["ps"] từ "zsh:1: operation not permitted: ps".
  t.check("...dạng zsh: chữ không phải đường file (ps) không tính", sandboxDenials("zsh:1: operation not permitted: ps\nzsh:1: operation not permitted: out/a.txt").paths.join(","), "out/a.txt");
}

process.exit(t.finish() ? 0 : 1);
