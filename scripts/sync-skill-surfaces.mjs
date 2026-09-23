#!/usr/bin/env node
/**
 * Keeps the workspace-local skills identical across the four agent surfaces.
 *
 * `.claude/skills/` is the only place a human edits. The other three surfaces
 * are copies, because `seo-crew` dispatches the same job to different runtimes
 * and a worker that reads a stale copy produces a wrong answer confidently.
 *
 * Two rules make the copying safe:
 *   - one direction only. There is no flag to sync a surface back into
 *     `.claude`, because that would silently destroy the canonical version.
 *   - a target file may legitimately differ from canonical in the frontmatter
 *     keys listed in OVERRIDE_KEYS. `.claude/skills/seo-log-cv/SKILL.md` pins
 *     `model: haiku` and the other surfaces must not inherit it. Those lines are
 *     excluded from comparison and preserved on write.
 *
 * Usage:
 *   node mwg-agent-crew/scripts/sync-skill-surfaces.mjs --check
 *   node mwg-agent-crew/scripts/sync-skill-surfaces.mjs --apply
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const CANONICAL = ".claude/skills";
const TARGETS = [".codex/skills", ".agents/skills", ".gemini/skills"];

/**
 * A skill that must also ship inside the module it drives, keyed by skill name.
 *
 * `seo-crew` is the only entry point into `mwg-agent-crew`, but it lived solely
 * in `.claude/skills/`, which is outside the module. The module is published on
 * its own (`git subtree push --prefix=mwg-agent-crew`), so a clone of it got the
 * engine and no way to start it. Mirroring the skill into the module makes that
 * clone complete.
 *
 * This is a mirror, not a second canonical copy: `.claude/skills/` is still the
 * only place a human edits, and `--check` fails the moment the two drift.
 */
const BUNDLED = { "seo-crew": "mwg-agent-crew/skill" };

/** Every surface a given skill is copied to. */
function surfacesFor(skill) {
  const bundle = BUNDLED[skill];
  return bundle ? [...TARGETS, bundle] : TARGETS;
}

/** Skill names a surface is expected to hold, or null for "all owned". */
function expectedAt(surface) {
  const bundled = Object.entries(BUNDLED)
    .filter(([, dir]) => dir === surface)
    .map(([skill]) => skill);
  return bundled.length ? new Set(bundled) : null;
}

/**
 * Only workspace-owned skills. Google Workspace, n8n, gcloud and the anthropic
 * content skills come from upstream sources and are updated by their own
 * installers, so copying them between surfaces would fight those installers.
 */
const OWNED_PREFIXES = ["seo-", "content-", "image-", "onpage-", "tgdd-", "batch-"];

/**
 * Extensions read and written as UTF-8 text, where frontmatter overrides apply.
 * Anything else is copied byte-for-byte: decoding a binary asset such as a PNG
 * logo as UTF-8 replaces every invalid byte with U+FFFD and writes back a file
 * that no longer opens. The allowlist is deliberate — an unlisted extension is
 * treated as binary, so a new asset type is safe by default.
 */
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".rst",
  ".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".bash", ".zsh",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".csv", ".tsv", ".html", ".htm", ".css", ".svg", ".xml", ".sql",
]);

/** True when a skill file is text and can go through the override path. */
function isTextFile(file) {
  return TEXT_EXTENSIONS.has(extname(file).toLowerCase());
}

/** Frontmatter keys a target surface is allowed to differ on. */
const OVERRIDE_KEYS = ["model"];

const abs = (p) => join(REPO_ROOT, p);

/** Skill directories this script owns, by name, from the canonical surface. */
function ownedSkills() {
  return readdirSync(abs(CANONICAL))
    .filter((name) => OWNED_PREFIXES.some((prefix) => name.startsWith(prefix)))
    // A stray archive such as .codex/skills/seo-log-cv.zip is not a skill.
    .filter((name) => statSync(join(abs(CANONICAL), name)).isDirectory())
    .sort();
}

/** Every file inside a skill directory, as paths relative to that directory. */
function filesUnder(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Splits a file into its frontmatter block and the rest. Returns null
 * frontmatter for files that do not open with a `---` fence, which covers
 * reference docs and scripts inside a skill directory.
 */
function splitFrontmatter(text) {
  if (!text.startsWith("---\n")) return { front: null, rest: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { front: null, rest: text };
  return { front: text.slice(4, end + 1), rest: text.slice(end + 1) };
}

const isOverrideLine = (line) => OVERRIDE_KEYS.some((key) => line.startsWith(`${key}:`));

/** The file content with override lines removed, so comparison ignores them. */
function comparable(text) {
  const { front, rest } = splitFrontmatter(text);
  if (front === null) return text;
  const kept = front.split("\n").filter((line) => !isOverrideLine(line));
  return `---\n${kept.join("\n")}${rest}`;
}

/** Override lines present in a target file, to carry over when rewriting it. */
function overrideLines(text) {
  const { front } = splitFrontmatter(text);
  if (front === null) return [];
  return front.split("\n").filter(isOverrideLine);
}

/**
 * Canonical content rewritten so the target keeps its own override lines.
 * Canonical's own override lines are dropped: they belong to `.claude` only.
 */
function contentForTarget(canonicalText, existingTargetText) {
  const keep = existingTargetText === null ? [] : overrideLines(existingTargetText);
  const { front, rest } = splitFrontmatter(canonicalText);
  if (front === null) return canonicalText;
  const kept = front.split("\n").filter((line) => line !== "" && !isOverrideLine(line));
  return `---\n${[...kept, ...keep].join("\n")}\n${rest.replace(/^\n/, "")}`;
}

/** One row per (skill, surface, file). Status drives the exit code. */
function compare() {
  const rows = [];
  for (const skill of ownedSkills()) {
    const canonicalDir = join(abs(CANONICAL), skill);
    const canonicalFiles = filesUnder(canonicalDir);
    for (const surface of surfacesFor(skill)) {
      const targetDir = join(abs(surface), skill);
      if (!existsSync(targetDir)) {
        rows.push({ skill, surface, file: "", status: "MISSING", note: "skill dir absent" });
        continue;
      }
      for (const file of canonicalFiles) {
        const targetFile = join(targetDir, file);
        if (!existsSync(targetFile)) {
          rows.push({ skill, surface, file, status: "MISSING", note: "" });
          continue;
        }
        if (!isTextFile(file)) {
          const canonicalBytes = readFileSync(join(canonicalDir, file));
          const targetBytes = readFileSync(targetFile);
          rows.push({
            skill,
            surface,
            file,
            status: canonicalBytes.equals(targetBytes) ? "SAME" : "DIFF",
            note: "",
          });
          continue;
        }
        const canonicalText = readFileSync(join(canonicalDir, file), "utf8");
        const targetText = readFileSync(targetFile, "utf8");
        if (comparable(canonicalText) === comparable(targetText)) {
          const overrides = [...new Set([...overrideLines(canonicalText), ...overrideLines(targetText)])];
          rows.push({
            skill,
            surface,
            file,
            status: "SAME",
            note: overrides.length ? `override: ${overrides.map((l) => l.split(":")[0]).join(",")}` : "",
          });
        } else {
          rows.push({ skill, surface, file, status: "DIFF", note: "" });
        }
      }
      // Reported, never deleted: an orphan may be a file someone is adding.
      for (const file of filesUnder(targetDir)) {
        if (!canonicalFiles.includes(file)) {
          rows.push({ skill, surface, file, status: "ORPHAN", note: "not in canonical" });
        }
      }
    }
  }
  rows.push(...straysAtSurfaceRoot());
  return rows;
}

/**
 * Anything sitting at a surface root that canonical does not own.
 *
 * The per-skill walk above only ever descends into directories canonical knows
 * about, so nothing at the root itself was ever looked at. A crew job on 26/08
 * found `.codex/skills/seo-log-cv.zip` -- untracked, from 03/08 -- sitting in a
 * surface the parity check had been calling clean for three weeks. The scan
 * reads a directory listing; nothing here deletes.
 */
function straysAtSurfaceRoot() {
  const allOwned = new Set(ownedSkills());
  const rows = [];
  for (const surface of [...TARGETS, ...new Set(Object.values(BUNDLED))]) {
    // A bundle surface holds exactly one skill, so anything else there is a
    // stray even when it is a skill this repo owns elsewhere.
    const owned = expectedAt(surface) ?? allOwned;
    const root = abs(surface);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      // Only what this repo claims. The surfaces also hold skills installed
      // from elsewhere, and calling those strays would make the check noise.
      if (!OWNED_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
      if (entry.isDirectory() && owned.has(entry.name)) continue;
      rows.push({
        skill: entry.name, surface, file: "", status: "ORPHAN",
        note: entry.isDirectory() ? "skill dir not in canonical" : "loose file at surface root",
      });
    }
  }
  return rows;
}

function printSummary(rows) {
  const bad = rows.filter((r) => r.status === "DIFF" || r.status === "MISSING");
  const orphans = rows.filter((r) => r.status === "ORPHAN");
  const bySkill = new Map();
  for (const row of rows) {
    const key = `${row.skill}|${row.surface}`;
    const current = bySkill.get(key) ?? { skill: row.skill, surface: row.surface, status: "SAME", note: "" };
    if (row.status === "DIFF" || row.status === "MISSING") current.status = row.status;
    else if (row.status === "ORPHAN" && current.status === "SAME") current.status = "ORPHAN";
    if (row.note && !current.note.includes(row.note)) current.note = row.note;
    bySkill.set(key, current);
  }
  console.log("SKILL | SURFACE | STATUS | NOTE");
  for (const row of bySkill.values()) {
    console.log(`${row.skill} | ${row.surface} | ${row.status} | ${row.note}`);
  }
  console.log("");
  for (const row of [...bad, ...orphans]) {
    // `file` is empty for a whole-skill row and for a stray at the surface
    // root; printing the separator anyway rendered a loose file as a directory.
    const path = [row.surface, row.skill, row.file].filter(Boolean).join("/");
    console.log(`  ${row.status}: ${path} ${row.note}`);
  }
  const pairs = ownedSkills().reduce((n, skill) => n + surfacesFor(skill).length, 0);
  console.log(
    `\n${ownedSkills().length} skill, ${pairs} skill×surface pair — ` +
      `DIFF/MISSING: ${bad.length}, ORPHAN: ${orphans.length}`,
  );
  return bad.length;
}

function apply(rows) {
  const written = [];
  for (const row of rows) {
    if (row.status !== "DIFF" && row.status !== "MISSING") continue;
    const canonicalDir = join(abs(CANONICAL), row.skill);
    const files = row.file ? [row.file] : filesUnder(canonicalDir);
    for (const file of files) {
      const targetFile = join(abs(row.surface), row.skill, file);
      mkdirSync(dirname(targetFile), { recursive: true });
      if (isTextFile(file)) {
        const existing = existsSync(targetFile) ? readFileSync(targetFile, "utf8") : null;
        const next = contentForTarget(readFileSync(join(canonicalDir, file), "utf8"), existing);
        writeFileSync(targetFile, next);
      } else {
        // Byte-for-byte: no decode, no frontmatter override on a binary asset.
        writeFileSync(targetFile, readFileSync(join(canonicalDir, file)));
      }
      written.push(relative(REPO_ROOT, targetFile));
    }
  }
  if (written.length === 0) console.log("Nothing to write — surfaces already match.");
  for (const path of written) console.log(`wrote ${path}`);
  return written.length;
}

const mode = process.argv[2];
if (mode !== "--check" && mode !== "--apply") {
  console.error("usage: sync-skill-surfaces.mjs --check | --apply");
  process.exit(2);
}

const rows = compare();
if (mode === "--check") {
  process.exit(printSummary(rows) > 0 ? 1 : 0);
}
apply(rows);
process.exit(printSummary(compare()) > 0 ? 1 : 0);
