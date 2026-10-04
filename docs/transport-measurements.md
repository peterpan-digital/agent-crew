# Nhật ký đo transport

File này **không nạp** khi vận hành. Nó giữ các phép đo đã sinh ra luật trong
`routing-table.md` và `references/` của skill điều phối, để lần sau khỏi đo lại hay
"phát hiện" lại. Luật thì nằm ở các file đó, không ở đây.

## Owner gõ tay trong app Codex: bề mặt thứ tư (đo 2026-09-22)

**Owner tự ngồi gõ trong app Codex là bề mặt THỨ TƯ, khác hẳn** (đo 22/09/2026, owner
chạy probe 3 bước và dán nguyên văn kết quả). Nó **không bị sandbox**: `date >
~/codex-sandbox-probe.txt` chạy được, ghi thẳng ra ngoài repo. Trình duyệt mở được
example.com và trả accessibility tree; Computer Use chụp được screenshot. Cả ba thứ
mà crew `--mode app` đều bị chặn.

Bộ tool cũng **không phải 18 tool** của ba bề mặt dispatch, mà là bộ khác hẳn:
`exec_command`, `apply_patch`, `web.run`, `image_gen`, `multi_tool_use.parallel`, cộng
~40 tool `mcp__codex_app.*` (`send_message_to_thread`, `list_threads`, `read_thread`,
`fork_thread`, `create_worktree`...).

Kết luận đúng, và nó hẹp hơn nghe tưởng: **sandbox là thuộc tính của lệnh gọi**, và
crew tự áp nó ở cả hai transport dispatch. Owner gõ tay không đi qua crew nên không
dính. Điều này **không** biến `--mode app` thành lối thoát — đường dispatch vẫn y cũ.

Ba phép đo chức năng là kết quả thật. Danh sách tool thì runtime **tự khai**, nên đọc
nó như lời khai, không như phép đo.

### Worker ghi file bằng shell — đo 2026-08-25

Probe Anti headless: nó gọi `write_to_file` → **TOOL_ERROR**
(`artifacts must be in ~/.gemini/antigravity-cli/brain/`, xảy ra **cả khi file nằm trong
workspace**), rồi quay sang `run_command`:

```text
echo "hello-authorship" > probe.txt && echo "line-two" >> probe.txt
```

Hệ quả cho mọi thứ đọc "worker đã ghi file nào":

- Danh sách file runtime tự khai (`touchedFiles`, event `file_change`) là sổ của **tool ghi
  file**. File ghi bằng shell không có trong đó.
- Nên nó xác nhận được, **không** loại trừ được: khai X thì X là của job đó; không khai gì
  thì không suy ra được là không ghi.
- Với Anti thì đây là **thường lệ**, không phải ngoại lệ — `write_to_file` trên máy này đang
  từ chối mọi đường ngoài `brain/`.
- Anti `--output-format json` không trả field nào về file. Muốn có phải đổi sang
  `stream-json` (`step_type: "tool"` + `tool_info.parameters`), nhưng đó là viết lại toàn bộ
  đường parse của `anti-run.mjs` kể cả phép phát hiện silent-fail — chưa làm.

Bằng chứng: bản ghi probe stream-json của Anti ngày 25/08 (dữ liệu nội bộ, không phát hành cùng module).

### `result` của companion — đo 2026-08-25 (bản 1.0.5)

`codex-run.mjs --mode app` giờ gọi `result <job-id>` sau khi job settle. Hình dạng thật:

| Field | Là gì |
| --- | --- |
| `storedJob.result.rawOutput` | Câu trả lời của worker. Đây là cái adapter lưu, ghi ra `{job}.codex-app-reply.md`, manifest trỏ qua `lastMessage` |
| `storedJob.rendered` | Cùng nội dung + footer "Resume in Codex" của companion. Fallback khi `rawOutput` rỗng |
| `storedJob.result.status` | **Exit status thật** (0 trên cả 2 job đo được). Ghi vào `companionExitStatus`, **không** vào `exitCode` — job fail trả gì thì chưa đo được |
| `storedJob.result.touchedFiles` | **Danh sách file runtime tự khai đã ghi**, per-job. Job thật 25/08 trả đúng 1 file khớp evidence path |
| `job.summary` vs `storedJob.summary` | Hai thứ khác nhau: `job.summary` là trích câu trả lời; `storedJob.summary` là dòng đầu brief bị cắt. Cái app hiển thị là `storedJob.summary` |

`touchedFiles` là tín hiệu tác giả mà cổng write-scope hôm nay không có. Nó quy kết bằng
mtime, nên một session khác sửa file trong lúc run là gate báo oan — đúng ca Run A exit 2
ngày 25/08.

Mọi lỗi của `result` đều **không** làm job fail: ghi vào `replyError` rồi đi tiếp. Job đã
ghi evidence hợp lệ thì không được fail vì mất phần ghi chép.

### Ba job app song song — đo 2026-08-25

3 job app cùng lúc (2 Codex `--effort low` + 1 Anti `flash`): 3/3 xong, **0 job mất,
0 job fail**, cổng nghiệm thu exit 0. Tổng 132 giây so với 228 giây khi chạy tuần tự 2
job — song song ăn được thật.

> **Sửa lại con số này ngày 25/08 (chiều), có căn cứ.** Đoạn dưới từng ghi "số app-server
> đi từ 1 lên 2", suy ra từ việc job thứ hai có process companion **detached** (ppid 1).
> Phép đo trực tiếp cho thấy suy luận đó sai: `task-worker` của companion **luôn** có
> ppid 1 ngay từ lúc sinh ra (đo: pid 10778, ppid 1,
> `codex-companion.mjs task-worker --job-id ...`). Đó là cách companion detach job nền,
> **không** phải dấu hiệu có app-server thứ hai. Đo lại với quy chủ theo broker: 2 job app
> chạy song song dùng **chung 1** app-server của broker, ở cả mốc dispatch và mốc settle.
>
> Chưa đo lại đúng hỗn hợp cũ (2 Codex + 1 Anti), nên không kết luận con số cho ca đó.
> Chỉ kết luận: cách đếm cũ không phân biệt được app-server với task-worker detached.

Đường phân nhánh ở `codex.mjs:623-637` có thật, nhưng `broker.log` rỗng nên chưa biết
cơ chế là `BROKER_BUSY` fallback hay mỗi background job vốn tự mở runtime.

### Codex app transport — đo 2026-08-25

Đường vào app của Codex là `codex-companion.mjs` trong plugin `codex-plugin-cc`, gọi
**thẳng**, không qua subagent. Hình dạng đã đo với companion 1.0.5:

| Lệnh | Trả về |
| --- | --- |
| `task --background --json` | `{ jobId, status:"queued", title, summary, logFile }` |
| `status <id> --wait --json` | `{ workspaceRoot, job, waitTimedOut, timeoutMs }` |
| `job.status` | `queued` / `running` / `completed` / `failed` / `cancelled` |
| `job.threadId` | id thread trong app — đã có sẵn lúc job settle, dùng làm `conversationId` |

Khác app mode của Anti ở một chỗ quan trọng: Codex **có tín hiệu hoàn thành thật**
(`--wait` chặn tới khi settle), nên adapter không phải poll file evidence để đoán. Trần
timeout vẫn giữ riêng vì `--wait` cũng treo được nếu broker chết; hết trần thì gọi
`cancel` trước khi báo lỗi.

Ba chỗ đã đo và **không** suy diễn được:

- Field `title` trong JSON luôn là `"Codex Task"`, không có cờ đặt tên — **nhưng app
  hiển thị theo `summary`**: danh sách thread hiện `Codex Companion Task: {dòng đầu brief}`
  (kiểm bằng mắt 25/08). Nên dòng đầu brief phải là title job; đó là thứ duy nhất phân biệt
  các thread trong app. Đừng kết luận từ riêng field `title` như phase 2 từng làm.
- Thread **hiện trong app Codex**, và 2 job Codex song song thì **hiện đủ 2**, không cái
  nào bị nuốt (đo 25/08, run B). Thread cũng lưu trên đĩa ở
  `~/.codex/sessions/.../rollout-*.jsonl` và resume được bằng `codex resume <id>`.
- **Nhưng KHÔNG hiện live.** Đo 25/08 bằng một job sống 224 giây: rollout có trên đĩa sau
  **8 giây**, app vẫn không thấy suốt cả job; phải **tắt app rồi mở lại** mới hiện. Cơ chế
  khớp dữ liệu (suy luận, chưa đo trực tiếp): app làm chủ backend riêng và chỉ đọc lại
  session store lúc khởi động, nên thread do backend khác ghi thì nó không hay.

- **Cảnh báo cho lần đo sau:** companion `spawn("codex", ["app-server"])`
  (`app-server.mjs:190`) nên process app-server đó *không phải* process của app desktop.
  Từ đó **không** suy ra được thread vắng mặt trong app: app đọc rollout theo yêu cầu, nên
  `lsof` không thấy handle và storage app không chứa thread id. Cả hai đều là bằng chứng
  vắng mặt vô giá trị — 25/08 đã kết luận sai một lần vì chúng. Chỉ mắt người mới trả lời
  được câu này.
- `sessionRuntime` **không** có ở `status <job-id>` (trả `null`). Nó chỉ có ở lệnh
  `setup` (`codex-companion.mjs:208`) — và `setup --json` chỉ mất **0.45-0.52s**, nên gọi
  nó là được, không cần tự suy. Suy từ `broker.json` là **đường dự phòng**, và phải kiểm
  pid: file sống lâu hơn tiến trình, nên "có `endpoint`" một mình sẽ báo `shared` cho một
  runtime đã chết.
- **Broker được dựng bởi chính lệnh dispatch**, không phải có sẵn hay không. Đo 25/08:
  trước job nào thì `direct`; sau job đầu thì broker sống và mọi job sau là `shared`.
  Đừng đo trạng thái broker khi chưa chạy job rồi kết luận máy không có broker.
  Bổ sung 25/08 (tối): reading còn **tự đổi** mà mình không làm gì — `direct` lúc 21:47,
  `shared` lúc 22:05, không dispatch gì ở giữa (broker của session khác lên). Nên một
  reading đơn lẻ không mô tả được cái máy lúc job thật sự chạy; xem mục dưới.
- `--write` là **bắt buộc**, không theo `role`: mọi job crew đều phải tự ghi file
  evidence, nên app mode read-only thì không job nào qua được cổng evidence.

### Runtime Codex ghi ở hai mốc — đo 2026-08-25

Manifest có ba field khác nhau, đừng lẫn: `role` là **lý do** chọn, `transport` là **lựa
chọn**, `codexRuntime` là **máy đã làm gì với lựa chọn đó**. Field thứ ba chỉ để đọc lại,
không có gì route theo nó.

Ghi **hai** mốc chứ không một, vì reading không ổn định: `direct` lúc 21:47 → `shared` lúc
22:05, không dispatch gì ở giữa. `atDispatch` do job **đầu tiên** bắn ghi (ghi một lần rồi
khoá), `atSettle` do job **cuối cùng** lắng ghi (ghi đè mỗi lần) — nhờ vậy các adapter chạy
song song không cần phối hợp gì mà ngữ nghĩa vẫn đúng.

Chỉ app mode ghi field này. Headless là `codex exec`, process riêng, không qua broker —
"chung hay riêng runtime" không phải câu hỏi tồn tại với nó, và lấy reading trong lúc chạy
headless sẽ gán broker của session khác cho job đó.

**Đếm app-server phải có quy chủ.** Đo 25/08, cùng một lúc có 5 process khớp mẫu và chỉ 3
là của ta:

| pid | chủ |
| --- | --- |
| 18224 | ChatGPT.app — không liên quan crew |
| 55831 | extension VS Code — không liên quan crew |
| 65720 | broker của plugin (`app-server-broker.mjs`) — **không phải** app-server |
| 65736 → 65737 | app-server của ta: node wrapper + native child = **một** server |

Nên một con số đếm trần là con số đổi khi user mở VS Code. Ba phân biệt bắt buộc: broker
không phải server; hai process là một server; server ngoài báo riêng, không cộng vào.

### Dispatch app cùng lúc bị đua — đo 2026-08-25

Bắn 2 job app **cùng lúc** (không nghỉ giữa hai lệnh): cả hai chết ngay ~15s, hai kiểu
khác nhau, và hai job id chia chung tiền tố thời gian `task-mt8to8sy-`:

| job | companion trả về |
| --- | --- |
| 1 | `status --wait` trả job **không có field `status`** (chỉ `phase: "starting"`) → adapter coi là vỡ giao thức |
| 2 | `status --wait` báo **`No job found`** cho job vừa queue thành công |

Bắn lại **lệch 5 giây**: 2/2 `done`, id khác nhau ở phần thời gian, cổng exit 0. Nên
nguyên nhân khu trú được ở **dispatch đồng thời**, không phải ở `status` nói chung.

Hai điều quan trọng hơn con số:

- **Worker vẫn làm xong việc.** Cả hai job "chết" đều đã ghi evidence đầy đủ với
  `Status: DONE`. `crew-reconcile.mjs` sửa cả hai về `done` và ghi lại chỗ bất đồng. Đây là
  bằng chứng sống cho doctrine: evidence trên đĩa thắng phán quyết runtime.
- **Job 1 sau đó companion không còn nhớ id** (`No job found` khi tra `result`). Đó đúng
  lớp `unknown_to_runtime` mà reconcile mới biết phân loại — nhưng vì có evidence nên đường
  evidence xử lý trước, không bị gọi là orphan.

**Đã khoan nhượng ở adapter (25/08).** `codex-run.mjs` chịu đúng hai hình dạng trên trong
`SETTLE_RACE_WINDOW_MS` = 45s kể từ lần hỏi đầu, hỏi lại mỗi 3s, rồi mới bỏ. Trần tính theo
**đồng hồ** chứ không theo số lần — vì `status --wait` chặn tới khi job settle, nên đếm lần
sẽ biến một lần chờ 8 phút thành ba. Một lệnh đã thật sự chờ thì đã quá cửa sổ, không bị hỏi
lại.

Chỉ hai hình dạng đó được khoan nhượng. Mọi lỗi khác vẫn chết ngay lần đầu: retry rộng tay
sẽ biến một job chết thật thành một job chết chậm, mà adapter này tồn tại chính vì một job
chết từng không ai hay trong 20 phút.

Số lần hỏi lại được **ghi vào manifest** (`settleRetries`, `settleRaceWhy`), không nuốt: một
cuộc đua được khoan nhượng mà không ai đo được tần suất là cuộc đua không ai sửa. Gốc vẫn ở
job store của companion, không ở đây.

Vận hành: vẫn nên **giãn các lệnh dispatch app ra** ~5s. Khoan nhượng làm job không chết
oan, nhưng mỗi lần hỏi lại vẫn tốn một vòng gọi process.
