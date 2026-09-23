#!/usr/bin/env node
/**
 * Run one Antigravity job and refuse to call it a success without proof.
 *
 * Two transports, same contract:
 *   headless  `agy -p` -- fast, no UI, returns structured JSON with duration
 *                         and token usage. The default.
 *   app       `agentapi new-conversation` -- creates a real conversation in the
 *                         Antigravity 2.0 desktop app so the user can watch it,
 *                         then polls the conversation store until it settles.
 *                         Pass `--resume <conversationId>` to send the prompt
 *                         into an existing conversation instead (`agentapi
 *                         send-message`) -- the case-3 resume from
 *                         routing-table.md. Transport stays "app" either way;
 *                         resume is an orthogonal flag, not a third mode.
 *
 * Why the evidence gate exists: agy has been observed returning
 * status=SUCCESS with an empty response and no work done, when a tool it needed
 * was blocked by a permission prompt it could not show. A worker that reports
 * success without writing its evidence file is therefore treated as failed.
 * The only trustworthy signal is a file on disk inside the task folder.
 *
 * And the order matters as much as the gate: agy's verdict is collected first
 * but judged last, by judgeJob() in crew-guards.mjs. Asking the runtime first
 * cost two finished jobs on 2026-08-24, recorded as failed on an agy ERROR
 * while their evidence was complete.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAntiEnv } from "./anti-env.mjs";
import { antiStatus } from "./anti-status.mjs";
import {
  DEFAULT_TIMEOUT,
  GuardError,
  assertEvidenceAbsent,
  judgeJob,
  parseDuration,
  readPrompt,
  appendWorkerContract,
  resolveResume,
  snapshotCredentialStore,
  diffCredentialStore,
  isWatchBlind,
  displayCredentialDir,
  readWorkerStatus,
  stripUnsafeEnv,
  validateEvidencePath,
} from "./crew-guards.mjs";

const POLL_INTERVAL_MS = 5_000;
const APP_MODELS = new Set(["flash_lite", "flash", "pro", "inherit"]);

/** Keeps `anti-run: ...` as the message prefix for every failure mode. */
class AntiRunError extends GuardError {
  constructor(message, detail) {
    super(message, detail);
    this.name = "AntiRunError";
  }
}

/** One wording for both readers: the runtime detail and the manifest failure. */
function resumeMismatchDetail(asked, got) {
  return `job xin tiếp conversation ${asked} nhưng agy mở conversation mới ${got}`
    + " — phiên cũ không được nạp, worker đã làm lại từ đầu";
}

function runHeadless({ promptText, workspace, evidenceAbs, model, timeout, agyMode, resumeId }) {
  const args = [
    "-p", promptText,
    "--output-format", "json",
    "--add-dir", workspace,          // agy otherwise works in its own scratch dir
    "--dangerously-skip-permissions", // a headless worker cannot answer prompts
    "--print-timeout", timeout,
    "--disable-slash-commands",       // the brief is the whole instruction
  ];
  if (model) args.push("--model", model);
  if (agyMode) args.push("--mode", agyMode);
  // `--conversation <id>`, never `--continue`. agy has both, and `--continue`
  // takes "the most recent conversation" -- with max_parallel at 3 that is a
  // race, and losing it means feeding a follow-up into another job's session.
  if (resumeId) args.push("--conversation", resumeId);

  const started = new Date();
  const proc = spawnSync("agy", args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: parseDuration(timeout) + 30_000, // let agy hit its own timeout first
    // Was inheriting the parent env whole. Same strip as every other worker
    // path -- this one runs unsandboxed and with --dangerously-skip-permissions.
    env: stripUnsafeEnv(process.env),
    maxBuffer: 64 * 1024 * 1024,
  });
  const endedAt = new Date().toISOString();

  if (proc.error) {
    throw new AntiRunError(`could not run agy: ${proc.error.message}`, "check that agy is on PATH");
  }
  const stdout = (proc.stdout ?? "").trim();
  const stderrTail = (proc.stderr ?? "").trim().split("\n").slice(-5).join("\n");

  // Everything below builds agy's own account of the run. It is collected, not
  // acted on: judgeJob() consults it only where the evidence cannot speak. Two
  // jobs on 2026-08-24 were recorded as failed on an agy ERROR while their
  // evidence was complete and met its acceptance criteria, and both had to be
  // patched by hand -- that is the inversion this ordering removes.
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

  // Measured 22/09, and the reason this is a check rather than a comment saying
  // "agy handles it": `agy --conversation <unknown-id>` prints
  // `warning: conversation "..." not found` to STDERR, exits 0, and opens a
  // BRAND NEW conversation. The same silent substitution the --resume gate was
  // built for, one layer down. Verified against the positive case in the same
  // session: a real id comes back unchanged, with num_turns 2 and 20k cached
  // tokens, and the agent answered from the earlier turn.
  //
  // The id is compared rather than the warning text, which is free to change
  // wording. That does NOT make it more trustworthy than agy's own verdict --
  // `conversation_id` is agy self-reporting too. What makes this check legal
  // under the evidence-first rule is narrower: judgeJob arbitrates whether the
  // WORK got done, which the evidence file can answer on its own. This
  // arbitrates which SESSION it was done in, and the evidence file holds no
  // data about that at all. Evidence cannot outrank the runtime on a question
  // evidence is silent about.
  //
  // So the finding is routed through runtimeDetail -- the ordinary WARN + ack
  // path -- and NOT by forcing `status: "failed"`. Measured: crew-collect
  // re-derives status from the evidence's own Status line, so an override here
  // is discarded at the gate and only leaves the manifest saying `failed` while
  // the gate table says PASS. Two answers to one event is the thing that gate
  // was written to remove.
  const returnedId = parsed?.conversation_id ?? null;
  const resumeMismatch = Boolean(resumeId && returnedId && returnedId !== resumeId);
  // Fails closed on purpose. The premise of this whole check is that the
  // runtime can fail to resume without saying so; if a version bump renames or
  // drops the field, "cannot verify" would otherwise read as "verified" on
  // EVERY resume at once, with no signal. A false alarm costs one ack; the
  // alternative costs a resume that silently never happened.
  const resumeUnverifiable = Boolean(resumeId && !returnedId);
  if (resumeMismatch) {
    runtimeDetail = resumeMismatchDetail(resumeId, returnedId);
  } else if (resumeUnverifiable) {
    runtimeDetail = `job xin tiếp conversation ${resumeId} nhưng agy không trả conversation_id`
      + " — không kiểm được phiên cũ có được nạp hay không";
  }

  const verdict = judgeJob(evidenceAbs, {
    runtimeOk: runtimeDetail === null,
    runtimeDetail,
    context: `agy conversation ${returnedId ?? "unknown"}`,
  });
  const evidenceBytes = verdict.evidenceBytes;

  return {
    worker: "antigravity",
    mode: "headless",
    conversationId: returnedId,
    resumedFrom: resumeId ?? null,
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
    evidenceBytes,
    status: verdict.status,
    resumeMismatch: resumeMismatch || undefined,
    reportedStatus: verdict.reportedStatus,
    runtimeVerdict: verdict.runtimeVerdict,
  };
}

function runApp({ promptText, workspace, evidenceAbs, model, title, timeout, resumeId }) {
  // `--model` alongside `--resume` never reaches here: resolveResume refuses the
  // pair outright, because send-message has no model parameter and would have
  // dropped it silently. So this check is only ever about a fresh conversation.
  if (model && !APP_MODELS.has(model)) {
    throw new AntiRunError(
      `app mode does not accept model "${model}"`,
      `pick one of: ${[...APP_MODELS].join(", ")}`,
    );
  }
  const { agentapi, env } = resolveAntiEnv(workspace);
  const args = resumeId ? ["send-message"] : ["new-conversation"];
  if (!resumeId) {
    if (model) args.push(`--model=${model}`);
  }
  if (title) args.push(`--title=${title}`);
  if (resumeId) args.push(resumeId);
  args.push(promptText);

  const started = new Date();
  let raw;
  try {
    raw = execFileSync(agentapi, args, {
      cwd: workspace,
      encoding: "utf8",
      timeout: 60_000,
      // Antigravity runs unsandboxed, so it is the path where a worker setting
      // KEYRING_BACKEND=file can actually destroy the credential store. See
      // STRIPPED_ENV.
      env: stripUnsafeEnv({ ...process.env, ...env }),
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    throw new AntiRunError(
      `agentapi ${resumeId ? "send-message" : "new-conversation"} failed`,
      String(err.stderr || err.message).trim().slice(0, 600),
    );
  }

  let conversationId = resumeId || undefined;
  if (!conversationId) {
    try {
      const parsed = JSON.parse(raw);
      conversationId = parsed?.response?.newConversation?.conversationId;
    } catch { /* fall through to the regex below */ }
    if (!conversationId) {
      // The prompt is echoed back in the payload, so match only a bare uuid line.
      conversationId = raw.match(/"conversationId"\s*:\s*"([0-9a-f-]{36})"/)?.[1];
    }
    if (!conversationId) {
      throw new AntiRunError(
        "agentapi did not return a conversation id",
        raw.trim().slice(0, 600),
      );
    }
  }

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
  // Steps are still polled, but only as a fallback for a worker that finished
  // without writing the required Status line.
  const deadline = Date.now() + parseDuration(timeout);
  let last = null;
  let settledAt = null;
  for (;;) {
    if (existsSync(evidenceAbs) && statSync(evidenceAbs).size > 0 && readWorkerStatus(evidenceAbs).reported) {
      break;
    }
    let prevSteps = last?.steps ?? null;
    try {
      last = antiStatus(conversationId);
    } catch {
      last = null; // the database appears a moment after the conversation does
    }
    // Fallback: the conversation settled and left evidence, but no Status line.
    if (last?.state === "done" && last.steps === prevSteps && existsSync(evidenceAbs)) {
      settledAt = last.steps;
      break;
    }
    if (Date.now() > deadline) {
      throw new AntiRunError(
        `app-mode job did not finish within ${timeout}`,
        `conversation ${conversationId}, evidence not written; last seen ${JSON.stringify(last)}`,
      );
    }
    sleepMs(POLL_INTERVAL_MS);
  }

  const endedAt = new Date().toISOString();
  // App mode has no runtime verdict to disagree with -- reaching here means the
  // evidence file appeared, which is the completion signal for this transport.
  const verdict = judgeJob(evidenceAbs, {
    runtimeOk: true,
    context: `app conversation ${conversationId}`,
  });
  const evidenceBytes = verdict.evidenceBytes;

  return {
    worker: "antigravity",
    mode: "app",
    resumedFrom: resumeId ?? null,
    conversationId,
    startedAt: started.toISOString(),
    endedAt,
    durationSec: Math.round((Date.parse(endedAt) - started.getTime()) / 1000),
    steps: settledAt ?? last?.steps ?? null,
    evidence: evidenceAbs,
    evidenceBytes,
    status: verdict.status,
    reportedStatus: verdict.reportedStatus,
    runtimeVerdict: verdict.runtimeVerdict,
  };
}

/** Blocking sleep: these scripts are synchronous CLI tools, not servers. */
function sleepMs(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

export function antiRun(options) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const evidenceAbs = validateEvidencePath(options.evidence, workspace);
  // Antigravity runs with --dangerously-skip-permissions (see buildArgs), so it
  // is ALWAYS outside a sandbox -- unlike Codex, where this is opt-in per job.
  const promptText = appendWorkerContract(readPrompt(options), {
    evidenceAbs,
    workspace,
    unsandboxed: true,
  });
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  parseDuration(timeout); // validate before spending anything

  assertEvidenceAbsent(evidenceAbs);

  const mode = options.mode ?? "headless";
  if (mode === "headless") {
    const resumeId = resolveResume(options, { worker: "antigravity", mode, supportsResume: true });
    return runHeadless({
      promptText, workspace, evidenceAbs, model: options.model, timeout,
      agyMode: options.agyMode, resumeId,
    });
  }
  if (mode === "app") {
    const resumeId = resolveResume(options, { worker: "antigravity", mode, supportsResume: true });
    return runApp({
      promptText, workspace, evidenceAbs, model: options.model, title: options.title, timeout,
      resumeId,
    });
  }
  throw new AntiRunError(`unknown mode "${mode}"`, "use --mode headless or --mode app");
}

export { AntiRunError };
export { parseDuration, validateEvidencePath } from "./crew-guards.mjs";

const KNOWN_FLAGS = new Set([
  "prompt", "promptFile", "evidence", "workspace", "timeout",
  "mode", "agyMode", "model", "title", "manifest", "job", "resume",
]);

/**
 * The message has to print what the CLI actually accepts. KNOWN_FLAGS holds the
 * internal keys, so a raw dump of it would tell the caller to use --promptFile
 * when the flag is --prompt-file.
 */
function knownFlagSpellings(alias) {
  const cliName = Object.fromEntries(Object.entries(alias).map(([cli, key]) => [key, cli]));
  return [...KNOWN_FLAGS].map((key) => `--${cliName[key] ?? key}`);
}

function parseArgv(argv) {
  const out = {};
  const alias = {
    "prompt-file": "promptFile",
    "agy-mode": "agyMode",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new AntiRunError(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    const key = alias[name] ?? name;
    // An unknown flag used to be accepted and ignored, so a typo in --model
    // silently ran the job on the default tier.
    if (!KNOWN_FLAGS.has(key)) {
      throw new AntiRunError(`unknown flag --${name}`, `known flags: ${knownFlagSpellings(alias).join(" ")}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new AntiRunError(`--${name} needs a value`);
    out[key] = value;
    i += 1;
  }
  return out;
}

/** Exit 3: the job finished but a human has to look before it counts. */
function needsHuman(result) {
  return Boolean(result.runtimeVerdict)
    || result.status === "done_unverified"
    || result.status === "blocked"
    || result.status === "needs_context";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let opts = {};
  let result = null;
  let claimed = false;
  // Captured before the job starts so a failed job still has a duration; the
  // failure path never sees the timestamps that antiRun() builds internally.
  const dispatchedAt = new Date().toISOString();

  // Same credential fingerprint the Codex adapter takes, and it matters more
  // here: Antigravity workers run with no sandbox at all. The deletion that
  // actually destroyed the owner's store on 18/09 came from outside a sandbox,
  // so a guard that only covered the sandboxed runtime would cover the safer
  // one -- the reasoning STRIPPED_ENV already spells out in crew-guards.mjs.
  //
  // Two exit paths here, not three: anti-run has no signal handler, so a job
  // whose adapter is killed records nothing at all -- credential check
  // included. That gap predates this guard and is not narrowed by it.
  const credentialsBefore = snapshotCredentialStore();
  /**
   * The credential finding, as a patch fragment to spread into updateJob.
   *
   * A fragment rather than a field, and that is the load-bearing part. Writing
   * `credentialTamper: undefined` on a clean attempt looked harmless -- JSON
   * drops the key -- but updateJob does a plain Object.assign, so it also
   * erased a finding recorded by an earlier attempt. An operator who saw exit 2
   * and re-dispatched the job would get a clean run and a store that was still
   * damaged. Omitting the key leaves the earlier record standing; `failure`
   * next door is cleared on purpose and preserves its history in `notes`, and
   * this field does neither.
   *
   * Each finding carries the directory it was taken in. The gate runs in its
   * own process and does not inherit GOOGLE_WORKSPACE_CLI_CONFIG_DIR, so
   * without this it printed its own default path -- sending whoever reads the
   * alarm to look at a file that was never touched. Found by a live run, not
   * by a fixture: a fixture supplies the path it expects.
   */
  const credentialPatch = () => {
    const dir = displayCredentialDir();
    if (isWatchBlind(credentialsBefore)) return { credentialWatch: `blind:${dir}` };
    const changes = diffCredentialStore(credentialsBefore, snapshotCredentialStore());
    return changes.length ? { credentialTamper: changes.map((c) => ({ ...c, dir })) } : {};
  };
  try {
    opts = parseArgv(process.argv.slice(2));
    // Recorded before the job spawns, not after it returns. A job that is still
    // working has no result to write, so without this the manifest showed it as
    // `pending` with no start time -- and the collect gate cannot tell a live
    // job from one that never launched, nor attribute any file it writes while
    // it runs. `timeoutMs` goes down here for the same reason: the gate needs
    // this job's own allowance to decide when silence means death.
    if (opts.manifest && opts.job) {
      const { assertTransport, claimRunSlot } = await import("./crew-manifest.mjs");
      // Before anything is spawned: a job recorded as one transport and fired
      // down the other leaves a manifest that lies, and the manifest is the only
      // thing later measurement can read.
      assertTransport(opts.manifest, Number(opts.job), opts.mode ?? "headless");
      // Takes a parallel slot inside the manifest lock, or refuses. Counting
      // outside the lock does not work: adapters start milliseconds apart, all
      // read the same count, and all of them proceed.
      claimRunSlot(opts.manifest, Number(opts.job), {
        startedAt: dispatchedAt,
        timeoutMs: parseDuration(opts.timeout ?? DEFAULT_TIMEOUT),
      });
      // Only a job this process actually claimed may be written by its failure
      // path. Without this, a refused second dispatch ("already running") fell
      // into the catch below and recorded the job as `failed` -- erasing the
      // FIRST invocation's `running` state and freeing its slot while it was
      // still working. A guard whose refusal gets overwritten by the caller's
      // own error handler is not a guard.
      claimed = true;
    }
    result = antiRun(opts);
  } catch (err) {
    // A failed job must be recorded, or collect cannot tell a job that broke
    // from one that never started -- both would read as "pending" forever.
    if (opts.manifest && opts.job) {
      try {
        const { updateJob, recordUnclaimedFailure } = await import("./crew-manifest.mjs");
        // A job this process claimed is its own to write. One it never claimed
        // may belong to another invocation that is still running, and that one
        // must not be overwritten -- see recordUnclaimedFailure.
        const record = claimed ? updateJob : recordUnclaimedFailure;
        record(opts.manifest, Number(opts.job), {
          status: "failed",
          startedAt: dispatchedAt,
          endedAt: new Date().toISOString(),
          failure: err.message,
          ...credentialPatch(),
        });
      } catch (manifestErr) {
        console.error(`anti-run: could not record the failure in the manifest: ${manifestErr.message}`);
      }
    }
    console.error(`anti-run: ${err.message}`);
    process.exit(1);
  }

  // Recording the outcome is deliberately outside the try above: the job has
  // already finished by now, so a manifest write that fails must be reported as
  // a bookkeeping problem, never as a failed job.
  if (opts.manifest && opts.job) {
    try {
      const { readManifest, updateJob } = await import("./crew-manifest.mjs");
      const priorJob = readManifest(opts.manifest).jobs.find((j) => j.seq === Number(opts.job)) ?? {};
      const prior = [
        ...(priorJob.notes ?? []),
        // Carried over before `failure` is cleared below, or the retry would
        // erase the only record that an earlier attempt died.
        ...(priorJob.failure ? [`lượt trước fail: ${priorJob.failure}`] : []),
      ];
      updateJob(opts.manifest, Number(opts.job), {
        notes: result.runtimeVerdict
          ? [...prior, `runtime báo fail (${result.runtimeVerdict}) nhưng evidence tự phán ${result.reportedStatus} — cần người đọc`]
          : prior,
        status: result.status,
        reportedStatus: result.reportedStatus,
        runtimeVerdict: result.runtimeVerdict,
        conversationId: result.conversationId,
        // Which session this job continued, and whether the runtime actually
        // honoured it. Recorded even when the answer is "it did not": a job
        // that asked to resume and silently got a fresh session is the one
        // anybody auditing the run needs to find, and `conversationId` alone
        // cannot show it -- it reports the session that ran, not the one asked for.
        resumedFrom: result.resumedFrom ?? null,
        resumeMismatch: result.resumeMismatch,
        // A retry that succeeded must not inherit the previous attempt's
        // failure: the field would keep firing a WARN on a job that is now
        // clean, and a WARN that cries on every retried job is one people learn
        // to scroll past. The history stays in `notes`, which is append-only.
        // `undefined` erases the key on a retry, which the docblock above warns
        // about for credentialTamper. It is deliberate here and safe for the
        // same reason `failure` itself is cleared: the history is preserved in
        // `notes` before this runs, and a stale mismatch flag left on a clean
        // retry would accuse a job that did resume correctly.
        failure: result.resumeMismatch
          ? resumeMismatchDetail(result.resumedFrom, result.conversationId)
          : undefined,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        agentDurationSec: result.agentDurationSec ?? null,
        usage: result.usage ?? null,
        evidenceBytes: result.evidenceBytes,
        ...credentialPatch(),
      });
    } catch (manifestErr) {
      console.error(
        `anti-run: job finished ${result.status} but the manifest was not updated: ${manifestErr.message}\n` +
        `  → the evidence at ${result.evidence} is valid; re-run the manifest update, not the job`,
      );
      console.log(JSON.stringify(result, null, 2));
      process.exit(2); // distinct from 1: the job worked, the bookkeeping did not
    }
  }

  // A runtime that disagreed with self-judging evidence must be said out loud,
  // not resolved quietly in either direction.
  if (result.runtimeVerdict) {
    console.error(
      `anti-run: the runtime disagreed with the evidence (${result.runtimeVerdict})\n` +
      `  → evidence judged itself ${result.reportedStatus}; a human must read ${result.evidence}`,
    );
  }
  // A worker that skipped the contract's Status line cannot be judged silently.
  if (result.status === "done_unverified") {
    console.error(
      `anti-run: evidence has no "Status:" line, so the outcome is unverified\n` +
      `  → ${result.evidence}`,
    );
  }
  console.log(JSON.stringify(result, null, 2));
  // Background dispatch made the exit code the ping, so a job that needs a human
  // must not ping as a clean success.
  process.exit(needsHuman(result) ? 3 : 0);
}
