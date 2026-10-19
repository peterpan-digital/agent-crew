/**
 * Fingerprinting the credential store.
 *
 * The incident this exists for, 18/09/2026: a worker set
 * GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file to dodge a 401, the Workspace CLI
 * then could not decrypt the store with the Keychain key, concluded the file
 * was corrupt, and issued a delete. Inside the Codex sandbox the write was
 * refused. Outside one -- which is where Antigravity workers run -- the same
 * delete succeeded and the owner had to re-authenticate from scratch.
 *
 * So deletion is not an edge case here, it is the main case.
 */
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  snapshotCredentialStore, diffCredentialStore, IMMUTABLE_CREDENTIAL_FILES,
  isWatchBlind, displayCredentialDir,
} from "../scripts/crew-guards.mjs";
import { makeChecker, tmpWorkspace } from "./helpers.mjs";

const t = makeChecker("credential-guard");

function store(files) {
  const dir = join(tmpWorkspace("cred-"), "gws");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const FULL = { "credentials.enc": "encrypted-blob", "client_secret.json": '{"client_id":"x"}' };

{
  const dir = store(FULL);
  const before = snapshotCredentialStore(dir);
  t.check("an untouched store reports no change", diffCredentialStore(before, snapshotCredentialStore(dir)).length, 0);
}

{
  // The 18/09 shape.
  const dir = store(FULL);
  const before = snapshotCredentialStore(dir);
  rmSync(join(dir, "credentials.enc"));
  const changes = diffCredentialStore(before, snapshotCredentialStore(dir));
  t.check("a deleted store file is caught", changes.length, 1);
  t.check("...named", changes[0].file, "credentials.enc");
  t.check("...and called a deletion, not a modification", changes[0].change, "deleted");
}

{
  const dir = store(FULL);
  const before = snapshotCredentialStore(dir);
  writeFileSync(join(dir, "client_secret.json"), '{"client_id":"swapped"}');
  const changes = diffCredentialStore(before, snapshotCredentialStore(dir));
  t.check("a swapped client secret is caught", changes[0]?.change, "modified");
}

{
  // A store that starts out missing a file must not crash the snapshot -- the
  // adapter takes it before every job, including on a machine mid-recovery.
  const dir = store({ "credentials.enc": "only-this" });
  const before = snapshotCredentialStore(dir);
  t.check("a missing file snapshots as null, not an error", before["client_secret.json"], null);
  writeFileSync(join(dir, "client_secret.json"), "appeared");
  const changes = diffCredentialStore(before, snapshotCredentialStore(dir));
  t.check("...and its appearance is a change", changes[0]?.change, "created");
}

{
  // Same content, two files: the digests must be per-file, or a swap between
  // them would cancel out.
  const dir = store({ "credentials.enc": "same", "client_secret.json": "same" });
  const snap = snapshotCredentialStore(dir);
  t.check("identical content still hashes per file", IMMUTABLE_CREDENTIAL_FILES.every((f) => snap[f]), true);
}

{
  // The hash must never travel with the finding: the manifest lands in
  // reports/ and gets committed, and a digest of client_secret.json in git is
  // a permanent oracle for checking guesses at the secret.
  const dir = store(FULL);
  const before = snapshotCredentialStore(dir);
  writeFileSync(join(dir, "credentials.enc"), "tampered");
  const changes = diffCredentialStore(before, snapshotCredentialStore(dir));
  const serialized = JSON.stringify(changes);
  t.check("the finding carries no digest", /[0-9a-f]{64}/.test(serialized), false);
  t.check("...only a name and a verb", Object.keys(changes[0]).sort().join(","), "change,file");
}

{
  // A store the process cannot read is not the same as one that is gone, and
  // must not be reported as a deletion -- that would send whoever reads the
  // gate looking for a delete that never happened.
  const dir = store(FULL);
  const before = snapshotCredentialStore(dir);
  chmodSync(join(dir, "credentials.enc"), 0o000);
  const after = snapshotCredentialStore(dir);
  chmodSync(join(dir, "credentials.enc"), 0o600); // so the tmp dir can be cleaned
  const changes = diffCredentialStore(before, after);
  // Running as root defeats the permission bit; skip rather than fail there.
  if (after["credentials.enc"] !== before["credentials.enc"]) {
    t.check("an unreadable file is not called deleted", changes[0]?.change, "unreadable");
  } else {
    t.check("an unreadable file is not called deleted (skipped: readable as root)", true, true);
  }
}

{
  // Defensive: a job dispatched before this guard existed has no baseline, and
  // a missing baseline must read as "nothing known", never as "everything
  // changed" -- a gate that red-lights every old run gets turned off.
  t.check("no baseline means no finding", diffCredentialStore(null, snapshotCredentialStore(store(FULL))).length, 0);
}

{
  // Review finding, 22/09: a store nobody can read is not a clean store. Both
  // ends produce the same error string, the diff comes back empty, and the
  // gate would vouch for a run the guard never actually watched.
  const dir = store(FULL);
  chmodSync(join(dir, "credentials.enc"), 0o000);
  chmodSync(join(dir, "client_secret.json"), 0o000);
  const snap = snapshotCredentialStore(dir);
  const blind = isWatchBlind(snap);
  chmodSync(join(dir, "credentials.enc"), 0o600);
  chmodSync(join(dir, "client_secret.json"), 0o600);
  if (snap["credentials.enc"] !== null && String(snap["credentials.enc"]).startsWith("unreadable:")) {
    t.check("a store the guard cannot read is reported blind", blind, true);
  } else {
    t.check("a store the guard cannot read is reported blind (skipped: readable as root)", true, true);
  }
  t.check("a readable store is not blind", isWatchBlind(snapshotCredentialStore(store(FULL))), false);
  t.check("an absent store is not blind either", isWatchBlind({ "credentials.enc": null, "client_secret.json": null }), false);
}

{
  // Going from unreadable to readable tells us nothing changed -- only that we
  // can see again. Calling it "modified" sends the reader hunting for an edit.
  const before = { "credentials.enc": "unreadable:EACCES", "client_secret.json": "h2" };
  const after = { "credentials.enc": "abc", "client_secret.json": "h2" };
  t.check("regaining read access is not called a modification",
    diffCredentialStore(before, after)[0]?.change, "unreadable");
}

{
  // The recorded directory must not publish the owner's home layout: manifests
  // live in reports/ and get committed.
  const shown = displayCredentialDir(join(homedir(), ".config", "gws"));
  t.check("the watched dir is recorded relative to home", shown, "~/.config/gws");
  t.check("...and a path outside home is left alone", displayCredentialDir("/opt/gws"), "/opt/gws");
  t.check("...and no username leaks", shown.includes(homedir()), false);
}

process.exit(t.finish() ? 0 : 1);
