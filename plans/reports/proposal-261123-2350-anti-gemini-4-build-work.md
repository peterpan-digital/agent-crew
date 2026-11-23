# Đề xuất: cho Anti nhận việc build, và vá bảng bậc model cho Gemini 4

Ngày 2026-11-23. Run đo: `.crew/runs/261123-2334` (gate `crew collect` exit 0, 5/5 PASS).

## Kết luận trước

1. **Crew hiện chưa dùng được model mới của Anti.** Mọi bậc Anti (`light/standard/deep`) vẫn ra Gemini 3.8 Flash. `deep` đang rơi xuống phương án dự phòng cuối (`flash-high`) vì không còn model tên `pro`. Hai bậc `claude` và `claude-max` thì đang chết hẳn. Đây là bug cần vá ngay, dù có giao việc build cho Anti hay không.
2. **Bài thử code của tôi chưa đủ khó để phân hạng các model.** Cả 4 model đều qua 17/17 ca của test ẩn, kể cả Flash 3.8 làm mốc. Bài thử chỉ chứng minh được rằng Anti headless làm trọn một bài build có spec rõ: viết module, viết test, tự chạy test, ghi evidence, không ghi ra ngoài vùng cho phép.
3. Đề xuất: vá bảng bậc (phần A) trước, rồi mở việc build cho Anti theo phần B. Trước khi đổi luật định tuyến cho cả crew, chạy thêm một bài thử khó hơn (phần C).

## Model Anti đang có (agy 1.5.15, `agy models` + `/quota` lúc 23:33)

| Dòng | Tên ID | Nhóm quota | Ghi chú |
| --- | --- | --- | --- |
| Gemini 4 Hydrogen | `gemini-4-hydrogen-{low,medium,high,xhigh}` | Gemini Models (tuần 92%) | Vai Executor của Orchestrator (theo changelog 1.5.10) |
| Gemini 4 Neon | `gemini-4-neon-{low,medium,high,xhigh}` | Gemini Models | Mới thêm ở 1.5.12/1.5.13 |
| Gemini 4 Argon | `gemini-4-argon-{low,medium,high}` | **Nhóm riêng, chỉ có hạn tuần** (100%) | Gói Pro có quota Argon tách riêng |
| Orchestrator | `gemini-pro-orchestrator-neon`, `…-g1-pro` (Argon) | Neon nằm trong nhóm Gemini; g1-pro không thuộc nhóm nào | Planner (Neon/Argon) + Executor Hydrogen |
| Gemini 3.8 Flash | `gemini-3.8-flash-{low,medium,high}` | Gemini Models | Đây là model mà mọi bậc đang dùng |
| Claude 5.5 | `claude-{opus,sonnet}-5-5-{low,medium,high}` | Claude and GPT (**tuần còn 1%**, hồi 25/11) | |

Gemini 4 Carbon chỉ dùng được qua API key hoặc gói Enterprise, nên không có trong danh sách. Phần định vị và benchmark từ job research (job 1) có nguồn yếu: chỉ ghi tên miền trần như `blog.google`, không có link tới trang cụ thể. Vì vậy chỉ coi là tham khảo. Phần khớp được với changelog của `agy` thì đáng tin.

## Số đo bài thử (spec 1 module + test ẩn 17 ca, headless, cùng một brief)

| Model | Test ẩn | Thời gian agent | Token output | Thinking |
| --- | --- | --- | --- | --- |
| gemini-4-hydrogen-high | 17/17 | **105s** | 11.2k | 6.5k |
| gemini-4-neon-high | 17/17 | 185s | 17.7k | 12.4k |
| gemini-4-argon-high | 17/17 | 223s | 14.5k | 10.1k |
| gemini-3.8-flash-high (mốc) | 17/17 | 281s | 27.5k | 21.3k |

Đọc được gì: với việc có spec rõ, Hydrogen nhanh gấp khoảng 2,7 lần và tốn ít token hơn khoảng 2,5 lần so với Flash 3.8, mà kết quả vẫn ngang nhau. Bài thử này không cho biết model nào suy luận giỏi hơn.

Điều kiện đo: mỗi model chỉ chạy một lần (n=1). Job 2–4 (Gemini 4) chạy song song với nhau, còn job 5 (Flash) chạy một mình sau đó. Nếu có lệch thì lệch theo hướng bất lợi cho Gemini 4, nên kết luận "nhanh hơn" vẫn đứng được, nhưng con số cụ thể chỉ là ước lượng.

## Tài liệu chính thức của Google (research lần 2, run `.crew/runs/261123-2359`, gate exit 0)

Lần này mỗi ý đều có link trang cụ thể và câu trích nguyên văn: model card trên `deepmind.google/models/model-cards/gemini-4-*`, blog trên `antigravity.google/blog/gemini-4-*-in-google-antigravity`, `antigravity.google/docs/models`, `antigravity.google/docs/plans`, và `aistudio.google.com/docs/pricing`. Claude chưa tự mở lại từng link; nội dung khớp với changelog của `agy` ở mọi chỗ so được.

| Dòng | Google định vị (trích) | Vai trong Antigravity | Giá API in/out mỗi 1M token |
| --- | --- | --- | --- |
| Carbon | "our strongest model for long-horizon software engineering…" | Planner. Chỉ có ở gói Ultra/Enterprise, **gói Pro không có** | $2 / $10, từ 30/11 là $4 / $20 |
| Argon | "our latest frontier model, excels at deep work…"; nhanh hơn và tốn ít token mỗi lượt hơn Carbon | Planner (gói Pro chọn được) | $2 / $10, từ 30/11 là $4 / $20 |
| Neon | "the sweet spot between Gemini 4 Carbon… and Gemini 4 Hydrogen" | **Planner mặc định** | $3 / $15 |
| Hydrogen | "speed and efficiency for everyday coding and agentic workflows" | **Executor mặc định** ("searches, edits files, runs builds and tests") | $1.50 / $7.50 |
| Flash 3.8 | "cost-effective scaling of general-purpose… agents" | Model duy nhất của gói Free | $0.75 / $3.75 |

Benchmark: Google không công bố SWE-bench Verified hay LiveCodeBench cho Gemini 4. Mỗi model card lại dùng một bộ benchmark khác nhau (SWE-sweep, FrontierSWE, DeepSWE, Terminal-Bench 4.0 hoặc 4.1…), nên **không so trực tiếp được Neon với Argon**. Vài số dùng được:
- Trên SWE-sweep, Neon đạt 39.0% khi chạy trong harness của chính nhà cung cấp, chỉ 12.8% trên harness tối giản. Hydrogen đạt 13.5%.
- Terminal-Bench 4.1: Neon 65.2%, Hydrogen 57.0%. Terminal-Bench 4.0: Carbon 65.2%, Argon 57.4%, Flash 3.8 chỉ 19.1%.

Kết luận cho việc chọn bậc:
- Hydrogen cho `light`/`standard` và Neon cho `deep` khớp đúng vai mà Google đặt cho hai model (Executor và Planner mặc định).
- Flash 3.8 tụt rất xa trên benchmark agent mới (Terminal-Bench 4.0 chỉ 19.1%), nên đẩy nó xuống làm dự phòng là đúng.
- Argon được định vị cao hơn Neon về độ sâu, và trên gói Pro có quota riêng. Vì vậy nó hợp với bậc `max` của Anti (phần B), nhưng vẫn cần bài thử khó để xác nhận.

## A. Vá bảng bậc model — **đã vá** trên nhánh `fix/crew-gemini-4-tiers` (chưa commit)

Kết quả: `crew doctor` giờ in `light → gemini-4-hydrogen-low`, `standard → gemini-4-hydrogen-medium`, `deep → gemini-4-neon-high`, `claude → claude-sonnet-5-5-high`, `claude-max → claude-opus-5-5-high`. Bộ test 40/40 file xanh. Các test mới đỏ khi chạy với code cũ. Phần quota không dùng module của probe, mà so tên nhóm với ID model theo dạng slug, nên không cần gọi thêm `agy models`.

`scripts/lib/model-tiers.mjs`, `DEFAULT_TIER_MAP`. Tên nhóm model ghi rõ theo thứ tự ưu tiên, không dùng regex rộng. Lý do: Argon tiêu một nhóm quota khác, nên regex rộng có thể vô tình chuyển chi phí sang nhóm đó.

| Bậc | agy hiện tại | Đề xuất (regex `agy`, theo thứ tự) |
| --- | --- | --- |
| light | flash-lite → flash-low | `^gemini-[\d.]+-hydrogen-low$`, `^gemini-[\d.]+-flash-low$` |
| standard | flash-medium | `^gemini-[\d.]+-hydrogen-medium$`, `^gemini-[\d.]+-flash-medium$` |
| deep | pro-high → pro → flash-high | `^gemini-[\d.]+-neon-high$`, `^gemini-[\d.]+-flash-high$` |
| claude | `^claude-sonnet-[\d-]+$` (chết) | `^claude-sonnet-[\d-]+-high$` |
| claude-max | `^claude-opus-[\d-]+(-thinking)?$` (chết) | `^claude-opus-[\d-]+-high$` |

Luật viết regex: **mỗi regex chỉ khớp đúng một mức effort**. Lý do: `pickModel` so phiên bản bằng các cụm số trong tên, nên `gemini-4-neon-high` và `gemini-4-neon-xhigh` đều thành `[4]` và hoà nhau. Khi hoà, `reduce` giữ tên đứng trước trong `agy models`. Một regex khớp nhiều effort (`-(high|xhigh)$`) sẽ chọn effort theo thứ tự in ra của `agy`, tức là âm thầm đổi giá.

Bậc `claude*` trước đây không có effort, vì tên 06/11 không có hậu tố. Chọn `-high` là **một quyết định về chi phí**, không phải chép máy móc: Opus high là mức đắt nhất của nhóm Claude/GPT. Nếu muốn rẻ hơn thì dùng `-medium`.

Kèm theo:
- Sửa `tests/fixtures/fake-agy` và `tests/model-tiers.test.mjs`. Hai file này vẫn dùng danh sách model 06/11, nên bộ test vẫn xanh dù crew đã hỏng.
- Sửa `worker-quota-verdict.mjs` `relevantGroups` (nhánh Anti, dòng ~52–55). Code đang chọn nhóm bằng cách so tên nhóm với `/gemini/i`. Regex này khớp cả "Gemini Models" lẫn "Gemini 4 Argon". Hậu quả: khi nhóm Argon cạn, một job Hydrogen cũng bị chặn; và một job Argon thì bị xét cả nhóm Gemini chung. Danh sách model thật của mỗi nhóm nằm trong `description` của JSON `/quota` ("Models within this group: …"), còn nhóm Argon thì không có danh sách mà lấy theo tên nhóm. Đã có sẵn module làm đúng việc map này trong `.crew/runs/261123-2334/probe-gemini-4-neon-high/quota-groups.mjs`. Tôi đã đọc: 100 dòng, không có dependency, xử lý đúng ` (Low)…(Max)` và giữ nguyên `Orchestrator (Neon)`. Dùng được làm điểm xuất phát, nhưng vẫn cần viết test riêng trong bộ test của crew.
- `crew doctor` / `tier` tự in đúng tên mới sau khi vá, không cần sửa gì thêm.

## B. Mở việc build cho Anti

1. **Bảng bậc:** cho Anti headless dùng bậc `code` → `^gemini-[\d.]+-neon-high$`, và `max` → `^gemini-[\d.]+-argon-high$` (nhóm quota riêng, không ăn vào quota Gemini chung), dự phòng `^gemini-[\d.]+-neon-xhigh$`. Chuỗi nâng bậc của Anti thành `light → standard → deep/code → max`. **Dòng `max` chưa có số đo nào ủng hộ:** Argon chỉ mới chạy bài thử dễ, ngang với các model khác.
2. **Luật định tuyến** (`SKILL.md` Bước 0 và Bước 3, `references/routing-table.md`, `dispatch-playbook.md`): bỏ luật "code → chỉ Codex". Thay bằng luật phân theo **độ rõ của spec**, không theo loại việc:
   - Build có spec rõ và acceptance chạy được bằng lệnh (test, script so khớp): **Anti `--tier code`** hoặc Codex `--tier code`. Chọn bên nào còn nhiều quota hơn (`crew quota`).
   - Refactor nhiều bước, việc chưa viết nổi acceptance, sửa bug chưa rõ nguyên nhân: giữ **Codex** `deep/code/max`.
   - Việc cần `--workspace-cli on` hoặc `--sandbox-mode danger-full-access`: giữ **Codex**, vì hai cờ này chỉ có ở Codex headless.
   - Câu "Anti = việc đã có rule thành văn" sửa thành "Anti = việc có spec/acceptance rõ, kể cả code".
3. **Dòng định tuyến ở chế độ `delegate: aggressive`:** cho phần code/script được ghi `Anti` hoặc `Codex`, thay vì cố định là Codex.
4. **Luật research → Anti trong `~/.claude/CLAUDE.md`** là file của anh, tôi không tự sửa. Nếu đồng ý với phần B thì nên viết thêm một dòng: "việc build có spec + acceptance chạy được cũng giao Anti `--tier code`".

## C. Bài thử tiếp theo, trước khi chốt phần B

Bài thử hôm nay quá dễ. Bài tiếp theo nên là việc thật, sửa nhiều file trong repo này. Ví dụ chính là phần A: giao cùng một brief cho Anti `neon-high` và Codex `sol high`, mỗi bên làm trong worktree riêng, chấm bằng `npm test` cùng một bộ test ẩn. Nếu Anti đạt ngang Codex thì chốt phần B. Còn nếu Anti trượt thì giữ Anti ở việc build có spec gói trong 1–2 file.

## Câu hỏi còn treo

- Bậc `deep` đã chọn Neon (Planner mặc định, dùng nhóm quota chính có hồi 5h). Argon để cho `max` ở phần B — tài liệu chính thức ủng hộ hướng này nhưng chưa có số đo trên việc khó.
- Có muốn thử Orchestrator (`gemini-pro-orchestrator-neon`) cho bậc `code` không? Model này chạy được với `agy -p` (theo research, chưa đo), nhưng `usage` có thể gộp token của hai model.
- Nhóm Claude/GPT của Anti đang còn 1% hạn tuần. Bậc `claude*` sau khi vá vẫn bị `crew quota` chặn tới 25/11.
