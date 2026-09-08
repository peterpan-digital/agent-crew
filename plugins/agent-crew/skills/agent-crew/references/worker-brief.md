# Worker Brief Contract

Một profile cho cả 3 worker. Brief nói **WHAT + NEED**, không nói HOW.

Phép thử: chỉ viết thứ worker **không tự suy ra được** từ file trong repo. Trần 2 KB
(đổi bằng `briefMaxBytes` trong `crew.config.json`). Ghi vào đúng đường dẫn mà
`crew add-job` in ra — bản đã gửi được giữ lại để sau này audit được.

Trần này do code ép và **không có flag bỏ qua**. Một cửa thoát mà người gọi bật được
trong cùng một hơi thì không phải trần. Quá trần nghĩa là cắt phần HOW.

## Template

```markdown
# Job {run_id}#{job_seq} — {worker}

## Tình hình
{Đang có gì, ở đâu, số liệu nền. Không kể lịch sử.}

## Cần gì
{Hình dạng output cần đạt. Không mô tả bằng các bước.}

## Bối cảnh & file
- {entry point để worker tự scout, file bắt buộc đọc}

## Lưu ý
- {bẫy đã biết, ràng buộc không đọc được từ file, chỗ lần trước làm sai}

## Được ghi
- {evidence_path}
- {các path đã khai ở --allow}

KHÔNG ghi file nào ngoài danh sách trên.

## Acceptance
- [ ] {kiểm được bằng mắt hoặc bằng lệnh}

## Ranh giới
- Không đọc `.env`/secret/token. Không sửa file trong `protectedPaths`/`protectedDirs`.
- Không dispatch worker khác (`AGENT_CREW_ROLE=worker`).
- Cost gate {tên API}: gặp thì DỪNG, trả BLOCKED / COST_GATE.

## Lệnh được cấp sẵn
- {lệnh cần môi trường đặc biệt, cấp nguyên văn}

## Kết thúc

Dòng **cuối cùng** của evidence phải là một dòng `Status:` mang **đúng một** giá trị:
`DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, hoặc `NEEDS_CONTEXT`. Dòng liệt kê nhiều giá
trị bị từ chối. Ngay trên nó là `Summary:` và `Concerns/Blockers:`.

Thiếu 3 dòng này thì cổng nghiệm thu đọc job là **chưa xong**, kể cả khi việc đã làm
đúng. Đừng kết bằng mục khác.
```

## Vì sao dòng `Status:` phải đúng một giá trị

Brief đưa cho worker nguyên văn dòng `Status: DONE | DONE_WITH_CONCERNS | BLOCKED |
NEEDS_CONTEXT`. Một worker echo lại chính brief của nó — hoặc dán template khi báo rằng
nó không làm được gì — sẽ tạo ra một dòng khớp regex. Nên cổng đọc: liệt kê nhiều giá
trị là **không** phán quyết. Một phán quyết thật gọi tên đúng một kết cục.

## Mục `## Lưu ý` — chỗ duy nhất chỉ bạn viết được

Trần 5 gạch. Đây là chỗ duy nhất mang thứ worker không thể tự đọc ra: kinh nghiệm run
trước, bẫy đã gặp, ràng buộc do user nói miệng. Quá 5 gạch là đang kê bước trở lại.

## Mục `## Lệnh được cấp sẵn` — khi lệnh chạm guard

`AGENT_CREW_ROLE=worker` chặn `crew new-run`, nên **worker không chạy được test của
chính crew**. Job nào cần một lệnh vướng guard thì brief **cấp sẵn nguyên văn** lệnh đó:

```text
## Lệnh được cấp sẵn
- env -u AGENT_CREW_ROLE node tests/run.mjs
```

Vì sao cấp sẵn thay vì để worker tự xử: đo được trên một run thật, cả hai worker Codex
đều vướng guard; một con tự lách bằng `env -u` rồi khai ra trong evidence. Để worker tự
suy ra rằng nó được phép gỡ guard là dạy nó sai thứ — lần sau nó gỡ guard khác mà không
hỏi. Cấp sẵn giữ được cả hai: lệnh chạy được, và việc gỡ vẫn là quyết định của dispatcher,
nằm trong brief để audit.

Chỉ cấp cho **đúng lệnh đó**, không cấp chung cho cả job. Chốt chặn đệ quy thật là `depth`
trong manifest; cấp `env -u` cho một lệnh **không** nới `depth`.

## Ví dụ: outcome vs kê bước

**Sai** — kê thuật toán hộ worker, 1.4 KB cho một việc 10 dòng:

```markdown
## Cần gì
1. Mở src/payment/handler.ts
2. Tìm hàm handlePayment
3. Đếm số if
4. Nếu trên 5 thì tách ra hàm riêng
5. Đặt tên hàm mới theo pattern validateX
6. Chạy npm test
7. Nếu fail thì sửa lại import
```

**Đúng** — nói hình dạng đích, để worker tự chọn đường:

```markdown
## Cần gì
`handlePayment` trong `src/payment/handler.ts` hiện có 11 nhánh. Cần dưới 5, bằng cách
tách phần validate ra, không đổi public API.

## Acceptance
- [ ] `npm test tests/payment` xanh
- [ ] `handlePayment` còn dưới 5 nhánh
- [ ] không có export nào bị thêm/bớt/đổi tên
```

Bản đúng ngắn hơn, kiểm được, và không khoá worker vào một cách làm có thể sai.
