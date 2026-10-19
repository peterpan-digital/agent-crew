#!/usr/bin/env node
/**
 * The Workspace-token path, and the env strip that guards the credential store.
 *
 * Two things are being protected here, and they fail in opposite directions.
 *
 * The strip is the load-bearing one. On 09/09 a worker set KEYRING_BACKEND=file
 * to dodge a 401; the Workspace CLI could not decrypt the store with the
 * Keychain key, decided it was corrupt, and issued a delete. The Codex sandbox
 * refused the write. On 18/09 the same deletion ran from outside a sandbox and
 * succeeded -- the store was gone and the owner had to re-authenticate. So the
 * assertion that matters is a negative one: the variable is not in the child's
 * env, on every worker path, including the unsandboxed ones.
 *
 * The token is the opposite risk: it must reach the worker that asked for it
 * and no one else, and it must never be written down. A test that only checked
 * "the token arrived" would pass just as happily if it also landed in the log.
 *
 * The happy path is deliberately NOT tested here. Minting needs the real
 * credential store and a live call to Google, and a mock of both would prove
 * only that the mock works -- the plan requires a real probe for that, and the
 * phase report carries it.
 *
 * Run: node mwg-agent-crew/tests/workspace-cli-auth.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STRIPPED_ENV, stripUnsafeEnv, workerEnv } from "../scripts/crew-guards.mjs";
import { FIXTURE_BIN, MODULE_ROOT, makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("workspace-cli-auth");
const ADAPTER = join(MODULE_ROOT, "scripts", "codex-run.mjs");
const ws = tmpWorkspace("wstoken-");
const RUN_DIR_REL = join("tasks", "t", "reports", "crew-test");
mkdirSync(join(ws, RUN_DIR_REL), { recursive: true });
const brief = writeFile(join(ws, "brief.md"), "do the thing\n");

const KEYRING = "GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND";
const TOKEN = "GOOGLE_WORKSPACE_CLI_TOKEN";

// --- the pure guards -------------------------------------------------------

t.check(
  "the keyring backend is on the strip list",
  STRIPPED_ENV.includes(KEYRING),
  true,
);

{
  const got = stripUnsafeEnv({ [KEYRING]: "file", KEEP: "yes" });
  t.check("stripUnsafeEnv removes the keyring override", got[KEYRING], undefined);
  t.check("...and leaves everything else alone", got.KEEP, "yes");
  // anti-run has never set the role itself; its caller does. Starting to set it
  // here would be a behaviour change smuggled in under a security fix.
  t.check("...and does not invent a crew role", got.MWG_CREW_ROLE, undefined);
}

{
  const got = workerEnv();
  t.check("workerEnv sets the recursion guard", got.MWG_CREW_ROLE, "worker");
  t.check("...and strips the keyring override", got[KEYRING], undefined);
}

{
  // The caller passing the var explicitly must not beat the strip: `extra` is
  // spread before the deletion, not after.
  const got = workerEnv({ [KEYRING]: "file" });
  t.check("an explicit override in extra is still stripped", got[KEYRING], undefined);
}

// --- what actually reaches the child ---------------------------------------

/** Runs the adapter the way the skill dispatches it. */
function run({ evidence, extra = [], env = {} }) {
  const proc = spawnSync("node", [
    ADAPTER,
    "--prompt-file", brief,
    "--evidence", evidence,
    "--workspace", ws,
    "--timeout", "60s",
    ...extra,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${process.env.PATH}`,
      FAKE_MODE: "envdump",
      FAKE_EVIDENCE: join(ws, evidence),
      ...env,
    },
    timeout: 90_000,
  });
  return { exit: proc.status, stderr: proc.stderr ?? "", stdout: proc.stdout ?? "" };
}

{
  // The parent is poisoned on purpose: inheritance is the whole attack.
  const evidence = join(RUN_DIR_REL, "strip.md");
  const r = run({ evidence, env: { [KEYRING]: "file" } });
  const body = readFileSync(join(ws, evidence), "utf8");
  t.check("a poisoned parent env still runs", r.exit, 0);
  t.check("...and the child never sees the keyring override", /KEYRING=absent/.test(body), true);
  t.check("...while the recursion guard does arrive", /ROLE=worker/.test(body), true);
}

{
  // Least privilege: a job that did not ask gets nothing, even though the
  // dispatcher could mint one.
  const evidence = join(RUN_DIR_REL, "notoken.md");
  const r = run({ evidence });
  const body = readFileSync(join(ws, evidence), "utf8");
  t.check("a job that did not ask for the CLI runs fine", r.exit, 0);
  t.check("...and carries no Workspace token", /TOKEN=absent/.test(body), true);
}

{
  // A token in the dispatcher's own env must not leak through by inheritance:
  // it is granted per job, not ambient.
  const evidence = join(RUN_DIR_REL, "noinherit.md");
  const r = run({ evidence, env: { [TOKEN]: "inherited-should-not-pass" } });
  const body = readFileSync(join(ws, evidence), "utf8");
  t.check("an ambient token is not what grants access", r.exit, 0);
  // Documents today's behaviour rather than asserting a guard that does not
  // exist: process.env is spread wholesale, so an ambient token does reach the
  // child. Worth knowing, and worth deciding on separately -- see the phase
  // report's open questions.
  t.check("...though today it does still inherit (known gap)", /TOKEN=present/.test(body), true);
}

// --- the flag itself -------------------------------------------------------

{
  const evidence = join(RUN_DIR_REL, "badflag.md");
  const r = run({ evidence, extra: ["--workspace-cli", "maybe"] });
  t.check("an unknown --workspace-cli value is refused", r.exit !== 0, true);
  t.check("...and says what the allowed values are", /use one of: on, off/.test(r.stderr), true);
}

{
  // P6, measured 18/09: the app broker is reused across dispatches, so env
  // injected at dispatch never reaches the job. Accepting the flag would hand
  // back a job that looks authorised and 401s anyway.
  const evidence = join(RUN_DIR_REL, "appmode.md");
  const r = run({ evidence, extra: ["--mode", "app", "--workspace-cli", "on"] });
  t.check("app mode refuses the flag outright", r.exit !== 0, true);
  t.check("...and explains it is the broker, not a typo", /broker is reused/.test(r.stderr), true);
  t.check("...and points at the transport that does work", /--mode headless/.test(r.stderr), true);
}

// --- minting, when the credential store cannot answer ----------------------

{
  // A dispatcher that cannot authenticate must fail here, with that reason. The
  // failure this replaces was a spawned worker walking into a bare 401 it had
  // no way to read as "the dispatcher could not authenticate".
  const fakeBin = join(ws, "badbin");
  mkdirSync(fakeBin, { recursive: true });
  const stub = join(fakeBin, "gws");
  writeFileSync(stub, "#!/bin/bash\necho 'no credentials' >&2\nexit 1\n");
  chmodSync(stub, 0o755);

  const evidence = join(RUN_DIR_REL, "mintfail.md");
  const r = run({
    evidence,
    extra: ["--workspace-cli", "on"],
    env: { PATH: `${fakeBin}:${FIXTURE_BIN}:${process.env.PATH}` },
  });
  t.check("a mint that cannot read the store fails the job", r.exit !== 0, true);
  t.check("...naming the credential read, not a 401", /Workspace credentials/.test(r.stderr), true);
  // Nothing spawned means nothing wrote: the fake codex would have created it.
  const wrote = readdirSync(join(ws, RUN_DIR_REL)).includes("mintfail.md");
  t.check("...and no worker was spawned", wrote, false);
}

// --- the token must not be written down ------------------------------------

{
  // Whatever else changes, the log is the thing a token would outlive the job
  // in. Checked against the strip case, which is the only run here that
  // definitely produced a log.
  const logDir = join(ws, "tasks", "t", "data", "crew-logs", "crew-test");
  let logs = "";
  try {
    for (const f of readdirSync(logDir)) logs += readFileSync(join(logDir, f), "utf8");
  } catch { /* no log dir means nothing to leak */ }
  t.check("no log carries a token value", /inherited-should-not-pass/.test(logs), false);
}

process.exit(t.finish() ? 0 : 1);
