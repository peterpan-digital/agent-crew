#!/usr/bin/env node
/**
 * The checks every crew worker must pass, regardless of which runtime executes
 * it. Antigravity uses them today; the Codex runner uses the same ones so a
 * "done" from either worker means the same thing.
 *
 * The central rule: a worker's own claim of success is not evidence. Only a
 * non-empty file inside the task folder is.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { loadCrewConfig } from "./lib/crew-config.mjs";
import { layoutOf, loadLayout, logDirRel } from "./lib/crew-layout.mjs";
import { WORKER_ROLE_ENV } from "./lib/crew-role.mjs";

// Ceilings come from skills/agent-crew/references/cost-gate.md; a runaway agent burns quota.
export const DEFAULT_TIMEOUT = "15m";
export const MAX_TIMEOUT_MS = 30 * 60_000;

/**
 * The brief ceiling, in bytes of UTF-8.
 *
 * The rule ("brief nói WHAT + NEED, không nói HOW") lived only in
 * worker-brief.md, and prose is a rule the dispatcher drifts on: of the 24
 * briefs written after the rule landed, 23 were under the cap and one was 2227
 * bytes -- written by the dispatcher who had just criticised long briefs. A
 * ceiling nothing measures is a preference.
 *
 * There is deliberately no override flag. An escape hatch the caller can flip
 * in the same breath is the same shape as the manifest guards that validated a
 * field and then let `extra` overwrite it. Over the cap means cut the HOW.
 *
 * Hai trần từ 2.2.1 (owner chốt 07/11). Trần cứng 2 KB làm dispatcher viết lại brief
 * ngay lúc bắn, và vòng viết lại đó tốn token Claude hơn chính mấy trăm byte thừa —
 * luật sinh ra để đỡ token lại đốt token. Giờ: trên BRIEF_SOFT_BYTES job vẫn chạy,
 * adapter ghi `briefBytes` + note vào sổ, collect gắn cờ `BRIEF DÀI` để còn thấy mà
 * chỉnh dần; trên MAX_BRIEF_BYTES mới từ chối — cỡ đó là đang kê thuật toán hộ worker
 * (ca 7,2 KB ngày 24/08). Vẫn không có cờ bỏ qua.
 */
export const BRIEF_SOFT_BYTES = 2048;
export const MAX_BRIEF_BYTES = 8192;

/**
 * Env vars a worker must never inherit, and must not be able to set for itself.
 *
 * KEYRING_BACKEND=file is the one that matters. On 09/09 a worker set it to
 * dodge a 401; the Workspace CLI then could not decrypt the credential store
 * with the Keychain key, decided the file was corrupt, and issued a delete for
 * it and the token cache. The Codex sandbox refused the writes. On 18/09 the
 * same deletion ran from outside a sandbox and succeeded -- the store was gone
 * and the owner had to re-authenticate from scratch.
 *
 * So this lives here, not in one adapter. Codex workers are sandboxed and
 * Antigravity workers are not, which makes the unsandboxed path the more
 * dangerous of the two; a guard that only covered Codex would cover the
 * safer one.
 */
export const STRIPPED_ENV = ["GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND"];

/**
 * Where the Workspace CLI keeps its credential store.
 *
 * Read from the env first so a non-default profile is still watched: a guard
 * that only ever looks at the default directory is blind on exactly the machine
 * whose setup is unusual.
 */
export const CREDENTIAL_STORE_DIR =
  process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR || join(homedir(), ".config", "gws");

/**
 * The two files in that store that a normal job never changes.
 *
 * `token_cache.json` is deliberately absent: it is rewritten on every token
 * refresh, so watching it would fire on the healthy path and teach everyone to
 * ignore the alarm. These two only change when someone re-authenticates by
 * hand -- or when something has gone wrong.
 */
export const IMMUTABLE_CREDENTIAL_FILES = ["credentials.enc", "client_secret.json"];

/**
 * Fingerprints the immutable half of the credential store.
 *
 * Synchronous on purpose: codex-run's signal handler gets no `await`, and the
 * job killed mid-flight is the one most worth fingerprinting.
 *
 * A missing file reads as `null` rather than an error, because deletion is the
 * exact incident this watches for. On 18/09 a worker decided the store was
 * corrupt and deleted it; outside a sandbox the delete succeeded and the owner
 * had to re-authenticate from scratch. A guard that threw on ENOENT would have
 * failed precisely then.
 */
export function snapshotCredentialStore(dir = CREDENTIAL_STORE_DIR) {
  const out = {};
  for (const name of IMMUTABLE_CREDENTIAL_FILES) {
    try {
      out[name] = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
    } catch (err) {
      out[name] = err.code === "ENOENT" ? null : `unreadable:${err.code}`;
    }
  }
  return out;
}

/**
 * True when the snapshot could not read a single file for a reason other than
 * absence -- so the guard is watching nothing and would report "clean".
 *
 * Without this the blind case is indistinguishable from a healthy one: both
 * ends of the job read the same error string, the diff is empty, and the gate
 * passes. A guard that cannot see has to say so rather than vouch.
 */
export function isWatchBlind(snapshot) {
  const values = IMMUTABLE_CREDENTIAL_FILES.map((f) => snapshot?.[f]);
  return values.length > 0
    && values.every((v) => typeof v === "string" && v.startsWith("unreadable:"));
}

/**
 * The watched directory as it should be recorded, with the home prefix folded
 * back to `~`.
 *
 * Manifests live in `reports/` and get committed, so writing the resolved path
 * would publish the OS username and home layout into git on every incident.
 * The tilde form still tells a reader which store was watched.
 */
export function displayCredentialDir(dir = CREDENTIAL_STORE_DIR) {
  const home = homedir();
  return dir === home ? "~" : dir.startsWith(home + "/") ? `~${dir.slice(home.length)}` : dir;
}

/**
 * What changed between two snapshots, as names and verbs only.
 *
 * The hashes deliberately do not travel any further than this comparison. The
 * manifest lives in `reports/` and gets committed, so a digest of
 * `client_secret.json` sitting in git would be a permanent oracle for checking
 * guesses at the secret -- bought for nothing, since detecting a change never
 * needed the value.
 */
export function diffCredentialStore(before, after) {
  if (!before || !after) return [];
  const changes = [];
  for (const name of IMMUTABLE_CREDENTIAL_FILES) {
    const a = before[name];
    const b = after[name];
    if (a === b) continue;
    const unreadable = (v) => typeof v === "string" && v.startsWith("unreadable:");
    // "unreadable" covers both directions. Going from a hash to an error, and
    // from an error to a hash, both mean the same thing: nobody knows whether
    // the bytes changed. Calling either one "modified" would send the reader
    // hunting for an edit that may never have happened.
    const change = unreadable(a) || unreadable(b) ? "unreadable"
      : a === null ? "created"
      : b === null ? "deleted"
      : "modified";
    changes.push({ file: name, change });
  }
  return changes;
}

/**
 * Removes the unsafe vars from an env object that is otherwise already built.
 *
 * Split from workerEnv on purpose: anti-run has never set MWG_CREW_ROLE itself
 * (its caller does, see the crew skill's SKILL.md, Bước 6), and quietly starting to set it here
 * would be a behaviour change smuggled in under a security fix.
 */
export function stripUnsafeEnv(env) {
  const out = { ...env };
  for (const name of STRIPPED_ENV) delete out[name];
  return out;
}

/** The env a Codex worker gets: the recursion guard, plus the strip. */
export function workerEnv(extra = {}) {
  return stripUnsafeEnv({ ...process.env, ...WORKER_ROLE_ENV, ...extra });
}

export class GuardError extends Error {
  constructor(message, detail) {
    super(detail ? `${message}\n  ${detail}` : message);
    this.name = "GuardError";
    this.detail = detail;
  }
}

/**
 * One gate for `--resume`, shared by both adapters.
 *
 * It exists because of a silent failure, not a missing feature. `--resume` was
 * accepted by anti-run's flag parser but read only on the app branch, so
 * `--mode headless --resume <id>` parsed fine, printed nothing, and opened a
 * BRAND NEW conversation. The worker then re-read the task from scratch and the
 * dispatcher had no way to tell -- the run looked exactly like a successful
 * resume. A flag that cannot be honoured has to be refused, loudly.
 *
 * `supportsResume` comes from the ADAPTER, not from a table in here. Two places
 * declaring which surfaces can resume is two places to drift; the adapter is the
 * one that would actually have to build the argv, so it owns the answer.
 *
 * Rejecting `--model` alongside `--resume` is deliberately stricter than the
 * runtimes are. agy accepts --model on a headless resume; agentapi send-message
 * has no model parameter at all and ignores it. One rule for all four surfaces
 * is easier to hold than four, and changing a model mid-session is a reason to
 * open a new session, not to reuse one.
 */
export function resolveResume(options, { worker, mode, supportsResume }) {
  const raw = options.resume;
  if (raw === undefined || raw === null) return null;

  if (!supportsResume) {
    throw new GuardError(
      `--resume is not available on ${worker} --mode ${mode}`,
      "that surface always opens a new session; drop the flag or dispatch on a surface that resumes",
    );
  }

  const id = String(raw).trim();
  if (!id) {
    throw new GuardError(
      "--resume needs the id of the session to continue",
      "read it from the finished job in the manifest (conversationId), do not guess it",
    );
  }

  if (options.model) {
    throw new GuardError(
      "--resume and --model cannot be combined",
      "a resumed session already has the model it was opened with; open a new session to change tier",
    );
  }

  return id;
}

/**
 * Refuse a flag the surface about to run cannot honour.
 *
 * The generalisation of resolveResume, written after finding more flags with
 * the identical defect it was built for. They parsed cleanly, were read on
 * exactly one branch, and were dropped in silence on the other:
 *
 *   --title      read only by anti's app branch
 *   --agy-mode   read only by anti's headless branch
 *
 * (`--idle` on the old Codex app transport was the third, gone with it.) A flag
 * that silently does nothing is worse than a missing feature, because it is
 * relied upon.
 */
export function assertSurfaceFlags(options, { worker, mode, unsupported }) {
  for (const [key, cliName] of Object.entries(unsupported)) {
    const value = options[key];
    if (value === undefined || value === null || value === false) continue;
    throw new GuardError(
      `${cliName} is not available on ${worker} --mode ${mode}`,
      "that surface ignores it entirely; drop the flag, or dispatch on the surface that reads it",
    );
  }
}

/** Accepts Go-style durations because that is what agy's --print-timeout takes. */
/**
 * Chuỗi lát (`crew run --chain`): trần 30m vẫn áp cho TỪNG lát; budget là tổng
 * thời gian các lát của một chuỗi, ghi sổ nên chạy lại không mở đồng hồ mới.
 * Ngưỡng ở references/cost-gate.md.
 */
export const DEFAULT_CHAIN_BUDGET = "4h";
export const MAX_CHAIN_BUDGET_MS = 8 * 3_600_000;
export const DEFAULT_CHAIN_SLICES = 8;
export const MAX_CHAIN_SLICES = 8;
/** Owner chốt: cứ 2 lát thì chuỗi nghỉ (exit 4) cho Claude đọc handoff. */
export const CHAIN_CHECKPOINT_EVERY = 2;

/** Budget chuỗi: cùng cú pháp `--timeout` nhưng trần 8h thay vì 30m. */
export function parseChainBudget(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:\d+(?:\.\d+)?[hms])+$/.test(text)) {
    throw new GuardError(`không đọc được --budget "${value}"`, 'dùng dạng "45m", "4h", "2h30m"');
  }
  const unit = { h: 3_600_000, m: 60_000, s: 1000 };
  const ms = [...text.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)].reduce((sum, [, n, u]) => sum + Number(n) * unit[u], 0);
  if (ms <= 0) throw new GuardError(`--budget "${value}" phải dương`);
  if (ms > MAX_CHAIN_BUDGET_MS) throw new GuardError(`--budget "${value}" vượt trần 8h của một chuỗi`, "chẻ việc ra, hoặc chạy chuỗi mới sau khi Claude đọc handoff");
  return ms;
}

export function parseDuration(value) {
  const text = String(value).trim();
  // Anchored on purpose. The unanchored version accepted trailing junk by
  // ignoring it, so `--timeout 1m30` silently meant 60s rather than 90s and a
  // legitimate 90-second job got killed at 60. A typo has to be rejected, not
  // reinterpreted as a smaller number.
  if (!/^(?:\d+(?:\.\d+)?[hms])+$/.test(text)) {
    throw new GuardError(`cannot parse duration "${value}"`, 'use forms like "90s", "15m", "1h30m"');
  }
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)];
  if (matches.length === 0) {
    throw new GuardError(`cannot parse duration "${value}"`, 'use forms like "90s", "15m", "1h30m"');
  }
  const unit = { h: 3_600_000, m: 60_000, s: 1000 };
  const ms = matches.reduce((sum, [, n, u]) => sum + Number(n) * unit[u], 0);
  if (ms <= 0) throw new GuardError(`duration "${value}" is not positive`);
  if (ms > MAX_TIMEOUT_MS) throw new GuardError(`thời lượng "${value}" vượt trần 30m của một job`, ceilingHint(text, ms));
  return ms;
}

/**
 * Gợi ý khi `--timeout` vượt trần. Trước đây chỉ bảo "chẻ job", nên dispatcher
 * hạ về 30m rồi bắn lại y nguyên: việc thật sự cần 40m bị cắt giữa chừng.
 * Đường đúng cho việc dài là `--chain`, nên in sẵn lệnh với budget bằng đúng
 * thời lượng vừa xin.
 */
function ceilingHint(text, ms) {
  if (ms > MAX_CHAIN_BUDGET_MS) {
    return "quá cả trần 8h của một chuỗi: chẻ việc thành nhiều job, hoặc nhiều chuỗi nối nhau sau khi Claude đọc handoff";
  }
  return `việc cần hơn 30m thì đừng hạ --timeout: bắn bằng chuỗi lát, mỗi lát ≤30m, tự nối trên cùng thread\n`
    + `  → thay bằng: --chain --timeout 30m --budget ${text}   (xem cost-gate.md)`;
}

/**
 * Layout a job runs under: the one its run sealed into the manifest, else the
 * workspace's `crew.config.json` (a loose job with no run).
 */
export function jobLayout({ manifest, workspace }) {
  if (manifest) {
    try {
      return layoutOf(JSON.parse(readFileSync(manifest, "utf8")));
    } catch { /* manifest đọc lỗi thì adapter sẽ tự báo ở bước đọc sổ; layout lấy từ config */ }
  }
  return loadLayout(workspace);
}

/**
 * Evidence must land inside the layout's evidence root (`tasks/` in the original
 * workspace, `.crew/` by default), so a crew run leaves its trail where the
 * write-scope gate looks and never scattered in the repo.
 */
export function validateEvidencePath(evidence, workspace, layout = loadLayout(workspace)) {
  if (!evidence) {
    throw new GuardError("--evidence is required", `every job must write a report file under ${layout.evidenceRoot}/`);
  }
  const abs = resolve(workspace, evidence);
  const root = join(resolve(workspace), ...layout.evidenceRoot.split("/")) + sep;
  if (!abs.startsWith(root)) {
    throw new GuardError(`evidence path is outside the evidence root: ${abs}`, `it must be under ${root}`);
  }
  return abs;
}

/** A stale file from an earlier run would read as proof of this one. */
export function assertEvidenceAbsent(evidenceAbs) {
  if (existsSync(evidenceAbs)) {
    throw new GuardError(
      `evidence file already exists: ${evidenceAbs}`,
      "use a fresh path per job so a stale file can never be mistaken for proof",
    );
  }
}

/**
 * The gate that catches a silent success: agy has been observed returning
 * status=SUCCESS with an empty response and no work done, when a tool it needed
 * was blocked by a permission prompt it could not show.
 */
export function assertEvidenceWritten(evidenceAbs, context) {
  if (!existsSync(evidenceAbs)) {
    throw new GuardError(
      "the worker reported success but wrote no evidence file",
      `expected ${evidenceAbs}\n  ${context}`,
    );
  }
  const size = statSync(evidenceAbs).size;
  if (size === 0) {
    throw new GuardError(
      "the worker created an empty evidence file",
      `${evidenceAbs} is 0 bytes\n  ${context}`,
    );
  }
  return size;
}

/**
 * The worker's own `Status:` line, read back off the evidence file.
 *
 * A worker that finished and a worker that stopped at the cost gate both leave a
 * non-empty evidence file, so file existence alone cannot tell them apart. The
 * contract puts the verdict on the last Status line; this reads it rather than
 * trusting the runtime's exit code.
 */
const WORKER_STATUS = {
  DONE: "done",
  DONE_WITH_CONCERNS: "done_with_concerns",
  BLOCKED: "blocked",
  NEEDS_CONTEXT: "needs_context",
  // Chưa xong, nhưng dừng có trật tự: evidence có `## Handoff` để job sau làm
  // tiếp trên cùng thread. Không phải thất bại, cũng không phải đạt.
  CONTINUE: "continue",
};

export function readWorkerStatus(evidenceAbs) {
  const lines = readFileSync(evidenceAbs, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const verdict = lines[i].match(/^Status:\s*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT|CONTINUE)\b/)?.[1];
    if (!verdict) continue;
    // The brief hands the worker the literal line
    // `Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`, so a worker
    // that echoes its own brief -- or pastes the template while reporting that
    // it achieved nothing -- would otherwise be read as DONE. A real verdict
    // names exactly one outcome.
    const tokens = lines[i].match(/\b(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT|CONTINUE)\b/g) ?? [];
    if (new Set(tokens).size > 1) continue;
    return { status: WORKER_STATUS[verdict], reported: verdict };
  }
  // No Status line means the worker ignored the contract, so we cannot say the
  // job succeeded -- but the evidence may still be usable. Flag, do not judge.
  return { status: "done_unverified", reported: null };
}

/**
 * `usage` của một dòng stream Codex `{"type":"turn.completed","usage":{...}}`, hoặc
 * `prev` khi dòng không phải sự kiện đó. Lượt bị giết giữa chừng không có
 * `turn.completed`, nên job hết giờ chỉ có số khi lượt cứu handoff chạy xong.
 * Đo 06/11: con số tăng dần qua các lát cùng thread (602k → 1,40M → 2,44M input),
 * nên đọc nó như tổng dồn của thread; phần của một lát = lát này trừ lát trước.
 */
export function codexTurnUsage(line, prev = null) {
  if (!line || !line.includes("turn.completed")) return prev;
  let d;
  try { d = JSON.parse(line); } catch { return prev; }
  if (d?.type !== "turn.completed" || !d.usage || typeof d.usage !== "object") return prev;
  return d.usage;
}

/** Evidence đã tự phán (có dòng Status) thì không cần lượt cứu handoff. */
export function evidenceHasStatus(evidenceAbs) {
  try {
    return existsSync(evidenceAbs) && statSync(evidenceAbs).size > 0 && readWorkerStatus(evidenceAbs).reported != null;
  } catch {
    return false;
  }
}

export function readPrompt({ prompt, promptFile }) {
  if (promptFile) {
    const abs = resolve(promptFile);
    if (!existsSync(abs)) throw new GuardError(`no prompt file at ${abs}`);
    const text = readFileSync(abs, "utf8").trim();
    if (!text) throw new GuardError(`prompt file ${abs} is empty`);
    return assertBriefFits(text, abs);
  }
  const text = (prompt ?? "").trim();
  if (!text) throw new GuardError("--prompt or --prompt-file is required");
  return assertBriefFits(text, "--prompt");
}

/**
 * Số byte của brief (đã trim) đúng như `readPrompt` đo, hoặc null khi không đọc
 * được — adapter dùng để ghi sổ, không bao giờ ném: lỗi thật để readPrompt báo.
 */
export function briefSize({ prompt, promptFile }) {
  try {
    const text = promptFile ? readFileSync(resolve(promptFile), "utf8").trim() : String(prompt ?? "").trim();
    return text ? Buffer.byteLength(text, "utf8") : null;
  } catch {
    return null;
  }
}

/** Note cho job có brief quá trần mềm, hoặc null. */
export function longBriefNote(bytes) {
  return bytes != null && bytes > BRIEF_SOFT_BYTES
    ? `brief ${bytes} byte, quá trần mềm ${BRIEF_SOFT_BYTES} — lần sau tách bối cảnh ra file trong thư mục run, brief chỉ trỏ tới`
    : null;
}

/** Measured in bytes, not characters: Vietnamese briefs run ~1.15 bytes/char. */
function assertBriefFits(text, where) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BRIEF_BYTES) {
    throw new GuardError(
      `brief is ${bytes} bytes, over the ${MAX_BRIEF_BYTES}-byte ceiling (${where})`,
      "cut the HOW: the worker reads the files and its own SKILL.md, so a brief\n" +
      "  only needs what it cannot derive from those -- what, why, acceptance, traps",
    );
  }
  return text;
}

/**
 * Hai dòng cho mọi job, vì owner chen vào conversation của worker được bất cứ lúc
 * nào, kể cả khi job không phải phiên chat. Lời owner tới Claude chỉ qua lời worker
 * kể lại, nên nó phải nằm ở một mục cố định thì collect mới thấy và báo được. Đo
 * 01/10: worker chép cả câu hỏi bâng quơ vào mục này, nên câu chữ giới hạn nó vào
 * việc đổi mục tiêu hoặc phạm vi.
 */
export const OWNER_CHANGE_LINE = "Owner đổi mục tiêu hoặc phạm vi giữa chừng → ghi mục `## Thay đổi từ owner` trong evidence:"
  + " owner muốn đổi gì, lúc nào. Câu hỏi hay trò chuyện không đổi việc thì không ghi.";
export const OUTSIDE_BRIEF_LINE = "Đã ghi hoặc cần ghi thứ brief không giao → liệt kê ở mục `## Ghi ngoài brief`:"
  + " đường dẫn ngoài thư mục của run, hoặc Sheet/CMS kèm URL/ID. Việc brief đã giao thì không liệt kê.";
/**
 * Đo 09/10 trên 6 run để dở: worker ghi mục trống bằng đủ kiểu câu phủ định ("Không có.
 * Chỉ ghi file evidence này.", "Không ghi ngoài task folder…"), và collect không phân biệt
 * được với nội dung thật nên gắn BRIEF ĐỔI / GHI NGOÀI BRIEF ở 5/6 run. Một cờ luôn bật là
 * cờ người ta học cách bỏ qua. Cách ghi trống phải là một chuỗi cố định.
 */
export const EMPTY_SECTION_LINE = "Hai mục trên mà không có gì thì ghi đúng một dòng \"Không có\" ngay dưới tiêu đề, không giải thích thêm.";
/**
 * Đo 05-07/10: worker Anti (chạy ở root repo, không sandbox) để nháp ra root ở 3 run — 22
 * file script/HTML/JSON tạm. Gate bắt được nhưng chỉ SAU khi ghi, và mỗi lần phải đi dò
 * xem là của ai. Nói chỗ để nháp trước thì worker không cần đoán.
 */
export function scratchLine(evidenceRel) {
  const runDir = evidenceRel.split("/").slice(0, -1).join("/");
  return `File nháp (script, HTML/JSON tải về, file tạm) để trong ${runDir}/data/ — không để ở root repo hay thư mục hiện tại.`;
}
/**
 * Đo 07/10: owner bảo "báo Claude" trong một job thường thì worker không biết làm
 * gì, và đi đọc code adapter để tự tìm cách. Ghi evidence chính là cách báo.
 */
export const REPORT_LINE = "Owner bảo \"báo Claude\" hoặc \"xong\" → dừng việc, ghi evidence kèm dòng Status"
  + " (chưa xong thì Status: BLOCKED hoặc DONE_WITH_CONCERNS, nêu phần còn lại). Ghi evidence chính là báo Claude;"
  + " không cần tìm cách nào khác. Đã ghi Status thì không làm tiếp, không sửa evidence nữa.";
export const STATUS_LINE = "Dòng cuối evidence file phải là: Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT";
/**
 * Bốn mục con của handoff. Cố định để collect kiểm được và để job sau (hay
 * chuỗi lát) đọc đúng chỗ mà không phải hiểu văn của worker.
 */
export const HANDOFF_SECTIONS = "`## Handoff` gồm `### Đã xong`, `### Đang dở`, `### Bước kế tiếp`, `### File đã đụng`";

/** Job ngắn hơn ngưỡng này không có hạn mềm: không đủ chỗ để vừa làm vừa dừng có trật tự. */
export const SOFT_DEADLINE_MIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Hạn mềm: còn `max(5 phút, 15% timeout)` trước hard timeout. Null khi job
 * ngắn hơn 10 phút. Worker tự dừng ở đây thì không cần lượt cứu.
 */
export function softDeadlineAt(startMs, timeoutMs) {
  if (!(timeoutMs >= SOFT_DEADLINE_MIN_TIMEOUT_MS)) return null;
  return new Date(startMs + timeoutMs - Math.max(5 * 60_000, 0.15 * timeoutMs));
}

/** HH:MM theo giờ máy — worker xem giờ bằng `date` trên cùng máy. */
const clock = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function handoffLine(softDeadline) {
  return `Hạn mềm ${clock(softDeadline)} (giờ máy, xem bằng \`date\`). Kiểm giờ sau mỗi bước lớn; còn dưới 5 phút thì không mở bước lớn mới.`
    + ` Tới hạn mềm mà chưa xong: dừng, ghi ${HANDOFF_SECTIONS}, rồi dòng cuối \`Status: CONTINUE\`.`
    + " CONTINUE chỉ dùng khi việc chưa xong và có handoff; xong mà còn lo ngại thì vẫn là DONE_WITH_CONCERNS.";
}

/**
 * Lượt cứu khi hết hard timeout mà evidence chưa có Status. Tự đủ nghĩa: job
 * dưới 10 phút chưa từng nhận dòng hạn mềm, nên không được dựa vào nó.
 */
export function handoffRescuePrompt(evidenceRel) {
  // Đo 06/11 trên job Codex thật: không có câu nguồn, worker ghi tin này vào
  // `## Thay đổi từ owner`, và collect gắn BRIEF ĐỔI cho một việc owner không hề nói.
  return "Tin từ crew (không phải owner): hết giờ. Không làm tiếp, không chạy lệnh nào khác."
    + ` Ghi ngay vào ${evidenceRel} (giữ nguyên phần đã có) mục ${HANDOFF_SECTIONS},`
    + " rồi dòng cuối `Status: CONTINUE`. Không ghi tin này vào mục `## Thay đổi từ owner`.";
}

/** Lượt cứu: trần cứng và trần im lặng. Không cấp thêm quyền nào so với job gốc. */
export const HANDOFF_RESCUE_MS = 3 * 60_000;
export const HANDOFF_RESCUE_IDLE_MS = 60_000;

/**
 * Phiên chat thay dòng Status: adapter app thoát ngay khi evidence có `Status:`,
 * nên worker chỉ được viết nó khi owner bảo. Bốn mục cố định để Claude tóm tắt
 * phiên mà không phải đọc cả conversation.
 */
export const CHAT_LINE = "Đây là phiên chat với owner. Trả lời owner bình thường. CHỈ ghi evidence khi owner bảo báo Claude"
  + " hoặc bảo xong. Evidence gồm `## Tóm tắt trao đổi`, `## Thay đổi từ owner`, `## Ghi ngoài brief`, `## Việc còn mở`;"
  + " mục nào không có gì thì ghi \"Không có\". " + STATUS_LINE;


/**
 * The three lines `agent-crew` Bước 5 requires in every brief, appended by the
 * adapter instead of trusted to the person writing the brief.
 *
 * Why here rather than in the prose: run `crew-260909-1450` lost all three jobs,
 * including the one that never touched the sandbox. `brief-codex-1.md` was
 * missing the "Chỉ được ghi đúng file" line, so the worker wrote a complete
 * report into the chat and never created the evidence file -- and an evidence
 * file that does not exist is, by this module's central rule, a job that did not
 * happen. readPrompt measured the brief's size and nothing else, so a brief
 * could pass every guard while missing the only instruction that makes the work
 * collectable.
 *
 * Appended after the byte ceiling is checked, not before: the ceiling is a
 * discipline on the HOW the dispatcher writes, and charging them ~250 bytes of
 * boilerplate they no longer author would turn a real limit into a moving one.
 *
 * `unsandboxed` adds one more line, and only then: a job dispatched outside
 * Seatbelt can write anywhere on the machine, so the boundary that the sandbox
 * used to enforce has to be stated where the worker reads it.
 *
 * Idempotent by evidence path: a brief that already carries the line keeps the
 * author's wording. Two copies of a write-scope rule is how a worker learns to
 * pick whichever it likes.
 */
/**
 * Dòng cổng chi phí, lấy từ `costGate` trong config của workspace. Tên API phải
 * đi nguyên vào sau `COST_GATE — `: đó là thứ collect đọc để tạo hold. Config
 * hỏng thì adapter đã dừng từ lúc nạp layout; ở đây chỉ không thêm dòng.
 */
export function costGateLine(workspace) {
  let costGate;
  try {
    ({ costGate } = loadCrewConfig(workspace));
  } catch {
    return null;
  }
  if (!costGate.length) return null;
  const names = costGate.map(({ api, via }) => (via ? `${api} (qua ${via})` : api)).join(", ");
  return `Cổng chi phí: KHÔNG tự gọi ${names}. Cần tới thì dừng trước khi gọi, ghi \`Concerns/Blockers: COST_GATE — {tên API}\` và \`Status: BLOCKED\`.`;
}

export const WRITE_LOCK_LINE = "Vùng ghi ở trên được hệ điều hành khoá: ghi ra ngoài sẽ báo `Operation not permitted`."
  + " Việc thật cần ghi chỗ khác thì đừng tìm đường vòng: dừng, ghi `Status: BLOCKED` và nêu đường cần thêm.";

export function appendWorkerContract(text, { evidenceAbs, workspace, unsandboxed = false, writeLocked = false, chat = false, mayModify = [], softDeadline = null }) {
  const evidenceRel = evidenceAbs.startsWith(workspace + sep)
    ? evidenceAbs.slice(workspace.length + 1)
    : evidenceAbs;
  // The run dir is the evidence file's parent (crew-{yymmdd-hhmm}); it is only
  // ever cosmetic here, so an unexpected layout drops the id rather than throws.
  const runId = evidenceRel.split("/").slice(-2, -1)[0] ?? null;
  const lines = [
    runId
      ? `Bạn là worker trong crew run ${runId}. Không được dispatch worker khác.`
      : "Bạn là worker trong một crew run. Không được dispatch worker khác.",
    // Đường `--allow` của job phải nằm trong cùng dòng: đo 20/10, một job Codex có
    // `--allow sum.mjs` đọc dòng "chỉ ghi evidence" ở cuối prompt rồi từ chối tạo đúng
    // file nó được giao, trả BLOCKED. Hai luật ghi lệch nhau thì worker chọn luật chặt.
    mayModify.length
      ? `Chỉ được ghi đúng file: ${evidenceRel}, cộng các đường được cấp cho job này: ${mayModify.map((p) => `\`${p}\``).join(", ")} (và file nháp bạn tự sinh trong thư mục của run).`
      : `Chỉ được ghi đúng file: ${evidenceRel} (và file nháp bạn tự sinh trong thư mục của run).`,
    ...(evidenceRel.includes("/") ? [scratchLine(evidenceRel)] : []),
    ...(chat ? [CHAT_LINE] : [STATUS_LINE, REPORT_LINE]),
    OWNER_CHANGE_LINE,
    OUTSIDE_BRIEF_LINE,
    // CHAT_LINE đã tự dặn "không có gì thì ghi Không có" cho cả 4 mục.
    ...(chat ? [] : [EMPTY_SECTION_LINE]),
    // Phiên chat chờ owner, không chạy theo đồng hồ của job.
    ...(softDeadline && !chat ? [handoffLine(softDeadline)] : []),
  ];
  // Sandbox ghi đang khoá đúng các đường trên: worker bị chặn thì phải nói ra, không
  // tìm đường vòng (ghi qua chỗ khác rồi chép lại) — đường vòng là thứ khiến cổng
  // phạm vi phải đoán.
  if (writeLocked) lines.push(WRITE_LOCK_LINE);
  const costLine = costGateLine(workspace);
  if (costLine) lines.push(costLine);
  // Owner chốt 22/09: gộp --workspace-cli on với --sandbox-mode danger-full-access
  // KHÔNG bị cấm, vì một job cần cả trình duyệt lẫn Sheet mà phải tách đôi là trả
  // giá quá đắt cho một rủi ro chưa xảy ra. Đổi lại, khi lớp sandbox không còn thì
  // ràng buộc phải đi vào brief -- chỗ worker thật sự đọc. Rào hash quanh kho
  // credential vẫn chạy, nhưng nó PHÁT HIỆN sau khi hỏng, không chặn trước.
  if (unsandboxed) {
    lines.push(
      "Job này chạy NGOÀI sandbox: ghi được toàn máy. Chỉ đụng workspace này;"
        + " không đọc/ghi `~/.config/gws/`, `.env`, secret, token, hay config ngoài repo.",
    );
  }
  // STATUS_LINE nằm trọn trong CHAT_LINE: một brief thường lỡ chép câu chat vào
  // thì vẫn phải nhận dòng Status đứng riêng, không thì worker ngồi chờ owner tới timeout.
  const present = (line) => (line === STATUS_LINE ? text.replaceAll(CHAT_LINE, "") : text).includes(line);
  const missing = lines.filter((line) => !present(line));
  if (missing.length === 0) return text;
  return `${text}\n\n${missing.join("\n")}\n`;
}

/**
 * sha256 of the evidence as the adapter judged it. Collect compares it with the
 * file it reads later: measured 07/10, an Anti app worker rewrote its evidence
 * 28 seconds after the adapter had recorded the job as done, and the gate read
 * the new version as if it were the one judged.
 */
export function evidenceDigest(evidenceAbs) {
  return createHash("sha256").update(readFileSync(evidenceAbs)).digest("hex");
}

/**
 * The verdict for one finished job, with evidence outranking the runtime.
 *
 * Both adapters used to ask the runtime first and only look at the evidence
 * afterwards. That inverted the module's own rule and cost two real jobs: agy
 * returned status=ERROR twice on 2026-08-24 while the work was complete and the
 * evidence file met its acceptance criteria, so both were recorded as failed and
 * had to be patched by hand into a status that does not exist in the contract.
 *
 * So the runtime's own verdict is consulted in exactly two places: when there is
 * no usable evidence (then it is all we have), and when the evidence carries no
 * Status line (then it decides whether an unverified report is a finished job or
 * a corpse). A runtime failure over evidence that does carry a Status line is
 * recorded as disagreement -- `runtimeVerdict` -- not as failure, because the
 * collect step has to show a human that disagreement rather than bury it.
 */
export function judgeJob(evidenceAbs, { runtimeOk, runtimeDetail = null, context = "" }) {
  if (!existsSync(evidenceAbs) || statSync(evidenceAbs).size === 0) {
    // No evidence: the runtime's account is the only account there is. Two
    // different stories need two different headlines -- a worker that claimed
    // success and wrote nothing is a silent failure, while a worker that was
    // killed never got the chance to claim anything.
    if (runtimeOk) assertEvidenceWritten(evidenceAbs, context);
    throw new GuardError(
      "the job did not finish and left no usable evidence",
      `${runtimeDetail ?? "the runtime failed with no detail"}\n  expected ${evidenceAbs}\n  ${context}`,
    );
  }
  const evidenceBytes = statSync(evidenceAbs).size;
  const evidenceSha256 = evidenceDigest(evidenceAbs);
  const verdict = readWorkerStatus(evidenceAbs);

  if (!verdict.reported && !runtimeOk) {
    throw new GuardError(
      "the runtime failed and the evidence carries no Status line",
      `${runtimeDetail ?? "no detail"}\n  the evidence at ${evidenceAbs} is kept for reading, but it cannot be judged`,
    );
  }

  return {
    status: verdict.status,
    reportedStatus: verdict.reported,
    evidenceBytes,
    evidenceSha256,
    // Set only when the runtime disagreed with evidence that judged itself.
    runtimeVerdict: runtimeOk ? null : (runtimeDetail ?? "runtime reported failure"),
  };
}

/**
 * Where a job's raw log goes: the layout's `logDir` (the task's own `data/`
 * folder in the original workspace, `.crew/logs/` by default), never next to
 * the evidence.
 *
 * The reason is that a task's `data/` folder is already ignored by git, for both
 * the flat and the work-item layout. Keeping the log beside the evidence meant
 * same fact -- "these two files are legitimate and must not be committed" --
 * had to be written in three places: gitignore patterns, a whitelist in the
 * skill's collect step, and an exception in the collect gate. One existing rule
 * replaces all three, and the manifest records the path so nothing has to guess
 * the name.
 */
export function resolveLogDir(evidenceAbs, workspace, layout = loadLayout(workspace)) {
  const rel = relative(workspace, evidenceAbs).split(sep).join("/");
  return join(workspace, ...logDirRel(layout, rel).split("/"));
}
