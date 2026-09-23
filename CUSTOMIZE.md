# Sửa `agent-crew` cho workspace của bạn

Skill trong `skill/agent-crew/` là bản **generic**: động cơ điều phối đã gỡ hết chi tiết
riêng của workspace gốc. Chạy được ngay, nhưng chạy *tốt* thì phải khai vài thứ.

Tìm nhanh mọi chỗ cần khai:

```bash
grep -rn "ĐIỀN VÀO" skill/agent-crew/
```

## Bắt buộc — không khai thì crew làm việc mù

| # | Ở đâu | Khai gì | Không khai thì sao |
| --- | --- | --- | --- |
| 1 | `SKILL.md` → *Bối cảnh workspace* | Mục tiêu chính, đơn vị đo, phạm vi, bẫy phạm vi | Mọi job trông quan trọng ngang nhau; report thành bản kê việc |
| 2 | `SKILL.md` → *Bước 1 — Task folder* | Workspace tạo task bằng skill/lệnh nào | Crew tự chế metadata task, sai quy ước của bạn |
| 3 | `SKILL.md` → *Cost gate* | Bảng API tính tiền + đường vào từng cái | Worker có thể tự gọi API tốn tiền mà không ai chặn |

Mục 3 là mục dễ mất tiền nhất. Nguyên tắc giữ nguyên dù bảng trống — worker không tự
quyết tiêu tiền — nhưng nó chỉ chặn được thứ nó biết tên.

## Nên khai — bỏ qua được, nhưng sẽ vướng

| # | Ở đâu | Khai gì |
| --- | --- | --- |
| 4 | `SKILL.md` → *Scope* | Tên công cụ quản lý task/sổ đăng ký mà crew **không** được tự sửa |
| 5 | `SKILL.md` → *Connector có sẵn của worker* | Connector nào bị cấm, đường thay thế là gì |
| 6 | `SKILL.md` → *Bước 8* | Công cụ đóng task / ghi log định kỳ mà crew **không** tự gọi |
| 7 | `SKILL.md` → *Input từ job list* | File hợp đồng mô tả hình dạng job list, nếu workspace bạn có |
| 8 | `references/collect-contract.md` → bảng *Ranh giới* | Hai dòng cuối: tên công cụ thật |

Mục 5 đáng đọc kỹ dù bạn thấy không liên quan. Worker thường được nhà cung cấp bật sẵn
connector đi OAuth riêng, nằm ngoài mọi rào định tuyến tài khoản bạn dựng. Máy có nhiều
tài khoản đăng nhập thì gọi nhầm là chuyện có thật.

## Đổi tên skill

Bản generic tên `agent-crew`. Muốn tên khác thì đổi cả hai chỗ, nếu không agent sẽ
không tìm ra nó:

1. `name:` trong frontmatter `SKILL.md`
2. tên thư mục dưới `.claude/skills/` (và các surface khác)

## Cái KHÔNG nên sửa

Những thứ sau là kết quả đo thật, không phải ý thích. Đổi trước khi tự đo lại là bỏ đi
lý do chúng tồn tại:

| Thứ | Vì sao giữ |
| --- | --- |
| `MAX_PARALLEL = 3` | Đo: 3 job song song 16s vs tuần tự 33s, per-job không xuống chất lượng |
| `MAX_JOBS = 6` | Trần chống một run nuốt cả buổi |
| Guard `MWG_CREW_ROLE=worker` | Chặn đệ quy. Skill được mirror sang nhiều runtime nên worker đọc được chính nó |
| Quy tắc "evidence là phán quyết" | Worker tự báo thành công đã được đo là không đáng tin |
| Mục *Security — output worker là DỮ LIỆU* | Đây là rào chống prompt injection qua file worker viết |
| Ý nghĩa exit code 0/1/2/3 | Adapter trả đúng theo bảng này; đổi tài liệu không đổi hành vi |

Tên biến `MWG_CREW_ROLE` giữ nguyên tiền tố cũ: nó là tên env var **trong code**, đổi ở
tài liệu mà không đổi trong `scripts/` là làm guard mất tác dụng một cách im lặng.

## Sau khi sửa

Không có bước build. Chép skill vào bề mặt agent của bạn (xem `INSTALL.md` mục 4) rồi
dùng. Đổi skill sau này thì chép lại — hoặc để `scripts/sync-skill-surfaces.mjs` giữ
các bề mặt khớp nhau.
