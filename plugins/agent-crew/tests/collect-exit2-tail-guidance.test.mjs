#!/usr/bin/env node
/**
 * Đuôi output của `crew collect` khi exit 2 phải nói vi phạm gì và gỡ bằng lệnh nào.
 *
 * Vì sao (đo 21/11/2026): run Codex sandbox chỉ ghi được `products/_shared/listing-kit`,
 * trong lúc nó chạy một session khác sửa ba file `.claude|.agents|.codex/skills/...`.
 * File bảo vệ cố ý không được loại theo sandbox, nên collect tính cho job và exit 2
 * — đúng. Nhưng khối "GHI VÀO FILE ĐƯỢC BẢO VỆ" không chỉ cách gỡ (`--not-ours` vẫn
 * dùng được), không nói job đã sandbox không ghi tới đó, và dòng cuối chỉ nói chung
 * "có vi phạm phạm vi ghi, trùng evidence, kho credential bị đổi hoặc holds bị sửa".
 * Session đọc `| tail -15` nên chỉ thấy danh sách file "không tính", báo owner "mọi
 * bước kiểm đều qua" và bỏ run kẹt exit 2.
 *
 * Run: node plugins/agent-crew/tests/collect-exit2-tail-guidance.test.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { addJob, createRun, updateJob } from "../scripts/crew-manifest.mjs";
import { MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("collect-exit2-tail-guidance");
const CLI = join(MODULE_ROOT, "scripts", "crew-collect.mjs");
const RUN_REL = join("tasks", "t", "reports", "crew-test");
const DONE = "work\n\nStatus: DONE\nSummary: ok\n";

function cli(manifestPath, args = []) {
  const p = spawnSync("node", [CLI, manifestPath, ...args], { encoding: "utf8" });
  return { exit: p.status, out: p.stdout ?? "" };
}

/** Run một job đã xong; `sandboxed` thì job chỉ ghi được thư mục run. */
function newRun({ sandboxed }) {
  const ws = tmpWorkspace("exit2-tail-");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { manifestPath } = createRun({ runDir: join(ws, RUN_REL), runId: "test", task: "t", workspace: ws, depth: 0 });
  const ev = join(RUN_REL, "w1.md");
  addJob(manifestPath, { worker: "codex", role: "assist", title: "job", evidence: ev });
  writeFile(join(ws, ev), DONE);
  const now = Date.now();
  updateJob(manifestPath, 1, {
    status: "done",
    startedAt: new Date(now - 120_000).toISOString(),
    endedAt: new Date(now).toISOString(),
    ...(sandboxed ? { writeSandbox: { kind: "codex-permissions", writable: ["tasks/t"], readOnly: [join(RUN_REL, "manifest.json")] } } : {}),
  });
  // Session khác sửa skill của repo trong lúc job chạy.
  const skill = writeFile(join(ws, ".claude", "skills", "x", "SKILL.md"), "sửa bởi session khác\n");
  utimesSync(skill, new Date(now - 60_000), new Date(now - 60_000));
  return { manifestPath };
}

// --- job đã sandbox: file bảo vệ vẫn chặn (đúng thiết kế) nhưng output chỉ đường ---
{
  const { manifestPath } = newRun({ sandboxed: true });
  const r = cli(manifestPath, ["--dry-run"]);
  t.check("file bảo vệ đổi trong lúc job sandbox chạy: vẫn exit 2", r.exit, 2);
  const tail = r.out.trimEnd().split("\n").slice(-6).join("\n");
  t.check("...6 dòng cuối nêu đúng loại vi phạm (file bảo vệ) và path", /file bảo vệ/i.test(tail) && tail.includes(".claude/skills/x/SKILL.md"), true);
  t.check("...6 dòng cuối chỉ lệnh gỡ --not-ours", /--not-ours \.claude\/skills\/x\/SKILL\.md --reason/.test(tail), true);
  t.check("...khối file bảo vệ nói job đã sandbox không ghi được tới đó", /sandbox.*không ghi được tới đây/.test(r.out), true);
  const waived = cli(manifestPath, ["--dry-run", "--not-ours", ".claude/skills/x/SKILL.md", "--reason", "session khác sửa skill"]);
  t.check("...bác bằng --not-ours thì hết vi phạm", waived.exit, 0);
}

// --- job không sandbox: không được nói "không ghi được tới đây" ----------------------------
{
  const { manifestPath } = newRun({ sandboxed: false });
  const r = cli(manifestPath, ["--dry-run"]);
  t.check("job không sandbox: file bảo vệ exit 2", r.exit, 2);
  t.check("...không khẳng định worker không ghi được", /không ghi được tới đây/.test(r.out), false);
  t.check("...vẫn nêu loại vi phạm ở đuôi", /file bảo vệ/i.test(r.out.trimEnd().split("\n").slice(-6).join("\n")), true);
}

process.exit(t.finish() ? 0 : 1);
