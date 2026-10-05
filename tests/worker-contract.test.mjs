/**
 * The three lines every brief must carry, appended by the adapter.
 *
 * The case these exist for: run `crew-260909-1450` lost all three jobs, and the
 * one that had nothing to do with the sandbox lost because its brief omitted
 * the write-scope line. The worker reported into the chat instead of the
 * evidence file. `readPrompt` measured the brief and let it through, because
 * size was the only thing it measured.
 */
import { join, sep } from "node:path";
import { appendWorkerContract, readPrompt, MAX_BRIEF_BYTES, CHAT_LINE, OUTSIDE_BRIEF_LINE, OWNER_CHANGE_LINE, STATUS_LINE } from "../scripts/crew-guards.mjs";
import { makeChecker } from "./helpers.mjs";

const t = makeChecker("worker-contract");

const WS = `${sep}ws`;
const EV = join(WS, "tasks", "t", "reports", "crew-260909-1450", "worker-codex-1.md");
const REL = join("tasks", "t", "reports", "crew-260909-1450", "worker-codex-1.md");
const ctx = { evidenceAbs: EV, workspace: WS };

{
  // The failure this whole guard exists for: a brief with none of the lines.
  const out = appendWorkerContract("## Tình hình\nLàm việc X.", ctx);
  t.check("the write-scope line is added", out.includes(`Chỉ được ghi đúng file: ${REL}`), true);
  t.check("the Status line is added", /Dòng cuối evidence file phải là: Status: DONE \| /.test(out), true);
  t.check("the no-dispatch line is added", /Không được dispatch worker khác\./.test(out), true);
  t.check("the run id comes off the evidence path", out.includes("crew run crew-260909-1450"), true);
  t.check("the author's own text is kept", out.includes("Làm việc X."), true);
}

{
  // A brief that already carries a line keeps the author's wording; two copies
  // of a write-scope rule teaches a worker to pick whichever it prefers.
  const authored = `Chỉ được ghi đúng file: ${REL} (và data bạn tự sinh trong task folder).`;
  const out = appendWorkerContract(`## Cần gì\nX.\n${authored}`, ctx);
  t.check("an already-present line is not duplicated",
    out.split(authored).length - 1, 1);
  t.check("...and the lines it did lack are still added",
    /Không được dispatch worker khác\./.test(out), true);
}

{
  const full = appendWorkerContract("brief", ctx);
  t.check("running it twice changes nothing", appendWorkerContract(full, ctx), full);
}

{
  // Cosmetic only: an evidence path with no run dir must not throw.
  const flat = appendWorkerContract("brief", { evidenceAbs: join(WS, "w.md"), workspace: WS });
  t.check("a path with no run dir still gets the lines",
    flat.includes("Chỉ được ghi đúng file: w.md"), true);
  t.check("...and falls back to an unnamed run",
    flat.includes("trong một crew run"), true);
}

{
  // The ceiling is a discipline on what the dispatcher writes. Charging them
  // for boilerplate they no longer author would make a real limit a moving one.
  const atCap = "x".repeat(MAX_BRIEF_BYTES);
  const out = appendWorkerContract(readPrompt({ prompt: atCap }), ctx);
  t.check("a brief at the cap still passes and gets the lines",
    out.length > MAX_BRIEF_BYTES && out.includes(`Chỉ được ghi đúng file: ${REL}`), true);
}

{
  // Owner chốt 22/09 không cấm chạy ngoài sandbox, kể cả kèm --workspace-cli on.
  // Cái giữ chỗ còn lại là brief, nên nó phải tự xuất hiện theo bậc sandbox chứ
  // không trông vào việc người giao việc nhớ gõ tay.
  const sandboxed = appendWorkerContract("brief", ctx);
  t.check("a sandboxed job gets no extra boundary line",
    /NGOÀI sandbox/.test(sandboxed), false);

  const loose = appendWorkerContract("brief", { ...ctx, unsandboxed: true });
  t.check("an unsandboxed job is told so", /chạy NGOÀI sandbox/.test(loose), true);
  t.check("...and the credential store is named in the brief itself",
    loose.includes("`~/.config/gws/`"), true);
  t.check("...without dropping any of the three base lines",
    loose.includes(`Chỉ được ghi đúng file: ${REL}`)
      && /Không được dispatch worker khác\./.test(loose)
      && /Dòng cuối evidence file phải là/.test(loose), true);
  t.check("...and stays idempotent",
    appendWorkerContract(loose, { ...ctx, unsandboxed: true }), loose);
}

{
  // Owner chen vào conversation được ở mọi job, nên 2 dòng này có ở mọi job.
  const out = appendWorkerContract("brief", ctx);
  t.check("job thường: có dòng Thay đổi từ owner", out.includes(OWNER_CHANGE_LINE), true);
  t.check("job thường: có dòng Ghi ngoài brief", out.includes(OUTSIDE_BRIEF_LINE), true);
  t.check("job thường: vẫn là dòng Status cũ, không có câu phiên chat", `${out.split("\n").includes(STATUS_LINE)}:${out.includes(CHAT_LINE)}`, "true:false");
  t.check("dòng owner chỉ nhận đổi mục tiêu/phạm vi, không chép chuyện phiếm", /không đổi việc thì không ghi/.test(OWNER_CHANGE_LINE), true);

  const chat = appendWorkerContract("brief", { ...ctx, chat: true });
  t.check("chat: có câu phiên chat", chat.includes(CHAT_LINE), true);
  t.check("chat: dòng Status đứng riêng bị thay, không có hai lời dặn khác nhau", chat.split("\n").includes(STATUS_LINE), false);
  t.check("chat: 4 mục evidence được nêu tên", ["Tóm tắt trao đổi", "Thay đổi từ owner", "Ghi ngoài brief", "Việc còn mở"].every((s) => CHAT_LINE.includes(`## ${s}`)), true);
  t.check("chat: vẫn có rào ghi + không dispatch", /Chỉ được ghi đúng file/.test(chat) && /Không được dispatch/.test(chat), true);
  t.check("chat: chạy lại không đổi gì", appendWorkerContract(chat, { ...ctx, chat: true }), chat);
  const pasted = appendWorkerContract(`brief\n${CHAT_LINE}`, ctx);
  t.check("brief thường lỡ chép câu chat: vẫn có dòng Status đứng riêng", pasted.split("\n").includes(STATUS_LINE), true);
}

process.exit(t.finish() ? 0 : 1);
