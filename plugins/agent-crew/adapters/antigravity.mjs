#!/usr/bin/env node
/**
 * Run one Antigravity job and refuse to call it a success without proof.
 *
 * Two transports, same contract:
 *   headless  `agy -p` -- fast, no UI, returns structured JSON with duration
 *                         and token usage. The default, for both roles.
 *   app       `agentapi new-conversation` -- creates a real conversation in the
 *                         Antigravity desktop app so a human can watch it, then
 *                         polls the conversation store until it settles.
 *
 * `app` was cut once already: an app job reports no token usage and no reply
 * text, so the adapter had to pass `runtimeOk: true` unconditionally, and the
 * headless silent-failure check (SUCCESS with an empty response) simply does
 * not exist for it. That trade-off is real and is not undone here -- it is why
 * lib/manifest.mjs keeps `headless` the default for both roles and requires a
 * `note` to override it. What restores `app` safely is that the trade-off was
 * already priced in on the evidence side: the evidence file, not agentapi's
 * response, is and remains the completion signal (see runApp below), so `app`
 * buys a human a live conversation to watch without weakening the gate that
 * catches a worker that did nothing. It stays worth having for three cases: a
 * job that will hit a permission prompt a human must answer, open-ended work
 * with no acceptance criteria written yet, and a thread meant to be resumed in
 * a later session.
 *
 * Why the evidence gate exists at all: agy has been observed returning
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
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_TIMEOUT,
  GuardError,
  assertEvidenceAbsent,
  judgeJob,
  parseDuration,
  readPrompt,
  readWorkerStatus,
  validateEvidencePath,
} from "../lib/guards.mjs";
import { resolveBin, spawnToolSync } from "../lib/platform.mjs";
import { callAgentapi, resolveAntiEnv } from "../lib/app/antigravity-env.mjs";
import { antiStatus } from "../lib/app/antigravity-status.mjs";
import { resolveSqlite } from "../lib/os-probe.mjs";

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
 *
 * This only applies to headless. `app` never touches a shim: callAgentapi runs
 * the language_server binary agentapi-env discovered off the running process,
 * which is always a real executable, never a `.cmd`/`.bat` wrapper -- so the
 * prompt goes into argv with no cmd.exe reinterpretation risk on either
 * platform.
 */
const PROMPT_MODES = new Set(["auto", "inline", "file-pointer"]);

/** Models the app accepts. Headless's `--model` takes a different, larger set. */
const APP_MODELS = new Set(["flash_lite", "flash", "pro", "inherit"]);

const APP_POLL_INTERVAL_MS = 5_000;
const APP_NEW_CONVERSATION_TIMEOUT_MS = 60_000;

function pointerPrompt(promptFile) {
  return `Đọc file brief tại ${promptFile} rồi thực hiện đúng theo nó. Không làm gì ngoài brief.`;
}

/** Blocking sleep: this adapter runs synchronously inside one job process. */
function sleepMs(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
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
      transport: "headless",
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
    transport: "headless",
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

/**
 * `app` transport: `agentapi new-conversation`, then poll until the job
 * settles. Ported from the pre-plugin anti-run.mjs's runApp(), with two
 * changes from that original: agentapi is now discovered off the running
 * process rather than a fixed install path (see antigravity-env.mjs's header
 * for why that is the only thing that works on both macOS and Windows), and
 * the step-status poll degrades explicitly instead of assuming a database that
 * turns out not to exist -- see the sqlite3 note below.
 */
function runApp({ promptText, workspace, evidenceAbs, model, title, timeout }) {
  if (model && !APP_MODELS.has(model)) {
    throw new AntiRunError(
      `app mode does not accept model "${model}"`,
      `pick one of: ${[...APP_MODELS].join(", ")}`,
    );
  }

  const resolved = resolveAntiEnv(workspace);
  const args = ["new-conversation"];
  if (model) args.push(`--model=${model}`);
  if (title) args.push(`--title=${title}`);
  args.push(promptText); // agentapi takes the prompt as a bare positional, not a flag

  const started = new Date();
  let raw;
  try {
    raw = callAgentapi(resolved.invocation, args, {
      cwd: workspace,
      timeoutMs: APP_NEW_CONVERSATION_TIMEOUT_MS,
      // Same guard the headless path applies: a worker that reads the skill
      // and dispatches its own crew is the recursion this stops, not a
      // permission a human needs to grant.
      env: { ...resolved.env, AGENT_CREW_ROLE: "worker" },
    });
  } catch (err) {
    const wrapped = new AntiRunError(
      "agentapi new-conversation failed",
      String(err.stderr || err.message).trim().slice(0, 600),
    );
    wrapped.runtimeFacts = { transport: "app", address: resolved.address };
    throw wrapped;
  }

  let conversationId;
  try {
    const parsed = JSON.parse(raw);
    conversationId = parsed?.response?.newConversation?.conversationId;
  } catch { /* fall through to the regex below */ }
  if (!conversationId) {
    // The prompt is echoed back in this same payload, and a worker brief can
    // itself quote something that looks like a uuid -- so this matches only the
    // named field, never a bare uuid anywhere in the text.
    conversationId = raw.match(/"conversationId"\s*:\s*"([0-9a-f-]{36})"/)?.[1];
  }
  if (!conversationId) {
    const wrapped = new AntiRunError("agentapi did not return a conversation id", raw.trim().slice(0, 600));
    wrapped.runtimeFacts = { transport: "app", address: resolved.address };
    throw wrapped;
  }

  // sqlite3 is optional (Windows ships none). Decided once, up front, instead
  // of re-probed on every poll tick, so a host without it degrades exactly
  // once rather than eating a spawn attempt every 5 seconds for the whole
  // timeout. Losing it loses the step-status fallback for this run, not the
  // transport: the evidence file and the timeout below are still the real
  // contract, unconditionally.
  const sqlite = resolveSqlite();
  const stepStatusAvailable = Boolean(sqlite);

  // The app gives no completion callback, so poll the conversation store. A
  // conversation that never leaves 0 steps means the app never picked it up.
  // The evidence file is the completion signal, not the step statuses.
  //
  // Measured: an app-mode worker wrote its report 23 seconds after dispatch,
  // then left its write_to_file step at status 7 for the whole remaining
  // timeout. Polling step status called that job "still running" for eight
  // minutes after it had finished, and then failed it. Step status is an
  // undocumented enum owned by the app; the evidence file is the contract.
  //
  // Steps are still polled when sqlite3 is available, but only as a fallback
  // for a worker that finished without writing the required Status line.
  const deadline = Date.now() + parseDuration(timeout);
  let last = stepStatusAvailable
    ? null
    : { conversationId, available: false, steps: null, state: "unknown" };
  let settledAt = null;
  for (;;) {
    if (existsSync(evidenceAbs) && statSync(evidenceAbs).size > 0 && readWorkerStatus(evidenceAbs).reported) {
      break;
    }
    if (stepStatusAvailable) {
      const prevSteps = last?.steps ?? null;
      try {
        last = antiStatus(conversationId, { store: resolved.store, sqlite });
      } catch {
        last = null; // the database appears a moment after the conversation does
      }
      // Fallback: the conversation settled and left evidence, but no Status line.
      if (last?.available && last.state === "done" && last.steps === prevSteps && existsSync(evidenceAbs)) {
        settledAt = last.steps;
        break;
      }
    }
    if (Date.now() > deadline) {
      const wrapped = new AntiRunError(
        `app-mode job did not finish within ${timeout}`,
        `conversation ${conversationId}, evidence not written; last seen ${JSON.stringify(last)}`
        + (stepStatusAvailable ? "" : " (step-status polling unavailable: no sqlite3 on this host)"),
      );
      wrapped.runtimeFacts = {
        transport: "app", address: resolved.address, conversationId, steps: last?.steps ?? null,
      };
      throw wrapped;
    }
    sleepMs(APP_POLL_INTERVAL_MS);
  }

  const endedAt = new Date().toISOString();
  // App mode has no runtime verdict to disagree with -- reaching here means the
  // evidence file appeared, which is the completion signal for this transport.
  let verdict;
  try {
    verdict = judgeJob(evidenceAbs, { runtimeOk: true, context: `app conversation ${conversationId}` });
  } catch (err) {
    err.runtimeFacts = {
      transport: "app", address: resolved.address, conversationId, steps: settledAt ?? last?.steps ?? null,
    };
    throw err;
  }

  return {
    worker: "antigravity",
    transport: "app",
    bin: resolved.invocation.file,
    address: resolved.address,
    conversationId,
    startedAt: started.toISOString(),
    endedAt,
    durationSec: Math.round((Date.parse(endedAt) - started.getTime()) / 1000),
    steps: settledAt ?? last?.steps ?? null,
    stepStatusAvailable,
    evidence: evidenceAbs,
    evidenceBytes: verdict.evidenceBytes,
    status: verdict.status,
    reportedStatus: verdict.reportedStatus,
    runtimeVerdict: verdict.runtimeVerdict,
  };
}

export function antiRun(options) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const evidenceAbs = validateEvidencePath(options.evidence, workspace, options.evidenceRoot);
  const promptText = readPrompt(options);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  parseDuration(timeout); // validate before spending anything

  assertEvidenceAbsent(evidenceAbs);

  const transport = options.transport ?? "headless";
  if (transport === "app") {
    return runApp({
      promptText,
      workspace,
      evidenceAbs,
      model: options.model,
      title: options.title,
      timeout,
    });
  }
  if (transport !== "headless") {
    throw new AntiRunError(`unknown transport "${transport}"`, "use transport headless or app");
  }
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
