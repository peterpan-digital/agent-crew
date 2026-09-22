/**
 * The three lines every brief must carry, appended by the adapter.
 *
 * The case these exist for: run `crew-260909-1450` lost all three jobs, and the
 * one that had nothing to do with the sandbox lost because its brief omitted
 * the write-scope line. The worker reported into the chat instead of the
 * evidence file. `readPrompt` measured the brief and let it through, because
 * size was the only thing it measured.
 */
import { join, sep } from "node:path";
import { appendWorkerContract, readPrompt, MAX_BRIEF_BYTES } from "../scripts/crew-guards.mjs";
import { makeChecker } from "./helpers.mjs";

const t = makeChecker("worker-contract");

const WS = `${sep}ws`;
const EV = join(WS, "tasks", "t", "reports", "crew-260909-1450", "worker-codex-1.md");
const REL = join("tasks", "t", "reports", "crew-260909-1450", "worker-codex-1.md");
const ctx = { evidenceAbs: EV, workspace: WS };

{
  // The failure this whole guard exists for: a brief with none of the lines.
  const out = appendWorkerContract("## Tình hình\nLàm việc X.", ctx);
  t.check("the write-scope line is added", out.includes(`Chỉ được ghi đúng file: ${REL}`), true);
  t.check("the Status line is added", /Dòng cuối evidence file phải là: Status: DONE \| /.test(out), true);
  t.check("the no-dispatch line is added", /Không được dispatch worker khác\./.test(out), true);
  t.check("the run id comes off the evidence path", out.includes("crew run crew-260909-1450"), true);
  t.check("the author's own text is kept", out.includes("Làm việc X."), true);
}

{
  // A brief that already carries a line keeps the author's wording; two copies
  // of a write-scope rule teaches a worker to pick whichever it prefers.
  const authored = `Chỉ được ghi đúng file: ${REL} (và data bạn tự sinh trong task folder).`;
  const out = appendWorkerContract(`## Cần gì\nX.\n${authored}`, ctx);
  t.check("an already-present line is not duplicated",
    out.split(authored).length - 1, 1);
  t.check("...and the lines it did lack are still added",
    /Không được dispatch worker khác\./.test(out), true);
}

{
  const full = appendWorkerContract("brief", ctx);
  t.check("running it twice changes nothing", appendWorkerContract(full, ctx), full);
}

{
  // Cosmetic only: an evidence path with no run dir must not throw.
  const flat = appendWorkerContract("brief", { evidenceAbs: join(WS, "w.md"), workspace: WS });
  t.check("a path with no run dir still gets the lines",
    flat.includes("Chỉ được ghi đúng file: w.md"), true);
  t.check("...and falls back to an unnamed run",
    flat.includes("trong một crew run"), true);
}

{
  // The ceiling is a discipline on what the dispatcher writes. Charging them
  // for boilerplate they no longer author would make a real limit a moving one.
  const atCap = "x".repeat(MAX_BRIEF_BYTES);
  const out = appendWorkerContract(readPrompt({ prompt: atCap }), ctx);
  t.check("a brief at the cap still passes and gets the lines",
    out.length > MAX_BRIEF_BYTES && out.includes(`Chỉ được ghi đúng file: ${REL}`), true);
}

process.exit(t.finish() ? 0 : 1);
