# Transport `app` và resume

Đọc khi: job `app` (Anti hay Codex), job `--resume`, cần lệnh Monitor cho job dài, hoặc
job app vừa báo fail ngay sau dispatch. Lõi `SKILL.md` Bước 3 và Bước 6 có bản tóm tắt;
file này là luật đầy đủ. Nhật ký đo nằm ở `mwg-agent-crew/docs/transport-measurements.md`.

## Vì sao `app` là ngoại lệ

Lõi `SKILL.md` Bước 3 liệt kê 3 ca được chọn `app`. Ngoài 3 ca đó, `app` là trả giá quan sát mà không lấy lại gì: đo 25/08 trên 6 job app
thật — Anti app không có `usage`/`response`, Codex app không watchdog và `exitCode: null`,
và thread **không hiện live** (phải tắt/mở lại app mới thấy).

## Giãn lệnh dispatch app

**Giãn các lệnh dispatch ra ít nhất 5 giây một cái. Đừng bắn cùng lúc.** Đo 25/08: bắn 2
job `app` không nghỉ giữa hai lệnh thì **cả hai chết** ~15s — hai job id trùng phần thời
gian, một job bị `status --wait` trả về không có field `status`, job kia bị báo
`No job found` cho chính id vừa queue thành công. Bắn lại lệch 5 giây: 2/2 đậu.

`codex-run.mjs` giờ **tự chịu** hai hình dạng đó trong 45s đầu (hỏi lại mỗi 3s) nên job
không chết oan nữa, và số lần hỏi lại ghi vào manifest ở `settleRetries`. Vẫn nên giãn tay:
khoan nhượng không miễn phí, mỗi lần hỏi lại là một vòng gọi process.

Điều đáng nhớ hơn: **worker vẫn làm xong việc** trong cả hai job "chết" đó — evidence đầy
đủ, `Status: DONE`. `crew-reconcile.mjs` sửa cả hai về `done`. Nên job app báo fail ngay
sau khi dispatch thì **đọc đĩa trước, đừng retry ngay**: retry sẽ chạy lại việc đã xong.

## Codex: adapter, không subagent

**Codex** — dùng adapter, **không** spawn subagent `codex:codex-rescue` nữa. Subagent đó
theo định nghĩa là forwarder, không được poll/monitor/lấy kết quả, nên job chết là không
ai ghi sổ (đã xảy ra 2026-08-24: pid chết ở phút 2, phát hiện ở phút 22):
`codex-run.mjs` là đường duy nhất (lệnh ở lõi Bước 6).

## Resume cho Anti app — `--resume <conversationId>` (thêm 2026-09-17)

Trước 17/09, `anti-run.mjs --mode app` chỉ biết `agentapi new-conversation`: mỗi job app
luôn mở một conversation mới, kể cả khi đang tiếp tục đúng việc một conversation trước đó
vừa làm. Ca thật gây ra thay đổi: một job nhiều bước dừng giữa chừng ở `COST_GATE`, user
duyệt qua chat, và bước tiếp theo là **đúng việc của cùng conversation đó** — nó đã đọc
dữ liệu, đã chọn hướng, đã tra tham số. Mở conversation mới bắt nó làm lại toàn bộ từ
đầu, tốn token và có nguy cơ đổi kế hoạch đã được duyệt.

`agentapi` có sẵn lệnh thứ ba ngoài `new-conversation` và `get-conversation-metadata`:
`send-message [--title=<title>] <recipient_id> <content>` — gửi tiếp một prompt vào đúng
conversation đang có. `anti-run.mjs` giờ dùng nó khi được truyền `--resume`:

```bash
MWG_CREW_ROLE=worker node mwg-agent-crew/scripts/anti-run.mjs \
  --mode app --resume <conversationId> --title "Generate ảnh - {bài}" \
  --prompt-file "$RUN_DIR/brief-anti-4.md" \
  --evidence "$RUN_DIR/worker-anti-4.md" \
  --timeout 30m --workspace "$PWD" \
  --manifest "$PWD/$RUN_DIR/manifest.json" --job 4
```

Bốn điều cần biết trước khi dùng:

- **Transport vẫn ghi là `"app"`** trong manifest, không phải một transport thứ ba. `--resume`
  là cờ trực giao, không phải mode riêng — `assertTransport` vẫn so `--mode app` với
  `job.transport`, không biết gì về resume. Lý do giữ vậy: TRANSPORTS chỉ có 2 giá trị
  (`app`/`headless`), thêm giá trị thứ ba kéo theo sửa `resolveRouting`, `addJob`, và mọi chỗ
  đọc lại field này — trong khi bản chất resume vẫn là "mở một hộp cho user xem", chỉ khác ở
  chỗ hộp đã mở sẵn.
- **`conversationId` lấy từ job trước, không tự đoán.** Đọc field `conversationId` của job đã
  xong trong manifest (`m.jobs.find(j => j.seq === N).conversationId`) — đây là id
  `runApp()` trả về sau `new-conversation`, không phải id do dispatcher đặt tên.
- **Không truyền `--model`. Từ 22/09 đây là lỗi cứng, không còn bị bỏ qua.** `send-message`
  không có tham số model — conversation đã có model từ lúc `new-conversation`. Trước đây cặp
  `--model` + `--resume` chạy tiếp và bỏ qua `--model` lặng lẽ; giờ `resolveResume` từ chối cả
  job. Luật này áp cho **cả 4 bề mặt**, kể cả những bề mặt runtime có nhận `--model` — một luật
  dễ nhớ hơn bốn, và đổi bậc model giữa chừng là lý do để mở phiên mới chứ không phải dùng lại
  phiên cũ. Lưu ý rule "`--model` (anti) là bắt buộc": nó **không** áp cho job resume.
- **Evidence path vẫn phải mới**, đúng rule "hai job không bao giờ nhận cùng evidence path" —
  resume là một **job mới** (seq mới, `addJob` mới) tiếp tục một **conversation cũ**, không phải
  sửa lại job cũ. Job cũ giữ nguyên verdict (`blocked` ở ca COST_GATE) làm bằng chứng cho quyết
  định dừng đúng lúc; job resume ghi bằng chứng cho phần làm tiếp.

Cách poll hoàn thành, cổng evidence, và `judgeJob()` giữ nguyên y hệt `new-conversation` —
`runApp()` chỉ khác ở cách lấy `conversationId` (từ tham số thay vì từ output lệnh), phần còn
lại của vòng đời job không đổi.

## Resume cho Anti headless — `agy --conversation <id>` (thêm 2026-09-23)

Resume Anti chạy được ở **cả hai transport**: app dùng `agentapi send-message` (mục trên),
headless dùng `agy --conversation <id>`. Lệnh giống job Anti headless thường, thêm
`--resume <conversationId>` và **bỏ** `--model`; vẫn là job mới với evidence path mới.

Adapter **tự kiểm phiên có được nạp thật không**, vì `agy --conversation <id-sai>` chỉ
warning ở stderr rồi **exit 0 và mở conversation mới** — đo 22/09. Nó so id agy trả về
với id đã xin: lệch, hoặc agy không trả id nào, thì job bị `runtimeVerdict` và cổng
`crew-collect` bắt phải `--ack-runtime`. Manifest ghi `resumedFrom` + `resumeMismatch`.

## Resume cho Codex (headless và app)

**Resume một job Codex headless** cũng là `--resume <id>`, id lấy ở `conversationId`
của job trước — adapter bắt nó từ sự kiện `thread.started` và ghi vào manifest cho
**mọi** job headless, không riêng job resume. Codex `exec resume` báo lỗi thẳng khi id
không tồn tại (`no rollout found`), khác agy. Đo thật 23/09: job 2 bị cấm đọc file vẫn
nhắc đúng chuỗi job 1 vừa ghi.

**Resume một job Codex app** cũng `--resume <id>`, nhưng đọc kỹ hai điều:

- **Chỉ trong cùng phiên Claude** *(bằng app mode)*. Companion giữ job app theo phiên
  và xoá khi phiên đóng. Nhưng thread thì **không** mất: nó nằm chung
  `~/.codex/sessions/` với session headless, nên hôm sau vẫn tiếp được bằng
  `--mode headless --resume <id>` (đo 23/09: tiếp được thread app tạo từ 25/08).
  Đánh đổi: **mất phần nhìn**, job chạy ngầm không hiện trong app.
- **Gặp "còn job Codex app khác đang chạy"** thì đợi job đó xong rồi bắn lại —
  companion không tiếp thread khi còn task app dang dở.
- **CLI không nhận thread id**, nó luôn tiếp "task mới nhất". Adapter hỏi trước và
  **từ chối nếu lệch**, nên gặp lỗi `--resume asked for thread X but the companion
  would continue Y` thì nghĩa là có job app khác mới hơn: bắn job này sau job đó,
  hoặc resume bằng headless.

Cả 4 bề mặt đều ghi `resumedFrom` vào manifest, và đều so lại id sau khi chạy —
lệch thì `resumeMismatch` + cổng `crew-collect` bắt `--ack-runtime`.

## Resume cho Codex app — guard tiền-kiểm (thêm 2026-09-23)

Khác hẳn 3 ô kia: **CLI không nhận thread id.** `--resume` của companion chỉ là
alias boolean của `--resume-last`, và nó tự chọn "task resumable mới nhất của phiên
Claude này". `max_parallel` là 3, nên "mới nhất" là một cuộc đua — mà gửi tiếp vào
thread của job khác thì không rút lại được.

Nên adapter hỏi trước bằng `task-resume-candidate --json` (có trong bảng dispatch
của companion, không có trong `--help`), so `threadId` với id đã xin, **lệch thì từ
chối trước khi gửi**. Từ chối xảy ra trước cả lúc ghi file prompt: một refusal để
lại sidecar sẽ chặn đúng lần thử lại mà chính thông báo lỗi của nó khuyên làm.

Vì sao không import `runAppServerTurn` (hàm nội bộ companion, *có* nhận id): không
phải vì CLI bền hơn hàm nội bộ, mà vì **hướng hỏng**. Mọi cách probe sai đều dẫn tới
*từ chối*; còn một tham số `resumeThreadId` bị đổi tên âm thầm dẫn tới *gửi vào
thread lạ*.

Guard **thu hẹp chứ không đóng** cửa sổ: ứng viên có thể đổi giữa lúc kiểm và lúc
gửi. Nên sau khi chạy còn so lại `job.threadId` với id đã xin — giống hệt Anti và
Codex headless. Không có phép so đó thì đúng lỗi phase này sinh ra để chặn, khi nó
lọt, lại được ghi thành một lần thành công sạch.

**Owner chốt 23/09: không chặn.** Lý do là cửa sổ hẹp hơn tưởng — companion **tự
từ chối** khi còn job app khác đang chạy (`Task <id> is still running`), nên chỉ
còn đúng một ca lọt: một job chuyển từ đang-chạy sang xong *vừa khít* trong 1-2
giây giữa lúc kiểm và lúc gửi. Chặn thêm chỉ bịt được ca đó, đổi lại mất resume
app suốt lúc run bận. Ca companion từ chối giờ được **dịch lại** thành câu đọc
được thay vì trả nguyên văn lỗi của project khác.

## Thread app resume được bằng headless (đo 2026-09-23)

Thread do app tạo nằm **chung `~/.codex/sessions/`** với session `exec`. Đo thật:
`codex exec resume --all <thread-app>` tiếp được một thread app tạo từ 25/08 và nó
nhắc đúng việc hôm đó. Cần `--all` khi resume từ thư mục khác thư mục lúc tạo.

Đây là **đường duy nhất tiếp một thread app qua phiên Claude khác** — companion
xoá job app khi phiên đóng, còn rollout thì không bị xoá. Đổi lại **mất phần
nhìn**: job chạy ngầm, không hiện trong app nữa. Dùng khi cần trí nhớ hơn cần xem.

## Cờ không đọc được thì phải từ chối, không được im (thêm 2026-09-23)

`assertSurfaceFlags` trong `crew-guards.mjs`. Ba cờ từng parse trót lọt rồi bị bỏ
qua lặng lẽ ở bề mặt không đọc chúng:

| Cờ | Chỉ được đọc ở | Gõ ở bề mặt kia thì |
| --- | --- | --- |
| `--title` | anti app | trước: im lặng mất tên · giờ: lỗi |
| `--agy-mode` | anti headless | trước: im lặng mất chế độ · giờ: lỗi |
| `--idle` | codex headless | trước: **hứa watchdog không tồn tại** · giờ: lỗi |

`--idle` là cái nguy: nó đọc như "treo quá X thì giết", nên người giao việc tin là
có người canh. Ở app mode không có ai canh cả. **Cờ im lặng không làm gì tệ hơn cờ
thiếu, vì nó được tin.**

## Lịch sử: vì sao có `role`

Tiêu chí cũ hơn nữa dựa vào việc user có thích theo dõi trong app hay không — đó không
phải rule, vì không có cách nào kiểm. Kết quả: 34 job lịch sử chia 10 app / 24 headless
mà không truy được vì sao job nào đi đường nào. `addJob` giờ đòi `role` và ghi cả `role`
lẫn `transport` vào manifest: `role` là **lý do**, `transport` là **hệ quả**. Chính vì
tách ra mà lần đổi mặc định này không làm run cũ thành vô nghĩa — run cũ vẫn đọc được
quyết định của nó dựa trên gì.

Job `worker: claude` có `role` nhưng `transport: null`: không có process nào được bắn,
ghi transport vào đó là ghi một box chat chưa từng mở.

| Transport | Cơ chế | Có stdout? |
| --- | --- | --- |
| `headless` | Anti: `agy -p --output-format json`. Codex: `codex exec` | **Có** — trả về Claude |
| `app` | Anti: `agentapi new-conversation` (hoặc `send-message` khi có `--resume`, xem mục Resume ở trên) → session **hiện trong Antigravity 2.0**; adapter poll bằng file evidence. Codex: `codex-run.mjs --mode app` → companion `task --background` → thread **hiện trong app Codex**, tên `Codex Companion Task: {dòng đầu brief}`; chờ bằng `status --wait`. Cả hai đã kiểm bằng mắt 25/08 | Anti **không**; Codex **có** (`result <job-id>`) |

Hai runtime lệch nhau chỗ stdout — đừng suy từ Anti sang Codex. Cả hai đều lấy **file
evidence** làm phán quyết, stdout chỉ là tiện.

## Đo được về app mode (2026-08-19)

Worker app mode ghi xong report sau 23 giây, nhưng để step `write_to_file` ở status `7`
suốt 8 phút còn lại. Nếu phát hiện "xong" bằng step status thì job đã hoàn thành vẫn bị
coi là đang chạy rồi bị đánh fail. Vì vậy `anti-run.mjs` lấy **file evidence** làm tín
hiệu hoàn thành, step chỉ là dự phòng. Sau khi sửa, cùng job đó chạy 55 giây.

Hệ quả khi dùng app mode:

- Luôn chạy `crew-reconcile.mjs` sau một run có job app. Job app có thể hoàn thành sau
  khi adapter đã bỏ cuộc; evidence trên đĩa mới là sự thật.
- Job app từng dừng hẳn sau 1 tool call mà không ghi gì (conversation 6 step, không có
  error, không có permission blob). Evidence gate bắt được. Đừng giao việc bắt buộc phải
  ra file cho app mode nếu không ai ngồi xem.

## Codex `app`: thread trong app

`--mode app` mở **thread thật trong app Codex** qua `codex-companion.mjs` của plugin, rồi
chờ bằng `status --wait` (có tín hiệu hoàn thành thật, không phải poll đoán). Thread id
được ghi vào `conversationId` của manifest. Đánh đổi: **không** watchdog, `exitCode: null`,
và thread **không hiện live** — rollout lên đĩa sau ~8s nhưng phải tắt/mở lại app mới thấy.

Thread hiện trong app với tên `Codex Companion Task: {dòng đầu brief}` — companion lấy
dòng đầu làm `summary`. Field `title` trong JSON luôn là `"Codex Task"`, **nhưng đó không
phải cái app hiển thị**. Vẫn nên để **dòng đầu mỗi brief là title của job**, nếu không 3
thread song song trông y như nhau.

Companion nằm ngoài repo. Máy nào không có bản marketplace thì đặt
`MWG_CODEX_COMPANION` trỏ tới đường tuyệt đối. Không tìm thấy thì adapter **báo lỗi**,
không âm thầm rơi về headless.

Hệ quả vận hành, khác nhau rõ giữa hai runtime:

| | Anti app | Codex app |
| --- | --- | --- |
| Xem tiến trình lúc job chạy | **Được** — session hiện live trong Antigravity 2.0 | **Không** |
| Mở lại sau khi xong | được | được, nhưng phải restart app; hoặc `codex resume <id>` |
| Can thiệp giữa chừng | được | không |

Nên với Codex, `transport: app` mua được **biên bản mở lại được + `conversationId` làm
provenance**, không mua được **mặt điều khiển**. Đừng chọn `app` cho Codex vì nghĩ sẽ
ngồi xem được.

## Heartbeat cho job dài

Job dự kiến trên 5 phút: arm thêm một `Monitor` đọc stream của job.

```bash
tail -f tasks/{task}/data/crew-logs/crew-{run_id}/worker-codex-2.codex-stream.jsonl \
  | grep -E --line-buffered '"type":"(turn\.completed|turn\.failed|crew\.note)"'
```

Filter **phải** bọc cả nhánh fail. Monitor chỉ grep tín hiệu tốt thì một job crashloop
im lặng giống hệt job đang chạy — và im lặng không phải là tin tốt.

Ba `type` đó là toàn bộ nhánh kết thúc, đã kiểm trên `codex-cli 0.144.3`: enum thật là
`thread.started | turn.started | turn.completed | turn.failed | item.started |
item.updated | item.completed` — **không có** `type: error`. `crew.note` là dòng
`codex-run.mjs` tự ghi vào stream khi nó giết job, để Monitor thấy được cái chết chứ
không chỉ thấy im lặng.

`codex-run.mjs` còn tự giết job nào không phát ra event nào trong `--idle-timeout`
(mặc định 2m). Đó là ca pid chết mà state vẫn đọc là running.

## Anti app: báo sớm khi conversation im (thêm 2026-10-03)

Trước 03/10, job Anti app treo (kẹt prompt permission, worker dừng giữa chừng) chỉ lộ
ra khi hết `--timeout`, tức tới 30 phút. Adapter giờ đo độ im của conversation trong
vòng poll và báo sớm, nhưng **không** tự giết job.

| Thành phần | Cách làm |
| --- | --- |
| Tín hiệu chính | Vân tay `byStatus` của chính conversation (số bước theo từng trạng thái). Chỉ đổi khi một bước của conversation đó đổi trạng thái |
| Tín hiệu phụ | mtime mới nhất của file mà **riêng job này** khai ở `filesMayModify` (bỏ symlink, bỏ `reports/crew-*`). Chỉ được **hoãn** báo động, không được tính là có tiến triển |
| Ngưỡng | `warn` 5 phút, `alert` 10 phút; đổi bằng `--quiet-warn`/`--quiet-alert` (chỉ `--mode app`; lệnh dài làm conversation im đúng bằng độ dài lệnh). `warn` phải nhỏ hơn `alert`, kể cả khi chỉ truyền một cờ (cờ kia lấy mặc định) |
| Đầu ra | Mỗi lần đổi mức, một dòng JSON `{"type":"anti.watch","level","at","quietSec","conversationId"}` vào sidecar `data/crew-logs/crew-{run}/worker-anti-{seq}.anti-watch.jsonl`. `alert` còn ghi 1 note vào job, đúng một lần |
| Ngủ quên | Conversation `done` mà chưa có evidence ≥ 2 phút → `{"level":"idle","idleSec",...}`, một lần mỗi đợt `done`, kèm 1 note vào job. Không dừng job. Không áp cho phiên chat (`--chat on`): ở đó worker chờ owner với `done` là đúng thiết kế. Đo 07/10: chen vào lúc worker chờ lệnh nền, app không đánh thức worker nữa. Gặp `idle`: mở conversation xem bước cuối. Đang chờ lệnh nền thì **để yên**; không chờ gì thì worker đã thôi lượt, nhắn nó ghi evidence hoặc SIGTERM. |
| Ghi vào manifest | `conversationId` ngay sau khi có id, **trước** vòng poll; `quietMaxSec` (khoảng im dài nhất) lúc job kết thúc, kể cả khi fail, **trừ** khi dừng bằng signal |
| Dừng tay | SIGTERM/SIGINT vào adapter → job `failed` ("dispatcher dừng sau cảnh báo"), kiểm kho credential + vân tay holds, exit 1 |

Vì sao không lấy mtime làm tín hiệu chính: mọi thứ trong hệ crew đều làm mtime nhảy
(manifest đổi mỗi lần có job đổi trạng thái, log dispatch, evidence của job **khác**),
nên đồng hồ im không bao giờ tới ngưỡng.

Vì sao chỉ có ở app mode: headless đợi `agy` trong `spawnSync`, không có vòng poll nào
để đo, và nó chặn event loop nên signal không tới được handler nào. Adapter cố ý **không**
đăng ký handler cho job headless: đăng ký ở đó chỉ làm SIGTERM mất tác dụng cho tới khi
`agy` trả về. Gõ `--quiet-*` ở headless là lỗi.

Số đo nền trên app thật (04/10, `flash`; run đo hạ ngưỡng còn `--quiet-warn 1m --quiet-alert 3m`):

- Worker đọc/đếm/ghi bình thường: `byStatus` đổi mỗi 5-10 giây; job 146 giây có
  `quietMaxSec` 5. Ngưỡng 5 phút cao gấp ~30 lần, không báo nhầm.
- Một lệnh terminal đơn chạy 90 giây: bước đó đứng ở trạng thái đang chạy suốt lệnh,
  `quietMaxSec` 75, `warn` ở giây 60 rồi `recovered`. Khoảng im ≈ lệnh dài nhất.
- Giữa hai bước, `antiStatus().state` có lúc là `done` dù job chưa xong. Đừng dùng
  `state` một mình làm tín hiệu xong; adapter còn đợi file evidence.

Chưa đo: job treo thật (kẹt prompt permission), và model `pro` nghĩ lâu giữa các bước.
