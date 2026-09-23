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
