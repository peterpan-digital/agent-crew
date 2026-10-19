/**
 * Bộ che dữ liệu tìm danh sách domain nội bộ qua khoá `redactConfig` của
 * `crew.config.json`. Bản module cũ tìm `harness.config.json` theo đường tương
 * đối của chính nó — chuyển vào plugin là đường đó trỏ vào hư không, và state
 * phiên lặng lẽ thôi che domain nội bộ. File này giữ cho chuyện đó không lặp lại.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRedactConfig } from "../scripts/lib/redact-values.mjs";
import { loadCrewConfig } from "../scripts/lib/crew-config.mjs";
import { MODULE_ROOT, makeChecker } from "./helpers.mjs";

const t = makeChecker("redact-config");
const ok = (name, cond) => t.check(name, Boolean(cond), true);
const msg = (fn) => { try { fn(); return "không ném"; } catch (e) { return e.message; } };

function repo(config) {
  const ws = mkdtempSync(join(tmpdir(), "redact-cfg-"));
  execFileSync("git", ["init", "-q"], { cwd: ws });
  if (config) writeFileSync(join(ws, "crew.config.json"), JSON.stringify(config));
  return ws;
}
const SECRET = { redact: { internalDomains: ["acme-shop.test"], emailDomains: ["acme-shop.test"] }, cms: { origin: "https://cms.acme-tool.test" } };

// ---- khai redactConfig → đọc đúng file, kể cả từ thư mục con ----
{
  const ws = repo({ redactConfig: "private/redact.json" });
  mkdirSync(join(ws, "private"));
  writeFileSync(join(ws, "private", "redact.json"), JSON.stringify(SECRET));
  mkdirSync(join(ws, "sub"));
  const got = loadRedactConfig({ env: {}, cwd: join(ws, "sub") });
  ok("redactConfig khai → configured", got.configured);
  ok("origin của mục khác thành internalHosts", got.lists.internalHosts.includes("cms.acme-tool.test"));
  ok("CLAUDE_PROJECT_DIR thắng cwd", loadRedactConfig({ env: { CLAUDE_PROJECT_DIR: ws }, cwd: tmpdir() }).configured);
  ok("CREW_HARNESS_CONFIG thắng crew.config.json",
    !loadRedactConfig({ env: { CREW_HARNESS_CONFIG: join(ws, "khong-co.json") }, cwd: ws }).configured);
}

// ---- không khai / không có config → chỉ luật chung ----
{
  const none = loadRedactConfig({ env: {}, cwd: repo(null) });
  ok("không có crew.config.json → không configured", !none.configured);
  ok("...và path nói chỗ cần khai", /redactConfig/.test(none.path));
  ok("config không có khoá → không configured", !loadRedactConfig({ env: {}, cwd: repo({ costGate: ["X"] }) }).configured);
  const missing = repo({ redactConfig: "chua-tao.json" });
  ok("khai mà file chưa có → không configured", !loadRedactConfig({ env: {}, cwd: missing }).configured);
}

// ---- khai sai → ném, không âm thầm bỏ che ----
{
  ok("đường ra ngoài repo bị từ chối", /redactConfig/.test(msg(() => loadCrewConfig(repo({ redactConfig: "../x.json" })))));
  ok("không phải .json bị từ chối", /\.json/.test(msg(() => loadCrewConfig(repo({ redactConfig: "x.txt" })))));
  ok("crew.config.json hỏng → bộ che ném", /redact:/.test(msg(() => loadRedactConfig({ env: {}, cwd: repo({ redactConfig: "../x.json" }) }))));
}

// ---- đầu-cuối: state-write che domain nội bộ khi chạy từ gốc repo ----
{
  const ws = repo({ redactConfig: "redact.json", stateDir: ".crew/state" });
  writeFileSync(join(ws, "redact.json"), JSON.stringify(SECRET));
  mkdirSync(join(ws, ".crew", "state"), { recursive: true });
  const transcript = join(ws, "t.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Đã sửa https://staging.acme-shop.test/admin và báo ai@acme-shop.test" }] } }) + "\n");
  const r = spawnSync(process.execPath, [join(MODULE_ROOT, "scripts", "agent-state-write.mjs"), "--agent", "claude"], {
    cwd: ws, encoding: "utf8",
    input: JSON.stringify({ session_id: "s1", transcript_path: transcript, cwd: ws }),
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const files = readdirSync(join(ws, ".crew", "state"));
  const body = files.length ? readFileSync(join(ws, ".crew", "state", files[0]), "utf8") : "";
  ok(`state-write ghi file (exit ${r.status})`, files.length === 1);
  ok("domain back-door bị che", body.length > 0 && !body.includes("staging.acme-shop.test"));
  ok("email công ty bị che", body.length > 0 && !body.includes("ai@acme-shop.test"));
}

process.exit(t.finish() ? 0 : 1);
