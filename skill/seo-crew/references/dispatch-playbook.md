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

Ba ví dụ **owner**: Anti chạy `seo-gsc-rank-check` cho một bộ keyword, bảng rank ra là
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

Request: *"Lọc bộ keyword laptop doanh nghiệp, rồi xem tuần rồi category laptop trên
GSC ra sao, và viết cái script gộp 2 file export lại."*

| Seq | Worker | `role` | `transport` | Đầu việc | Acceptance |
| --- | --- | --- | --- | --- | --- |
| 1 | Antigravity | owner | headless | Lọc keyword theo case của `seo-keyword-research` | File keyword đã lọc, có cột lý do loại, số dòng vào/ra khớp |
| 2 | Claude | owner | — | GSC category review 7 ngày | Report có bảng mover + kết luận, số liệu khớp GSC |
| 3 | Codex | owner | headless | Script gộp 2 file export | Script nhận đường dẫn qua CLI, chạy ra file gộp, không hardcode |

Ba job khác loại, chạy song song được, mỗi job có acceptance kiểm được. Đúng.

Cả ba `owner` mà vẫn `headless`: không ca nào trong 3 ca `app` áp vào đây. Job 1 lọc
keyword theo rule đã thành văn nên không có prompt permission bất ngờ; job 3 có acceptance
viết được trước; không job nào cần làm tiếp buổi sau.

Cả ba đều `owner` — không phải nhầm. Áp đúng phép thử thì mỗi đầu việc ở đây có
deliverable riêng được nghiệm thu, nên đó là hình dạng **thường gặp** của một run.
`assist` là ca thiểu số: nó chỉ xuất hiện khi output của job không được nghiệm thu
riêng mà chảy vào một thứ Claude viết.

## Ví dụ phân rã từ job list weekly plan

Đây là đường vào thường dùng nhất: `seo-weekly-action-plan` đã chấm ưu tiên bằng dữ
liệu, crew không cần phân rã lại từ câu nói của user.

Input `data/processed/crew-joblist-2026-08-24.yaml`:

```yaml
run_scope: "Laptop · tuần 2026-08-24 · run 1/2"
rank_source_date: "2026-06-11"
rank_stale: true
measurement_end_date: "2026-08-18"
jobs:
  - seq: 1
    title: "Khai báo Title/Desc 2 URL Laptop rank 2-5 đang giảm theo tháng"
    priority: P1
    worker_hint: antigravity
    action_family: TD
    urls: [/laptop-asus-zenbook, /laptop-dell-gaming-alienware]
    why: "rank Tổng 3.49 và 2.18; L1 +33,0%/+64,8% nhưng L2 −8,6%/−3,4%"
    acceptance: "2 dòng Title_Desc có cột I và J = OK sau kỳ checker daily kế tiếp"
    kpi_link: "đẩy 2 URL lên top 1-2, chặn đà giảm L2"
  - seq: 2
    title: "Đối chiếu GA4 Organic vs GSC clicks cho 2 URL trên"
    priority: P2
    worker_hint: claude
    action_family: AC
    acceptance: "CSV corroboration có cột ratio, data_loss_from_other_row=false, có dòng disclaimer timezone"
    kpi_link: "xác nhận đà giảm L2 là thật, không phải nhiễu GSC"
next_run:
  contains: "P3 · 8 URL rank 5-15 CTR yếu"
  reason: "vượt MAX_JOBS 6"
```

Crew làm gì:

| Bước | Việc |
| --- | --- |
| 1 | Kiểm field từng job. Đủ → nhận. Thiếu `acceptance` hoặc `kpi_link` → từ chối job đó. |
| 2 | `rank_stale: true` → **nêu với user trước khi bắn**. Rank cũ 70 ngày. User đồng ý thì gắn nhãn `RANK STALE` vào brief cả 2 job. |
| 3 | Job 1 rule đã thành văn trong `seo-gsc-rank-check` + `Title_Desc` → giữ `antigravity`. Job 2 phải đọc số và quyết → giữ `claude`. |
| 4 | `next_run` là lô sau. Ghi vào report, **không tự chạy**. |

Cái crew **không** phải làm: nghĩ lại xem URL nào đáng làm. Câu đó plan tuần đã trả
lời bằng dữ liệu — 11/15 keyword volume cao nhất đã bị loại ở đó vì URL đang tự tăng.
Crew nghĩ lại là làm hỏng chính công đoạn vừa lọc.

## Ví dụ KHÔNG nên dispatch

> *"Check rank mấy keyword này giúp anh."*

Một đầu việc. Làm trực tiếp bằng `seo-gsc-rank-check`. Tạo run 1 job chỉ thêm
overhead và thêm file rác trong task folder.

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
| **Mơ hồ** — không rõ cả tình hình lẫn output | *"Lọc keyword cho tốt"* | Worker đi lung tung. Đây mới là chỗ Antigravity yếu |
| **Outcome** — tình hình rõ, file rõ, output rõ, không kê bước | *"3 file này, taxonomy đóng nằm trong file reference; cần CSV 5 cột đúng bộ nhãn của reference, kèm % dòng không phân loại được"* | Đúng. Worker tự nghĩ cách bằng token của nó |
| **Kê bước** — Claude viết sẵn thuật toán | mục *"Cách phân loại"* của `brief-codex-3.md` cũ: build lookup theo path segment, chuẩn hoá URL, ưu tiên pattern nhiều bằng chứng… | Chạy được, nhưng đốt token Claude và cướp việc worker |

Câu cũ ở đây — *"brief càng ràng thì Antigravity càng làm tốt"* — gộp nhầm hai thứ.
Cái Anti cần là **tình hình và output rõ**, không phải **các bước được kê sẵn**. Owner
đã đo trực tiếp: Anti đủ khôn để đi từ cái đang có sang cái output cần, miễn là biết rõ
hai đầu.

Phép thử duy nhất: **brief chỉ chứa thứ worker không thể tự suy ra từ file + `SKILL.md`.**

| Được viết | Không được viết |
| --- | --- |
| *"Dùng `seo-gsc-rank-check`"* | tóm tắt lại quy trình trong `SKILL.md` đó |
| *"`Nhóm NH` là taxonomy đóng — mọi nhãn output phải nằm trong bộ đã có ở file reference"* | *"build lookup theo path segment đầu, bỏ `www`, ưu tiên pattern nhiều bằng chứng"* |
| *"Tab Infobox không có daily trigger, phải chạy `checkInfoboxArticlesAll` tay"* | các bước chạy checker |
| *"Lần trước worker bỏ sót link trong `h2`; `h3-h6` và `table` là vùng cấm"* | vòng lặp chèn link |
| *"Rank trong GSC có thể thuộc URL của DMX, phải loại trước khi tính"* | công thức lọc |

Bốn chỗ vẫn phải viết cụ thể, không được để mở: đường dẫn được đọc, đúng 1 file được
ghi, bảng cost gate, và dòng `Status:` cuối file — đó là thứ bước collect đọc.

## Năm quy tắc khi render brief

1. Một job = một acceptance. Không viết nổi acceptance quan sát được thì chẻ lại.
2. `## Lưu ý` trần 5 gạch — chỗ duy nhất chỉ Claude viết được. Quá 5 là kê bước trở lại.
3. `## Được ghi` là hàng rào duy nhất còn hiệu lực với Antigravity. Viết cụ thể.
4. `evidence_path` là file duy nhất job ghi kết quả; hai job không trùng.
5. Render xong phải **thay hết placeholder**. Brief còn `{...}` là brief chưa viết.
