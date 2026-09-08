# Dispatch Playbook

Cách biến một request thành job list, và cách chọn worker cho từng job.

## Phân rã request thành job

Một job = **một đầu việc có acceptance riêng**. Test để biết chia đúng chưa:

> Viết được acceptance criteria kiểm được cho job đó không?
> Không viết nổi → đó không phải job, đó là một mảnh của job khác.

Hai lỗi hay gặp:

| Lỗi | Dấu hiệu | Sửa |
| --- | --- | --- |
| Chia quá vụn | Job xử lý dưới ~30s, hoặc job B chỉ dùng output job A | Gom lại. Mỗi lần khởi động worker tốn vài giây, và mỗi job tốn một brief |
| Gộp việc khác loại | Một job vừa sửa code vừa viết đánh giá kiến trúc | Tách theo worker: sửa code → Codex, đánh giá → Claude |

Job B chỉ chạy được sau khi job A xong thì **không phải hai job của cùng một run**. Run
này chạy A, đọc kết quả, rồi mở run sau cho B. Trần 3 job song song tồn tại vì run được
thiết kế cho việc **độc lập**; xếp hàng trong một run là bắt cổng nghiệm thu chấm một
thứ chưa xong.

## Chọn worker

Tiêu chí là **rule đã thành văn hay chưa**, không phải dễ/khó:

- Có tài liệu/mẫu ràng đủ case, chỉ cần thi hành đúng và nhanh → **Antigravity**. Nó gọn
  khi có mẫu; điểm yếu là suy luận mở, không phải tốc độ.
- Phải đọc số rồi quyết hướng, hoặc viết một tài liệu chính thức → **Claude** (chính bạn).
- Code, pipeline, transform nhiều bước, refactor, chạy test → **Codex**.

Một cách kiểm nhanh: nếu bạn phải viết vào brief *cách* làm thì bạn đang chọn sai worker
hoặc chia sai job. Brief đúng nói cần gì, không nói làm thế nào.

## Chọn `role`

Không chọn theo cảm giác. Một câu hỏi:

> **Ai chịu trách nhiệm về acceptance của đầu ra job này?**

| Trả lời | `role` |
| --- | --- |
| Chính worker — evidence của nó **là** deliverable | `owner` |
| Bạn — job chỉ là nguyên liệu cho thứ bạn viết | `assist` |

Ba ví dụ **owner**: Codex sửa một suite test flaky, suite xanh là thứ được nghiệm thu.
Antigravity đổi tên một API theo checklist đã có, diff là kết quả cuối. Codex viết một
script migration, script chạy được là deliverable.

Ba ví dụ **assist**: Codex đọc 4 module rồi liệt kê chỗ gọi một hàm, để bạn quyết đổi
chữ ký thế nào. Antigravity thu thập 20 trang docs cho bạn đọc. Codex đếm số call site
khớp một pattern trong 5 package để bạn chọn hướng. Cả ba: deliverable là thứ **bạn** viết.

Ca không phân loại được vào đâu là dấu hiệu **job chia sai**, không phải luật sai — quay
lại mục phân rã ở đầu file.

`owner` là hình dạng thường gặp. `assist` là thiểu số: nó chỉ xuất hiện khi output của
job không được nghiệm thu riêng mà chảy vào một thứ bạn viết.

## Ví dụ phân rã đúng

Request: *"Test auth đang flaky, tao muốn biết vì sao. Với lại viết cái script gộp 2 file
export lại, rồi xem cái module payment có chỗ nào còn gọi API cũ không."*

| Seq | Worker | `role` | Đầu việc | Acceptance |
| --- | --- | --- | --- | --- |
| 1 | codex | owner | Tìm nguyên nhân flaky ở `tests/auth/`, sửa | `npm test tests/auth` xanh 5 lần liên tiếp; evidence nêu nguyên nhân, không chỉ nêu bản sửa |
| 2 | codex | owner | Script gộp 2 file export | Script nhận đường dẫn qua CLI, chạy ra file gộp, không hardcode đường dẫn |
| 3 | antigravity | assist | Liệt kê call site còn gọi API cũ trong `src/payment/` | Bảng `file:line` + tên hàm; không sửa gì |

Ba job khác loại, độc lập, mỗi job có acceptance kiểm được. Job 3 là `assist` vì bảng
call site không được nghiệm thu riêng — nó là nguyên liệu để **bạn** quyết có migrate hay
không.

`--allow` của từng job: job 1 `tests/auth/` và `src/auth/`; job 2 `scripts/`; job 3
không có gì (nó chỉ đọc). Job 3 mà xin quyền ghi là dấu hiệu brief sai.

## Ví dụ phân rã sai, và sai ở đâu

Request: *"Refactor cái module payment cho gọn."*

Chia thành 3 job "refactor file A / refactor file B / refactor file C" là **sai**, vì:

- Ba job cùng loại, cùng worker, cùng vùng code → chúng sẽ đụng nhau. Cổng phạm vi ghi
  sẽ báo chồng chéo, và không ai phân được job nào ghi gì (cửa sổ thời gian của ba job
  song song luôn giao nhau).
- Không job nào có acceptance riêng. "Gọn hơn" không kiểm được.

Đúng là: **một job** Codex `owner` với acceptance viết được ("test cũ vẫn xanh, không
đổi public API, giảm số nhánh trong `handlePayment` xuống dưới 5"), hoặc — nếu chưa biết
refactor thế nào — **không dispatch**: đó là việc phán đoán, bạn tự đọc code trước.

## Khi KHÔNG dùng crew

- Một đầu việc → làm trực tiếp.
- Việc cần user quyết giữa chừng → làm trực tiếp, hỏi user.
- Việc dưới 30 giây → làm trực tiếp.
- Việc phụ thuộc tuần tự → chạy từng run, đọc kết quả, rồi mở run sau.
- Chưa viết nổi acceptance cho bất kỳ job nào → chưa đủ hiểu vấn đề để giao. Đọc thêm trước.
