# Windows / macOS

Plugin này được viết để chạy cả trên Windows và macOS. Chỗ nào khác nhau thì nằm gọn
trong `lib/platform.mjs`; file này ghi lại **cái gì đã xử, cái gì chưa verify**.

Chạy `crew doctor` trước khi dispatch lần đầu trên một máy mới. Nó in platform, phiên
bản Node, có git hay không, và `agy`/`codex` resolve tới đâu.

## Yêu cầu

| Thứ | Bản |
| --- | --- |
| Node | 20 trở lên (dùng `readdirSync({recursive})` và `parentPath`) |
| git | cần cho nửa "diff" của cổng phạm vi ghi; thiếu thì cổng nói thẳng là chỉ còn một nửa |
| `agy` | chỉ cần nếu dùng worker `antigravity` |
| `codex` | chỉ cần nếu dùng worker `codex` |

Có một trong hai CLI là chạy được. Không có cái nào thì `crew doctor` trả exit 1.

Không cần MCP, không cần credential, không cần dịch vụ ngoài.

## Bảy chỗ khác nhau giữa hai platform, và cách xử

| # | Vấn đề | Cách xử |
| --- | --- | --- |
| 1 | Trên Windows, CLI cài qua npm thường là `codex.cmd`; Node **từ chối** spawn `.cmd`/`.bat` khi không có shell (EINVAL từ Node 18.20/20.12) | `resolveBin` tra PATH bằng `where`, **ưu tiên `.exe`**; nếu chỉ có shim `.cmd` thì `buildLaunch` gọi qua `cmd.exe /d /s /c` với quoting tự viết |
| 2 | Không dùng `shell: true` ở đâu cả | Shell nhận một chuỗi ghép, mà một trong các tham số là brief viết từ request của user — `&`, `|`, `%VAR%` sẽ bị cmd hiểu. Tham số nào chứa ký tự cmd hành động được thì bị **từ chối**, không escape rồi cầu may |
| 3 | Brief đi qua argv là không an toàn với shim `.cmd` | Codex nhận brief qua **stdin** nên không đụng argv. `agy` chỉ nhận qua `-p`, nên khi gặp shim, adapter tự chuyển sang `file-pointer`: argv chỉ mang đường dẫn, worker tự đọc brief từ file. Việc chuyển được **ghi vào manifest** (`promptMode`), không làm im lặng |
| 4 | Windows không có process group âm, nên `kill(-pid)` của watchdog không chạy | `killTree` dùng `taskkill /PID x /T /F` trên Windows, `kill(-pid)` trên POSIX. Không có bậc "polite" trên Windows — `/F` là bắt buộc vì một CLI đang chờ stdin không đáp lời đóng nhẹ nhàng |
| 5 | `git status` in dấu `/`, `node:path` in dấu `\` trên Windows | Mọi so sánh đường dẫn đi qua `comparablePath`/`pathStartsWith`: chuẩn về `/`, và **lowercase trên Windows** vì Windows không phân biệt hoa thường. Không làm bước này thì cổng phạm vi ghi khớp **không gì cả** — và "không khớp gì" đọc ra thành "không có vi phạm nào" |
| 6 | `if (import.meta.url === \`file://${process.argv[1]}\`)` **luôn false** trên Windows (`file:///C:/...` vs `C:\...`) | Chỉ còn một entrypoint (`bin/crew.mjs`) và nó dùng `pathToFileURL`. Bản gốc có 4 file mang lỗi này — mỗi file sẽ load, không làm gì, và exit 0 |
| 7 | Skill cũ dùng `date +%y%m%d`, `mkdir -p`, `tail -f`, và `${f/a/b}` của bash | Không còn dòng shell nào trong `SKILL.md`. Mọi thứ đi qua `crew new-run`, `crew retry-log`, `crew watch` |

## Chưa verify trên Windows

Nói thẳng chỗ này vì nó quyết định mức tin cậy:

- **Bảy điểm trên được suy từ code và từ tài liệu Node, chưa chạy thật trên một máy
  Windows.** Test suite chạy được trên Windows theo thiết kế (không có bash, không có
  `tail`, fixture là Node) nhưng chưa có ai chạy nó ở đó.
- **`agy` trên Windows nằm ở đâu và tên gì**: chưa biết. Nếu nó là shim `.cmd`, adapter
  sẽ tự chuyển sang `file-pointer` — đường đó có code nhưng chưa chạy thật.
- **`codex` trên Windows là `.cmd` hay `.exe`**: chưa kiểm. Cả hai đường đều có code.
- **Đường dẫn có dấu cách** (`C:\Users\Ten Nguoi Dung\...`): quoting đã viết theo luật
  CreateProcess nhưng chưa chạy thật.

Gặp lỗi ở một trong các chỗ này thì đường thoát nhanh nhất là trỏ thẳng vào binary:

```bash
# PowerShell / cmd
set AGENT_CREW_CODEX_BIN=C:\full\path\to\codex.exe
set AGENT_CREW_AGY_BIN=C:\full\path\to\agy.exe
```

```bash
# macOS / Linux
export AGENT_CREW_CODEX_BIN=/usr/local/bin/codex
```

Env var được ưu tiên tuyệt đối. Trỏ vào một đường dẫn không tồn tại thì đó **là** lỗi —
nó không âm thầm quay về tra PATH, vì như vậy là trao cho người dùng một binary khác cái
họ vừa chỉ định.

## Shell nào chạy các lệnh này

`SKILL.md` chỉ chứa lệnh `node "..."`, nên shell nào cũng được: bash, zsh, Git Bash,
PowerShell, cmd. Đó là chủ ý — không có dialect nào phải đúng.

Một chỗ duy nhất còn phụ thuộc shell là cách bạn bắn job **chạy nền**. Trong Claude Code
thì dùng Bash tool với `run_in_background: true`, không dùng `&` — lý do ở Bước 5 của
`SKILL.md`.
