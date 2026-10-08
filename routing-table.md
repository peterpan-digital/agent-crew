# Routing Table

## Tiêu chí phân việc

Không phân theo "dễ / khó". Phân theo **rule đã thành văn hay chưa**:

| Điều kiện | Worker |
| --- | --- |
| Rule đã viết thành văn trong `SKILL.md`, chỉ cần thi hành đúng và nhanh | **Antigravity** |
| Cần phán đoán ngoài văn bản: đọc số, chọn hướng, quyết định nghiệp vụ | **Claude** |
| Code, pipeline, logic nhiều bước, refactor | **Codex** |

Lý do Antigravity được nhiều việc hơn cảm giác trực quan: nó nhanh và làm rất gọn khi
bộ case đã ràng kỹ. Điểm yếu của nó là suy luận mở, không phải tốc độ hay độ chính xác
khi có mẫu.

## Bảng phân việc

Chia theo **rule đã thành văn hay chưa**, không theo dễ/khó:

| Worker | Loại việc |
| --- | --- |
| **Claude** | Việc cần phán đoán ngoài văn bản: đọc số rồi kết luận, xếp ưu tiên, viết report chính thức, audit trạng thái, quyết định đánh đổi |
| **Codex** | Code và pipeline: viết/refactor tool, workflow, dedup/clustering, transform dữ liệu phức tạp, chạy theo lô |
| **Antigravity** | Việc đã có rule viết sẵn trong một skill: lọc theo tiêu chí, readback/export, chuẩn hoá bảng, điền metadata theo mẫu, audit nhiều URL, việc cần browser tools |

`ĐIỀN VÀO`: thêm tên skill cụ thể của workspace bạn vào từng hàng. Bảng trống vẫn route
được theo loại việc, nhưng có tên skill thì Claude khỏi phải đoán.

Bảng này chỉ trả lời **ai làm**. Nó không có cột transport: transport không phải thuộc
tính của loại việc. Cùng một việc có thể là owner hay assist tuỳ ai chịu trách nhiệm về
đầu ra — và cả hai đều chạy `headless` trừ khi có lý do viết ra.

## Transport

**`headless` là mặc định cho cả `owner` và `assist`.** Chọn `app` là ghi đè, và ghi đè
phải kèm `note` nói vì sao — không note thì `addJob` từ chối.

| Vai trò | Nghĩa là | Transport mặc định |
| --- | --- | --- |
| **owner** | Worker là người đảm nhiệm chính. Evidence của nó **chính là** deliverable được nghiệm thu | **headless** |
| **assist** | Worker làm nguyên liệu cho deliverable mà Claude mới là người viết (Anti chạy browser lấy trang, Codex research song song nhiều nhánh) | **headless** |

`role` không còn quyết transport, nhưng **vẫn bắt buộc** và vẫn là phép thử:

> **Ai chịu trách nhiệm về acceptance của đầu ra job này?**
> Chính worker → `role: owner`. Claude → `role: assist`.

`role` quyết cách **chấm** output. `transport` quyết harness **thấy được gì**. Hai trục
khác nhau — rule 25/08 trước đó nối chúng lại là nối sai, và phép đo phase 3 của
`260825-1203-crew-transport-mode-split` cho thấy vì sao.

### Vì sao headless là mặc định (đo 2026-08-25, 6 job app thật)

| Đo được | Nghĩa là |
| --- | --- |
| Anti app truyền `runtimeOk: true` vô điều kiện; không `usage`, không `response`, không `numTurns` | Mất khả năng phát hiện silent-fail mà headless có (`SUCCESS` + `response` rỗng = bị chặn ở prompt permission) |
| Codex app: `exitCode: null`, **không watchdog**, không gọi `result` | Job treo chỉ chết khi hết trần timeout; text reply của worker bị bỏ |
| Thread app **không hiện live** — rollout trên đĩa ở +8s, mắt chỉ thấy sau khi tắt/mở lại app | "Mở app ngồi xem cho chắc" không mua được cái nó hứa |

Nói gọn: `app` **quan sát yếu hơn** `headless` ở cả hai runtime. Nên nó phải là ngoại lệ
có lý do, không phải mặc định.

### Ba ca `app` đáng giá (user chốt 25/08)

1. **Job Anti sẽ gặp prompt permission cần người trả.** Anti app cho người bấm đồng ý;
   headless gặp prompt là silent-fail. Đây là ca app mạnh nhất còn lại.
2. **Việc mở/khám phá, chưa viết nổi acceptance trước.** Không có tiêu chí chấm thì mất
   evidence-first cũng không mất gì; đổi lại owner nhìn được quá trình.
3. **Cần thread resume làm tiếp buổi sau.** `codex resume <id>` cho Codex, `anti-run.mjs
   --resume <conversationId>`. Từ 23/09 **cả 4 bề mặt đều resume được**, chung một
   cờ `--resume <id>`.

   Nhưng "làm tiếp buổi sau" **vẫn là lý do chọn Anti app** — vì lý do khác lúc
   đầu tưởng. Codex app chỉ resume được **trong cùng một phiên Claude**: companion
   giữ job theo `CODEX_COMPANION_SESSION_ID` và xoá chúng khi phiên đóng. Anti app
   không dính vì `agentapi` giữ conversation ở store riêng của app.

Ngoài 3 ca này, chọn `app` là đang trả giá quan sát để lấy một thứ chưa nêu được.

### Luật chọn transport theo loại việc

| Việc | Đường | Vì sao |
| --- | --- | --- |
| Đọc/ghi file, Sheet, script, code | **headless**, mặc định | Quyền hẹp nhất đủ dùng, đã nghiệm thu |
| Google Workspace | **headless + `--workspace-cli on`** | Owner chốt 22/09: luôn đi Workspace CLI. **Không có lối tắt qua app** — app cũng bị sandbox nên `gws` không ghi nổi `token_cache.json` |
| Cần trình duyệt / Computer Use / ghi ngoài repo | **headless + `--sandbox-mode danger-full-access`** | Bậc sandbox là thứ duy nhất chặn; app mode không thay thế được |
| Việc cần ngữ cảnh một thread app đang sống | `--mode app` | Xem "Ba ca `app` đáng giá" |

### Luật transport chi tiết nằm ở đâu

Bảng này chỉ đủ để chọn đường. Luật chi tiết nằm ở `references/` của skill điều phối
(trong module: `skill/agent-crew/references/`):

| Cần biết | File |
| --- | --- |
| Job `app`, resume Anti/Codex, giãn lệnh dispatch, heartbeat, báo im lặng của Anti app | `transport-va-resume.md` |
| `--workspace-cli on`, `--sandbox-mode`, connector Google, `401`, cổng kho credential | `quyen-han-worker.md` |
| Bảng verdict, cửa sổ phạm vi, retry, reconcile orphan, hold | `nghiem-thu-chi-tiet.md` |
| Owner gõ `@anti`/`@codex`, resume theo manifest, phiên chat với worker, review 2 vòng | `phoi-hop-owner.md` |

Nhật ký đo (vì sao các luật đó ra đời, số đo từng ngày) ở
`docs/transport-measurements.md`. Không cần đọc để vận hành.

## Bảo vệ theo thư mục, không theo tên file

`CLAUDE.md` bảo vệ tám **thư mục** skill (`.claude/skills/`, `.codex/skills/`,
`.agents/skills/`, `.gemini/skills/`, cùng bốn bản trong `mwg-workflow-n8n/`). Đến
25/08 code kiểm bằng `PROTECTED_PATHS.includes(path)` — **khớp tuyệt đối** — nên mọi
thứ *bên trong* các thư mục đó không được bảo vệ: worker sửa
`.claude/skills/seo-crew/SKILL.md` không khớp entry nào, rồi khớp prefix cho phép của
task, và rơi vào `inScope`.

Giờ có `PROTECTED_DIRS` khớp theo prefix. Hai hệ quả cần biết:

- **Khai `filesMayModify` không mua được quyền ghi vào thư mục được bảo vệ.** Trước
  đây khai `[".claude/skills/"]` là đủ; giờ vẫn bị tính là protected hit.
- **Protected hit vẫn bác được bằng `--not-ours`.** Có chủ ý: repo này thường có vài
  session chạy cùng lúc, nên session khác sửa file skill là chuyện thật và hay xảy ra.
  Cấm bác hoàn toàn thì không run nào đi qua được khi có người bên cạnh chạy sync — mà
  một cổng không thể thoả mãn một cách trung thực là cổng người ta học cách bỏ qua.
  Lý do vẫn được ghi, và entry vẫn mang nhãn `protected` để người đọc thấy thứ vừa
  được bác là loại nào.

## Model

Chọn bậc theo **lượng phán đoán cần để đi từ input sang output**, không theo cảm
giác việc nặng hay nhẹ.

| Loại việc | Anti headless (`agy`) | Anti app (`agentapi`) | Codex (cả 2 transport) |
| --- | --- | --- | --- |
| Điền theo mẫu, chuẩn hoá bảng, readback/export Sheet | `gemini-3.7-flash-low` | `flash_lite` | — |
| Thi hành skill nhiều case, crawl + phân loại theo whitelist | `gemini-3.7-flash-medium` | `flash` | `--effort low` |
| Suy luận từ dữ liệu sang output chưa có mẫu sẵn | `gemini-3.1-pro-high` | `pro` | `--effort medium` |
| Code/pipeline nhiều bước, refactor tool | — | — | `--effort high` |

Bậc chỉ là điểm khởi đầu. Job fail vì model yếu thì **nâng đúng 1 bậc và ghi note**,
không nhảy thẳng lên `pro-high` cho mọi thứ — làm vậy thì lần sau không ai biết việc
nào thật sự cần bậc cao.

Ràng buộc từng runtime:

| Runtime | Ghi chú |
| --- | --- |
| `agy` | nhận tên model đầy đủ; `agy models` liệt kê bản còn sống |
| `agentapi` | **chỉ** nhận `flash_lite\|flash\|pro\|inherit`, không nhận tên đầy đủ |
| Codex | Bậc đặt bằng `--effort`; vẫn truyền `-m` (mặc định config hiện tại `gpt-5.5`) — để trống thì manifest không ghi được model nào đã chạy, đúng cái field này sinh ra để đo. Đo 2026-08-24: codex **im lặng bỏ qua** `model_reasoning_effort` sai chính tả, nên adapter tự whitelist để bắt typo |

**Không truyền `--model` thì không dispatch.** Trước phase 03, mọi job trong mọi
manifest đều `"model": null` — knob có mà chưa ai bật, nên không có cách nào đo model
nào hay fail ngoài đoán. `addJob` ghi `model` (và `effort` cho Codex) để lần sau đo được.

Dispatch Codex đi qua `codex-run.mjs`, **không** qua subagent `codex:codex-rescue`.
Lý do không phải transport của subagent tệ — nó lái app-server thật và mở thread thật
trong app. Lý do là **subagent bị cấm quan sát**: `agents/codex-rescue.md` cấm nó
poll, monitor, fetch result, cancel. Runtime `codex-companion.mjs` bên dưới có đủ
`status`/`result`/`cancel`, chỉ tầng agent là mù. Đo 2026-08-24: pid chết ở phút 2,
manifest không có field `failure` nào, phát hiện ở phút 22 — job chết mà không ai ghi
sổ vì không ai được phép nhìn.

## Khi KHÔNG dùng crew

- Request chỉ có **1 đầu việc** → làm trực tiếp. Dispatch cho có là thêm 5.5s startup vô ích.
- Job nhỏ hơn ~30s xử lý → gom vào một job, đừng chẻ. Overhead khởi động `agy` là 5.5s/lần.
- Việc cần quyết định nghiệp vụ giữa chừng → Claude tự làm, không giao đi rồi hỏi lại.
