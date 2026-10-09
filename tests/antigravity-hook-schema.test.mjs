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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  // Một hook PreToolUse duy nhất gọi cả rào GWS lẫn cổng chi phí: tài liệu app không nói quyết định
  // nào thắng khi hai hook cùng sự kiện trả khác nhau.
  const preCmds = Object.values(doc).flatMap((s) => (s.PreToolUse ?? []).flatMap((x) => x.hooks ?? []));
  t.check("đúng một hook PreToolUse, là anti-pretool-gate", preCmds.length === 1 && preCmds[0].command.includes("anti-pretool-gate"), true);
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

  // ------------------------------------------- cổng API tốn tiền (qua đúng lệnh trong hooks.json)
  // Host, tên key và tên script ghép lúc chạy: file này mà chứa nguyên chuỗi thì chính cổng
  // chặn worker Anti chạy test của repo (review 09/10).
  const H = {
    ahrefs: ["api", "ahrefs", "com"].join("."),
    gemini: ["generativelanguage", "googleapis", "com"].join("."),
    openai: ["api", "openai", "com"].join("."),
    dfs: ["api", "dataforseo", "com"].join("."),
    router: ["openrouter", "ai"].join("."),
  };
  const KEY = ["OPENAI", "API", "KEY"].join("_");
  const AF = ["ahrefs", "fetch"].join("_");
  const GI = ["generate", "image"].join("_");
  const BL = ["batch-llm-skill", "skill.py"].join("/");
  const AF_PATH = `.claude/skills/seo-keyword-research/scripts/${AF}.py`;
  const ENV = { ...process.env };
  delete ENV.MWG_CREW_ROLE;
  const GATE = (command, extra = {}, env = ENV) => {
    const input = JSON.stringify({ conversationId: "c1", workspacePaths: [WS], toolCall: { name: "run_command", args: { CommandLine: command, Cwd: WS } }, ...extra });
    const r = shRun(gwsCmd.command, env, input);
    try { return JSON.parse(r.stdout); } catch { return { decision: `stdout hỏng: ${r.stdout}` }; }
  };
  const D = (command, extra) => GATE(command, extra).decision;
  t.check("cổng: rào GWS vẫn chạy qua hook gộp", D(["gws", "drive files list"].join(" ")), "deny");
  t.check("cổng: curl thẳng host Ahrefs → deny", D(`curl -s https://${H.ahrefs}/v3/site-explorer/x`), "deny");
  t.check("cổng: lý do mang đúng tên API trong bảng Cost gate", /COST_GATE — Ahrefs/.test(GATE(`curl https://${H.ahrefs}/x`).reason ?? ""), true);
  t.check("cổng: chạy script skill Ahrefs → deny", D(`python3 ${AF_PATH} matching --seeds x`), "deny");
  t.check("cổng: chỉ đọc script đó → ask", D(`cat ${AF_PATH}`), "ask");
  t.check("cổng: đọc SKILL.md skill ảnh → ask", D("cat .claude/skills/image-seo-pipeline/SKILL.md"), "ask");
  t.check("cổng: python -c gọi Gemini → deny", D(`python3 -c "import requests; requests.post('https://${H.gemini}/v1beta/x')"`), "deny");
  t.check("cổng: crawl web thường → ask", D("curl -sI https://www.thegioididong.com/laptop"), "ask");
  t.check("cổng: lệnh thường → ask", D("ls -la"), "ask");
  t.check("cổng: KHÔNG BAO GIỜ allow",
    ["ls", `curl https://${H.openai}/v1/x`, `MWG_COST_OK=1 curl https://${H.router}/api/v1/x`].some((c) => D(c) === "allow"), false);

  // Cách gọi thật thà mà regex cũ để lọt.
  t.check("cổng: đường script trong ngoặc kép → deny", D(`python3 "${AF_PATH}" matching --seeds x`), "deny");
  t.check("cổng: cd vào skill rồi đường tương đối → deny",
    D(`cd .claude/skills/seo-keyword-research/scripts && python3 ${AF}.py matching --seeds x`), "deny");
  t.check("cổng: cd vào batch-llm-skill rồi python3 skill.py → deny",
    D("cd .claude/skills/batch-llm-skill && python3 skill.py --file a.csv --goal x"), "deny");
  t.check("cổng: cờ có giá trị trước script (-X utf8) → deny", D(`python3 -X utf8 ${AF_PATH} matching --seeds x`), "deny");
  t.check("cổng: uv run --with … script → deny", D(`uv run --with requests ${AF_PATH} matching --seeds x`), "deny");
  t.check("cổng: python -m module skill → deny", D(`cd .claude/skills/seo-keyword-research && python3 -m scripts.${AF} matching`), "deny");
  t.check("cổng: python -c import module skill → deny", D(`python3 -c "import ${AF}; ${AF}.main()"`), "deny");
  t.check("cổng: heredoc import module ảnh → deny", D(`python3 - <<'PY'\nfrom ${GI} import run\nrun()\nPY`), "deny");
  t.check("cổng: curl … | jq vẫn thấy host → deny", D(`curl -s https://${H.dfs}/v3/x | jq .`), "deny");

  // Việc miễn phí trước đây bị chặn nhầm.
  t.check("cổng: grep tên key trong repo → ask", D(`grep -rn ${KEY} .claude/skills`), "ask");
  t.check("cổng: grep host trong repo → ask", D(`grep -rn "${H.ahrefs}" .`), "ask");
  t.check("cổng: git commit nhắc tên key → ask", D(`git commit -m "doc: ${KEY} đọc từ .env"`), "ask");
  t.check("cổng: ước tính units Ahrefs (offline) → ask", D(`python3 ${AF_PATH} estimate --limit 50`), "ask");
  t.check("cổng: batch LLM --dry-run → ask", D(`python3 .claude/skills/${BL} --file a.csv --dry-run`), "ask");
  t.check("cổng: bước miễn phí skill ảnh (fetch_prompt_config) → ask",
    D("python3 .claude/skills/image-ai-generate/scripts/fetch_prompt_config.py --row 2"), "ask");
  t.check("cổng: đọc docs openrouter → ask", D(`curl -sI https://${H.router}/docs`), "ask");
  t.check("cổng: chạy chính test này → ask", D("node mwg-agent-crew/tests/antigravity-hook-schema.test.mjs"), "ask");

  // Worker ghi script rồi chạy: lệnh không có host, nội dung script thì có — trong hay ngoài workspace.
  const scratch = mkdtempSync(join(WS, "tasks", ".cost-gate-test-"));
  const outside = mkdtempSync(join(tmpdir(), "cost-gate-script-"));
  try {
    writeFileSync(join(scratch, "goi.py"), `import requests\nrequests.post('https://${H.dfs}/v3/serp')\n`);
    writeFileSync(join(scratch, "sach.py"), "print('crawl tgdd')\n");
    writeFileSync(join(outside, "ngoai.py"), `from ${GI} import run\nrun()\n`);
    const rel = scratch.slice(WS.length + 1);
    t.check("cổng: chạy script tự viết có host DataForSEO → deny", D(`python3 ${rel}/goi.py`), "deny");
    t.check("cổng: chạy script tự viết không gọi API → ask", D(`python3 ${rel}/sach.py`), "ask");
    t.check("cổng: script ngoài workspace import module skill → deny", D(`python3 ${join(outside, "ngoai.py")}`), "deny");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }

  // Ngoài crew: owner đồng ý trong conversation thì Anti MỞ ĐẦU lệnh bằng MWG_COST_OK=1.
  t.check("cổng: ngoài crew, mở đầu MWG_COST_OK=1 → ask", D(`MWG_COST_OK=1 curl https://${H.router}/api/v1/key`), "ask");
  t.check("cổng: MWG_COST_OK=1 nằm giữa lệnh không tính → deny", D(`echo MWG_COST_OK=1; curl https://${H.router}/api/v1/key`), "deny");
  // Trong crew: prompt đầu có dòng hợp đồng → chỉ qua khi owner đã trả lời hold.
  const tdir = mkdtempSync(join(tmpdir(), "cost-gate-"));
  const crewT = join(tdir, "t.jsonl");
  writeFileSync(crewT, JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "brief\n\nBạn là worker trong crew run 261009-1400. Không được dispatch worker khác." }) + "\n");
  const ownT = join(tdir, "o.jsonl");
  writeFileSync(ownT, JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "chạy ahrefs cho tao" }) + "\n");
  const crewOverride = GATE(`MWG_COST_OK=1 curl https://${H.router}/api/v1/key`, { transcriptPath: crewT });
  t.check("cổng: conversation crew, có MWG_COST_OK=1 vẫn deny", crewOverride.decision, "deny");
  t.check("cổng: lý do bảo worker trả BLOCKED", /Status: BLOCKED/.test(crewOverride.reason ?? ""), true);
  t.check("cổng: conversation owner có transcript, có override → ask",
    D(`MWG_COST_OK=1 curl https://${H.router}/api/v1/key`, { transcriptPath: ownT }), "ask");
  t.check("cổng: MWG_CREW_ROLE=worker là crew dù không có transcript → deny",
    GATE(`MWG_COST_OK=1 curl https://${H.router}/api/v1/key`, {}, { ...ENV, MWG_CREW_ROLE: "worker" }).decision, "deny");

  // Owner cho chạy tiếp qua hold: đúng conversation, đúng API, lời owner (via chat), chưa cover.
  const conv = "conv-cost-gate-test-0001";
  const taskDir = mkdtempSync(join(WS, "tasks", ".cost-gate-hold-"));
  const runDir = join(taskDir, "reports", "crew-261009-0000");
  mkdirSync(runDir, { recursive: true });
  const hold = (over = {}) => ({
    id: "h1", seq: 1, kind: "cost_gate", api: "Ahrefs", status: "answered",
    answer: { words: "ok chạy đi", outcome: "resume", via: "chat", at: new Date().toISOString() }, ...over,
  });
  const writeRun = (h) => writeFileSync(join(runDir, "manifest.json"), JSON.stringify({
    jobs: [{ seq: 1, worker: "antigravity", conversationId: conv }], holds: [h],
  }));
  const ahrefs = (extra = {}) => D(`curl https://${H.ahrefs}/x`, { conversationId: conv, transcriptPath: crewT, ...extra });
  try {
    writeRun(hold());
    t.check("cổng: crew + owner đã cho resume đúng API → ask", ahrefs(), "ask");
    t.check("cổng: crew + hold của API khác → deny", D(`curl https://${H.openai}/x`, { conversationId: conv, transcriptPath: crewT }), "deny");
    t.check("cổng: crew + hold của conversation khác → deny", ahrefs({ conversationId: "conv-khac-000001" }), "deny");
    writeRun(hold({ answer: { ...hold().answer, via: "dispatcher" } }));
    t.check("cổng: hold do dispatcher trả lời (không phải owner) → deny", ahrefs(), "deny");
    writeRun(hold({ answer: { ...hold().answer, outcome: "drop" } }));
    t.check("cổng: owner chọn bỏ việc → deny", ahrefs(), "deny");
    writeRun(hold({ coveredBy: 2 }));
    t.check("cổng: hold đã cover xong → deny", ahrefs(), "deny");
    writeRun(hold({ answer: { ...hold().answer, at: new Date(Date.now() - 25 * 3600e3).toISOString() } }));
    t.check("cổng: lời owner quá 24 giờ → deny", ahrefs(), "deny");
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }

  t.check("cổng: workspace khác → ask", D(`curl https://${H.ahrefs}/x`, { workspacePaths: [tmpdir()] }), "ask");
  t.check("cổng: workspacePaths là chuỗi vẫn được xét → deny", D(`curl https://${H.ahrefs}/x`, { workspacePaths: WS }), "deny");
  for (const [label, input] of [["rác", "không phải json"], ["null", "null"], ["rỗng", ""]]) {
    const r = shRun(gwsCmd.command, ENV, input);
    t.check(`cổng: stdin ${label} → vẫn có decision`, ["ask", "deny"].includes(JSON.parse(r.stdout || "{}").decision), true);
  }
}

process.exit(t.finish() ? 0 : 1);
