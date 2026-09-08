#!/usr/bin/env node
/**
 * Flag parsing for every subcommand.
 *
 * Deliberately strict in one way: an unknown flag is an error. An unknown flag
 * that is accepted and ignored is how a typo in `--effort` silently runs a job
 * at the wrong tier, or a typo in `--idle-timeout` silently disables a watchdog.
 * Both have happened.
 */
export class ArgError extends Error {
  constructor(message, detail) {
    super(detail ? `${message}\n  ${detail}` : message);
    this.name = "ArgError";
  }
}

/**
 * `spec` maps flag name (without `--`) to "value" | "flag" | "list".
 * Returns `{ values, flags, lists, positional }`.
 */
export function parse(argv, spec) {
  const values = new Map();
  const flags = new Set();
  const lists = new Map();
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    // `--name=value` is accepted because it is what people type, and because it
    // removes the "value that looks like a flag" ambiguity entirely.
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    const kind = spec[name];
    if (!kind) {
      throw new ArgError(`unknown flag --${name}`, `known flags: ${Object.keys(spec).map((f) => `--${f}`).join(" ")}`);
    }
    if (kind === "flag") {
      if (inlineValue !== null) throw new ArgError(`--${name} takes no value`);
      flags.add(name);
      continue;
    }
    let value = inlineValue;
    if (value === null) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new ArgError(`--${name} needs a value`);
      i += 1;
    }
    if (kind === "list") lists.set(name, [...(lists.get(name) ?? []), value]);
    else values.set(name, value);
  }
  return { values, flags, lists, positional };
}

/** A required flag, with the error naming the flag rather than the field. */
export function required(parsed, name) {
  const v = parsed.values.get(name);
  if (v === undefined || v === "") throw new ArgError(`--${name} is required`);
  return v;
}

/** An integer flag, rejected rather than coerced. */
export function int(parsed, name, { required: req = false } = {}) {
  const raw = parsed.values.get(name);
  if (raw === undefined) {
    if (req) throw new ArgError(`--${name} is required`);
    return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ArgError(`--${name} needs a whole number, got "${raw}"`);
  return n;
}
