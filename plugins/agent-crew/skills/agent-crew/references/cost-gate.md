# Cost Gate

Hai loại chi phí, hai cơ chế khác nhau.

## Loại 1 — API tốn tiền theo lần gọi: PHẢI XIN XÁC NHẬN

Worker gặp một trong các đường dưới đây thì **dừng**, trả `Status: BLOCKED` với
`Concerns/Blockers: COST_GATE — {tên API}`. Claude hỏi user, được đồng ý mới dispatch lại.

Danh sách khai ở `costGate` trong `crew.config.json` của repo, không ở đây:

```json
{
  "costGate": [
    "API dữ liệu trả phí",
    { "api": "LLM chạy theo lô", "via": "tên skill gọi nó" }
  ]
}
```

`api` là tên worker phải ghi sau `COST_GATE — ` (collect đọc nó để tạo hold, nên không
chứa `, ; . ( :`). `via` là skill hoặc workflow dẫn tới API — worker cần biết **đường
vào**, vì nó gặp cái tên skill trước khi gặp cái tên API. Adapter chèn cả danh sách vào
brief; routing gate im lặng với prompt nhắc tới bất kỳ tên nào trong đó, và từ chối
config có trigger khớp tên đó.

Miễn gate (free quota, cứ chạy): các nguồn đọc miễn phí và crawl web thường.

Danh sách trống không có nghĩa là mở cổng. Không chắc một đường có tốn tiền hay không thì
coi như **có** và hỏi — đoán sai theo hướng này chỉ mất một lượt hỏi, đoán sai theo
hướng kia thì mất tiền.

## Loại 2 — Credit của chính worker: NGƯỠNG CỨNG, KHÔNG HỎI

Hỏi từng lần dispatch thì mất luôn ý nghĩa tự động. Chặn bằng ngưỡng.

| Ngưỡng | Giá trị | Căn cứ |
| --- | --- | --- |
| `max_parallel` | **3** | đo 2026-08-18: 3 job song song 16s vs tuần tự 33s, per-job không degrade |
| `max_jobs_per_run` | **6** | vượt thì báo user, không tự chạy tiếp |
| `print_timeout_default` | **15m** | mặc định của `agy` là 5m, quá ngắn cho job thật |
| `print_timeout_max` | **30m** | job cần hơn thì phải chẻ nhỏ hoặc chuyển `transport: app` |
| `min_job_size` | ~30s xử lý | dưới ngưỡng này thì gom job — overhead khởi động `agy` là 5.5s/lần |

## Vì sao phải dùng ngưỡng thay vì đọc quota

`agy --help` **không** expose subcommand `credits` (docs của Google có trang credits nhưng
CLI này không có). Không đọc được quota còn lại từ CLI → ngưỡng cứng là cơ chế kiểm soát
duy nhất. Nếu Google thêm `agy credits` về sau thì thay bằng đọc quota thật.

## Job thất bại vẫn tốn tiền

Bẫy đã đo: `agy` thiếu permission trả `status: SUCCESS` + `response` rỗng — vẫn tính token
(33.912 input / 770 output trong lần đo). Nên adapter phải fail loudly ngay lần đầu, không
retry mù. Retry tối đa **1 lần**, và chỉ khi nguyên nhân fail không phải permission.
