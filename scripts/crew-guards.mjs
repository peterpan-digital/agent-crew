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
import { join, resolve, sep } from "node:path";

// Ceilings come from mwg-agent-crew/cost-gate.md; a runaway agent burns quota.
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
 */
export const MAX_BRIEF_BYTES = 2048;

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
 * (its caller does, see routing-table.md), and quietly starting to set it here
 * would be a behaviour change smuggled in under a security fix.
 */
export function stripUnsafeEnv(env) {
  const out = { ...env };
  for (const name of STRIPPED_ENV) delete out[name];
  return out;
}

/** The env a Codex worker gets: the recursion guard, plus the strip. */
export function workerEnv(extra = {}) {
  return stripUnsafeEnv({ ...process.env, MWG_CREW_ROLE: "worker", ...extra });
}

export class GuardError extends Error {
  constructor(message, detail) {
    super(detail ? `${message}\n  ${detail}` : message);
    this.name = "GuardError";
    this.detail = detail;
  }
}

/** Accepts Go-style durations because that is what agy's --print-timeout takes. */
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
  if (ms > MAX_TIMEOUT_MS) {
    throw new GuardError(
      `duration "${value}" exceeds the crew ceiling of 30m`,
      "split the job instead of raising the timeout (see cost-gate.md)",
    );
  }
  return ms;
}

/**
 * Evidence must land inside the task folder, so a crew run leaves its trail
 * where the workspace task contract expects it and never scattered in the repo.
 */
export function validateEvidencePath(evidence, workspace) {
  if (!evidence) {
    throw new GuardError("--evidence is required", "every job must write a report file under tasks/");
  }
  const abs = resolve(workspace, evidence);
  const tasksRoot = join(resolve(workspace), "tasks") + sep;
  if (!abs.startsWith(tasksRoot)) {
    throw new GuardError(`evidence path is outside the task tree: ${abs}`, `it must be under ${tasksRoot}`);
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
};

export function readWorkerStatus(evidenceAbs) {
  const lines = readFileSync(evidenceAbs, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const verdict = lines[i].match(/^Status:\s*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\b/)?.[1];
    if (!verdict) continue;
    // The brief hands the worker the literal line
    // `Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`, so a worker
    // that echoes its own brief -- or pastes the template while reporting that
    // it achieved nothing -- would otherwise be read as DONE. A real verdict
    // names exactly one outcome.
    const tokens = lines[i].match(/\b(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\b/g) ?? [];
    if (new Set(tokens).size > 1) continue;
    return { status: WORKER_STATUS[verdict], reported: verdict };
  }
  // No Status line means the worker ignored the contract, so we cannot say the
  // job succeeded -- but the evidence may still be usable. Flag, do not judge.
  return { status: "done_unverified", reported: null };
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
 * The three lines `seo-crew` Bước 5 requires in every brief, appended by the
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
export function appendWorkerContract(text, { evidenceAbs, workspace, unsandboxed = false }) {
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
    `Chỉ được ghi đúng file: ${evidenceRel} (và data bạn tự sinh trong task folder).`,
    "Dòng cuối evidence file phải là: Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT",
  ];
  // Owner chốt 22/09: gộp --workspace-cli on với --sandbox-mode danger-full-access
  // KHÔNG bị cấm, vì một job cần cả trình duyệt lẫn Sheet mà phải tách đôi là trả
  // giá quá đắt cho một rủi ro chưa xảy ra. Đổi lại, khi lớp sandbox không còn thì
  // ràng buộc phải đi vào brief -- chỗ worker thật sự đọc. Rào hash quanh kho
  // credential vẫn chạy, nhưng nó PHÁT HIỆN sau khi hỏng, không chặn trước.
  if (unsandboxed) {
    lines.push(
      "Job này chạy NGOÀI sandbox: ghi được toàn máy. Chỉ đụng workspace và task folder;"
        + " không đọc/ghi `~/.config/gws/`, `.env`, secret, token, hay config ngoài repo.",
    );
  }
  const missing = lines.filter((line) => !text.includes(line));
  if (missing.length === 0) return text;
  return `${text}\n\n${missing.join("\n")}\n`;
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
    // Set only when the runtime disagreed with evidence that judged itself.
    runtimeVerdict: runtimeOk ? null : (runtimeDetail ?? "runtime reported failure"),
  };
}
