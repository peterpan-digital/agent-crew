# Dispatch Playbook

## Phân rã request thành job

Một job = **một đầu việc có acceptance riêng**. Test để biết chia đúng chưa:

> Viết được acceptance criteria kiểm được cho job đó không?
> Không viết nổi → đó không phải job, đó là một mảnh của job khác.

Hai lỗi hay gặp:

| Lỗi | Dấu hiệu | Sửa |
| --- | --- | --- |
| Chia quá vụn | Job xử lý dưới ~30s, hoặc job B chỉ dùng output job A | Gom lại. Overhead `agy` 5.5s/lần |
| Gộp việc khác loại | Một job vừa lọc keyword vừa viết report đánh giá | Tách theo worker: lọc → Anti, đánh giá → Claude |

## Chọn worker

Đọc `mwg-agent-crew/routing-table.md`. Tiêu chí là **rule đã thành văn hay chưa**,
không phải dễ/khó:

- Có `SKILL.md` ràng đủ case, chỉ cần thi hành → **Antigravity**. Nó nhanh và rất gọn
  khi có mẫu; điểm yếu là suy luận mở, không phải tốc độ hay độ chính xác.
- Phải đọc số rồi quyết hướng, hoặc viết report chính thức → **Claude**.
- Code, pipeline, transform nhiều bước, refactor tool → **Codex**.

## Chọn `role`

Không chọn theo cảm giác. Một câu hỏi:

> **Ai chịu trách nhiệm về acceptance của đầu ra job này?**

| Trả lời | `role` |
| --- | --- |
| Chính worker — evidence của nó **là** deliverable | `owner` |
| Claude — job chỉ là nguyên liệu cho thứ Claude viết | `assist` |

`role` quyết cách **chấm** output. Nó **không** quyết transport — hai trục khác nhau.

Ba ví dụ **owner**: Anti chạy một skill đo sẵn có cho một bộ dữ liệu, bảng kết quả là
thứ được nghiệm thu. Codex refactor một tool, script chạy được là deliverable. Anti điền
metadata theo mẫu cho 30 ảnh, file metadata là kết quả cuối.

Ba ví dụ **assist**: Anti mở browser lấy 20 trang cho Claude đọc. Codex research song
song 4 nhánh để Claude tổng hợp thành một report. Codex đếm số dòng khớp điều kiện trong
5 file export để Claude quyết hướng. Cả ba: deliverable là thứ **Claude** viết.

Ca không phân loại được vào đâu là dấu hiệu **job chia sai**, không phải luật sai — quay
lại mục phân rã ở đầu file.

## Chọn transport

**Mặc định `headless`, cho cả `owner` và `assist`.** Không phải vì headless tiện, mà vì
nó là transport harness **quan sát được**: có `exitCode`, có `usage`, có text reply, có
watchdog. Đo 25/08 trên 6 job app thật thì `app` không có một cái nào trong số đó ở Anti,
và thiếu watchdog + `exitCode` ở Codex.

Chọn `app` chỉ trong 3 ca, và `addJob` đòi `note` nói ca nào:

| Ca | Vì sao app thắng |
| --- | --- |
| Job Anti sẽ gặp **prompt permission cần người trả** | Headless gặp prompt là silent-fail: `SUCCESS` với `response` rỗng |
| **Việc mở/khám phá**, chưa viết nổi acceptance trước | Không có tiêu chí chấm thì mất evidence-first cũng không mất gì |
| Cần **thread resume** làm tiếp buổi sau | `codex resume <id>` (Codex) hoặc `anti-run.mjs --resume <conversationId>` (Anti, thêm 2026-09-17) — chỉ thread app có |

Ghi đè không `note` bị từ chối, và lời từ chối liệt kê luôn 3 ca này.

Một thứ `app` **không** mua được, dù trực giác nói ngược: **theo dõi realtime.** Thread
Codex app lên đĩa sau ~8s nhưng app chỉ hiện nó sau khi tắt và mở lại — đo 25/08 bằng một
job 224 giây. Đừng chọn `app` vì nghĩ sẽ ngồi xem được.

**Stdout lệch nhau giữa hai runtime, đừng suy từ cái này sang cái kia:** job Anti `app`
không trả output về stdout, nên chọn `app` cho việc mà bước sau cần kết quả là bước sau
không có gì để xử lý. Codex `app` thì **có** `result <job-id>`. Dù vậy cả hai đều lấy
file evidence làm phán quyết — stdout chỉ là tiện.

## Ví dụ phân rã đúng

Request: *"Lọc bộ dữ liệu thô theo bộ tiêu chí đã có, rồi xem tuần rồi chỉ số chính
biến động ra sao, và viết cái script gộp 2 file export lại."*

| Seq | Worker | `role` | `transport` | Đầu việc | Acceptance |
| --- | --- | --- | --- | --- | --- |
| 1 | Antigravity | owner | headless | Lọc dữ liệu theo rule đã thành văn trong một skill sẵn có | File đã lọc, có cột lý do loại, số dòng vào/ra khớp |
| 2 | Claude | owner | — | Phân tích biến động 7 ngày | Report có bảng biến động + kết luận, số liệu khớp nguồn |
| 3 | Codex | owner | headless | Script gộp 2 file export | Script nhận đường dẫn qua CLI, chạy ra file gộp, không hardcode |

Ba job khác loại, chạy song song được, mỗi job có acceptance kiểm được. Đúng.

Cả ba `owner` mà vẫn `headless`: không ca nào trong 3 ca `app` áp vào đây. Job 1 chạy
theo rule đã thành văn nên không có prompt permission bất ngờ; job 3 có acceptance viết
được trước; không job nào cần làm tiếp buổi sau.

Cả ba đều `owner` — không phải nhầm. Áp đúng phép thử thì mỗi đầu việc ở đây có
deliverable riêng được nghiệm thu, nên đó là hình dạng **thường gặp** của một run.
`assist` là ca thiểu số: nó chỉ xuất hiện khi output của job không được nghiệm thu
riêng mà chảy vào một thứ Claude viết.

## Ví dụ phân rã từ một job list có sẵn

Khi workspace đã có công cụ chấm ưu tiên bằng dữ liệu, crew không phân rã lại từ câu
nói của user — nó route thẳng.

Hình dạng job list (tên field là quy ước của skill này; nguồn nào ánh xạ đủ cũng được):

```yaml
run_scope: "mô tả phạm vi và lô chạy, ví dụ: run 1/2"
source_date: "2026-06-11"     # dữ liệu lập plan lấy ngày nào
source_stale: true            # đã cũ so với ngưỡng workspace bạn đặt
jobs:
  - seq: 1
    title: "Sửa metadata cho 2 trang đang tụt hạng"
    priority: P1
    worker_hint: antigravity
    why: "chỉ số tháng giảm ở cả 2 trang, rule xử lý đã thành văn"
    acceptance: "2 dòng tương ứng có cột trạng thái = OK sau kỳ kiểm kế tiếp"
    goal_link: "chặn đà giảm, đẩy 2 trang lên nhóm đầu"
  - seq: 2
    title: "Đối chiếu số liệu 2 nguồn cho 2 trang trên"
    priority: P2
    worker_hint: claude
    acceptance: "CSV đối chiếu có cột tỉ lệ, cờ mất dữ liệu = false, có dòng ghi chú timezone"
    goal_link: "xác nhận đà giảm là thật, không phải nhiễu đo"
next_run:
  contains: "P3 · 8 mục còn lại"
  reason: "vượt MAX_JOBS 6"
```

Crew làm gì:

| Bước | Việc |
| --- | --- |
| 1 | Kiểm field từng job. Đủ → nhận. Thiếu `acceptance` hoặc `goal_link` → từ chối job đó. |
| 2 | `source_stale: true` → **nêu với user trước khi bắn**, nói rõ cũ bao nhiêu ngày. User đồng ý thì gắn nhãn cảnh báo vào brief cả 2 job, để worker không báo số cũ như số mới. |
| 3 | Job 1 chạy theo rule đã thành văn → giữ `antigravity`. Job 2 phải đọc số rồi quyết → giữ `claude`. |
| 4 | `next_run` là lô sau. Ghi vào report, **không tự chạy**. |

## Ví dụ KHÔNG nên dispatch

> *"Đo giúp anh mấy chỉ số này."*

Một đầu việc. Làm trực tiếp bằng skill đo sẵn có. Tạo run 1 job chỉ thêm overhead và
thêm file rác trong task folder.

> *"Đọc file này rồi tóm tắt cho anh."*

Một đầu việc, cần phán đoán. Claude tự làm.

## Thứ tự khi job có phụ thuộc

Job phụ thuộc nhau thì **không** bắn song song. Chạy job trước, nghiệm thu, rồi mới
bắn job sau với output của nó ghi trong brief. Đừng để job sau tự đi tìm output của
job trước — brief phải nói rõ đường dẫn.

Nếu chuỗi phụ thuộc dài hơn 2 tầng: đó là dấu hiệu nên để một worker làm cả chuỗi,
không phải chia ra.

## Brief: ba loại, chỉ một loại đúng

| Loại | Ví dụ | Kết quả |
| --- | --- | --- |
| **Mơ hồ** — không rõ cả tình hình lẫn output | *"Lọc dữ liệu cho tốt"* | Worker đi lung tung. Đây mới là chỗ Antigravity yếu |
| **Outcome** — tình hình rõ, file rõ, output rõ, không kê bước | *"3 file này, bộ nhãn đóng nằm trong file reference; cần CSV 5 cột đúng bộ nhãn đó, kèm % dòng không phân loại được"* | Đúng. Worker tự nghĩ cách bằng token của nó |
| **Kê bước** — Claude viết sẵn thuật toán | *"build lookup theo path segment, chuẩn hoá URL, ưu tiên pattern nhiều bằng chứng…"* | Chạy được, nhưng đốt token Claude và cướp việc worker |

Câu cũ ở đây — *"brief càng ràng thì Antigravity càng làm tốt"* — gộp nhầm hai thứ.
Cái Anti cần là **tình hình và output rõ**, không phải **các bước được kê sẵn**. Owner
đã đo trực tiếp: Anti đủ khôn để đi từ cái đang có sang cái output cần, miễn là biết rõ
hai đầu.

Phép thử duy nhất: **brief chỉ chứa thứ worker không thể tự suy ra từ file + `SKILL.md`.**

| Được viết | Không được viết |
| --- | --- |
| *"Dùng skill X"* | tóm tắt lại quy trình đã nằm trong `SKILL.md` của X |
| *"Trường phân loại này là bộ nhãn đóng — mọi nhãn output phải nằm trong bộ có sẵn ở file reference"* | *"build lookup theo path segment đầu, bỏ `www`, ưu tiên pattern nhiều bằng chứng"* |
| *"Bảng này không có trigger tự động, phải chạy hàm kiểm bằng tay"* | các bước chạy hàm đó |
| *"Lần trước worker bỏ sót vùng A; vùng B và C là vùng cấm"* | vòng lặp xử lý |
| *"Số liệu nguồn có thể lẫn bản ghi của hệ khác, phải loại trước khi tính"* | công thức lọc |

Bốn chỗ vẫn phải viết cụ thể, không được để mở: đường dẫn được đọc, đúng 1 file được
ghi, bảng cost gate, và dòng `Status:` cuối file — đó là thứ bước collect đọc.

## Năm quy tắc khi render brief

1. Một job = một acceptance. Không viết nổi acceptance quan sát được thì chẻ lại.
2. `## Lưu ý` trần 5 gạch — chỗ duy nhất chỉ Claude viết được. Quá 5 là kê bước trở lại.
3. `## Được ghi` là hàng rào duy nhất còn hiệu lực với Antigravity. Viết cụ thể.
4. `evidence_path` là file duy nhất job ghi kết quả; hai job không trùng.
5. Render xong phải **thay hết placeholder**. Brief còn `{...}` là brief chưa viết.

## Input từ một job list có sẵn

Nếu workspace của bạn có công cụ tự sinh danh sách việc (plan tuần, hàng đợi ticket,
backlog đã chấm ưu tiên), dùng **thẳng** file đó. **Không bắt user list lại việc** —
cái đã chấm ưu tiên bằng dữ liệu thì crew chỉ việc route.

Crew cần mỗi job mang đủ các field sau. Tên field là quy ước của skill này; nguồn nào
xuất ra cũng được, miễn ánh xạ đủ:

| Field | Việc |
| --- | --- |
| `title` | Một dòng, dùng luôn làm dòng đầu brief |
| `priority` | Thứ tự chạy khi vượt `MAX_JOBS` |
| `worker_hint` | Gợi ý worker. **Chỉ là gợi ý** — Bước 3 mới quyết |
| `why` | Vì sao làm việc này. Thiếu thì worker không tự cân nhắc được |
| `evidence` | Đường dẫn file bằng chứng job phải ghi |
| `acceptance` | Điều kiện nghiệm thu, đo được |
| `goal_link` | Việc này nối về mục tiêu workspace ra sao |
| `cost_gate` | Có mặt = job chạm API tốn tiền |

`ĐIỀN VÀO`: nếu workspace bạn có file hợp đồng mô tả hình dạng job list, trỏ nó ở đây.

Ba việc phải làm khi nhận job list, không được bỏ:

1. **Kiểm field.** Job thiếu bất kỳ field bắt buộc nào → **từ chối job đó**, không
   đoán bù. Đặc biệt `acceptance` và `goal_link`: thiếu là dấu hiệu job chưa chín.
2. **Kiểm dữ liệu nguồn có cũ không.** Job list nào mang cờ báo "số liệu lập plan đã
   cũ" thì nêu với user trước khi dispatch; user vẫn muốn chạy thì ghi nhãn cảnh báo
   vào brief từng job, để worker không báo cáo số cũ như số mới.
3. **Kiểm `cost_gate`.** Job có field này → `BLOCKED / COST_GATE`, xin xác nhận user
   trước, không tự gọi.

`worker_hint` là **gợi ý**. Bước 3 vẫn là nơi quyết cuối theo `routing-table.md`.

Ngưỡng không đổi: `MAX_JOBS` 6, `MAX_PARALLEL` 3. Job list có `next_run` thì đó là lô
sau — **không tự chạy nó**.

## Ngưỡng job: code ép từ 26/08

Quá `MAX_JOBS` job thì dừng, báo user, không tự chạy tiếp. Từ 26/08 `addJob` tự từ chối
job thứ 7, `claimRunSlot` tự từ chối adapter thứ 4, và `readPrompt` tự từ chối brief quá
2048 B — nên ba ngưỡng này không còn phụ thuộc vào việc người điều phối có nhớ hay không.

## Ba dòng bắt buộc: adapter tự ghép

**Hai adapter tự ghép 3 dòng này vào prompt** (`appendWorkerContract`), nên quên chép tay
không còn giết job nữa. Vẫn nên viết vào brief để bản lưu đọc lại được đủ nghĩa — adapter
bỏ qua dòng đã có, không nhân đôi. Ba dòng ghép thêm **không tính** vào trần 2 KB: trần
đo phần dispatcher tự viết.

Vì sao phải ép bằng code: run `crew-260909-1450` mất **cả 3 job**, kể cả job không dính
sandbox — `brief-codex-1.md` thiếu đúng dòng "Chỉ được ghi đúng file", worker soạn xong
báo cáo rồi trả lời trong chat thay vì ghi ra file. `readPrompt` khi đó chỉ đo **kích
thước** brief.

## Lệnh chạm guard: cấp sẵn nguyên văn

`MWG_CREW_ROLE=worker` chặn `createRun`, nên worker **không chạy được test của
`mwg-agent-crew/`**. Job nào cần chạy test thì brief thêm mục `## Lệnh được cấp sẵn`
với lệnh nguyên văn:

```text
## Lệnh được cấp sẵn
- env -u MWG_CREW_ROLE node mwg-agent-crew/tests/collect-gate.test.mjs
```

Vì sao cấp sẵn thay vì để worker tự xử: đo 25/08, cả hai worker Codex đều vướng guard;
một con tự lách bằng `env -u` rồi khai ra. Để worker tự suy ra rằng nó được phép gỡ guard
là dạy nó sai thứ — lần sau nó gỡ guard khác mà không hỏi. Cấp sẵn giữ được cả hai: test
chạy được, và việc gỡ vẫn là quyết định của dispatcher, nằm trong brief để audit.

Chỉ cấp cho **đúng lệnh test**, không cấp chung cho cả job. Chốt chặn đệ quy thật là
`depth` trong manifest; cấp `env -u` cho một lệnh test không nới `depth`.

## Guard: vì sao nằm đầu file

Guard `MWG_CREW_ROLE` là mục đầu tiên của `SKILL.md`. Lý do guard nằm ở đây thay vì cuối file: skill này được mirror sang cả 4 runtime
(`.claude`, `.codex`, `.agents`, `.gemini`), nên một worker đọc được chính nó và
có thể dispatch tiếp thành đệ quy. Manifest cũng chặn tầng hai bằng `depth`:
`depth > 1` là từ chối.

## `model`/`effort`: vì sao bắt buộc

**`model`/`effort` là bắt buộc.** Trước đây mọi job trong mọi manifest đều `null`, nên
không có cách nào biết model nào hay fail ngoài đoán. Bảng bậc ở
`mwg-agent-crew/routing-table.md` mục *Model* — chọn theo lượng phán đoán cần, không
theo cảm giác nặng nhẹ.

## Trần 2 KB của brief

Trần **2 KB**. Dài hơn gần như luôn có nghĩa là đang kê thuật toán hộ worker — đúng cái
làm brief phình lên 7.2 KB hôm 24/08. Ba loại brief và ví dụ đối chiếu: mục "Brief: ba loại" ở trên.

## Bước 4: ghi `role` và `transport`

**`role` là bắt buộc** (`owner` | `assist`). Thiếu là `addJob` từ chối. `transport`
mặc định `headless` cho cả hai role, và được ghi tường minh vào manifest để lần sau đọc
không phải suy lại.

Muốn `app` thì truyền `transport: "app"` **kèm `note`** nói ca nào trong 3 ca ở Bước 3.
Ghi đè không `note` bị từ chối, và lời từ chối liệt kê luôn 3 ca — đó đúng là đường quay
lại chọn theo cảm tính.

## `--mode` khớp `transport`

**`--mode` phải khớp `transport` đã ghi ở Bước 4.** Ghi một transport rồi bắn đường
khác là để lại một dòng sai trong sổ — và sổ đó là thứ duy nhất sau này đo được.

## Ca `app` thứ ba: resume làm tiếp buổi sau

3. **Cần thread resume làm tiếp buổi sau** — `codex resume <id>` cho Codex,
   `--resume <id>` (xem Bước 6). Từ 23/09 chạy được ở **cả 4 bề mặt** — cùng một cờ.
   Nhưng Codex app chỉ resume được **trong cùng phiên Claude**, nên "làm tiếp buổi
   sau" vẫn phải chọn Anti app.
