#!/usr/bin/env node
/**
 * Report progress of an Antigravity conversation without ever writing to its
 * store.
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
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATIONS, resolveAntiEnv } from "./anti-env.mjs";

const TERMINAL_STEP_STATUS = 3;
const SQLITE = "/usr/bin/sqlite3";
const SIDECARS = ["", "-wal", "-shm"];

class AntiStatusError extends Error {
  constructor(message) {
    super(message);
    this.name = "AntiStatusError";
  }
}

export function conversationDbPath(conversationId, store = CONVERSATIONS) {
  return join(store, `${conversationId}.db`);
}

/** Copy-then-read. Returns whatever the query prints, trimmed. */
function querySnapshot(dbPath, sql) {
  if (!existsSync(dbPath)) {
    throw new AntiStatusError(`no conversation database at ${dbPath}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "anti-status-"));
  try {
    const copy = join(dir, "snapshot.db");
    for (const ext of SIDECARS) {
      if (existsSync(`${dbPath}${ext}`)) copyFileSync(`${dbPath}${ext}`, `${copy}${ext}`);
    }
    return execFileSync(SQLITE, [copy, sql], { encoding: "utf8", timeout: 15_000 }).trim();
  } catch (err) {
    if (err instanceof AntiStatusError) throw err;
    throw new AntiStatusError(`cannot read ${dbPath}: ${String(err.stderr || err.message).trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Returns { conversationId, steps, byStatus, state: "running"|"done", nonTerminal }.
 * Callers that need "did it actually do the work" must check the evidence file;
 * this only says whether the agent is still thinking.
 */
export function antiStatus(conversationId, { store = CONVERSATIONS } = {}) {
  const dbPath = conversationDbPath(conversationId, store);
  const rows = querySnapshot(dbPath, "select status, count(*) from steps group by status;");
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
    steps,
    byStatus,
    nonTerminal,
    // A conversation with zero steps has not started yet, which is "running".
    state: steps > 0 && nonTerminal === 0 ? "done" : "running",
  };
}

/** Confirms the conversation exists in the app, independent of the database. */
export function antiExists(conversationId, workspace) {
  const { agentapi, env } = resolveAntiEnv(workspace);
  try {
    const raw = execFileSync(agentapi, ["get-conversation-metadata", conversationId], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, ...env },
    });
    return Boolean(JSON.parse(raw)?.response?.conversationMetadata);
  } catch {
    return false;
  }
}

export { AntiStatusError, TERMINAL_STEP_STATUS };

if (import.meta.url === `file://${process.argv[1]}`) {
  const conversationId = process.argv[2];
  if (!conversationId) {
    console.error("usage: anti-status.mjs <conversation-id> [workspace]");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(antiStatus(conversationId), null, 2));
  } catch (err) {
    console.error(`anti-status: ${err.message}`);
    process.exit(1);
  }
}
