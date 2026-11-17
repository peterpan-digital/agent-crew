/**
 * Sandbox ghi cho worker: hệ điều hành chặn worker ghi ra ngoài vùng của job.
 *
 * Vì sao (15/11/2026): cổng phạm vi ghi đoán "file đổi trong khoảng job chạy là
 * của worker". Ở workspace nhiều session chạy cùng lúc, đoán đó sai gần như mọi
 * lần: 310 path bị bác tay trong 9/42 run, không path nào là worker ghi sai thật,
 * và session bắt đầu bác hàng loạt bằng script — cổng thành hình thức. Khi worker
 * KHÔNG THỂ ghi ra ngoài vùng, file đổi ngoài vùng chắc chắn không phải của nó,
 * nên collect khỏi phải đoán.
 *
 * Hai cơ chế, vì không lồng được (đo 15/11: bọc sandbox-exec ngoài Codex thì
 * seatbelt riêng của Codex chết `sandbox_apply: Operation not permitted`):
 *   - Codex: permission profile của chính Codex (codex-cli 0.164), khai qua `-c`.
 *     Đo: chặn cả `apply_patch` ("writing outside of the project") lẫn shell
 *     ("Operation not permitted"), giữ qua `exec resume` khi `-c` đứng sau
 *     `resume`; luật con `read` trong vùng `write` thắng.
 *   - agy: bọc cả tiến trình bằng `/usr/bin/sandbox-exec` (seatbelt). Đo: lệnh
 *     shell của agy bị chặn ngoài vùng, trong vùng ghi bình thường.
 *
 * Cả hai là giao diện bên thứ ba (Apple đã đánh dấu sandbox-exec lỗi thời,
 * profile Codex còn mới), nên trước mỗi job crew tự thử chặn (`probe*`). Thử
 * hỏng thì job chạy như trước sandbox này và sổ ghi lý do — tệ nhất là quay về
 * cổng đoán theo giờ, không tệ hơn.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedFor, guardLists } from "../crew-scope.mjs";
import { layoutOf } from "./crew-layout.mjs";

export const SEATBELT = "/usr/bin/sandbox-exec";
const PROFILE = "crew-job";
const PROBE_TIMEOUT_MS = 20_000;

const bare = (p) => String(p).replace(/\/+$/, "");
const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/** Đường thật của workspace: seatbelt so theo đường đã giải symlink (/tmp → /private/tmp). */
export function realWorkspace(workspace) {
  try { return realpathSync(workspace); } catch { return workspace; }
}

/**
 * Vùng ghi của một job, tương đối workspace, không dấu `/` cuối.
 *
 * Lấy đúng `allowedFor` mà cổng collect dùng: sandbox và cổng phải cùng một ý
 * về "job này được ghi đâu", hai bản sẽ trôi nhau. `readOnly` là control plane
 * và file bảo vệ nằm TRONG vùng ghi (vd thư mục task có `.claude/`): add-job đã
 * chặn khai `--allow` chạm tới chúng, nhưng run home thì không qua cổng đó.
 * `.git/` luôn chỉ đọc: worker không được commit.
 */
export function writeScopeFor(manifest, seq) {
  const writable = [...new Set(allowedFor(manifest, [seq]).map(bare).filter(Boolean))];
  const { files, dirs, control } = guardLists(layoutOf(manifest));
  // Sổ của run nằm ngay trong run home: worker ghi được sổ thì tự khai được cả
  // `writeSandbox` — đúng thứ collect dựa vào để thôi đoán. Khoá chỉ đọc.
  const ledger = typeof manifest.runDir === "string" ? [`${bare(manifest.runDir)}/manifest.json`] : [];
  const guarded = [...new Set([...files, ...dirs, ...control, ".git/", ...ledger].map(bare))];
  const readOnly = guarded.filter((g) => writable.some((w) => under(g, w)));
  return { writable, readOnly };
}

/** Chuỗi TOML cơ bản: JSON.stringify ra đúng dạng escape TOML nhận. */
const toml = (s) => JSON.stringify(s);

/**
 * `-c` cho Codex: cả máy chỉ đọc, vùng ghi + thư mục tạm được ghi, control plane
 * trong vùng ghi lại chỉ đọc; mạng mở như `network_access=true` trước đây (job
 * GSC/GA4/crawl cần). Thay cho `--sandbox workspace-write` và cờ mạng cũ.
 */
export function codexProfileArgs({ workspace, writable, readOnly = [] }) {
  const ws = realWorkspace(workspace);
  const entries = [[":root", "read"], [":tmpdir", "write"], [":slash_tmp", "write"]];
  // Workspace chỉ đọc, khai riêng: luật cụ thể hơn thắng, nên một workspace nằm dưới
  // /tmp hay $TMPDIR không bị quyền ghi thư mục tạm phủ lên (đo 15/11 với codex 0.164).
  entries.push([ws, "read"]);
  for (const w of writable) entries.push([join(ws, w), "write"]);
  for (const r of readOnly) entries.push([join(ws, r), "read"]);
  const fs = `{${entries.map(([k, v]) => `${toml(k)}=${toml(v)}`).join(",")}}`;
  return [
    "-c", `default_permissions=${toml(PROFILE)}`,
    "-c", `permissions.${PROFILE}.filesystem=${fs}`,
    "-c", `permissions.${PROFILE}.network={enabled=true,domains={"*"="allow"}}`,
  ];
}

/** Chuỗi seatbelt: escape `\` và `"`. */
const sb = (s) => `"${String(s).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;

/**
 * Profile seatbelt cho agy: mọi thứ như cũ, trừ ghi trong workspace chỉ được ở
 * vùng ghi. Luật sau thắng luật trước, nên thứ tự là: chặn workspace → mở vùng
 * ghi → khoá lại phần chỉ đọc. Ngoài workspace không đụng (agy cần ~/.gemini).
 */
export function seatbeltProfile({ workspace, writable, readOnly = [] }) {
  const ws = realWorkspace(workspace);
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (subpath ${sb(ws)}))`,
    ...writable.map((w) => `(allow file-write* (subpath ${sb(join(ws, w))}))`),
    ...readOnly.map((r) => `(deny file-write* (subpath ${sb(join(ws, r))}))`),
    "",
  ].join("\n");
}

/**
 * Thử chặn thật, không tốn token: trong thư mục tạm, `w/` được ghi, `o/` không.
 * Đạt khi `w/a` có và `o/b` không. Trả `{ ok, reason }`.
 */
function probeWith(run) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), "crew-sbx-probe-"));
    dir = realpathSync(dir);
    mkdirSync(join(dir, "w"));
    mkdirSync(join(dir, "o"));
    const p = run(dir, `touch ${JSON.stringify(join(dir, "w", "a"))}; touch ${JSON.stringify(join(dir, "o", "b"))}; exit 0`);
    if (p.error) return { ok: false, reason: `không chạy được: ${p.error.code ?? p.error.message}` };
    const inside = existsSync(join(dir, "w", "a"));
    const outside = existsSync(join(dir, "o", "b"));
    if (inside && !outside) return { ok: true, reason: null };
    if (!inside) return { ok: false, reason: `thử ghi trong vùng cũng bị chặn (exit ${p.status}${p.stderr ? `: ${String(p.stderr).trim().split("\n").at(-1)}` : ""})` };
    return { ok: false, reason: "thử ghi ngoài vùng KHÔNG bị chặn" };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export function probeSeatbelt() {
  if (process.platform !== "darwin") return { ok: false, reason: `không có seatbelt trên ${process.platform}` };
  if (!existsSync(SEATBELT)) return { ok: false, reason: `không có ${SEATBELT}` };
  return probeWith((dir, cmd) => spawnSync(SEATBELT, ["-p", seatbeltProfile({ workspace: dir, writable: ["w"] }), "/bin/sh", "-c", cmd], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }));
}

export function probeCodexProfile(cmd = "codex") {
  return probeWith((dir, sh) => spawnSync(cmd, [
    // Đúng bộ `-c` job sẽ dùng, kể cả thư mục tạm: thư mục thử nằm trong thư mục tạm
    // nhưng luật "workspace chỉ đọc" cụ thể hơn nên vẫn phải chặn được `o/`.
    "sandbox", ...codexProfileArgs({ workspace: dir, writable: ["w"] }), "--", "/bin/sh", "-c", sh,
  ], { cwd: dir, encoding: "utf8", timeout: PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }));
}

/**
 * Đường worker bị sandbox chặn, đọc từ chữ worker/Codex in ra: dòng
 * "<path>: Operation not permitted" của shell, và lời từ chối `apply_patch` của
 * Codex (không kèm path). Để in gợi ý `--allow`, không để quyết gì.
 */
export function sandboxDenials(text) {
  const s = String(text ?? "").replaceAll("\\n", "\n").replaceAll("\\\"", "\"");
  const paths = new Set();
  // Chỉ nhận chữ trông như đường file (có `/` hoặc `.`): chặn không phải chặn GHI cũng
  // in cùng dạng — "sandbox-exec: sandbox_apply: …" khi lồng sandbox, "ps: …" khi soi
  // tiến trình — và gợi ý `--allow` cho chúng là chỉ sai đường (đo 16/11/2026).
  for (const m of s.matchAll(/([^\s:'"`]+): Operation not permitted/g)) if (/[./]/.test(m[1])) paths.add(m[1]);
  // zsh (shell của Codex) đảo thứ tự và viết thường: "operation not permitted: <path>" (đo 15/11).
  for (const m of s.matchAll(/operation not permitted: ([^\s'"`]+)/g)) paths.add(m[1]);
  const patch = /writing outside of the project/.test(s);
  return { paths: [...paths].slice(0, 10), patch };
}

/**
 * Quyết sandbox ghi cho một job trước khi bắn: `{ kind, writable, readOnly }` khi
 * khoá được, `{ kind: null, reason }` khi chạy như cũ, `null` khi job không có sổ
 * (không có vùng ghi nào để khoá). Ghi vào sổ cả hai trường hợp đầu: collect chỉ
 * tin `kind`, và người đọc sổ cần biết vì sao một job KHÔNG được khoá.
 */
export function planWriteSandbox({ manifest, seq, workspace, enabled = true, skipReason = null, kind, probe }) {
  if (!manifest || !seq) return null;
  if (skipReason) return { kind: null, reason: skipReason };
  if (!enabled) return { kind: null, reason: "crew.config.json khai writeSandbox: false" };
  // Vùng ghi tính theo workspace của sổ; profile dựng theo workspace lúc bắn. Lệch
  // nhau thì khoá sai cây: agy ghi lọt phần còn lại, Codex khoá chỗ không tồn tại.
  if (workspace && manifest.workspace && realWorkspace(workspace) !== realWorkspace(manifest.workspace)) {
    return { kind: null, reason: `--workspace ${workspace} khác workspace của sổ (${manifest.workspace})` };
  }
  const tried = probe();
  if (!tried.ok) return { kind: null, reason: `tự thử chặn không đạt: ${tried.reason}` };
  return { kind, ...writeScopeFor(manifest, seq) };
}

/** Dòng in ra stderr khi worker bị chặn ghi; `resumeHint` là lệnh tiếp đã dựng sẵn. */
export function denialHint({ paths, patch }, { manifestPath, seq, resumeId }) {
  if (!paths.length && !patch) return null;
  const where = [...paths, ...(patch ? ["(apply_patch bị từ chối ghi ngoài vùng)"] : [])].join(", ");
  return `worker bị sandbox ghi chặn ở: ${where}\n`
    + `  → nếu job thật cần ghi chỗ đó: crew amend ${manifestPath} --job ${seq} --allow <thư mục> --note "<vì sao>"`
    + `${resumeId ? `, rồi bắn lại job ${seq} kèm --resume ${resumeId} để làm tiếp trên thread cũ` : ", rồi bắn lại job"}`;
}
