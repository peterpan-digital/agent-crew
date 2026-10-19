/**
 * Sổ của người đọc trong manifest: những câu chỉ lệnh của người đọc được ghi, và gate
 * tin mà không kiểm lại.
 *
 *   replacedJobs    --replaced     job hỏng có job khác làm thay
 *   runtimeAcks     --ack-runtime  đã đọc chỗ runtime lệch evidence / evidence đổi
 *   dismissedPaths  --not-ours     path không phải của run, bỏ khỏi kiểm phạm vi ghi
 *
 * Worker ghi được manifest (nó nằm trong `tasks/{task}/`, và kiểm phạm vi bỏ qua chính
 * manifest), nên một dòng giả trong sổ là đường mở cổng: tự bác vi phạm ghi ngoài phạm
 * vi của mình, tự ack chỗ runtime báo fail. Cách chặn giống nhau cho cả ba:
 *
 *   1. Không ghi sổ khi run còn job pending/running (`assertReaderLedgersWritable`).
 *      Gate cũng không exit 0 được lúc đó (RUNNING là verdict chặn), nên người đọc chỉ
 *      mất việc gõ lại lệnh sau khi job xong, không mất lần report nào.
 *   2. Vì giữa claim và thoát không có lần ghi hợp lệ nào, claim chụp vân tay từng sổ và
 *      adapter giữ một bản trong bộ nhớ, so lại ở mọi đường thoát
 *      (`crew-manifest.holdsTamperPatch`). Bản trong manifest worker sửa được cùng lúc
 *      với sổ; bản trong bộ nhớ thì không.
 *
 * Không chọn cách "đóng dấu lại vân tay của job đang chạy mỗi lần collect ghi" (như
 * claim làm với `holds`): vân tay đó nằm trong manifest, worker tự tính lại được, nên
 * không chặn được ai cố ý. Cũng không dời sổ ra file khác: mọi chỗ trong repo mà worker
 * không ghi được thì collect cũng không có, và ngoài repo thì worker app vẫn với tới.
 *
 * Rủi ro còn lại, chung cho mọi sổ: worker app chạy tiếp SAU khi adapter thoát thì không
 * còn ai so (xem lib/replaced-jobs.mjs).
 *
 * Hàm thuần trên object manifest; người gọi bọc trong lock.
 */
import { createHash } from "node:crypto";
import { liveJobs } from "./holds.mjs";

/** Tên sổ → trường vân tay trên job. `replacedFingerprint` giữ tên cũ cho manifest đã có. */
export const READER_LEDGERS = {
  replacedJobs: "replacedFingerprint",
  runtimeAcks: "acksFingerprint",
  dismissedPaths: "dismissedFingerprint",
};

/** Vân tay một sổ. Vắng thì giống mảng rỗng, để manifest cũ không bị tính là khác. */
export function ledgerFingerprint(list) {
  return createHash("sha256").update(JSON.stringify(list ?? [])).digest("hex");
}

/** Vân tay mọi sổ, theo tên trường trên job. */
export function ledgerFingerprints(m) {
  return Object.fromEntries(Object.entries(READER_LEDGERS).map(([ledger, field]) => [field, ledgerFingerprint(m[ledger])]));
}

/** Từ chối ghi sổ khi run còn job sống. `flag` là cờ CLI để câu lỗi nói đúng lệnh. */
export function assertReaderLedgersWritable(m, flag) {
  const live = liveJobs(m);
  if (live.length) {
    throw new Error(
      `${flag}: run còn job đang chạy hoặc chờ chạy (${live.map((j) => `${j.seq}:${j.status}`).join(", ")}) — chưa ghi gì\n` +
      "  → đợi các job đó xong rồi chạy lại đúng lệnh này; job treo không evidence thì bỏ bằng --abandon <seq>",
    );
  }
}
