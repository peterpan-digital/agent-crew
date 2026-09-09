#!/usr/bin/env node
/**
 * Report progress of an Antigravity app-mode conversation without ever writing
 * to its store, and without requiring sqlite3 to be installed.
 *
 * The conversation database cannot be opened with `mode=ro` while the app holds
 * it: SQLite needs to create/attach the -shm file to read an active WAL, and a
 * read-only connection cannot. `immutable=1` does open, but it ignores the WAL
 * entirely and therefore hides the newest steps -- exactly the ones a progress
 * poll cares about. So the database and its sidecars are copied to a temp
 * directory and the copy is queried. The files are small (hundreds of KB).
 *
 * Step status: every step of a finished conversation is observed as status 3,
 * so 3 is treated as terminal and anything else as still running. The enum is
 * not documented, so an unknown status is reported as running rather than
 * silently assumed done -- overreporting "running" is recoverable, claiming a
 * job finished when it did not is not.
 *
 * sqlite3 is optional. macOS ships it at /usr/bin/sqlite3; Windows ships
 * nothing. This module is the one caller of resolveSqlite() (lib/os-probe.mjs)
 * for app mode, and a missing binary is not escalated to an error here: it is
 * returned as `{ available: false, state: "unknown" }` so the poller in
 * adapters/antigravity.mjs can fall back to the evidence file and the timeout
 * alone -- which is the transport's actual completion signal regardless (see
 * that file's runApp comment). Throwing here would fail an otherwise-fine job
 * over a signal the job never needed to succeed.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSqlite } from "../os-probe.mjs";
import { conversationsDir } from "./antigravity-env.mjs";

const TERMINAL_STEP_STATUS = 3;
const SIDECARS = ["", "-wal", "-shm"];
const QUERY_TIMEOUT_MS = 15_000;

export class AntiStatusError extends Error {
  constructor(message, remedy) {
    super(remedy ? `${message}\n  → ${remedy}` : message);
    this.name = "AntiStatusError";
    this.remedy = remedy;
  }
}

export function conversationDbPath(conversationId, store = conversationsDir()) {
  return join(store, `${conversationId}.db`);
}

/** Copy-then-read. Returns whatever the query prints, trimmed. */
function querySnapshot(sqlite, dbPath, sql) {
  if (!existsSync(dbPath)) {
    throw new AntiStatusError(
      `no conversation database at ${dbPath}`,
      "the database file appears a moment after the conversation does -- expected right after new-conversation, retry",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "anti-status-"));
  try {
    const copy = join(dir, "snapshot.db");
    for (const ext of SIDECARS) {
      if (existsSync(`${dbPath}${ext}`)) copyFileSync(`${dbPath}${ext}`, `${copy}${ext}`);
    }
    return execFileSync(sqlite, [copy, sql], {
      encoding: "utf8",
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
    }).trim();
  } catch (err) {
    if (err instanceof AntiStatusError) throw err;
    throw new AntiStatusError(`cannot read ${dbPath}: ${String(err.stderr || err.message).trim()}`);
  } finally {
    // Unconditional, including the throw above: a snapshot dir left behind on
    // every transient miss (the common case moments after new-conversation)
    // would otherwise fill the temp dir over a long crew session.
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Returns { conversationId, available, steps, byStatus, nonTerminal, state }.
 *
 * `state` is "running" | "done" | "unknown". "unknown" fires only when sqlite3
 * is not on this host (`available: false`), and callers must treat it as "no
 * opinion" -- never as "done". Callers that need "did it actually do the work"
 * must check the evidence file regardless of this result; this only says
 * whether the agent is still thinking, and only when it can say anything.
 *
 * `sqlite` is resolved once by the caller (adapters/antigravity.mjs) rather
 * than defaulted per call, so a host missing the binary is not re-probed on
 * every 5-second poll tick.
 */
export function antiStatus(conversationId, { store, sqlite = resolveSqlite() } = {}) {
  if (!sqlite) {
    return {
      conversationId, available: false, steps: null, byStatus: null, nonTerminal: null, state: "unknown",
    };
  }
  const dbPath = conversationDbPath(conversationId, store);
  const rows = querySnapshot(sqlite, dbPath, "select status, count(*) from steps group by status;");
  const byStatus = {};
  let steps = 0;
  for (const line of rows.split("\n").filter(Boolean)) {
    const [status, count] = line.split("|");
    byStatus[status] = Number(count);
    steps += Number(count);
  }
  const nonTerminal = Object.entries(byStatus)
    .filter(([status]) => Number(status) !== TERMINAL_STEP_STATUS)
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    conversationId,
    available: true,
    steps,
    byStatus,
    nonTerminal,
    // A conversation with zero steps has not started yet, which is "running".
    state: steps > 0 && nonTerminal === 0 ? "done" : "running",
  };
}

export { TERMINAL_STEP_STATUS };
