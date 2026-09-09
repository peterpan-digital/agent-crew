# Chọn transport: `headless` hay `app`

`role` là **lý do** (ai chịu trách nhiệm acceptance). `transport` là **hệ quả** (harness
thấy được gì trong lúc job chạy). Hai trục khác nhau, và tách chúng ra là điều kiện để
một run cũ vẫn đọc được: bạn hỏi được "quyết định đó dựa trên gì".

## `headless` là mặc định, vì đo được

Đo 2026-08-25, 6 job transport `app` thật:

| Đo được | Nghĩa là |
| --- | --- |
| Anti app trả `runtimeOk: true` **vô điều kiện**; không `usage`, không `response`, không `numTurns` | Mất khả năng phát hiện silent-fail mà headless có: `SUCCESS` + `response` rỗng chính là dấu hiệu một tool bị chặn ở prompt permission |
| Codex app: `exitCode: null` | Không có exit code để đọc; verdict phải dựa hoàn toàn vào evidence |
| Thread app **không hiện live** — rollout có trên đĩa ở +8s, mắt chỉ thấy sau khi tắt/mở lại app | "Mở app ngồi xem cho chắc" không mua được cái nó hứa |

Nói gọn: `app` **quan sát yếu hơn** `headless`, không mạnh hơn. Nên nó là ngoại lệ có lý
do, không phải mặc định — và lý do phải viết ra được.

Bản plugin này sửa được một trong ba dòng trên: adapter Codex app giờ tự áp trần timeout
**độc lập** với `status --wait` của companion, nên job treo vì broker chết vẫn bị giết
đúng hạn. Hai dòng còn lại là tính chất của runtime, không sửa được từ đây.

## Ba ca `app` đáng giá

1. **Job sẽ gặp prompt permission cần người trả.** Anti app cho người bấm đồng ý;
   headless gặp prompt là silent-fail. Đây là ca mạnh nhất.
2. **Việc mở/khám phá, chưa viết nổi acceptance trước.** Không có tiêu chí chấm thì mất
   evidence-first cũng không mất gì; đổi lại owner nhìn được quá trình.
3. **Cần thread resume làm tiếp buổi sau.** Chỉ thread app có.

Ngoài ba ca này, chọn `app` là đang trả giá quan sát để lấy một thứ chưa nêu được.

## Điều kiện chạy được `app`

`headless` chỉ cần `agy` / `codex` trên PATH. `app` cần thêm, và **`crew doctor` in ra
đúng trạng thái từng cái**:

### Antigravity `app`

| Cần | Ghi chú |
| --- | --- |
| App Antigravity **đang chạy** | Discovery tìm process `language_server` có `--subclient_type hub` |
| Workspace **đã mở trong app** ít nhất một chat | `projectId` chỉ tồn tại trên conversation đã bind vào đúng folder |
| `ps` + `lsof` (POSIX) hoặc PowerShell (Windows) | Xem `platform-notes.md` |

Không cần cài gì thêm và **không cần khai đường dẫn**: binary `language_server` được lấy
từ argv của chính process đang chạy, nên nó luôn là binary đang phục vụ app đó. `agentapi`
là subcommand của binary ấy.

`sqlite3` là **tuỳ chọn**. Nó chỉ dùng cho một fallback: worker chạy xong mà không ghi
dòng `Status:`. macOS có sẵn `/usr/bin/sqlite3`; Windows không có gì. Thiếu nó thì job
dựa hoàn toàn vào evidence file + timeout, và bản ghi nói rõ là fallback đã tắt.

### Codex `app`

Cần **companion của plugin `openai-codex`** — code của project khác, không ship kèm đây.
`crew doctor` báo có/không. Trỏ tay bằng:

```bash
AGENT_CREW_CODEX_COMPANION=<đường dẫn tuyệt đối tới codex-companion.mjs>
```

Không có companion thì transport `app` của Codex **báo lỗi**, không tự tụt về `headless`.
Tụt âm thầm là đúng loại lỗi cái harness này sinh ra để bắt: sổ ghi `app`, không có chat
box nào mở ra, và không ai biết bên nào nói dối.

## Ledger

`transport` được ghi vào manifest lúc `add-job` và **niêm phong**: `updateJob` không đổi
được, `job.extra` không chèn được. Lúc dispatch, `assertTransport` từ chối nếu process đi
đường khác với đường sổ ghi — kiểm **trước** khi claim slot, vì từ chối sau claim là rò
slot cho hết run.

Manifest version `2` là version thêm `transport`. Run version `1` vẫn đọc được; nó chỉ
không trả lời được câu hỏi nó chưa từng ghi — và `assertTransport` phân biệt "không có
field" với "field bằng null" (job `claude`) chứ không gộp hai thứ đó lại.
