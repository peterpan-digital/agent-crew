#!/usr/bin/env node
/**
 * The one entrypoint. Every subcommand is `node bin/crew.mjs <cmd> ...`.
 *
 * One entrypoint rather than a script per stage, for two reasons that both cost
 * real runs in the version this was ported from:
 *
 *   - Each script had its own `if (import.meta.url === \`file://${process.argv[1]}\`)`
 *     guard. That comparison is false on Windows -- `import.meta.url` is
 *     `file:///C:/...` while argv[1] is `C:\...` -- so every one of those
 *     scripts would have loaded, done nothing, and exited 0. Four silent no-ops.
 *   - Argument parsing was duplicated per script and had already drifted.
 *
 * Exit codes are the interface. A crew job is dispatched into the background, so
 * the exit code is the only ping the dispatcher gets, and each subcommand
 * documents its own.
 */
import { pathToFileURL } from "node:url";
import { findWorkspace } from "../lib/config.mjs";

const USAGE = `crew — dispatch and verify parallel agent jobs

  crew doctor                       what will actually run on this machine
  crew init                         write crew.config.json and .crew/.gitignore

  crew new-run [--label "..."]      open a run, print its id and manifest path
  crew add-job --worker W --role R --title "..." (--model M | --effort E)
               [--allow <prefix>]…  append a job, print its evidence + brief path
  crew run --job N                  dispatch job N (run this in the background)
  crew watch --job N                follow a codex job's event stream
  crew retry-log --job N            move a failed attempt's log aside for a retry

  crew claim --job N                mark a claude job running (so its writes are attributable)
  crew finish --job N               record a claude job's outcome from its evidence
  crew note --job N --text "..."    append a note to a job

  crew collect <manifest.json>      the review gate; its exit code is the verdict

Every command takes --manifest <path>; without it, the newest run is used.
Workers: antigravity | codex | claude.  Roles: owner | assist.
`;

const COMMANDS = {
  doctor: async () => (await import("../lib/cli/setup.mjs")).doctor,
  init: async () => (await import("../lib/cli/setup.mjs")).init,
  "new-run": async () => (await import("../lib/cli/run.mjs")).newRun,
  "add-job": async () => (await import("../lib/cli/run.mjs")).addJobCmd,
  claim: async () => (await import("../lib/cli/run.mjs")).claim,
  finish: async () => (await import("../lib/cli/run.mjs")).finish,
  note: async () => (await import("../lib/cli/run.mjs")).note,
  "retry-log": async () => (await import("../lib/cli/run.mjs")).retryLog,
  run: async () => (await import("../lib/cli/dispatch.mjs")).dispatch,
  watch: async () => (await import("../lib/cli/watch.mjs")).watch,
  collect: async () => {
    const { main } = await import("../lib/collect.mjs");
    return (argv) => main(argv);
  },
};

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  const loader = COMMANDS[cmd];
  if (!loader) {
    console.error(`crew: unknown command "${cmd}"\n`);
    console.error(USAGE);
    return 2;
  }
  const run = await loader();
  return run(rest, { cwd: findWorkspace() });
}

// pathToFileURL, not string concatenation: the naive comparison is the Windows
// bug described in the header.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      // `detail` is where the guards put the "→ do this instead" line, and it
      // is the half that makes an error actionable.
      console.error(`crew: ${err.message}`);
      process.exit(2);
    });
}
