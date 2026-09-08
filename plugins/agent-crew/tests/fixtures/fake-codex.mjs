/**
 * A stand-in for the codex CLI, so the adapter's lifecycle can be tested
 * without spending a real Codex run -- and so failure shapes that a real run
 * will not produce on demand can be produced deliberately.
 *
 * Node rather than a shell script: the suite has to run on Windows too, where
 * there is no bash and no exec bit. `tests/helpers.mjs` writes the per-platform
 * launcher that hands this file to `process.execPath`.
 *
 * FAKE_MODE picks the shape. FAKE_EVIDENCE is where the "worker" writes.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("fake-codex 0.0.1\n");
  process.exit(0);
}

const mode = process.env.FAKE_MODE ?? "";
const evidencePath = process.env.FAKE_EVIDENCE ?? "";

/** One JSONL event on stdout: the heartbeat the adapter's watchdog keys on. */
const event = () => process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
const evidence = (body) => writeFileSync(evidencePath, body);

switch (mode) {
  case "ok":
    event();
    evidence("work\n\nStatus: DONE\nSummary: ok\nConcerns/Blockers: none\n");
    process.exit(0);
    break;

  case "grandchild": {
    // Exits at once, but a grandchild keeps this process's stdout open. Settling
    // on `close` waits for that pipe to reach EOF, which is the hang the
    // adapter's drain window exists to bound.
    event();
    evidence("work\n\nStatus: DONE\nSummary: ok\n");
    const holder = spawn(
      process.execPath,
      // It only has to keep the inherited stdout descriptor open; writing to it
      // afterwards would just raise EPIPE against a reader that has gone.
      ["-e", "setTimeout(() => {}, 30000)"],
      { stdio: ["ignore", "inherit", "ignore"], detached: true, windowsHide: true },
    );
    holder.unref();
    process.exit(0);
    break;
  }

  case "nodrain":
    // Exits without reading stdin -> EPIPE on a brief over the pipe buffer.
    process.exit(7);
    break;

  case "stderr_only":
    // Never emits a stdout event: the watchdog must still fire. The interval is
    // what keeps this process alive, so there is nothing else to do here.
    //
    // Two ways out, both so this can never be the process that outlives the
    // suite: the pipe breaking (the adapter above was killed) and a hard
    // ceiling well past any test's own deadline.
    process.stderr.on("error", () => process.exit(0));
    setTimeout(() => process.exit(0), 120_000);
    setInterval(() => process.stderr.write("still working...\n"), 1000);
    break;

  case "blocked":
    event();
    evidence("stopped\n\nStatus: BLOCKED\nConcerns/Blockers: COST_GATE — Ahrefs\n");
    process.exit(0);
    break;

  case "no_status":
    // Finished, but ignored the contract's Status line.
    event();
    evidence("did some work and forgot the contract\n");
    process.exit(0);
    break;

  default:
    process.stderr.write(`fake-codex: unknown FAKE_MODE '${mode}'\n`);
    process.exit(99);
}
