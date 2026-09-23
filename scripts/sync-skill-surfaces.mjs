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
 *   node mwg-agent-crew/scripts/sync-skill-surfaces.mjs --bless
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join, relative } from "node:path";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const CANONICAL = ".claude/skills";
const TARGETS = [".codex/skills", ".agents/skills", ".gemini/skills"];

/**
 * A hand-maintained generic derivative of a canonical skill, keyed by skill name.
 *
 * `mwg-agent-crew` is published on its own, so a clone of it needs the skill that
 * drives it. But canonical `seo-crew` is written for THIS workspace: it names a
 * KPI, `seo-task-*`, File 1 / File 2, `tasks/_registry.md`. Shipping that to a
 * stranger hands them a skill pointing at things they do not have.
 *
 * So the module ships `skill/agent-crew/`: the same machinery with the local
 * details lifted out into fill-in blanks. It is a DERIVATIVE, not a mirror --
 * copying canonical over it would undo the whole point, which is exactly what
 * the first version of this block did.
 *
 * Nothing here is ever written by `--apply`. What is tracked instead is drift:
 * the derivative records the canonical fingerprint it was last reconciled
 * against, and `--check` reports STALE once canonical moves, so a human re-reads
 * both and runs `--bless`. Without that the generic copy rots silently, which is
 * the failure mode every other gate in this repo exists to catch.
 */
const DERIVED = { "seo-crew": "mwg-agent-crew/skill/agent-crew" };

/** File inside a derivative holding the canonical fingerprint it matches. */
const STAMP = ".derived-from";

/** Fingerprint of a canonical skill: every file, name and content. */
function canonicalFingerprint(skill) {
  const dir = join(abs(CANONICAL), skill);
  const h = createHash("sha256");
  for (const file of filesUnder(dir)) {
    h.update(file);
    h.update(readFileSync(join(dir, file)));
  }
  return h.digest("hex");
}

/** One row per derivative: SAME, STALE, or MISSING. */
function derivedRows() {
  const rows = [];
  for (const [skill, dir] of Object.entries(DERIVED)) {
    if (!existsSync(abs(dir))) {
      rows.push({ skill, surface: dir, file: "", status: "MISSING", note: "derivative absent" });
      continue;
    }
    const stampPath = join(abs(dir), STAMP);
    const want = canonicalFingerprint(skill);
    const got = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : "";
    rows.push(
      got === want
        ? { skill, surface: dir, file: "", status: "SAME", note: "derived, reconciled" }
        : {
            skill, surface: dir, file: "", status: "STALE",
            note: got ? "canonical moved since last reconcile" : `no ${STAMP} recorded`,
          },
    );
  }
  return rows;
}

/** Record that a derivative has been re-read against the current canonical. */
function bless() {
  for (const [skill, dir] of Object.entries(DERIVED)) {
    if (!existsSync(abs(dir))) {
      console.error(`cannot bless ${dir}: it does not exist`);
      process.exit(2);
    }
    writeFileSync(join(abs(dir), STAMP), `${canonicalFingerprint(skill)}\n`);
    console.log(`blessed ${dir} against ${CANONICAL}/${skill}`);
  }
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
    for (const surface of TARGETS) {
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
  rows.push(...derivedRows());
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
  const owned = new Set(ownedSkills());
  const rows = [];
  for (const surface of TARGETS) {
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
  const stale = rows.filter((r) => r.status === "STALE");
  for (const row of stale) {
    console.log(`  STALE: ${row.surface} — ${row.note}. Re-read it against canonical, then --bless`);
  }
  console.log(
    `\n${ownedSkills().length} skill × ${TARGETS.length} surface, ` +
      `${Object.keys(DERIVED).length} derived — ` +
      `DIFF/MISSING: ${bad.length}, ORPHAN: ${orphans.length}, STALE: ${stale.length}`,
  );
  return bad.length + stale.length;
}

function apply(rows) {
  // A derivative is hand-written and diverges on purpose. Left in, a MISSING row
  // for one would make --apply create `<derivative>/seo-crew/` out of canonical
  // -- reinstating exactly the overwrite this design exists to prevent.
  const derivedDirs = new Set(Object.values(DERIVED));
  const written = [];
  for (const row of rows) {
    if (derivedDirs.has(row.surface)) continue;
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
if (mode !== "--check" && mode !== "--apply" && mode !== "--bless") {
  console.error("usage: sync-skill-surfaces.mjs --check | --apply | --bless");
  process.exit(2);
}

if (mode === "--bless") {
  bless();
  process.exit(0);
}

const rows = compare();
if (mode === "--check") {
  process.exit(printSummary(rows) > 0 ? 1 : 0);
}
apply(rows);
process.exit(printSummary(compare()) > 0 ? 1 : 0);
