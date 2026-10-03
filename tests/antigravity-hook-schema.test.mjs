#!/usr/bin/env node
/**
 * Hook của Antigravity app.
 *
 * App bỏ NGUYÊN CẢ FILE `.agents/hooks.json` nếu một chỗ sai schema, và bỏ im
 * lặng: không hook nào chạy, không lỗi nào hiện ra ở phiên. Từ 21/09 tới 01/10
 * file mang schema của Claude nên trạng thái Anti chưa từng được ghi và rào
 * tài khoản GWS không áp cho worker Anti app. Test này canh đúng chỗ đó: schema
 * hợp lệ theo tài liệu của app, và mỗi hook trả đúng hình dạng stdout app đòi
 * (thiếu `decision` ở PreToolUse bị coi là TỪ CHỐI).
 *
 * Phần theo module (agent-state-write, derive-state) chạy ở mọi nơi. Phần theo
 * workspace (hooks.json, gws-ntcong-routing) bỏ qua khi module chạy ngoài
 * workspace, và fail to khi `.agents/` có mà file biến mất.
 *
 * Run: node mwg-agent-crew/tests/antigravity-hook-schema.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR_REL } from "../scripts/lib/state-file.mjs";
import { deriveFromTranscript, sniffFormat } from "../scripts/lib/derive-state.mjs";
import { MODULE_ROOT, makeChecker } from "./helpers.mjs";

const t = makeChecker("antigravity-hook-schema");
const WS = join(MODULE_ROOT, "..");
const WRITE = join(MODULE_ROOT, "scripts", "agent-state-write.mjs");

/** Một transcript Anti rút gọn, đúng hình dạng đo được ở transcript_full.jsonl. */
function antiTranscript(dir, { reply = "Đã ghi xong evidence cho job.", task = "tasks/261001-demo-task", prefix = "", name = "transcript_full.jsonl" } = {}) {
  const p = join(dir, name);
  writeFileSync(p, [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "làm đi" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "",
      tool_calls: [{ name: "write_to_file", args: { TargetFile: `"${prefix}${task}/reports/x.md"`, CodeContent: "..." } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "tool output không phải lời model" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: reply },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

// ------------------------------------------------ derive-state hiểu transcript Anti
{
  const w = mkdtempSync(join(tmpdir(), "anti-hook-"));
  const p = antiTranscript(w);
  t.check("nhận diện Anti (không nhầm sang Claude)", sniffFormat(readFileSync(p, "utf8").split("\n")[0]), "anti");
  const d = deriveFromTranscript(p);
  t.check("Anti: lấy lời model cuối", d.lastDid, "Đã ghi xong evidence cho job.");
  t.check("Anti: bỏ qua kết quả tool (GENERIC)", d.lastDid.includes("tool output"), false);
  t.check("Anti: nhặt đường dẫn từ tham số tool", d.files.some((f) => f.endsWith("reports/x.md")), true);
  t.check("Anti: nhặt task từ đường dẫn", d.task, "tasks/261001-demo-task");
}

// -------------------------------- agent-state-write: payload camelCase + stdout JSON
function runWrite(payload, args = ["--agent", "anti"]) {
  return spawnSync("node", [WRITE, ...args], { input: JSON.stringify(payload), encoding: "utf8", cwd: tmpdir() });
}
{
  const w = mkdtempSync(join(tmpdir(), "anti-hook-"));
  mkdirSync(join(w, STATE_DIR_REL), { recursive: true });
  const tp = antiTranscript(w);
  // Hook của Anti chạy với cwd = `.agents/`, nên workspace phải lấy từ workspacePaths.
  const r = runWrite({ conversationId: "2d6c5705-20df-466a-9791-bea1e0d9c56e", workspacePaths: [w], transcriptPath: tp, invocationNum: 3 });
  t.check("Anti: exit 0", r.status, 0);
  t.check("Anti: stdout là JSON `{}`", r.stdout, "{}");
  const files = readdirSync(join(w, STATE_DIR_REL));
  t.check("Anti: ghi đúng 1 file trạng thái", files.length, 1);
  t.check("Anti: tên file mang agent + id phiên", /^anti-2d6c5705/.test(files[0] ?? ""), true);
  t.check("Anti: file chứa lời model cuối", readFileSync(join(w, STATE_DIR_REL, files[0]), "utf8").includes("Đã ghi xong evidence"), true);

  // Anti ghi đường dẫn TUYỆT ĐỐI vào tham số tool (đo 01/10); bộ nhặt chỉ khớp dạng
  // tương đối. Thiếu bước cắt tiền tố workspace thì file trạng thái không bao giờ
  // ra, vì lượt đầu chưa có lời model và cũng không có đường dẫn nào nhặt được.
  {
    const w2 = mkdtempSync(join(tmpdir(), "anti-hook-"));
    mkdirSync(join(w2, STATE_DIR_REL), { recursive: true });
    const abs = antiTranscript(w2, { prefix: `${w2}/`, reply: "", name: "abs.jsonl" });
    runWrite({ conversationId: "abs-1", workspacePaths: [w2], transcriptPath: abs });
    const got = readdirSync(join(w2, STATE_DIR_REL));
    t.check("Anti: đường dẫn tuyệt đối vẫn ra file trạng thái", got.length, 1);
    t.check("Anti: ...và nhận đúng task", got.length ? readFileSync(join(w2, STATE_DIR_REL, got[0]), "utf8").includes("tasks/261001-demo-task") : false, true);
    t.check("Anti: ...và không lộ tiền tố máy", got.length ? readFileSync(join(w2, STATE_DIR_REL, got[0]), "utf8").includes(w2) : true, false);
  }

  // Hook chạy trước MỖI lần gọi model: lượt hai phải ghi đè, không đẻ file mới.
  runWrite({ conversationId: "2d6c5705-20df-466a-9791-bea1e0d9c56e", workspacePaths: [w], transcriptPath: tp, invocationNum: 4 });
  t.check("Anti: chạy lặp vẫn một file", readdirSync(join(w, STATE_DIR_REL)).length, 1);
}
{
  // Ca bỏ qua việc ghi vẫn phải in JSON, nếu không app coi hook là lỗi.
  const w = mkdtempSync(join(tmpdir(), "anti-hook-"));      // KHÔNG có tasks/_state
  const r = runWrite({ conversationId: "abc", workspacePaths: [w], transcriptPath: antiTranscript(w) });
  t.check("Anti: workspace không opt-in → vẫn exit 0", r.status, 0);
  t.check("Anti: ...và vẫn in `{}`", r.stdout, "{}");
  t.check("Anti: payload rỗng → vẫn in `{}`", runWrite({}).stdout, "{}");
  t.check("Claude: stdout KHÔNG đổi (không in gì)", runWrite({ session_id: "s", cwd: w }, ["--agent", "claude"]).stdout, "");
}

// ----------------------------------------------- phần theo workspace (hooks.json, gws)
const HOOKS_JSON = join(WS, ".agents", "hooks.json");
const GWS_HOOK = join(WS, ".agents", "hooks", "gws-ntcong-routing.cjs");
// Tên profile cá nhân ghép từ hai mảnh để lệnh Bash chứa file này không tự dính rào GWS.
const PERSONAL = ["gws", "personal"].join("-");

if (!existsSync(join(WS, ".agents"))) {
  console.log("antigravity-hook-schema: SKIP phần workspace — không thấy <workspace>/.agents/ (module chạy ngoài workspace)");
} else if (!existsSync(HOOKS_JSON) || !existsSync(GWS_HOOK)) {
  t.check(".agents/hooks.json và gws-ntcong-routing.cjs tồn tại", false, true);
} else {
  const doc = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  const GROUPED = new Set(["PreToolUse", "PostToolUse"]);
  const FLAT = new Set(["PreInvocation", "PostInvocation", "Stop"]);
  const problems = [];
  const handlerOk = (h, where) => {
    if (!h || typeof h.command !== "string" || !h.command.trim()) problems.push(`${where}: thiếu command`);
    if (h?.type && h.type !== "command") problems.push(`${where}: type ${h.type} chưa được hỗ trợ`);
  };
  for (const [name, spec] of Object.entries(doc)) {
    // Key "hooks" ở ngoài cùng đúng là lỗi đã làm app bỏ cả file.
    if (name === "hooks") problems.push(`key ngoài cùng "hooks" bị app coi là TÊN hook`);
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) { problems.push(`${name}: phải là object`); continue; }
    for (const [ev, list] of Object.entries(spec)) {
      if (ev === "enabled") continue;
      if (!GROUPED.has(ev) && !FLAT.has(ev)) { problems.push(`${name}: sự kiện ${ev} không tồn tại ở Anti`); continue; }
      if (!Array.isArray(list)) { problems.push(`${name}.${ev}: phải là mảng`); continue; }
      list.forEach((item, i) => {
        if (GROUPED.has(ev)) {
          if (typeof item.matcher !== "string") problems.push(`${name}.${ev}[${i}]: thiếu matcher`);
          if (!Array.isArray(item.hooks) || !item.hooks.length) problems.push(`${name}.${ev}[${i}]: thiếu hooks[]`);
          (item.hooks ?? []).forEach((h, j) => handlerOk(h, `${name}.${ev}[${i}].hooks[${j}]`));
        } else {
          handlerOk(item, `${name}.${ev}[${i}]`);
        }
      });
    }
  }
  t.check(`hooks.json đúng schema Antigravity ${problems.length ? "— " + problems.join("; ") : ""}`, problems.length, 0);

  const raw = JSON.stringify(doc);
  t.check("hooks.json không còn sự kiện chỉ của Claude", /UserPromptSubmit|SessionStart|SubagentStart/.test(raw), false);
  t.check("hooks.json không nhúng đường dẫn tuyệt đối của máy", /\/Users\//.test(raw), false);
  t.check("rào GWS có mặt ở PreToolUse", JSON.stringify(Object.values(doc).map((s) => s.PreToolUse)).includes("gws-ntcong-routing"), true);
  t.check("ghi trạng thái có mặt ở PreInvocation", JSON.stringify(Object.values(doc).map((s) => s.PreInvocation)).includes("agent-state-write"), true);
  // PreInvocation chạy TRƯỚC lần gọi model cuối nên không bao giờ thấy lời kết; chỉ Stop thấy.
  t.check("ghi trạng thái có mặt ở Stop (bắt lời model cuối)", JSON.stringify(Object.values(doc).map((s) => s.Stop)).includes("agent-state-write"), true);

  // Thiếu `decision` ở PreToolUse là app từ chối MỌI tool: mỗi nhánh phải in một decision.
  const gws = (command, extra = {}) => {
    const r = spawnSync("node", [GWS_HOOK], {
      input: JSON.stringify({ conversationId: "c1", workspacePaths: [WS], toolCall: { name: "run_command", args: { CommandLine: command } }, ...extra }),
      encoding: "utf8", cwd: join(WS, ".agents"),
    });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { /* để check bên dưới báo */ }
    return { status: r.status, out };
  };
  const bare = gws("gws drive files list");
  t.check("GWS: gws trần bị deny", bare.out?.decision, "deny");
  t.check("GWS: deny nói cách dùng đúng", /GOOGLE_WORKSPACE_CLI_CONFIG_DIR/.test(bare.out?.reason ?? ""), true);
  t.check("GWS: deny vẫn exit 0 (app đọc JSON, không đọc exit code)", bare.status, 0);
  t.check("GWS: profile cá nhân bị deny", gws(`${PERSONAL} drive files list`).out?.decision, "deny");
  const good = 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/gws" command gws drive files list';
  t.check("GWS: đúng profile → ask, không phải allow", gws(good).out?.decision, "ask");
  t.check("GWS: lệnh thường → ask (app tự quyết như khi không có hook)", gws("ls -la").out?.decision, "ask");
  t.check("GWS: KHÔNG BAO GIỜ trả allow", ["gws x", "ls", good].some((c) => gws(c).out?.decision === "allow"), false);
  t.check("GWS: workspace khác → ask", gws("gws drive", { workspacePaths: [tmpdir()] }).out?.decision, "ask");
  const junk = spawnSync("node", [GWS_HOOK], { input: "không phải json", encoding: "utf8" });
  t.check("GWS: stdin hỏng không làm hook sập", junk.status, 0);
  // Với Anti, sập = từ chối mọi tool. Các hình dạng stdin dị dạng đều phải thoát 0, không stack trace.
  for (const [label, input] of [["null", "null"], ["rỗng", ""], ["mảng", "[]"], ["chuỗi", '"x"']]) {
    const r = spawnSync("node", [GWS_HOOK], { input, encoding: "utf8" });
    t.check(`GWS: stdin ${label} → exit 0, không stack trace`, r.status === 0 && !/at .*\.cjs/.test(r.stderr), true);
  }
  const noCall = spawnSync("node", [GWS_HOOK], { input: JSON.stringify({ conversationId: "c", toolCall: null }), encoding: "utf8" });
  t.check("GWS: payload Anti thiếu toolCall → vẫn có decision", JSON.parse(noCall.stdout || "{}").decision, "ask");

  // Chạy đúng chuỗi lệnh trong hooks.json qua `sh -c` từ `.agents/`, như app làm. App khởi từ GUI có
  // thể có PATH tối thiểu không thấy `node`: lúc đó phải còn JSON, không thì PreToolUse từ chối mọi tool.
  const MIN_ENV = { PATH: "/usr/bin:/bin" };
  const shRun = (command, env, input = "{}") => spawnSync("sh", ["-c", command], { cwd: join(WS, ".agents"), env, input, encoding: "utf8" });
  const commandsOf = (event) => Object.values(doc).flatMap((s) => (s[event] ?? []).flatMap((x) => x.hooks ?? [x]));
  const [gwsCmd] = commandsOf("PreToolUse");
  const stateCmds = [...commandsOf("PreInvocation"), ...commandsOf("Stop")];
  const bareCall = JSON.stringify({ conversationId: "c", workspacePaths: [WS], toolCall: { name: "run_command", args: { CommandLine: "ls" } } });
  t.check("hooks.json: mọi hook có timeout rõ ràng (mặc định 30s, chạy đồng bộ)", [gwsCmd, ...stateCmds].every((h) => Number.isInteger(h.timeout) && h.timeout > 0 && h.timeout <= 15), true);
  t.check("lệnh PreToolUse trong hooks.json chạy được với PATH đầy đủ", JSON.parse(shRun(gwsCmd.command, { ...process.env }, bareCall).stdout || "{}").decision, "ask");
  t.check("lệnh PreToolUse: thiếu `node` trên PATH vẫn in decision (không từ chối mọi tool)", JSON.parse(shRun(gwsCmd.command, MIN_ENV, bareCall).stdout || "{}").decision, "ask");
  t.check("lệnh ghi trạng thái: thiếu `node` vẫn in JSON hợp lệ", stateCmds.every((h) => shRun(h.command, MIN_ENV).stdout.trim() === "{}"), true);

  // Đường Claude/Codex không được đổi: vẫn chặn bằng exit 2, không in JSON.
  const claude = spawnSync("node", [GWS_HOOK], {
    input: JSON.stringify({ cwd: WS, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gws drive" } }),
    encoding: "utf8",
  });
  t.check("Claude: gws trần vẫn exit 2", claude.status, 2);
  t.check("Claude: stdout vẫn rỗng", claude.stdout, "");
}

process.exit(t.finish() ? 0 : 1);
