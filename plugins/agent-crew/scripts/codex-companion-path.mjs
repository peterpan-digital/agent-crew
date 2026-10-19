/**
 * Where `codex-companion.mjs` lives.
 *
 * The companion is the runtime underneath the Codex plugin's `codex-rescue`
 * subagent, and it is the only way into a real Codex app thread. It sits
 * outside this repo, in the plugin install, so its path has to be discovered
 * rather than imported.
 *
 * The crew calls it directly instead of going through the subagent. Not because
 * the subagent's transport is bad -- it drives the same app-server -- but
 * because `agents/codex-rescue.md` forbids the subagent from polling,
 * monitoring, fetching results, or cancelling. A dispatcher that may not look is
 * how a Codex job died at minute two on 2026-08-24 and was found at minute
 * twenty-two.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REL = join("scripts", "codex-companion.mjs");

/**
 * Marketplace path only, plus an explicit env override.
 *
 * `~/.claude/plugins/cache/` is deliberately not probed. Measured 2026-08-25,
 * the cache path carries a version segment (`cache/openai-codex/codex/1.0.5/
 * scripts/...`), so probing it means writing a semver sort to pick "the newest"
 * -- and the newest copy on disk is not necessarily the one actually running.
 * A machine that only has the cache sets MWG_CODEX_COMPANION by hand: one
 * explicit line beats a guessing function.
 */
export function companionCandidates(env = process.env, home = homedir()) {
  const out = [];
  if (env.CLAUDE_PLUGIN_ROOT) out.push(join(env.CLAUDE_PLUGIN_ROOT, REL));
  out.push(join(home, ".claude", "plugins", "marketplaces", "openai-codex", "plugins", "codex", REL));
  return out;
}

/**
 * Throws rather than falling back to headless. Silently switching transport is
 * the exact class of failure this harness exists to catch: the manifest would
 * say `app`, no chat box would open, and nobody would know which one lied.
 */
export function resolveCompanion(env = process.env, home = homedir()) {
  // An explicit override is authoritative. If someone names a path and it is not
  // there, that is the error -- searching on would hand them a different
  // companion than the one they asked for, which is the same silent
  // substitution this module refuses everywhere else.
  if (env.MWG_CODEX_COMPANION) {
    if (existsSync(env.MWG_CODEX_COMPANION)) return env.MWG_CODEX_COMPANION;
    const err = new Error("MWG_CODEX_COMPANION points at nothing");
    err.detail =
      `probed:\n    ${env.MWG_CODEX_COMPANION}\n` +
      "  → fix MWG_CODEX_COMPANION, or unset it to use the marketplace install";
    throw err;
  }
  const candidates = companionCandidates(env, home);
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  const err = new Error("could not find codex-companion.mjs");
  err.detail =
    `probed:\n${candidates.map((p) => `    ${p}`).join("\n")}\n` +
    "  → set MWG_CODEX_COMPANION to its absolute path";
  throw err;
}
