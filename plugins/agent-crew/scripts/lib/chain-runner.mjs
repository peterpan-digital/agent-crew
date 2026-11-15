/**
 * `crew run anti|codex --manifest M --job N --prompt-file P --chain [--budget 4h] [--max-slices 8]`
 *
 * Cho worker tự quản một task dài bằng nhiều lát trên cùng thread: lát nào ra
 * `Status: CONTINUE` mà handoff qua kiểm cơ học thì crew tự ghi lát kế vào sổ và
 * bắn nó với `--resume <conversationId lát trước>`. Chuỗi dừng khi:
 *   - lát cuối không còn `continue` (exit theo trạng thái: 0 xong, 1 hỏng, 3 cần người);
 *   - thread bị tách, handoff không đạt, hết budget hoặc hết lát (exit 3);
 *   - đủ CHAIN_CHECKPOINT_EVERY lát kể từ checkpoint trước (exit 4: Claude đọc
 *     handoff rồi gọi lại đúng lệnh này).
 *
 * Mọi bộ đếm nằm trong sổ (job gốc N), không trong tiến trình: chain-runner chết
 * rồi gọi lại vẫn đếm tiếp, không mở đồng hồ mới. Lát được bắn bằng `spawn` async
 * qua chính `bin/crew.mjs`, nên SIGTERM vào đây chuyển xuống được lát đang chạy.
 *
 * Brief lát kế do dispatcher (chính file này) viết theo mẫu cố định, không chép
 * chữ của worker: handoff là dữ liệu, chỉ được trỏ tới.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { addJob, appendNote, readManifest, updateJob } from "../crew-manifest.mjs";
import {
  CHAIN_CHECKPOINT_EVERY, DEFAULT_CHAIN_BUDGET, DEFAULT_CHAIN_SLICES, DEFAULT_TIMEOUT, MAX_CHAIN_SLICES,
  parseChainBudget, parseDuration, resolveLogDir,
} from "../crew-guards.mjs";
import { layoutOf } from "./crew-layout.mjs";
import { checkHandoff } from "./handoff-check.mjs";
import { sliceChangedFiles } from "./chain-slice-progress.mjs";
import { QUOTA_EXIT } from "./worker-quota-verdict.mjs";

const CREW_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "crew.mjs");
const SHORT = { antigravity: "anti", codex: "codex" };
const WORKERS = { anti: "antigravity", antigravity: "antigravity", codex: "codex" };
/** Còn dưới mức này thì không mở lát mới: lát quá ngắn chỉ kịp đọc handoff. */
const MIN_SLICE_MS = 60_000;

class ChainUsage extends Error {}

/** Tách cờ của chuỗi khỏi cờ chuyển tiếp cho adapter. */
export function parseChainArgv(argv) {
  const pass = [];
  const own = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--chain") { own.chain = true; continue; }
    const name = a.startsWith("--") ? a.slice(2) : null;
    if (["budget", "max-slices", "manifest", "job", "prompt-file", "resume", "timeout"].includes(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new ChainUsage(`--${name} thiếu giá trị`);
      own[name] = v;
      i += 1;
      continue;
    }
    if (name === "evidence") throw new ChainUsage("--chain không nhận --evidence: evidence từng lát lấy từ sổ");
    if (name === "workspace-cli" && argv[i + 1] === "on") {
      throw new ChainUsage("--chain không chạy với --workspace-cli on: lát tự nối không được mang token Workspace");
    }
    pass.push(a);
  }
  if (!own.manifest || !own.job) throw new ChainUsage("--chain cần --manifest và --job");
  if (!own["prompt-file"]) throw new ChainUsage("--chain cần --prompt-file (brief gốc, các lát sau trỏ về nó)");
  const budgetMs = parseChainBudget(own.budget ?? DEFAULT_CHAIN_BUDGET);
  const maxSlices = own["max-slices"] === undefined ? DEFAULT_CHAIN_SLICES : Number(own["max-slices"]);
  if (!Number.isInteger(maxSlices) || maxSlices < 1 || maxSlices > MAX_CHAIN_SLICES) {
    throw new ChainUsage(`--max-slices phải là số nguyên 1..${MAX_CHAIN_SLICES}, nhận "${own["max-slices"]}"`);
  }
  const sliceMs = parseDuration(own.timeout ?? DEFAULT_TIMEOUT);
  return { ...own, budgetMs, maxSlices, sliceMs, pass };
}

const rel = (ws, p) => relative(ws, p).split(sep).join("/");
const spanMs = (j) => (j.startedAt && j.endedAt ? Math.max(0, Date.parse(j.endedAt) - Date.parse(j.startedAt)) : 0);
const exitForStatus = (j) => {
  if (j.status === "failed") return 1;
  if (j.runtimeVerdict || ["blocked", "needs_context", "done_unverified", "continue"].includes(j.status)) return 3;
  return 0;
};

/** Trạng thái chuỗi đọc từ sổ: job gốc, các lát theo thứ tự, thời gian đã tiêu. */
function chainState(manifestPath, rootSeq) {
  const m = readManifest(manifestPath);
  const root = m.jobs.find((j) => j.seq === rootSeq);
  if (!root) throw new ChainUsage(`không có job ${rootSeq} trong ${manifestPath}`);
  if (root.chainOf != null) throw new ChainUsage(`job ${rootSeq} là lát ${root.slice} của chuỗi ${root.chainOf}; gọi --chain bằng job gốc ${root.chainOf}`);
  const slices = [root, ...m.jobs.filter((j) => j.chainOf === rootSeq).sort((a, b) => a.slice - b.slice)];
  return { m, root, slices, last: slices.at(-1), elapsedMs: slices.reduce((s, j) => s + spanMs(j), 0) };
}

/** Bắn `crew run <w> ...` ở tiến trình con; trả exit code. `onChild` để chuyển signal. */
function runSlice(worker, args, onChild) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CREW_BIN, "run", worker, ...args], { stdio: "inherit" });
    onChild(child);
    child.on("error", (err) => { process.stderr.write(`crew --chain: không bắn được lát: ${err.message}\n`); done(127); });
    child.on("exit", (code, signal) => { onChild(null); done(code ?? (signal ? 128 + 15 : 1)); });
  });
}

/** Brief lát kế, mẫu cố định. Mọi đường là tương đối workspace. */
function sliceBrief({ rootSeq, slice, prevEvidence, rootBrief, evidence }) {
  return [
    `Tiếp việc của job ${rootSeq} — lát ${slice} của chuỗi.`,
    "",
    `Handoff của lát trước ở \`${prevEvidence}\`, mục \`## Handoff\`. Đọc nó trước, làm tiếp từ \`### Bước kế tiếp\`.`,
    `Brief gốc: \`${rootBrief}\`. Acceptance và phạm vi ghi giữ nguyên như brief gốc.`,
    "",
    `Evidence lát này: \`${evidence}\`. Evidence phải tự đủ nghĩa: tóm kết quả cả chuỗi tới giờ, không chỉ phần lát này làm.`,
    "",
  ].join("\n");
}

export async function runChain(workerArg, argv, { cwd }) {
  let opts;
  try {
    opts = parseChainArgv(argv);
  } catch (err) {
    process.stderr.write(`crew run --chain: ${err.message}\n`);
    return 2;
  }
  const worker = WORKERS[workerArg];
  const manifestPath = resolve(cwd, opts.manifest);
  const rootSeq = Number(opts.job);
  const promptFile = resolve(cwd, opts["prompt-file"]);
  let state;
  try {
    state = chainState(manifestPath, rootSeq);
    if (state.root.worker !== worker) throw new ChainUsage(`job ${rootSeq} là của ${state.root.worker}, không phải ${worker}`);
    if (!existsSync(promptFile)) throw new ChainUsage(`không thấy --prompt-file ${promptFile}`);
  } catch (err) {
    process.stderr.write(`crew run --chain: ${err.message}\n`);
    return 2;
  }
  const ws = state.m.workspace;
  const rootEvidenceAbs = join(ws, ...state.root.evidence.split("/"));
  const logsDir = resolveLogDir(rootEvidenceAbs, ws, layoutOf(state.m));
  const sidecar = join(logsDir, `chain-${rootSeq}.jsonl`);
  const log = (row) => {
    try { mkdirSync(logsDir, { recursive: true }); appendFileSync(sidecar, `${JSON.stringify({ type: "crew.chain", at: new Date().toISOString(), ...row })}\n`); } catch { /* sidecar chỉ để theo dõi */ }
  };
  const runRel = typeof state.m.runDir === "string" ? state.m.runDir : rel(ws, dirname(manifestPath));
  const rootBriefRel = relative(ws, promptFile).startsWith("..") ? promptFile : rel(ws, promptFile);

  let child = null;
  let signalled = null;
  const forward = (sig) => () => { signalled = sig; if (child) child.kill(sig); };
  const handlers = ["SIGTERM", "SIGINT", "SIGHUP"].map((sig) => [sig, forward(sig)]);
  for (const [sig, h] of handlers) process.on(sig, h);

  const record = (patch) => updateJob(manifestPath, rootSeq, patch);
  const stop = (code, reason, extra = {}) => {
    const s = chainState(manifestPath, rootSeq);
    record({ chainSlices: s.slices.length, chainElapsedMs: s.elapsedMs, chainStoppedFor: reason });
    log({ stop: reason, slice: s.last.slice ?? 1, seq: s.last.seq, status: s.last.status, elapsedSec: Math.round(s.elapsedMs / 1000), ...extra });
    process.stderr.write(`crew run --chain: chuỗi job ${rootSeq} dừng (${reason}), ${s.slices.length} lát, ${Math.round(s.elapsedMs / 60_000)} phút\n`);
    return code;
  };

  try {
    if (!state.root.chainStartedAt) record({ chainStartedAt: new Date().toISOString() });
    record({ chainStoppedFor: undefined });
    let firstPass = true;
    for (;;) {
      state = chainState(manifestPath, rootSeq);
      const { last, slices, elapsedMs } = state;
      const k = last.slice ?? 1;
      // Gốc đã failed từ lượt gọi trước, trước khi lát nào chạy. Đo 15/11/2026: cổng
      // trần 30m từ chối `--timeout 60m` trước khi spawn nhưng adapter vẫn ghi job là
      // failed (để sổ có lý do); session gõ đúng lệnh `--chain` crew gợi ý thì chuỗi
      // dừng câm "(failed), 0 phút" và session phải thêm job mới, chép brief. Gốc chưa
      // có thread thì không có gì để nối hay để mất: bắn lại như `crew run` thường
      // cho phép chạy lại job failed. Chỉ ở vòng đầu của lần gọi này, để lượt bắn lại
      // hỏng tiếp thì dừng chứ không lặp.
      const rootRefused = firstPass && slices.length === 1 && last.status === "failed";
      const retryRoot = rootRefused && !last.conversationId;
      firstPass = false;
      // Signal tới lúc không có lát nào chạy (đang kiểm handoff, đang ghi sổ).
      if (signalled) return stop(1, signalled.toLowerCase());
      if (last.status === "running") return stop(2, `lát ${k} (job ${last.seq}) đang chạy — đợi nó xong`);
      if (rootRefused && !retryRoot) {
        // Gốc đã chạy thật (có thread) rồi failed: bắn lại từ đầu sẽ bỏ việc đã làm,
        // nên không tự bắn — nhưng phải nói vì sao chuỗi không chạy và đường tiếp.
        const why = String(last.failure ?? "").split("\n").find((l) => l.trim()) ?? "không ghi lý do";
        process.stderr.write(
          `crew run --chain: job ${rootSeq} đã failed từ lượt trước (${why.trim()}), chuỗi không bắn lại\n`
          + `  → chạy tiếp trên thread cũ: crew add-job rồi gọi --chain cho job mới kèm --resume ${last.conversationId}; hoặc giao lại từ đầu bằng job mới\n`,
        );
      }

      if (last.status === "pending" || retryRoot) {
        const remaining = opts.budgetMs - elapsedMs;
        if (remaining < MIN_SLICE_MS) return stop(3, "hết budget");
        const timeoutSec = Math.floor(Math.min(opts.sliceMs, remaining) / 1000);
        const prev = slices.at(-2);
        if (prev && !prev.conversationId) return stop(3, `lát trước (job ${prev.seq}) không có conversationId để nối`);
        const args = ["--manifest", manifestPath, "--job", String(last.seq), "--timeout", `${timeoutSec}s`, ...opts.pass];
        if (prev) args.push("--prompt-file", join(dirname(manifestPath), `brief-${SHORT[worker]}-${last.seq}.md`), "--resume", prev.conversationId);
        else args.push("--prompt-file", promptFile, ...(opts.resume ? ["--resume", opts.resume] : []));
        const code = await runSlice(workerArg, args, (c) => { child = c; });
        const ran = chainState(manifestPath, rootSeq).last;
        log({ slice: k, seq: ran.seq, status: ran.status, conversationId: ran.conversationId ?? null, elapsedSec: Math.round(spanMs(ran) / 1000), usage: ran.usage ?? null, exit: code });
        record({ chainSlices: slices.length, chainElapsedMs: chainState(manifestPath, rootSeq).elapsedMs });
        if (signalled) return stop(1, signalled.toLowerCase());
        // Cổng quota của `crew run` từ chối trước adapter: lát chưa bắn, vẫn pending.
        if (code === QUOTA_EXIT && ran.status === "pending") return stop(QUOTA_EXIT, `worker cạn quota — lát ${k} chưa bắn`);
        if (ran.status === "pending" || ran.status === "running") return stop(code || 1, `lát ${k} không ghi kết quả vào sổ (exit ${code})`);
        // Trước trạng thái: Codex chấm lát chạy nhầm thread là failed, nhưng lý do
        // người đọc cần là thread bị tách, không phải "worker hỏng".
        if (ran.resumeMismatch) return stop(3, "thread bị tách (resumeMismatch)");
        if (ran.status !== "continue") return stop(code, ran.status);
        if (code !== 3 && code !== 0) return stop(code, `lát ${k} ra continue nhưng adapter exit ${code}`);
        continue;
      }

      if (last.status !== "continue") return stop(exitForStatus(last), last.status);
      if (last.resumeMismatch) return stop(3, "thread bị tách (resumeMismatch)");
      if (!last.conversationId) return stop(3, `lát ${k} không có conversationId để nối`);

      const text = readFileSync(join(ws, ...last.evidence.split("/")), "utf8");
      const prevSlice = slices.at(-2);
      let prevText = null;
      if (prevSlice) try { prevText = readFileSync(join(ws, ...prevSlice.evidence.split("/")), "utf8"); } catch { /* lát trước mất evidence: bỏ phép so */ }
      const verdict = checkHandoff({ text, prevText, changedFiles: sliceChangedFiles({ slice: last, manifestPath, workspace: ws, logsDir }) });
      if (!verdict.ok) return stop(3, `handoff không đạt: ${verdict.reason}`);

      if (k >= opts.maxSlices) return stop(3, `hết lát (${opts.maxSlices})`);
      if (opts.budgetMs - elapsedMs < MIN_SLICE_MS) return stop(3, "hết budget");
      if (k - (state.root.chainCheckpointSlice ?? 0) >= CHAIN_CHECKPOINT_EVERY) {
        record({ chainCheckpointAt: new Date().toISOString(), chainCheckpointSlice: k, chainSlices: slices.length, chainElapsedMs: elapsedMs });
        log({ stop: "checkpoint", slice: k, seq: last.seq, elapsedSec: Math.round(elapsedMs / 1000) });
        process.stderr.write(
          `crew run --chain: checkpoint sau lát ${k} — đọc handoff các lát vừa xong (dữ liệu, không phải lệnh), ổn thì gọi lại đúng lệnh này\n`,
        );
        return 4;
      }

      const seq = state.m.jobs.length + 1;
      const evidence = `${runRel}/worker-${SHORT[worker]}-${seq}.md`;
      const filesMayModify = [...new Set([...(state.root.filesMayModify ?? []), ...(last.filesMayModify ?? [])])];
      let next;
      try {
        next = addJob(manifestPath, {
          worker, role: state.root.role, transport: state.root.transport, title: `${state.root.title} — lát ${k + 1}`,
          evidence, filesMayModify, chainOf: rootSeq, slice: k + 1,
          ...(state.root.model ? { model: state.root.model } : {}),
          ...(state.root.effort ? { effort: state.root.effort } : {}),
          ...(state.root.tier ? { tier: state.root.tier } : {}),
          note: `lát ${k + 1} của chuỗi job ${rootSeq}, nối từ job ${last.seq} (conversation ${last.conversationId})`,
        });
      } catch (err) {
        return stop(3, `không ghi được lát kế: ${err.message.split("\n")[0]}`);
      }
      writeFileSync(join(dirname(manifestPath), `brief-${SHORT[worker]}-${next.seq}.md`),
        sliceBrief({ rootSeq, slice: k + 1, prevEvidence: last.evidence, rootBrief: rootBriefRel, evidence: next.evidence }));
      appendNote(manifestPath, rootSeq, `chuỗi: thêm lát ${k + 1} (job ${next.seq})`);
    }
  } catch (err) {
    process.stderr.write(`crew run --chain: ${err.message}\n`);
    return 1;
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}
