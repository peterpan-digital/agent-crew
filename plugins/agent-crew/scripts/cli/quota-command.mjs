/**
 * `crew quota` và cổng quota của `crew run`.
 *
 * `crew quota [--worker anti|codex]`: in quota còn lại của từng worker, không tốn
 * token (cách đọc ở lib/worker-quota-readers.mjs).
 *
 * Cổng: `crew run anti|codex ...` đọc quota của đúng worker, đúng nhóm model của
 * job, trước khi gọi adapter. Cạn → exit 5, adapter không chạy, sổ không đổi, job
 * vẫn `pending`. Thấp hoặc không đọc được → cảnh báo trên stderr rồi bắn như
 * thường. Tắt cho một lệnh bằng `--quota-check off`, cho cả máy/test bằng
 * `CREW_QUOTA_CHECK=off`.
 */
import { resolve } from "node:path";
import { readManifest } from "../crew-manifest.mjs";
import { readAntiQuota, readCodexQuota } from "../lib/worker-quota-readers.mjs";
import { QUOTA_EXIT, describeGroup, quotaVerdict } from "../lib/worker-quota-verdict.mjs";
import { CliError, parseFlags } from "./run-commands.mjs";

const WORKERS = { anti: "antigravity", antigravity: "antigravity", codex: "codex" };
const READERS = { antigravity: readAntiQuota, codex: readCodexQuota };

const flagValue = (argv, name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Bỏ `--quota-check <v>` khỏi argv (adapter từ chối cờ lạ); trả giá trị của nó. */
export function takeQuotaFlag(argv) {
  const i = argv.indexOf("--quota-check");
  if (i < 0) return { argv, value: undefined };
  const value = argv[i + 1];
  if (value !== "on" && value !== "off") throw new CliError(`--quota-check nhận on|off, nhận "${value ?? ""}"`);
  return { argv: [...argv.slice(0, i), ...argv.slice(i + 2)], value };
}

/**
 * Model mà job sẽ chạy: `--model` trên lệnh (sau khi expandRunArgs đã lấy từ sổ),
 * không có thì model ghi trong sổ — job `--resume` không mang `--model`.
 */
export function runModel(argv, { cwd }) {
  const model = flagValue(argv, "model");
  if (model) return model;
  const mp = flagValue(argv, "manifest");
  const seq = flagValue(argv, "job");
  if (!mp || !seq) return null;
  try {
    return readManifest(resolve(cwd, mp)).jobs.find((j) => String(j.seq) === String(seq))?.model ?? null;
  } catch {
    return null;
  }
}

/** Job lớn: chuỗi lát (cờ --chain, hoặc sổ ghi job đang chạy chuỗi), hoặc effort high/xhigh. */
export function isBigJob(argv, { cwd }) {
  if (argv.includes("--chain")) return true;
  // Lát của --chain tới đây không mang cờ --chain; sổ ghi `chainStartedAt` cho job đó.
  let job = null;
  const mp = flagValue(argv, "manifest");
  const seq = flagValue(argv, "job");
  try {
    if (mp && seq) job = readManifest(resolve(cwd, mp)).jobs.find((j) => String(j.seq) === String(seq)) ?? null;
  } catch { /* không đọc được sổ: coi như job thường */ }
  if (job?.chainStartedAt) return true;
  return /^(high|xhigh)$/.test(String(flagValue(argv, "effort") ?? job?.effort ?? ""));
}

/**
 * Cổng của `crew run`. Trả `{ argv, refuse }`: argv đã bỏ `--quota-check`,
 * `refuse` là exit code khi phải dừng (null = bắn tiếp).
 */
export async function quotaGate(workerArg, argv, { cwd, env = process.env, readers = READERS, now } = {}) {
  let rest;
  let value;
  try {
    ({ argv: rest, value } = takeQuotaFlag(argv));
  } catch (err) {
    process.stderr.write(`crew run: ${err.message}\n`);
    return { argv, refuse: 2 };
  }
  if (value === "off" || (value === undefined && env.CREW_QUOTA_CHECK === "off")) return { argv: rest, refuse: null };
  const worker = WORKERS[workerArg];
  if (!worker) return { argv: rest, refuse: null };
  const quota = await readers[worker]();
  const v = quotaVerdict(quota, { model: runModel(rest, { cwd }), now, bigJob: isBigJob(rest, { cwd }) });
  if (v.message) process.stderr.write(`${v.message}\n`);
  return { argv: rest, refuse: v.level === "empty" ? QUOTA_EXIT : null };
}

export async function quota(argv, { readers = READERS, now = new Date() } = {}) {
  let flags;
  try {
    ({ flags } = parseFlags(argv, ["worker"]));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const only = flags.worker === undefined ? null : WORKERS[flags.worker];
  if (flags.worker !== undefined && !only) {
    process.stderr.write(`--worker phải là anti|codex, nhận "${flags.worker}"\n`);
    return 2;
  }
  const order = only ? [only] : ["codex", "antigravity"];
  const results = await Promise.all(order.map((w) => readers[w]()));
  const label = { codex: "codex", antigravity: "anti" };
  const out = [`crew quota (đọc lúc ${now.toTimeString().slice(0, 5)}, không tốn token)`];
  for (const q of results) {
    const head = `  ${label[q.worker].padEnd(6)}`;
    if (!q.ok) {
      out.push(`${head}không đọc được: ${q.error}`);
      continue;
    }
    q.groups.forEach((g, i) => out.push(`${i ? " ".repeat(head.length) : head}${describeGroup(g, now)}`));
    if (q.resetCredits > 0) out.push(`${" ".repeat(head.length)}${q.resetCredits} lượt reset miễn phí chưa dùng (bấm trong app/CLI Codex)`);
  }
  process.stdout.write(`${out.join("\n")}\n`);
  return results.some((q) => q.ok) ? 0 : 1;
}
