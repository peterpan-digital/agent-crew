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
| 6 | `if (import.meta.url === \`file://${process.argv[1]}\`)` **luôn false** trên Windows (`file:///C:/...` vs `C:\...`) | Chỉ còn một entrypoint (`bin/crew.mjs`) và nó **không có guard nào cả** — xem mục dưới. Bản gốc có 4 file mang lỗi này; mỗi file sẽ load, không làm gì, và exit 0 |
| 7 | Skill cũ dùng `date +%y%m%d`, `mkdir -p`, `tail -f`, và `${f/a/b}` của bash | Không còn dòng shell nào trong `SKILL.md`. Mọi thứ đi qua `crew new-run`, `crew retry-log`, `crew watch` |

## Vì sao entrypoint không có guard "am I main"

Viết lại bằng `pathToFileURL` thay vì ghép chuỗi **chỉ sửa được cách viết trên
Windows**, và vẫn trả lời sai mọi khi hai đường dẫn là hai cách viết của cùng một file:
`import.meta.url` đã resolve qua symlink, còn `process.argv[1]` là đúng cái người gọi gõ.

Đo được: chạy `bin/crew.mjs` từ `/tmp/...` trên macOS — `/tmp` là symlink tới
`/private/tmp` — so `file:///private/tmp/...` với `file:///tmp/...`, guard false, lệnh
**exit 0 mà không in gì**. Đó là kiểu hỏng tệ nhất một tool như này có thể có: thành công
im lặng. Windows còn ba cách viết nữa gây đúng chuyện đó: hoa/thường của ký tự ổ đĩa, tên
8.3, và đường UNC.

Không file nào import `bin/crew.mjs` — mọi caller đều spawn nó, test cũng spawn — nên
điều kiện đó không có việc gì để làm. File **là** chương trình: nạp là chạy.
`tests/cli-entrypoint.test.mjs` khoá tính chất này, gồm một ca chạy qua đường symlink.

Cùng lý do, entrypoint đặt `process.exitCode` thay vì gọi `process.exit(code)`:
`exit()` bỏ những gì stdout còn đang xếp hàng, mà trên pipe — cách mọi caller đọc nó,
kể cả Bash tool — `console.log` **có** xếp hàng. Gọi `exit()` làm output rỗng ngẫu nhiên
theo độ dài.

## Transport `app`: chỗ khác nhau nhiều nhất

`headless` chỉ spawn một CLI. `app` phải **đọc trạng thái máy đang chạy**, và đó là chỗ
hai platform không dùng chung một dòng code nào:

| Việc | POSIX | Windows |
| --- | --- | --- |
| Liệt kê process + argv đầy đủ | `ps -Ao pid,command` | `Get-CimInstance Win32_Process` (JSON) |
| Cổng loopback của một pid | `lsof -nP -a -p <pid> -i` | `Get-NetTCPConnection -State Listen -OwningProcess` |
| Đọc snapshot conversation DB | `sqlite3` (macOS có sẵn) | **không có** — fallback tự tắt |

Cả ba nằm trong `lib/os-probe.mjs`. Không có implementation chung để gộp: hai bên không
thống nhất thứ gì ngoài **hình dạng câu trả lời**, nên seam đặt ở giá trị trả về.

Ba điều đáng biết:

1. **Không hardcode đường dẫn cài đặt Antigravity.** Bản gốc lấy `agentapi` từ
   `~/.gemini/antigravity/bin/agentapi`, mà trên macOS file đó là wrapper 100 byte
   `#!/bin/sh` exec sang `/Applications/Antigravity.app/.../language_server agentapi "$@"`
   — vừa là shebang POSIX vừa là đường dẫn macOS, tức hai lý do riêng biệt để không bao
   giờ chạy trên Windows. Bản này lấy binary từ **argv của chính process đang chạy**. Đó
   không phải cách lách: nó là câu trả lời đúng hơn trên cả hai platform, vì nó chỉ có thể
   trỏ vào binary đang thật sự phục vụ app này, thay vì một install nào đó mà đường dẫn
   tình cờ trỏ tới.
2. **Khớp process phải khớp trên token executable, không phải substring cả dòng.** Đo lúc
   dựng: tìm substring trả về 3 process trên máy chỉ chạy **một** app — hai cái kia là
   chính process probe và shell của nó, vì argv của chúng chứa đúng những chuỗi đang tìm.
   Trên Windows còn thêm một biến thể: `CommandLine` bọc executable trong dấu ngoặc kép
   khi đường dẫn có dấu cách, tức ca `C:\Program Files\...` là ca bình thường.
3. **`sqlite3` là tuỳ chọn, không phải điều kiện.** Nó chỉ phục vụ một fallback (worker
   xong mà không ghi dòng `Status:`). Bắt Windows cài sqlite3 để mở được cả transport,
   cho một tín hiệu mà transport không dùng để quyết định gì, là đổi sai.

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
- **`Get-CimInstance` / `Get-NetTCPConnection`**: viết theo cmdlet chuẩn, chưa chạy thật.
  Cả hai có sẵn trên Windows 10/Server 2016 trở lên; máy cũ hơn thì transport `app` của
  Antigravity không dùng được, `headless` vẫn chạy.
- **Antigravity app trên Windows**: process của nó có mang `--subclient_type hub` và
  `--app_data_dir antigravity` như trên macOS hay không — chưa kiểm. Nếu không, discovery
  báo "app không chạy" trong khi app đang chạy. Đường thoát: `AGENT_CREW_AGENTAPI` trỏ
  thẳng vào `language_server.exe`.
- **`CommandLine` là `null` khi process thuộc user khác.** Dòng đó bị bỏ chứ không bị báo
  là process không có argv — nhưng nếu Antigravity chạy dưới user khác thì nó sẽ vô hình
  với discovery.

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

Transport `app` có ba env var riêng, cùng luật:

| Env var | Trỏ vào |
| --- | --- |
| `AGENT_CREW_AGENTAPI` | `language_server` (hoặc `.exe`) của app Antigravity, hoặc một entrypoint agentapi |
| `AGENT_CREW_CODEX_COMPANION` | `codex-companion.mjs` của plugin `openai-codex` |
| `AGENT_CREW_SQLITE` | `sqlite3`, chỉ để bật lại fallback step-status |

Env var được ưu tiên tuyệt đối. Trỏ vào một đường dẫn không tồn tại thì đó **là** lỗi —
nó không âm thầm quay về tra PATH, vì như vậy là trao cho người dùng một binary khác cái
họ vừa chỉ định.

## Shell nào chạy các lệnh này

`SKILL.md` chỉ chứa lệnh `node "..."`, nên shell nào cũng được: bash, zsh, Git Bash,
PowerShell, cmd. Đó là chủ ý — không có dialect nào phải đúng.

Một chỗ duy nhất còn phụ thuộc shell là cách bạn bắn job **chạy nền**. Trong Claude Code
thì dùng Bash tool với `run_in_background: true`, không dùng `&` — lý do ở Bước 5 của
`SKILL.md`.
