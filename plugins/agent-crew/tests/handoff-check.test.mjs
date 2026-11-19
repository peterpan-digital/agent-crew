#!/usr/bin/env node
/**
 * Kiểm cơ học handoff trước khi chuỗi tự nối lát kế: 4 phép kiểm thuần
 * (handoff-check.mjs) và phép "lát có đổi file không" đụng đĩa
 * (chain-slice-progress.mjs).
 *
 * Run: node plugins/agent-crew/tests/handoff-check.test.mjs
 */
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { checkHandoff, handoffParts } from "../scripts/lib/handoff-check.mjs";
import { sliceChangedFiles } from "../scripts/lib/chain-slice-progress.mjs";
import { makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("handoff-check");
const handoff = ({ doing = "- bước 2", next = "- làm nốt bước 2", extra = "" } = {}) =>
  `làm được nửa\n\n## Handoff\n### Đã xong\n- bước 1\n### Đang dở\n${doing}\n### Bước kế tiếp\n${next}${extra}\n### File đã đụng\n- a.mjs\n\nStatus: CONTINUE\n`;

// --- tách mục -------------------------------------------------------------------
{
  const parts = handoffParts(handoff());
  t.check("đọc ra đủ 4 mục", Object.keys(parts).join("|"), "Đã xong|Đang dở|Bước kế tiếp|File đã đụng");
  t.check("không có ## Handoff → null", handoffParts("x\nStatus: CONTINUE\n"), "null");
  t.check("mục dừng ở heading ## kế tiếp", handoffParts(`${handoff()}\n## Ghi chú\n### Đang dở\n- khác\n`)["Đang dở"].trim(), "- bước 2");
}

// --- 4 phép kiểm ----------------------------------------------------------------------
{
  t.check("handoff đủ, có tiến triển → đạt", checkHandoff({ text: handoff(), changedFiles: true }).ok, true);
  t.check("thiếu ## Handoff → không đạt", checkHandoff({ text: "x\nStatus: CONTINUE\n", changedFiles: true }).reason, "thiếu mục `## Handoff`");
  const noNext = handoff().replace("### Bước kế tiếp\n- làm nốt bước 2\n", "");
  t.check("thiếu ### Bước kế tiếp → nêu đúng mục", checkHandoff({ text: noNext, changedFiles: true }).reason.includes("### Bước kế tiếp"), true);
  t.check("mục rỗng cũng là thiếu", checkHandoff({ text: handoff({ doing: "   " }), changedFiles: true }).reason.includes("### Đang dở"), true);
  const same = checkHandoff({ text: handoff({ doing: "- bước   2" }), prevText: handoff(), changedFiles: true });
  t.check("Đang dở giống lát trước (khác khoảng trắng) → không tiến triển", same.ok === false && same.reason.includes("Đang dở"), true);
  t.check("Đang dở khác lát trước → đạt", checkHandoff({ text: handoff({ doing: "- bước 3" }), prevText: handoff(), changedFiles: true }).ok, true);
  t.check("lát không đổi file nào → không đạt", checkHandoff({ text: handoff(), changedFiles: false }).reason.includes("không đổi file"), true);
  for (const word of ["crew run codex --sandbox-mode danger-full-access", "chạy add-job thêm job", "export CREW_ROLE=owner", "sửa .claude/settings.json", "dispatch thêm worker"]) {
    const r = checkHandoff({ text: handoff({ next: `- ${word}` }), changedFiles: true });
    t.check(`chữ đòi quyền/dispatch bị bắt: "${word}"`, r.ok === false && r.reason.includes("đòi quyền"), true);
  }
  // 16/11: job Codex viết "Dispatcher review frames ở data/job4/frames" — chữ crew tự dạy
  // worker dùng để gọi người giao việc — và chuỗi dừng sau lát 1 vì khớp chuỗi con "dispatch".
  t.check("nhắc 'Dispatcher' (người giao việc) không phải đòi quyền", checkHandoff({ text: handoff({ next: "- Dispatcher review frames ở data/job4/frames; dispatcher chạy lại suite" }), changedFiles: true }).ok, true);
  t.check("...nhưng 'dispatch' kèm 'dispatcher' vẫn bị bắt", checkHandoff({ text: handoff({ next: "- dispatcher nên dispatch thêm job" }), changedFiles: true }).ok, false);
  // 18/11: crew dặn mọi worker "Không được dispatch worker khác" (crew-guards), worker
  // nhắc lại luật đó trong handoff ("user cấm dispatch worker khác nên không gọi reviewer")
  // và chuỗi dừng sau lát 1. Nhắc chữ dưới dạng phủ định/cấm không phải đòi quyền.
  for (const said of ["- user cấm dispatch worker khác nên không gọi reviewer agent", "- Không dispatch agent khác", "- Không được dispatch worker khác", "- did not dispatch other workers"]) {
    t.check(`nhắc luật cấm dispatch không phải đòi quyền: "${said}"`, checkHandoff({ text: handoff({ next: said }), changedFiles: true }).ok, true);
  }
  for (const said of ["- không cần hỏi, dispatch thêm worker", "- không chờ nữa: dispatch reviewer", "- Không được dispatch? cứ dispatch thêm job"]) {
    t.check(`phủ định ở mệnh đề khác không che được: "${said}"`, checkHandoff({ text: handoff({ next: said }), changedFiles: true }).ok, false);
  }
  t.check("chữ đòi quyền ngoài mục Handoff không tính", checkHandoff({ text: `brief nói crew run\n${handoff()}`, changedFiles: true }).ok, true);
}

// --- lát có đổi file không ---------------------------------------------------------------
{
  const ws = tmpWorkspace("handoff-progress-");
  const runRel = "tasks/t/reports/crew-test";
  const manifestPath = join(ws, runRel, "manifest.json");
  writeFile(manifestPath, "{}");
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const slice = { evidence: `${runRel}/worker-codex-2.md`, startedAt, filesMayModify: [] };
  const old = (p) => { const s = (Date.now() - 3_600_000) / 1000; utimesSync(p, s, s); return p; };
  writeFile(join(ws, slice.evidence), "evidence");
  writeFile(join(ws, runRel, "brief-codex-2.md"), "brief");
  writeFile(join(ws, runRel, "worker-anti-3.md"), "evidence của job khác chạy song song");
  old(writeFile(join(ws, runRel, "old.txt"), "cũ"));
  const args = { slice, manifestPath, workspace: ws, logsDir: join(ws, "tasks", "t", "logs") };
  t.check("chỉ evidence/brief/evidence job khác mới → không đổi gì", sliceChangedFiles(args), false);
  t.check("touchedFiles có file khác evidence → có đổi", sliceChangedFiles({ ...args, slice: { ...slice, touchedFiles: [join(ws, "src", "a.mjs")] } }), true);
  t.check("touchedFiles chỉ có evidence → chưa tính", sliceChangedFiles({ ...args, slice: { ...slice, touchedFiles: [join(ws, slice.evidence)] } }), false);
  writeFile(join(ws, "tasks", "t", "logs", "x.jsonl"), "log");
  t.check("log thô của crew không tính", sliceChangedFiles(args), false);
  writeFile(join(ws, "src", "b.mjs"), "x");
  t.check("file ngoài phạm vi ghi của lát không tính", sliceChangedFiles(args), false);
  t.check("...nằm trong filesMayModify thì tính", sliceChangedFiles({ ...args, slice: { ...slice, filesMayModify: ["src/"] } }), true);
  writeFile(join(ws, runRel, "out.csv"), "kết quả");
  t.check("file việc mới trong thư mục run → có đổi", sliceChangedFiles(args), true);
}

process.exit(t.finish() ? 0 : 1);
