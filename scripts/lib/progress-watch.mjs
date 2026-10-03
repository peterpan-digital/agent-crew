/**
 * Một job Anti app còn sống hay đã im: hai hàm thuần, không đọc đồng hồ, không
 * ghi gì, không gọi app. `anti-run` đem kết quả đi ghi sidecar.
 *
 * Vì sao không dùng mtime làm tín hiệu chính: bất cứ thứ gì trong hệ thống crew
 * cũng làm mtime nhảy (manifest được sửa mỗi lần có job đổi trạng thái, log
 * dispatch, evidence của job KHÁC), nên đồng hồ im không bao giờ tới ngưỡng. Tín
 * hiệu chính là `byStatus` của chính conversation: nó chỉ đổi khi một bước của
 * conversation đó đổi trạng thái. mtime chỉ tính file mà RIÊNG job này khai ở
 * `filesMayModify`, và chỉ được hoãn báo động.
 *
 * Bảng `steps` không có cột thời gian, nên chưa có số đo nền cho ngưỡng: 5m/10m là
 * mặc định do owner chốt, và `quietMaxSec` được ghi vào job để sau này chỉnh theo số.
 */
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export const DEFAULT_QUIET_WARN_MS = 5 * 60_000;
export const DEFAULT_QUIET_ALERT_MS = 10 * 60_000;

/** Tối đa bao nhiêu entry duyệt cho một lần đo: poll mỗi 5 giây, không được quét cả ổ. */
const MAX_ENTRIES = 2000;
const LEVELS = ["ok", "warn", "alert"];

/** Vân tay của `byStatus`, không phụ thuộc thứ tự khoá. null nếu chưa đọc được. */
export function statusFingerprint(byStatus) {
  if (!byStatus || typeof byStatus !== "object") return null;
  return JSON.stringify(Object.entries(byStatus).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * mtime (ms) mới nhất của các file mà job này khai ở `filesMayModify`, hoặc null.
 *
 * `lstat`, không `stat`: symlink bị bỏ chứ không theo, vì một symlink trỏ ra ngoài
 * sẽ làm mtime của file không liên quan thành "tiến triển". Thư mục `reports/crew-*`
 * bị bỏ, vì đó là chỗ hệ thống crew ghi (manifest, brief, evidence của mọi job).
 */
export function newestOwnMtime(workspace, prefixes = []) {
  let newest = null;
  let seen = 0;
  const visit = (abs, depth) => {
    if (seen >= MAX_ENTRIES || depth > 6) return;
    seen += 1;
    let st;
    try { st = lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names;
      try { names = readdirSync(abs); } catch { return; }
      const inReports = abs.split("/").at(-1) === "reports";
      for (const name of names) {
        if (inReports && name.startsWith("crew-")) continue;
        visit(join(abs, name), depth + 1);
      }
    } else if (st.isFile()) {
      newest = newest === null ? st.mtimeMs : Math.max(newest, st.mtimeMs);
    }
  };
  for (const prefix of prefixes) {
    if (typeof prefix !== "string" || !prefix || isAbsolute(prefix) || normalize(prefix).startsWith("..")) continue;
    visit(join(workspace, prefix), 0);
  }
  return newest;
}

/**
 * Một lần poll: tiến triển không, đang ở mức nào, có phải báo không.
 *
 * Mức chỉ tăng trong lúc im, và chỉ `byStatus` đổi mới hạ nó về `ok` (kèm sự kiện
 * `recovered` để người đang nghe biết khỏi dừng). mtime của file riêng job chỉ đẩy
 * mốc im về sau, nên hoãn được một mức chưa báo nhưng không xoá mức đã báo.
 *
 * @returns {{ progressed: boolean, fingerprint: string|null, lastProgressAt: number,
 *             level: "ok"|"warn"|"alert", emit: "warn"|"alert"|"recovered"|null, quietMs: number }}
 */
export function progressVerdict({
  prevFingerprint = null, byStatus, newestOwnMtime: ownMtime = null, lastProgressAt, level = "ok", now, warnMs, alertMs,
}) {
  const fingerprint = statusFingerprint(byStatus);
  // Lần poll đầu (chưa có vân tay trước) là mốc để so, chưa phải tiến triển.
  const progressed = prevFingerprint !== null && fingerprint !== null && fingerprint !== prevFingerprint;

  if (progressed) {
    return { progressed: true, fingerprint, lastProgressAt: now, level: "ok", emit: level === "ok" ? null : "recovered", quietMs: 0 };
  }

  // mtime ở tương lai (lệch đồng hồ) coi như "vừa xong", không để nó che báo động vô hạn.
  const reference = Math.min(now, Math.max(lastProgressAt, ownMtime ?? 0));
  const quietMs = now - reference;
  const reached = quietMs >= alertMs ? "alert" : quietMs >= warnMs ? "warn" : "ok";
  const next = LEVELS[Math.max(LEVELS.indexOf(level), LEVELS.indexOf(reached))];
  return {
    progressed: false,
    fingerprint: fingerprint ?? prevFingerprint,
    lastProgressAt,
    level: next,
    emit: next !== level && next !== "ok" ? next : null,
    quietMs,
  };
}
