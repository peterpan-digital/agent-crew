#!/usr/bin/env node
/**
 * Run one Antigravity job and refuse to call it a success without proof.
 *
 * One transport: `agy -p`, headless, structured JSON out. The desktop-app
 * transport this was ported from is gone, and deliberately: an app job reported
 * no token usage and no reply text, so the adapter had to pass `runtimeOk: true`
 * unconditionally and silent failure stopped being detectable at all. A
 * transport nothing can observe cannot be part of a harness whose entire job is
 * observing.
 *
 * Why the evidence gate exists: agy has been observed returning
 * status=SUCCESS with an empty response and no work done, when a tool it needed
 * was blocked by a permission prompt it could not show. A worker that reports
 * success without writing its evidence file is therefore treated as failed. The
 * only trustworthy signal is a file on disk inside the run directory.
 *
 * And the order matters as much as the gate: agy's verdict is collected first
 * but judged last, by judgeJob() in lib/guards.mjs. Asking the runtime first
 * cost two finished jobs on one measured run, recorded as failed on an agy
 * ERROR while their evidence was complete.
 */
import { resolve } from "node:path";
import {
  DEFAULT_TIMEOUT,
  GuardError,
  assertEvidenceAbsent,
  judgeJob,
  parseDuration,
  readPrompt,
  validateEvidencePath,
} from "../lib/guards.mjs";
import { resolveBin, spawnToolSync } from "../lib/platform.mjs";

/** Keeps `antigravity: ...` as the message prefix for every failure mode. */
class AntiRunError extends GuardError {
  constructor(message, detail) {
    super(message, detail);
    this.name = "AntiRunError";
  }
}

/**
 * How the brief reaches the worker.
 *
 * `inline` puts it in argv, which is what agy's `-p` expects and what every
 * POSIX install gets. It is not always available: on Windows an npm-style
 * `.cmd` shim has to be launched through cmd.exe, and cmd.exe would reinterpret
 * the brief -- `&&` chains commands there and `%FOO%` expands. So `auto`
 * downgrades to `file-pointer` in exactly that case: argv then carries only a
 * path, and the brief is read by the worker from the file the dispatcher
 * already saved.
 *
 * The downgrade is recorded on the result (and from there into the manifest)
 * rather than done quietly. It changes what the worker sees -- one tool call
 * before it starts -- and a later reader comparing two runs deserves to know
 * which one had to take the long way round.
 */
const PROMPT_MODES = new Set(["auto", "inline", "file-pointer"]);

function pointerPrompt(promptFile) {
  return `Đọc file brief tại ${promptFile} rồi thực hiện đúng theo nó. Không làm gì ngoài brief.`;
}

function runHeadless({
  promptText, promptFile, workspace, evidenceAbs, model, timeout, agyMode,
  promptMode = "auto",
}) {
  if (!PROMPT_MODES.has(promptMode)) {
    throw new AntiRunError(
      `unknown prompt mode "${promptMode}"`,
      `use one of: ${[...PROMPT_MODES].join(", ")}`,
    );
  }
  const bin = resolveBin("agy", { envOverride: "AGENT_CREW_AGY_BIN" });

  let mode = promptMode;
  if (mode === "auto") mode = bin.viaCmd ? "file-pointer" : "inline";
  if (mode === "file-pointer" && !promptFile) {
    throw new AntiRunError(
      "prompt mode file-pointer needs --prompt-file",
      "the worker is told to read the brief off disk, so the brief has to be on disk",
    );
  }

  const prompt = mode === "inline" ? promptText : pointerPrompt(promptFile);
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--add-dir", workspace,           // agy otherwise works in its own scratch dir
    "--dangerously-skip-permissions", // a headless worker cannot answer prompts
    "--print-timeout", timeout,
    "--disable-slash-commands",       // the brief is the whole instruction
  ];
  if (model) args.push("--model", model);
  if (agyMode) args.push("--mode", agyMode);

  const started = new Date();
  const proc = spawnToolSync(bin, args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: parseDuration(timeout) + 30_000, // let agy hit its own timeout first
    maxBuffer: 64 * 1024 * 1024,
    // The guard that stops a worker from reading the skill and dispatching.
    env: { ...process.env, AGENT_CREW_ROLE: "worker" },
  }, {
    // Only the inline mode puts text this harness did not author into argv.
    argvIsTrusted: mode !== "inline",
  });
  const endedAt = new Date().toISOString();

  if (proc.error) {
    throw new AntiRunError(
      `could not run agy: ${proc.error.message}`,
      `resolved to ${bin.path}; check the install, or set AGENT_CREW_AGY_BIN`,
    );
  }
  const stdout = (proc.stdout ?? "").trim();
  const stderrTail = (proc.stderr ?? "").trim().split("\n").slice(-5).join("\n");

  // Everything below builds agy's own account of the run. It is collected, not
  // acted on: judgeJob() consults it only where the evidence cannot speak.
  let parsed = null;
  let runtimeDetail = null;

  if (proc.status !== 0) {
    runtimeDetail = `agy exited ${proc.status}: ${stderrTail || stdout.slice(0, 300)}`;
  } else {
    try {
      // agy prints one JSON object; take the last line in case of stray output.
      parsed = JSON.parse(stdout.split("\n").filter(Boolean).pop());
    } catch (err) {
      runtimeDetail = `agy output is not JSON: ${err.message}`;
    }
  }
  if (parsed && parsed.status !== "SUCCESS") {
    runtimeDetail = `agy reported status ${parsed.status}`;
  } else if (parsed && !String(parsed.response ?? "").trim()) {
    // The silent-failure case: SUCCESS with nothing said, which is what a
    // blocked permission prompt looks like from out here. It still only decides
    // the outcome when no evidence was written.
    runtimeDetail = "agy returned SUCCESS with an empty response (silent failure);"
      + " a tool it needed was probably blocked -- check the brief and permissions";
  }

  let verdict;
  try {
    verdict = judgeJob(evidenceAbs, {
      runtimeOk: runtimeDetail === null,
      runtimeDetail,
      context: `agy conversation ${parsed?.conversation_id ?? "unknown"}`,
    });
  } catch (err) {
    // A job with no usable evidence is exactly where these facts are wanted:
    // otherwise the ledger records "failed" and nothing about what ran. Which
    // binary, which prompt mode, and the conversation id are the three things a
    // person needs to go look, and none of them survive the message alone.
    err.runtimeFacts = {
      bin: bin.path,
      promptMode: mode,
      conversationId: parsed?.conversation_id ?? null,
      exitCode: proc.status ?? null,
      usage: parsed?.usage ?? null,
    };
    throw err;
  }

  return {
    worker: "antigravity",
    bin: bin.path,
    promptMode: mode,
    conversationId: parsed?.conversation_id ?? null,
    startedAt: started.toISOString(),
    endedAt,
    // Two clocks on purpose: durationSec is wall time (what a work log bills)
    // and agentDurationSec is what the agent itself reported (what a prompt cost).
    durationSec: Math.round((Date.parse(endedAt) - started.getTime()) / 1000),
    agentDurationSec: parsed?.duration_seconds ? Math.round(parsed.duration_seconds) : null,
    numTurns: parsed?.num_turns ?? null,
    usage: parsed?.usage ?? null,
    response: String(parsed?.response ?? "").trim() || null,
    evidence: evidenceAbs,
    evidenceBytes: verdict.evidenceBytes,
    status: verdict.status,
    reportedStatus: verdict.reportedStatus,
    runtimeVerdict: verdict.runtimeVerdict,
    exitCode: proc.status ?? null,
  };
}

export function antiRun(options) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const evidenceAbs = validateEvidencePath(options.evidence, workspace, options.evidenceRoot);
  const promptText = readPrompt(options);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  parseDuration(timeout); // validate before spending anything

  assertEvidenceAbsent(evidenceAbs);

  return runHeadless({
    promptText,
    promptFile: options.promptFile ? resolve(options.promptFile) : null,
    workspace,
    evidenceAbs,
    model: options.model,
    timeout,
    agyMode: options.agyMode,
    promptMode: options.promptMode ?? "auto",
  });
}

export { AntiRunError };
