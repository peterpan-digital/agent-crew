#!/usr/bin/env node
/**
 * The checks every crew worker must pass, regardless of which runtime executes
 * it. Antigravity and Codex use the same ones, so a "done" from either worker
 * means the same thing.
 *
 * The central rule: a worker's own claim of success is not evidence. Only a
 * non-empty file inside the run directory is.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathStartsWith } from "./platform.mjs";

// A runaway agent burns quota, so the ceiling is not negotiable per call.
export const DEFAULT_TIMEOUT = "15m";
export const MAX_TIMEOUT_MS = 30 * 60_000;

/**
 * The brief ceiling, in bytes of UTF-8.
 *
 * The rule ("a brief says WHAT + NEED, not HOW") used to live only in prose,
 * and prose is a rule the dispatcher drifts on: of 24 briefs written after the
 * rule landed, one was over -- written by the dispatcher who had just
 * criticised long briefs. A ceiling nothing measures is a preference.
 *
 * A repository may raise it in `crew.config.json` (`briefMaxBytes`), which is a
 * decision made once and reviewable in a diff. There is deliberately no
 * per-call override flag: an escape hatch the caller can flip in the same
 * breath is not a ceiling. Over the cap means cut the HOW.
 */
export const MAX_BRIEF_BYTES = 2048;

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
      "split the job instead of raising the timeout",
    );
  }
  return ms;
}

/**
 * Evidence must land inside the run directory.
 *
 * Not merely "inside the repo": one run's trail has to be one directory, or a
 * reviewer cannot tell which files were produced under which manifest, and the
 * scope gate loses the one prefix it can allow implicitly. Work products go
 * wherever the project keeps them -- those are declared per job as
 * `filesMayModify`; the *evidence* is bookkeeping and stays put.
 */
export function validateEvidencePath(evidence, workspace, evidenceRoot) {
  if (!evidence) {
    throw new GuardError("--evidence is required", "every job must write a report file inside the run directory");
  }
  if (!evidenceRoot) {
    throw new GuardError("evidenceRoot is required to validate an evidence path");
  }
  const abs = resolve(workspace, evidence);
  const root = resolve(workspace, evidenceRoot);
  if (!pathStartsWith(abs, root)) {
    throw new GuardError(`evidence path is outside the run directory: ${abs}`, `it must be under ${root}`);
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

export function readPrompt({ prompt, promptFile, maxBytes = MAX_BRIEF_BYTES }) {
  if (promptFile) {
    const abs = resolve(promptFile);
    if (!existsSync(abs)) throw new GuardError(`no prompt file at ${abs}`);
    const text = readFileSync(abs, "utf8").trim();
    if (!text) throw new GuardError(`prompt file ${abs} is empty`);
    return assertBriefFits(text, abs, maxBytes);
  }
  const text = (prompt ?? "").trim();
  if (!text) throw new GuardError("--prompt or --prompt-file is required");
  return assertBriefFits(text, "--prompt", maxBytes);
}

/** Measured in bytes, not characters: non-ASCII briefs run ~1.15 bytes/char. */
function assertBriefFits(text, where, maxBytes) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new GuardError(
      `brief is ${bytes} bytes, over the ${maxBytes}-byte ceiling (${where})`,
      "cut the HOW: the worker reads the repo itself, so a brief only needs\n" +
      "  what it cannot derive from there -- what, why, acceptance, known traps",
    );
  }
  return text;
}

/**
 * The verdict for one finished job, with evidence outranking the runtime.
 *
 * Both adapters used to ask the runtime first and only look at the evidence
 * afterwards. That inverted the rule above and cost two real jobs: agy returned
 * status=ERROR twice while the work was complete and the evidence met its
 * acceptance criteria, so both were recorded as failed and had to be patched by
 * hand into a status that does not exist in the contract.
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
