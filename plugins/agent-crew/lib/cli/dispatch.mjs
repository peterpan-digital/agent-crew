#!/usr/bin/env node
/**
 * `crew run --job N` -- dispatch one job that is already in the manifest.
 *
 * Everything about the job is read back out of the manifest rather than passed
 * again on the command line: which worker, which tier, where the evidence goes.
 * The version this was ported from passed all of it twice, and then needed two
 * written rules ("--model must match what you recorded", "--mode must match the
 * transport you recorded") plus a guard to catch the case where they disagreed.
 * Reading the record removes the disagreement instead of policing it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { assertTransport, readManifest } from "../manifest.mjs";
import { GuardError } from "../guards.mjs";
import { runJob } from "../job-runner.mjs";
import { antiRun } from "../../adapters/antigravity.mjs";
import { codexRun } from "../../adapters/codex.mjs";
import { int, parse } from "./args.mjs";
import { defaultManifest } from "./run.mjs";

const ADAPTERS = {
  antigravity: { name: "antigravity", fn: antiRun },
  codex: { name: "codex", fn: codexRun },
};

export async function dispatch(argv, { cwd }) {
  const parsed = parse(argv, {
    manifest: "value", job: "value", timeout: "value",
    "idle-timeout": "value", "prompt-mode": "value", "agy-mode": "value",
    brief: "value", transport: "value", title: "value",
  });
  const config = loadConfig({ workspace: cwd });
  const manifestPath = parsed.values.get("manifest") ?? defaultManifest(config);
  const seq = int(parsed, "job", { required: true });
  const manifest = readManifest(manifestPath);
  const job = manifest.jobs.find((j) => j.seq === seq);
  if (!job) throw new GuardError(`no job ${seq} in ${manifestPath}`);

  if (job.worker === "claude") {
    throw new GuardError(
      `job ${seq} is a claude job — nothing is dispatched for it`,
      "the dispatcher does that work itself, then records it with `crew finish --job N`",
    );
  }
  const adapter = ADAPTERS[job.worker];
  if (!adapter) throw new GuardError(`no adapter for worker "${job.worker}"`);

  // The transport is read off the record like everything else, and then checked
  // against the record. That looks circular and is not: `--transport` exists so
  // a caller can be explicit, and this is where an explicit value that
  // contradicts the ledger is refused. It has to happen before the slot is
  // claimed -- a refusal after the claim leaks the slot for the rest of the run.
  const transport = parsed.values.get("transport") ?? job.transport ?? "headless";
  assertTransport(manifestPath, seq, transport);

  const briefPath = parsed.values.get("brief")
    ?? join(manifest.workspace, manifest.evidenceRoot, `brief-${job.worker}-${seq}.md`);
  if (!existsSync(briefPath)) {
    throw new GuardError(
      `no brief at ${briefPath}`,
      "write the brief before dispatching; `crew add-job` printed the path it expects",
    );
  }

  const opts = {
    manifest: manifestPath,
    job: seq,
    workspace: manifest.workspace,
    evidenceRoot: manifest.evidenceRoot,
    evidence: job.evidence,
    promptFile: briefPath,
    maxBytes: config.briefMaxBytes,
    timeout: parsed.values.get("timeout") ?? config.defaultTimeout,
    // Read off the record, so the manifest and the process cannot disagree.
    model: job.model ?? undefined,
    effort: job.effort ?? undefined,
    idle: parsed.values.get("idle-timeout") ?? config.defaultIdleTimeout,
    promptMode: parsed.values.get("prompt-mode") ?? "auto",
    agyMode: parsed.values.get("agy-mode") ?? undefined,
    transport,
    // App mode puts a real conversation in front of a person, so it gets a
    // human-readable name. The job title is already that, and defaulting to it
    // means nobody has to type the same string twice.
    title: parsed.values.get("title") ?? job.title ?? undefined,
  };

  return runJob({ name: adapter.name, adapter: adapter.fn, opts });
}
