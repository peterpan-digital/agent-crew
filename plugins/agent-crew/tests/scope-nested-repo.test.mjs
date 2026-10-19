#!/usr/bin/env node
/**
 * changedPaths must see writes inside the nested `tasks/` repo.
 *
 * The outer repo ignores `tasks/` (task content stays out of the public
 * harness) and `tasks/` is its own local-only repo. A gate that read only the
 * outer `git status` would be blind to every evidence file and to any worker
 * writing into another task's folder.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { changedPaths } from "../scripts/crew-scope.mjs";
import { makeChecker, tmpWorkspace, writeFile } from "./helpers.mjs";

const t = makeChecker("scope-nested-repo");
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });

const ws = tmpWorkspace();
git(ws, "init", "-q");
writeFile(join(ws, ".gitignore"), "tasks/\n");
writeFile(join(ws, "harness.md"), "x\n");
git(ws, "add", "-A");
git(ws, "commit", "-q", "-m", "init");

git(join(ws, "tasks"), "init", "-q");
writeFile(join(ws, "tasks", "t", "README.md"), "task\n");
git(join(ws, "tasks"), "add", "-A");
git(join(ws, "tasks"), "commit", "-q", "-m", "init");

writeFile(join(ws, "tasks", "t", "reports", "crew-test", "worker-anti-1.md"), "Status: DONE\n");
writeFile(join(ws, "tasks", "other", "stray.md"), "ghi bậy sang task khác\n");
writeFile(join(ws, "tasks", "t", "README.md"), "task sửa\n");
writeFile(join(ws, "harness.md"), "y\n");

const paths = changedPaths(ws).sort();
t.check("thấy evidence trong repo tasks/", paths.includes("tasks/t/reports/crew-test/worker-anti-1.md"), true);
t.check("thấy file ghi bậy sang task khác", paths.includes("tasks/other/stray.md"), true);
t.check("thấy file task đã track bị sửa", paths.includes("tasks/t/README.md"), true);
t.check("vẫn thấy thay đổi ở repo ngoài", paths.includes("harness.md"), true);
t.check("không có đường dẫn thiếu tiền tố tasks/", paths.some((p) => p.startsWith("t/") || p.startsWith("other/")), false);

const plain = tmpWorkspace();
git(plain, "init", "-q");
writeFile(join(plain, "tasks", "t", "a.md"), "x\n");
t.check("không có repo lồng → tasks/ đọc từ repo ngoài như cũ", changedPaths(plain).some((p) => p.startsWith("tasks/")), true);

process.exit(t.finish() ? 0 : 1);
