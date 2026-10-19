#!/usr/bin/env node
/**
 * Hai câu hỏi Claude phải trả lời trước khi giao `@anti`/`@codex`, đọc thẳng từ
 * manifest thay vì nhớ:
 *
 *   run-for --task <dir> [--date YYMMDD]   run hôm nay của task còn nhận job không
 *                                          → in đường manifest, hoặc `new`
 *   latest  --task <dir> --worker anti|codex
 *                                          → conversation mới nhất của worker đó,
 *                                            để resume đúng chỗ thay vì đoán id
 *
 * `<dir>` là thư mục task hoặc work item: thư mục có `reports/crew-*`. Chỉ đọc,
 * không ghi gì. Id in ra luôn qua kiểm dạng: một id lạ đi thẳng vào `--resume`.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_JOBS, readManifest } from "./crew-manifest.mjs";

const WORKERS = { anti: "antigravity", antigravity: "antigravity", codex: "codex" };
const ID_SHAPE = /^[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$|^[0-9a-f]{16,64}$/i;

/** Mọi run đọc được của task, mới trước. Run hỏng bị bỏ qua chứ không làm hỏng lệnh. */
function runsOf(taskDir) {
  const reports = join(resolve(taskDir), "reports");
  if (!existsSync(reports)) return [];
  const out = [];
  for (const d of readdirSync(reports)) {
    if (!d.startsWith("crew-")) continue;
    const path = join(reports, d, "manifest.json");
    try { out.push({ path, m: readManifest(path) }); } catch { /* không phải run, hoặc hỏng */ }
  }
  return out.sort((a, b) => String(b.m.runId).localeCompare(String(a.m.runId)));
}

/** yymmdd theo giờ máy, cùng cách Bước 2 của seo-crew đặt `RUN_ID`. */
export function todayStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(now.getFullYear() % 100)}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/**
 * Run hôm nay còn mở của task: chưa viết report tổng, chưa qua cổng (exit 0), còn
 * dưới MAX_JOBS job. Run đã qua cổng là đã đóng sổ — nhét job mới vào là mở lại một
 * run người ta đã nghiệm thu. Không có thì `null` (CLI in `new`).
 */
export function runFor(taskDir, { date = todayStamp() } = {}) {
  if (!/^\d{6}$/.test(date)) throw new Error(`--date cần dạng YYMMDD, nhận "${date}"`);
  const open = runsOf(taskDir).find(({ m }) => String(m.runId).startsWith(`${date}-`)
    && !(m.reports?.length) && m.lastCollect?.exitCode !== 0 && (m.jobs?.length ?? 0) < MAX_JOBS);
  return open?.path ?? null;
}

/**
 * Conversation mới nhất của một worker trong mọi run của task. Bỏ job có
 * `resumeMismatch`: id của nó là phiên đã chạy, không phải phiên được xin, nên
 * resume vào đó là tiếp nhầm chỗ. Id sai dạng cũng bỏ, không in.
 */
export function latestConversation(taskDir, worker) {
  const name = WORKERS[worker];
  if (!name) throw new Error(`--worker cần anti|codex, nhận "${worker}"`);
  let best = null;
  for (const { path, m } of runsOf(taskDir)) {
    for (const j of m.jobs ?? []) {
      if (j.worker !== name || j.resumeMismatch || typeof j.conversationId !== "string" || !ID_SHAPE.test(j.conversationId)) continue;
      const at = Date.parse(j.startedAt ?? "") || 0;
      if (!best || at > best.at) {
        best = { at, conversationId: j.conversationId, transport: j.transport ?? null, status: j.status, run: m.runId, seq: j.seq, title: j.title ?? null, manifest: path };
      }
    }
  }
  if (!best) return null;
  const { at, ...out } = best;
  return out;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!["--task", "--date", "--worker"].includes(k) || rest[i + 1] === undefined) throw new Error(`cờ lạ hoặc thiếu giá trị: ${k}`);
    opts[k.slice(2)] = rest[i + 1];
  }
  return { cmd, opts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { cmd, opts } = parseArgs(process.argv.slice(2));
    if (!opts.task) throw new Error("thiếu --task <thư mục task hoặc work item>");
    if (cmd === "run-for") {
      console.log(runFor(opts.task, opts.date ? { date: opts.date } : {}) ?? "new");
    } else if (cmd === "latest") {
      const hit = latestConversation(opts.task, opts.worker);
      if (!hit) { console.log("chưa có conversation"); process.exit(1); }
      console.log(JSON.stringify(hit));
    } else {
      throw new Error("usage: crew-session.mjs run-for --task <dir> [--date YYMMDD] | latest --task <dir> --worker anti|codex");
    }
  } catch (err) {
    console.error(`crew-session: ${err.message}`);
    process.exit(2);
  }
}
