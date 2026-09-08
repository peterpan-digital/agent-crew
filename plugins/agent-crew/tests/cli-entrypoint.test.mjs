#!/usr/bin/env node
/**
 * The entrypoint actually runs, and its output actually arrives.
 *
 * Both halves are here because both failed, and both failed silently with exit
 * 0 -- the one outcome this tool must never produce:
 *
 *   1. `bin/crew.mjs` guarded its work behind `import.meta.url ===
 *      pathToFileURL(process.argv[1]).href`. That is true only when the two
 *      paths are spelled identically, and `import.meta.url` is resolved through
 *      symlinks while argv[1] is whatever the caller typed. Run through
 *      `/tmp/...` on macOS -- `/tmp` being a symlink to `/private/tmp` -- the
 *      comparison was false, main() never ran, and the command exited 0 having
 *      printed nothing. Windows has the same hazard in three more spellings.
 *      The guard is gone; these cases keep it gone.
 *   2. The entrypoint ended in `process.exit(code)`, which discards stdout
 *      writes still queued. On a pipe -- how every caller reads this, including
 *      the harness that dispatches jobs -- console.log IS queued. spawnSync
 *      below uses pipes, so any regression shows up as empty output.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREW_CLI, MODULE_ROOT, makeChecker, trySymlink } from "./helpers.mjs";

const t = makeChecker("cli-entrypoint");

const run = (cli, args, cwd) => spawnSync(process.execPath, [cli, ...args], {
  cwd, encoding: "utf8", timeout: 60_000,
});

// --- E1: the program runs and its output reaches a pipe --------------------
{
  const help = run(CREW_CLI, ["--help"], MODULE_ROOT);
  t.check("--help exits 0", help.status, 0);
  t.check("...and prints the usage to stdout", /crew doctor/.test(help.stdout ?? ""), true);
  // Guards against a return to process.exit(): the usage text is ~1.5 KB, which
  // is large enough to still be queued when a synchronous exit would fire.
  t.check("...all of it, not a truncated head", (help.stdout ?? "").includes("crew collect"), true);
}

// --- E2: the same file reached through a symlinked path -------------------
{
  const dir = mkdtempSync(join(tmpdir(), "crew-link-"));
  const link = join(dir, "plugin-link");
  const refused = trySymlink(MODULE_ROOT, link, "dir");
  if (refused) {
    t.skip("a symlinked plugin path still runs", refused);
    t.skip("...and prints the same usage", refused);
  } else {
    const viaLink = run(join(link, "bin", "crew.mjs"), ["--help"], dir);
    // The bug produced exit 0 with empty output, so the exit code alone proves
    // nothing here -- the output is the assertion that matters.
    t.check("a symlinked plugin path still runs", viaLink.status, 0);
    t.check("...and prints the same usage", /crew doctor/.test(viaLink.stdout ?? ""), true);
  }
  rmSync(dir, { recursive: true, force: true });
}

// --- E3: an unknown command is refused, loudly ----------------------------
{
  const bogus = run(CREW_CLI, ["nope"], MODULE_ROOT);
  t.check("an unknown command exits 2", bogus.status, 2);
  t.check("...and names what was not understood", /unknown command "nope"/.test(bogus.stderr ?? ""), true);
  t.check("...and still prints the usage", /crew doctor/.test(bogus.stderr ?? ""), true);
}

// --- E4: no arguments is a usage error, not a silent success --------------
{
  const bare = run(CREW_CLI, [], MODULE_ROOT);
  t.check("no arguments exits 2", bare.status, 2);
  t.check("...and prints the usage", /crew new-run/.test(bare.stdout ?? ""), true);
}

process.exit(t.finish() ? 0 : 1);
