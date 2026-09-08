#!/usr/bin/env node
/**
 * `crew watch --job N` -- a heartbeat for a long Codex job.
 *
 * Replaces `tail -f <stream> | grep -E ...`, which is three portability
 * problems in one line: `tail -f` and `grep --line-buffered` are not on
 * Windows, and the filter had to be written by hand every time. Written by
 * hand, it was also written wrong: a filter that greps only for success makes a
 * silently crashlooping job look exactly like a healthy one, and silence is not
 * good news.
 *
 * So the event set is fixed here and covers every terminal branch:
 *
 *   turn.completed  the job finished a turn
 *   turn.failed     the job failed one
 *   crew.note       the adapter itself wrote something into the stream -- this
 *                   is how a watchdog kill becomes visible rather than just
 *                   looking like the log stopping
 *
 * Those three are the whole ending. Verified against the codex event enum:
 * thread.started | turn.started | turn.completed | turn.failed | item.started |
 * item.updated | item.completed -- note there is no `type: "error"`, which is
 * why a hand-written filter for one would have waited forever.
 */
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { readManifest } from "../manifest.mjs";
import { GuardError, parseDuration } from "../guards.mjs";
import { resolveLogDir } from "../../adapters/codex.mjs";
import { int, parse } from "./args.mjs";
import { defaultManifest } from "./run.mjs";

const TERMINAL_TYPES = new Set(["turn.completed", "turn.failed", "crew.note"]);
const POLL_MS = 1000;
/** Margin past the job's own timeout, so the adapter has time to record a kill. */
const WATCH_MARGIN_MS = 5 * 60_000;

/** Blocking sleep: this is a synchronous CLI tool following a file, not a server. */
function sleepMs(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

export function watch(argv, { cwd }) {
  const parsed = parse(argv, { manifest: "value", job: "value", timeout: "value" });
  const config = loadConfig({ workspace: cwd });
  const manifestPath = parsed.values.get("manifest") ?? defaultManifest(config);
  const seq = int(parsed, "job", { required: true });
  const manifest = readManifest(manifestPath);
  const job = manifest.jobs.find((j) => j.seq === seq);
  if (!job) throw new GuardError(`no job ${seq} in ${manifestPath}`);
  if (job.worker !== "codex") {
    throw new GuardError(
      `job ${seq} is a ${job.worker} job and has no event stream`,
      "only the codex adapter writes one; watch its exit code instead",
    );
  }

  const evidenceAbs = join(manifest.workspace, job.evidence);
  const base = job.evidence.split("/").pop().replace(/\.md$/, "");
  const streamPath = job.stream ?? join(resolveLogDir(evidenceAbs), `${base}.codex-stream.jsonl`);
  // The bound comes from the job's own allowance plus a margin, not from a
  // duration of its own: the job cannot outlive its timeout, so anything longer
  // would be this command waiting on a corpse. It deliberately does NOT reuse
  // parseDuration's default -- that function caps at the 30m *job* ceiling, and
  // a watch on a 30m job legitimately has to outlast it. (Written the naive way
  // first, with a "35m" default: parseDuration refused it, so watch failed
  // instantly on every job.)
  const jobAllowance = Number.isFinite(job.timeoutMs) && job.timeoutMs > 0
    ? job.timeoutMs
    : 30 * 60_000;
  const waitMs = parsed.values.get("timeout")
    ? parseDuration(parsed.values.get("timeout"))
    : jobAllowance + WATCH_MARGIN_MS;
  const deadline = Date.now() + waitMs;

  console.log(`watching job ${seq}: ${streamPath}`);
  let offset = 0;
  let residual = "";

  for (;;) {
    if (Date.now() > deadline) {
      console.log(`watch: hết thời gian chờ, job ${seq} chưa có event kết thúc`);
      return 1;
    }
    if (!existsSync(streamPath)) {
      // The stream appears a moment after dispatch. A job that never writes one
      // is caught by the collect gate's stale check, not here.
      sleepMs(POLL_MS);
      continue;
    }
    const size = statSync(streamPath).size;
    if (size > offset) {
      const fd = openSync(streamPath, "r");
      try {
        const buf = Buffer.allocUnsafe(size - offset);
        const read = readSync(fd, buf, 0, buf.length, offset);
        offset += read;
        const parts = (residual + buf.subarray(0, read).toString("utf8")).split("\n");
        residual = parts.pop() ?? "";
        for (const line of parts) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (!TERMINAL_TYPES.has(event?.type)) continue;
          // Only the type and the job are printed. The event body is worker
          // output, and worker output is data to be read deliberately, not
          // text to be piped into a reader's context.
          console.log(`job ${seq}: ${event.type}`);
          if (event.type === "crew.note") console.log(`  (adapter đã can thiệp — đọc ${streamPath})`);
          return event.type === "turn.completed" ? 0 : 3;
        }
      } finally {
        closeSync(fd);
      }
    }
    sleepMs(POLL_MS);
  }
}
