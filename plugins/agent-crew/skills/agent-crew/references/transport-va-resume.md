# Transport `app` và resume

Đọc khi: job Anti `app`, job `--resume`, cần lệnh Monitor cho job dài, hoặc job app vừa
báo fail ngay sau dispatch. Codex chỉ chạy headless từ 2.0.4; luật và số đo cũ của Codex
app gom ở mục cuối *Lịch sử: Codex app*. Lõi `SKILL.md` Bước 3 và Bước 6 có bản tóm tắt;
file này là luật đầy đủ. Nhật ký đo nằm ở `docs/transport-measurements.md` của plugin.

## Vì sao `app` là ngoại lệ

**Codex không có `app` nữa** (từ 2.0.4): `crew add-job --worker codex --transport app` và
`codex-run.mjs --mode app` đều bị từ chối, kèm hướng dẫn headless `--resume <conversationId>`.
Run cũ có job Codex app vẫn collect/reconcile được; job Codex app còn `pending` thì bắn sẽ
fail, làm lại bằng job headless mới.

Lõi `SKILL.md` Bước 3 liệt kê 3 ca được chọn `app` (chỉ Anti). Ngoài 3 ca đó, `app` là trả giá quan sát mà không lấy lại gì: đo 25/08 trên 6 job app
thật — Anti app không có `usage`/`response`, Codex app không watchdog và `exitCode: null`,
và thread **không hiện live** (phải tắt/mở lại app mới thấy).

## Giãn lệnh dispatch app

**Giãn các lệnh dispatch ra ít nhất 5 giây một cái. Đừng bắn cùng lúc.** Đo 25/08: bắn 2
job `app` không nghỉ giữa hai lệnh thì **cả hai chết** ~15s — hai job id trùng phần thời
gian, một job bị `status --wait` trả về không có field `status`, job kia bị báo
`No job found` cho chính id vừa queue thành công. Bắn lại lệch 5 giây: 2/2 đậu.

Số đo đó là trên Codex app (nay đã bỏ, cách adapter từng tự chịu cuộc đua ở mục *Lịch
sử*). Luật giãn 5 giây vẫn giữ cho job Anti app: rẻ, và chưa có số đo nào nói Anti miễn nhiễm.

Điều đáng nhớ hơn: **worker vẫn làm xong việc** trong cả hai job "chết" đó — evidence đầy
đủ, `Status: DONE`. `crew reconcile` sửa cả hai về `done`. Nên job app báo fail ngay
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
crew run anti --manifest "$MP" --job 4 --resume <conversationId> --title "Generate ảnh - {bài}" \
  --prompt-file {brief job 4} --timeout 30m
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
  resume là một **job mới** (seq mới, `crew add-job` mới) tiếp tục một **conversation cũ**, không phải
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
`crew collect` bắt phải `--ack-runtime`. Manifest ghi `resumedFrom` + `resumeMismatch`.

## Resume cho Codex (headless)

**Resume một job Codex headless** cũng là `--resume <id>`, id lấy ở `conversationId`
của job trước — adapter bắt nó từ sự kiện `thread.started` và ghi vào manifest cho
**mọi** job headless, không riêng job resume. Codex `exec resume` báo lỗi thẳng khi id
không tồn tại (`no rollout found`), khác agy. Đo thật 23/09: job 2 bị cấm đọc file vẫn
nhắc đúng chuỗi job 1 vừa ghi.

Thread do Codex app tạo trước 2.0.4 cũng tiếp được bằng đúng lệnh này
(`crew run codex --resume <conversationId>`) — xem mục *Thread app resume được bằng headless*.

Các bề mặt resume đều ghi `resumedFrom` vào manifest, và đều so lại id sau khi chạy —
lệch thì `resumeMismatch` + cổng `crew collect` bắt `--ack-runtime`.

## Chuỗi lát `--chain` (thêm 2.0.7)

`crew run <w> --manifest M --job N --prompt-file P --chain` là resume tự động có rào: lát
`CONTINUE` → lát kế `--resume <conversationId lát trước>`, cùng worker/role/transport/tier
(resume không nhận `--model`, model ăn theo thread). Mỗi lát là một job thật trong sổ
(`chainOf: N`, `slice: k`, evidence riêng `worker-<w>-<seq>.md`, brief `brief-<w>-<seq>.md`
do crew viết theo mẫu cố định — không chép chữ worker). Trạng thái chuỗi ghi trên job gốc:
`chainStartedAt`, `chainSlices`, `chainElapsedMs`, `chainCheckpointAt`/`chainCheckpointSlice`,
`chainStoppedFor`.

- **Kiểm cơ học trước mỗi lát kế** (`scripts/lib/handoff-check.mjs`, không tốn token Claude):
  đủ 4 mục handoff; `### Đang dở` khác lát trước; lát có đổi file ngoài evidence
  (`touchedFiles` của Codex, không có thì mtime trong thư mục run + `filesMayModify`);
  handoff không nhắc `dispatch`, `crew run`, `add-job`, `--sandbox-mode`, `--workspace-cli`,
  `danger-full-access`, `CREW_ROLE`, đường control plane. Trượt → exit 3.
- **Checkpoint mỗi 2 lát** (exit 4). Lát sau resume cùng thread nên vẫn thấy lượt trước —
  handoff bị nhiễm chỉ thị không chặn hẳn được; checkpoint là chỗ Claude đọc.
- **Phạm vi ghi không tự nới.** Lát kế lấy `filesMayModify` mới nhất của job gốc + lát
  trước; muốn nới thì `crew amend <MP> --job N --allow ... --note ...` giữa 2 lát.
- **Thread bị tách** (`resumeMismatch`) → dừng exit 3, không nối tiếp vào thread lạ.
- **Signal.** Lát bắn bằng `spawn` async; SIGTERM vào chuỗi chuyển xuống lát đang chạy,
  ghi `chainStoppedFor: "sigterm"`, exit 1. Lát **Anti headless** cũng dừng sạch từ 11/11:
  adapter giết cả nhóm tiến trình của `agy` rồi ghi `failed`.
- **Monitor.** Sidecar `chain-<N>.jsonl` (đường ở dòng `chain` của `crew paths`) có một
  dòng `{"type":"crew.chain","slice","seq","status","conversationId","elapsedSec","usage"}`
  mỗi lát, thêm `"stop"` khi chuỗi dừng hoặc tới checkpoint. `usage` của Codex là **tổng dồn
  của thread** (đo 06/11): lát sau trừ lát trước ra phần của lát — tăng nhanh dần là thread
  đang phình, cân nhắc dừng chuỗi và mở thread mới bằng brief tóm tắt. Chuỗi bắn nền thì exit code đã
  là ping; Monitor chỉ để thấy tiến độ giữa chừng:

  ```bash
  CHAIN=$(crew paths "$MP" --job N | awk -F'\t' '$1=="chain"{print $2}')
  tail -n0 -F "$CHAIN" | grep --line-buffered '"type":"crew.chain"'
  ```
- Lát `running` khi gọi lại → từ chối (exit 2), không bắn chồng. Lát `pending` (chuỗi chết
  sau khi ghi sổ, trước khi bắn) → gọi lại sẽ bắn đúng lát đó.

## Thread app resume được bằng headless (đo 2026-09-23)

Thread do app tạo nằm **chung `~/.codex/sessions/`** với session `exec`. Đo thật:
`codex exec resume --all <thread-app>` tiếp được một thread app tạo từ 25/08 và nó
nhắc đúng việc hôm đó. Cần `--all` khi resume từ thư mục khác thư mục lúc tạo.

Nên thread Codex app cũ không mất theo transport: companion xoá job app khi phiên
đóng, còn rollout thì không. Job chạy ngầm, không hiện trong app — điều mà Codex app
cũng chưa từng làm tốt (không hiện live).

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
mà không truy được vì sao job nào đi đường nào. `crew add-job` giờ đòi `role` và ghi cả `role`
lẫn `transport` vào manifest: `role` là **lý do**, `transport` là **hệ quả**. Chính vì
tách ra mà lần đổi mặc định này không làm run cũ thành vô nghĩa — run cũ vẫn đọc được
quyết định của nó dựa trên gì.

Job `worker: claude` có `role` nhưng `transport: null`: không có process nào được bắn,
ghi transport vào đó là ghi một box chat chưa từng mở.

| Transport | Cơ chế | Có stdout? |
| --- | --- | --- |
| `headless` | Anti: `agy -p --output-format json`. Codex: `codex exec` | **Có** — trả về Claude |
| `app` (chỉ Anti) | `agentapi new-conversation` (hoặc `send-message` khi có `--resume`, xem mục Resume ở trên) → session **hiện trong Antigravity 2.0**; adapter poll bằng file evidence. Đã kiểm bằng mắt 25/08 | **Không** |

Mọi transport đều lấy **file evidence** làm phán quyết, stdout chỉ là tiện.

## Đo được về app mode (2026-08-19)

Worker app mode ghi xong report sau 23 giây, nhưng để step `write_to_file` ở status `7`
suốt 8 phút còn lại. Nếu phát hiện "xong" bằng step status thì job đã hoàn thành vẫn bị
coi là đang chạy rồi bị đánh fail. Vì vậy `anti-run.mjs` lấy **file evidence** làm tín
hiệu hoàn thành, step chỉ là dự phòng. Sau khi sửa, cùng job đó chạy 55 giây.

Hệ quả khi dùng app mode:

- Luôn chạy `crew reconcile` sau một run có job app. Job app có thể hoàn thành sau
  khi adapter đã bỏ cuộc; evidence trên đĩa mới là sự thật.
- Job app từng dừng hẳn sau 1 tool call mà không ghi gì (conversation 6 step, không có
  error, không có permission blob). Evidence gate bắt được. Đừng giao việc bắt buộc phải
  ra file cho app mode nếu không ai ngồi xem.

## Heartbeat cho job dài

Job dự kiến trên 5 phút: arm thêm một `Monitor` đọc stream của job.

```bash
tail -f "$(crew paths "$MP" --job 2 | awk -F'\t' '$1=="logs"{print $2}')/worker-codex-2.codex-stream.jsonl" \
  | grep -E --line-buffered '"type":"(turn\.completed|turn\.failed|crew\.note)"'
```

Filter **phải** bọc cả nhánh fail. Monitor chỉ grep tín hiệu tốt thì một job crashloop
im lặng giống hệt job đang chạy — và im lặng không phải là tin tốt.

Ba `type` đó là toàn bộ nhánh kết thúc, đã kiểm trên `codex-cli 0.144.3`: enum thật là
`thread.started | turn.started | turn.completed | turn.failed | item.started |
item.updated | item.completed` — **không có** `type: error`. `crew.note` là dòng
`codex-run.mjs` tự ghi vào stream khi nó giết job, để Monitor thấy được cái chết chứ
không chỉ thấy im lặng.

`codex-run.mjs` còn canh job im: không phát event nào trong `--idle-timeout` (mặc định
2m) thì nó **hỏi xem Codex còn sống không** trước khi giết (thêm 08/11,
`scripts/lib/codex-liveness.mjs`). Codex không in gì lúc chờ model, nên im chưa chắc là
chết — mạng chậm từng làm job đang chờ model bị giết oan. Job còn sống khi một trong:

| Tín hiệu | Nghĩa | Trần |
| --- | --- | --- |
| CPU cây tiến trình Codex tăng ≥ 0.2s trong cửa sổ đo | đang chạy lệnh / đang xử lý | `--timeout` |
| Byte mạng nhận về tăng giữa hai lần `nettop` | model đang trả lời, dù chậm | `--timeout` |
| Chỉ còn kết nối mạng mở | đang chờ model nghĩ | im tối đa 10 phút |

Còn sống thì sidecar có dòng `crew.note` "im …s nhưng còn sống: <lý do>" và hỏi lại sau
30s. Chết thì lý do bị giết nêu đủ: `no stdout event for 125s — không dùng CPU, không có
kết nối mạng`. Đó là ca pid chết mà state vẫn đọc là running. Giới hạn: Codex treo mà vẫn
nhận byte keepalive trông như còn sống; `--timeout` là chốt cuối. Không cần nâng
`--idle-timeout` khi mạng chậm nữa.

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

Vì sao báo im chỉ có ở app mode: headless không có vòng poll nào để đo. Gõ `--quiet-*` ở
headless là lỗi. Dừng tay thì headless có từ 11/11: `agy` chạy bất đồng bộ trong nhóm tiến
trình riêng, SIGTERM/SIGINT vào adapter giết cả nhóm (agy và mọi lệnh nó sinh ra) rồi ghi
`failed` ("dispatcher dừng job, đã giết agy"). Trước đó adapter đợi trong `spawnSync`, signal
chỉ giết adapter, và một `agy` mồ côi đã ghi đè file của run giao lại 20 phút sau.

Số đo nền trên app thật (04/10, `flash`; run đo hạ ngưỡng còn `--quiet-warn 1m --quiet-alert 3m`):

- Worker đọc/đếm/ghi bình thường: `byStatus` đổi mỗi 5-10 giây; job 146 giây có
  `quietMaxSec` 5. Ngưỡng 5 phút cao gấp ~30 lần, không báo nhầm.
- Một lệnh terminal đơn chạy 90 giây: bước đó đứng ở trạng thái đang chạy suốt lệnh,
  `quietMaxSec` 75, `warn` ở giây 60 rồi `recovered`. Khoảng im ≈ lệnh dài nhất.
- Giữa hai bước, `antiStatus().state` có lúc là `done` dù job chưa xong. Đừng dùng
  `state` một mình làm tín hiệu xong; adapter còn đợi file evidence.

Chưa đo: job treo thật (kẹt prompt permission), và model `pro` nghĩ lâu giữa các bước.

## Lịch sử: Codex app (bỏ từ 2.0.4)

Owner chốt 06/11: Codex app không chat tiếp được, không xem live, không watchdog,
`exitCode: null` — không đáng giữ. Ca duy nhất nó từng che ("làm tiếp buổi sau")
headless `--resume <conversationId>` làm tốt hơn. Code transport app (`codexRunApp`,
companion, settle-race) đã xoá ở 2.1.3. Phần dưới giữ lại số đo và luật cũ để đọc run cũ.

**Cuộc đua lúc dispatch.** `codex-run.mjs --mode app` từng tự chịu hai hình dạng chết
oan (`status --wait` không có `status`, `No job found` cho id vừa queue) trong 45s đầu,
hỏi lại mỗi 3s, ghi số lần ở `settleRetries`.

**Transport.** `codex-run.mjs --mode app` → companion `task --background` → thread
**hiện trong app Codex**, tên `Codex Companion Task: {dòng đầu brief}`; chờ bằng
`status --wait`. Có stdout (`result <job-id>`). Kiểm bằng mắt 25/08.

### Resume một job Codex app

Cũng `--resume <id>`, với các điều kiện:

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

### Guard tiền-kiểm (thêm 2026-09-23)

Khác hẳn các bề mặt khác: **CLI không nhận thread id.** `--resume` của companion chỉ là
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

### Thread trong app

`--mode app` mở **thread thật trong app Codex** qua `codex-companion.mjs` của plugin, rồi
chờ bằng `status --wait` (có tín hiệu hoàn thành thật, không phải poll đoán). Thread id
được ghi vào `conversationId` của manifest. Đánh đổi: **không** watchdog, `exitCode: null`,
và thread **không hiện live** — rollout lên đĩa sau ~8s nhưng phải tắt/mở lại app mới thấy.

Thread hiện trong app với tên `Codex Companion Task: {dòng đầu brief}` — companion lấy
dòng đầu làm `summary`. Field `title` trong JSON luôn là `"Codex Task"`, **nhưng đó không
phải cái app hiển thị**. Vẫn nên để **dòng đầu mỗi brief là title của job**, nếu không 3
thread song song trông y như nhau.

Companion nằm ngoài repo. Máy nào không có bản marketplace thì đặt
`CREW_CODEX_COMPANION` (tên cũ `MWG_CODEX_COMPANION` vẫn nhận) trỏ tới đường tuyệt đối. Không tìm thấy thì adapter **báo lỗi**,
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
