#!/usr/bin/env node
/**
 * Hàng chờ quyết định của một run, ghi bằng lệnh thay vì sửa tay manifest.
 *
 *   crew-hold.mjs <manifest> list
 *   crew-hold.mjs <manifest> add --seq N --question "..." [--option "..."]...
 *   crew-hold.mjs <manifest> answer <id> --words "<câu owner gõ>" --outcome drop|resume [--via chat]
 *   crew-hold.mjs <manifest> defer <id> --until YYYY-MM-DD --words "..."
 *   crew-hold.mjs <manifest> cover <id> --by <seq>
 *
 * Hai rào ở đây là rào PHỤ. Đo 01/10: `MWG_CREW_ROLE` không tới được worker của
 * Antigravity app, nên "từ chối dưới vai worker" chỉ chặn được worker headless. Rào
 * chính là điều kiện của dữ liệu: mọi lệnh ghi bị từ chối khi run còn job
 * pending/running (kiểm trong lock, cùng lock với claim), cộng vân tay `holds`
 * mà adapter so lại ở mọi đường thoát.
 *
 * Exit: 0 = xong | 2 = sai cú pháp hoặc bị từ chối.
 */
import { readManifest, updateManifest } from "./crew-manifest.mjs";
import { addDecisionHold, answerHold, coverHold, deferHold, HoldError } from "./lib/holds.mjs";

const WITH_VALUE = new Set(["--seq", "--question", "--words", "--outcome", "--via", "--until", "--by"]);
const REPEATABLE = new Set(["--option"]);
const COMMANDS = new Set(["list", "add", "answer", "defer", "cover"]);

function parseArgs(argv) {
  const opts = { values: new Map(), lists: new Map(), positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (WITH_VALUE.has(a) || REPEATABLE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new HoldError(`${a} thiếu giá trị`);
      if (REPEATABLE.has(a)) opts.lists.set(a, [...(opts.lists.get(a) ?? []), v]);
      else opts.values.set(a, v);
      i += 1;
    } else if (a.startsWith("--")) {
      throw new HoldError(`cờ lạ: ${a}`);
    } else opts.positional.push(a);
  }
  return opts;
}

function intFlag(opts, name) {
  const raw = opts.values.get(name);
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n)) throw new HoldError(`${name} cần số nguyên, nhận ${JSON.stringify(raw ?? null)}`);
  return n;
}

const USAGE =
  "usage: crew-hold.mjs <manifest.json> list\n" +
  "       crew-hold.mjs <manifest.json> add --seq N --question \"...\" [--option \"...\"]...\n" +
  "       crew-hold.mjs <manifest.json> answer <id> --words \"<câu owner gõ>\" --outcome drop|resume [--via chat]\n" +
  "       crew-hold.mjs <manifest.json> defer <id> --until YYYY-MM-DD --words \"...\"\n" +
  "       crew-hold.mjs <manifest.json> cover <id> --by <seq>\n" +
  "exit: 0 = xong | 2 = sai cú pháp hoặc bị từ chối";

function list(manifestPath) {
  const holds = readManifest(manifestPath).holds ?? [];
  if (!holds.length) return console.log("không có hold nào");
  console.log("| id | loại | job | trạng thái | câu hỏi |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const h of holds) {
    const state = h.status === "answered"
      ? `answered/${h.answer?.outcome}${h.coveredBy != null ? ` (cover ${h.coveredBy})` : ""}`
      : h.status === "deferred" ? `deferred tới ${h.until}` : h.status;
    const options = h.options?.length ? ` [${h.options.join(" | ")}]` : "";
    console.log(`| ${h.id} | ${h.kind} | ${h.seq} | ${state} | ${h.question}${options} |`);
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  const [manifestPath, cmd, id, ...extra] = opts.positional;
  if (!manifestPath || !COMMANDS.has(cmd)) throw new HoldError(USAGE);
  if (extra.length) throw new HoldError(`thừa tham số: ${extra.join(" ")}`);
  const needsId = cmd === "answer" || cmd === "defer" || cmd === "cover";
  if (needsId !== (id !== undefined)) throw new HoldError(needsId ? `${cmd} cần <id> của hold` : `${cmd} không nhận <id>`);

  if (cmd === "list") return list(manifestPath);

  const now = new Date();
  let done;
  updateManifest(manifestPath, (m) => {
    if (cmd === "add") {
      const h = addDecisionHold(m, {
        seq: intFlag(opts, "--seq"), question: opts.values.get("--question"), options: opts.lists.get("--option") ?? [],
      }, now);
      done = `đã tạo hold ${h.id} (decision) cho job ${h.seq}`;
    } else if (cmd === "answer") {
      const h = answerHold(m, id, {
        words: opts.values.get("--words"), outcome: opts.values.get("--outcome"), via: opts.values.get("--via") ?? "chat",
      }, now);
      done = `đã ghi câu trả lời cho ${h.id}: ${h.answer.outcome}`
        + (h.kind === "cost_gate" && h.answer.outcome === "resume" ? `\n  → resume xong thì nối job: cover ${h.id} --by <seq job resume>` : "");
    } else if (cmd === "defer") {
      const h = deferHold(m, id, { until: opts.values.get("--until"), words: opts.values.get("--words") }, now);
      done = `đã hoãn ${h.id} tới ${h.until} (chỉ ẩn khỏi digest, gate vẫn chặn)`;
    } else {
      const h = coverHold(m, id, intFlag(opts, "--by"), now);
      done = `đã nối ${h.id} với job ${h.coveredBy}; collect sẽ tính lại verdict PASS của job đó`;
    }
    return m;
  });
  console.log(done);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    // Rào phụ, xem docblock. Chạy TRƯỚC khi đọc manifest: worker không cần thấy gì cả.
    if (process.env.MWG_CREW_ROLE === "worker") {
      throw new HoldError(
        "crew-hold từ chối chạy dưới MWG_CREW_ROLE=worker\n" +
        "  → hold là câu hỏi của owner; worker không trả lời hộ, và không được sửa hàng chờ của chính run mình",
      );
    }
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`crew-hold: ${err.message}`);
    process.exit(2);
  }
}
