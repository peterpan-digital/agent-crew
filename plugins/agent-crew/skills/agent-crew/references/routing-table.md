# Routing Table

## Tiêu chí phân việc

Không phân theo "dễ / khó". Phân theo **rule/spec đã thành văn hay chưa**:

| Điều kiện | Worker |
| --- | --- |
| Rule đã viết thành văn trong `SKILL.md`, chỉ cần thi hành đúng và nhanh | **Antigravity** |
| Build có spec rõ và lệnh kiểm chạy được (`--accept-cmd`) | **Antigravity** hoặc **Codex** `--tier code`, chọn theo quota |
| Cần phán đoán ngoài văn bản: đọc số, chọn hướng, quyết định nghiệp vụ | **Claude** |
| Code chưa viết nổi spec trước, refactor lớn chưa rõ hướng, sửa bug chưa rõ nguyên nhân, job cần `--workspace-cli`/`danger-full-access` | **Codex** |

Lý do Antigravity được nhiều việc hơn cảm giác trực quan: nó nhanh và làm rất gọn khi
bộ case đã ràng kỹ. Điểm yếu của nó là suy luận mở, không phải tốc độ hay độ chính xác
khi có mẫu.

## Bảng phân việc

Chia theo **rule đã thành văn hay chưa**, không theo dễ/khó:

| Worker | Loại việc |
| --- | --- |
| **Claude** | Việc cần phán đoán ngoài văn bản: đọc số rồi kết luận, xếp ưu tiên, viết report chính thức, audit trạng thái, quyết định đánh đổi |
| **Codex** | Code và pipeline còn mở: viết/refactor tool khi hướng chưa chốt, workflow, dedup/clustering, transform dữ liệu phức tạp, chạy theo lô, việc cần Workspace CLI hoặc full access |
| **Antigravity** | Việc đã có rule viết sẵn trong một skill: lọc theo tiêu chí, readback/export, chuẩn hoá bảng, điền metadata theo mẫu, audit nhiều URL, việc cần browser tools. **Và** build có spec + lệnh kiểm (`--tier code`) |

Tên skill cụ thể của từng repo nằm ở `CLAUDE.md` của repo đó, không ở đây. Repo có bảng
skill → worker thì bảng đó thắng; không có thì route theo loại việc ở trên.

Bảng này chỉ trả lời **ai làm**. Nó không có cột transport: transport không phải thuộc
tính của loại việc. Cùng một việc có thể là owner hay assist tuỳ ai chịu trách nhiệm về
đầu ra — và cả hai đều chạy `headless` trừ khi có lý do viết ra.

## Build có spec: Anti hay Codex

Tới 23/11 mọi việc code đi Codex. Từ 24/11 Anti nhận được việc build, với hai điều kiện
viết ra được **trước** khi bắn: spec nói rõ hành vi cần có, và một lệnh kiểm chạy được
(test, script so khớp) để khai `--accept-cmd`. Thiếu một trong hai thì vẫn Codex — điểm yếu
của Anti là suy luận mở, và không có lệnh kiểm thì không ai bắt được chỗ nó đoán sai.

Chọn bên nào: `crew quota`, bên còn nhiều quota hơn nhận; ngang nhau thì Anti (để Codex cho
việc còn mở). Một bên cạn thì bên kia nhận. Mỗi job build khai `--accept-cmd`: gate tự chạy
lệnh, nên worker tự khai `DONE` mà lệnh đỏ vẫn ra `FAIL`.

Số đo (run `261123-2334`, `261124-0030`, n=1 mỗi ô):

| Bài | Model | Kết quả |
| --- | --- | --- |
| 1 module + test, spec rõ (17 ca ẩn) | Hydrogen high / Neon high / Argon high / Flash 3.8 high | cả 4 qua 17/17; Hydrogen nhanh nhất (105s), Flash 3.8 chậm nhất (281s) |
| 6 file của chính crew: code, CLI, test, tài liệu (28 ca ẩn + toàn bộ test) | Neon high | 28/28, toàn bộ test xanh — bản được lấy |
| như trên | Argon high | 28/28 nhưng một test tự viết sai, worker không chạy được nên không thấy, vẫn tự báo `DONE_WITH_CONCERNS` |

Ca Argon là lý do `--accept-cmd` bắt buộc với job build: không có nó gate đã cho bản hỏng `PASS`.
Chưa có số đo Anti so với Codex trên cùng bài (Codex cạn quota ngày đo).

## Transport

**`headless` là mặc định cho cả `owner` và `assist`.** Chọn `app` là ghi đè, và ghi đè
phải kèm `--note` nói vì sao — không note thì `crew add-job` từ chối. **Codex chỉ chạy
`headless`** (từ 2.0.4): `--worker codex --transport app` bị từ chối dù có note.

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

### Ba ca `app` đáng giá (user chốt 25/08, chỉ còn cho Anti)

1. **Job Anti sẽ gặp prompt permission cần người trả.** Anti app cho người bấm đồng ý;
   headless gặp prompt là silent-fail. Đây là ca app mạnh nhất còn lại.
2. **Việc mở/khám phá, chưa viết nổi acceptance trước.** Không có tiêu chí chấm thì mất
   evidence-first cũng không mất gì; đổi lại owner nhìn được quá trình.
3. **Cần thread resume làm tiếp buổi sau.** `crew run anti --resume <conversationId>`:
   `agentapi` giữ conversation ở store riêng của app nên sống qua phiên Claude.
   Codex không cần app cho ca này: `crew run codex --resume <conversationId>` chạy
   headless, tiếp được cả thread app cũ (đo 23/09).

Ngoài 3 ca này, chọn `app` là đang trả giá quan sát để lấy một thứ chưa nêu được.

### Luật chọn transport theo loại việc

| Việc | Đường | Vì sao |
| --- | --- | --- |
| Đọc/ghi file, Sheet, script, code | **headless**, mặc định | Quyền hẹp nhất đủ dùng, đã nghiệm thu |
| Google Workspace | **headless + `--workspace-cli on`** | Owner chốt 22/09: luôn đi Workspace CLI. **Không có lối tắt qua app** — app cũng bị sandbox nên `gws` không ghi nổi `token_cache.json` |
| Cần trình duyệt / Computer Use / ghi ngoài repo | **headless + `--sandbox-mode danger-full-access`** | Bậc sandbox là thứ duy nhất chặn; app mode không thay thế được |
| Việc cần ngữ cảnh một thread đang có | `--resume <conversationId>` (Codex: headless; Anti: cùng transport của job trước) | Xem "Ba ca `app` đáng giá" |

### Luật transport chi tiết nằm ở đâu

Bảng này chỉ đủ để chọn đường. Luật chi tiết nằm ở các file cùng thư mục:

| Cần biết | File |
| --- | --- |
| Job Anti `app`, resume Anti/Codex, giãn lệnh dispatch, heartbeat, báo im lặng của Anti app | `transport-va-resume.md` |
| `--workspace-cli on`, `--sandbox-mode`, connector Google, `401`, cổng kho credential | `quyen-han-worker.md` |
| Bảng verdict, cửa sổ phạm vi, retry, reconcile orphan, hold | `nghiem-thu-chi-tiet.md` |
| Owner gõ `@anti`/`@codex`, resume theo manifest, phiên chat với worker, review 2 vòng | `phoi-hop-owner.md` |

Nhật ký đo (vì sao các luật đó ra đời, số đo từng ngày) ở
`docs/transport-measurements.md` của plugin. Không cần đọc để vận hành.

## Bảo vệ theo thư mục, không theo tên file

Cổng phạm vi có hai danh sách: file bảo vệ (MCP config, credential, thư mục skill của
các runtime) và control plane (settings, hook, `.git/`, `crew.config.json`, file chỉ
dẫn agent ở mọi cấp). Phần chung nằm trong code; repo thêm phần riêng bằng
`protectedPaths` / `controlPlanePaths` trong `crew.config.json`. Đường kết thúc bằng `/`
là thư mục, khớp theo prefix.

Khớp theo prefix có lý do: đến 25/08 code kiểm bằng khớp tuyệt đối, nên mọi thứ *bên
trong* thư mục skill không được bảo vệ — worker sửa `.claude/skills/x/SKILL.md` không
khớp entry nào, rồi khớp prefix cho phép của task, và rơi vào `inScope`. Hai hệ quả:

- **Khai `--allow` không mua được quyền ghi vào thư mục được bảo vệ** hay control plane.
- **Protected hit vẫn bác được bằng `--not-ours`.** Có chủ ý: một repo thường có vài
  session chạy cùng lúc, nên session khác sửa file skill là chuyện thật và hay xảy ra.
  Cấm bác hoàn toàn thì không run nào đi qua được khi có người bên cạnh chạy sync — mà
  một cổng không thể thoả mãn một cách trung thực là cổng người ta học cách bỏ qua.
  Lý do vẫn được ghi, và entry vẫn mang nhãn `protected` để người đọc thấy thứ vừa
  được bác là loại nào.

## Model

Chọn bậc theo **lượng phán đoán cần để đi từ input sang output**, không theo cảm
giác việc nặng hay nhẹ. Ghi bằng `crew add-job --tier <bậc>`; crew đổi ra tên còn sống.

| Loại việc | `--tier` | Anti headless (`agy`) | Anti app (`agentapi`) | Codex (headless) |
| --- | --- | --- | --- | --- |
| Điền theo mẫu, chuẩn hoá bảng, readback/export | `light` | hydrogen-low, không có thì flash-lite → flash-low | `flash_lite` | Luna mới nhất, `low` |
| Thi hành skill nhiều case, crawl + phân loại theo whitelist | `standard` | hydrogen-medium, không có thì flash-medium | `flash` | Terra mới nhất, `medium` |
| Suy luận từ dữ liệu sang output chưa có mẫu sẵn; sửa bug khó | `deep` | neon-high, không có thì pro-high → pro → flash-high | `pro` | Sol mới nhất, `xhigh` |
| Code/pipeline nhiều bước, refactor tool | `code` | neon-high | — | Sol mới nhất, `high` |
| Việc khó nhất: kiến trúc lớn, bài toán `deep`/`code` chưa giải được | `max` | argon-high, không có thì neon-xhigh | — | Astra mới nhất, `max` |
| Phán đoán sâu muốn giao đi để đỡ token Claude; viết/tổng hợp cần giọng tốt | `claude` | claude-sonnet bản mới nhất, mức `high` | — | — |
| Như trên, việc khó nhất (suy luận nhiều bước, review thiết kế) | `claude-max` | claude-opus bản mới nhất, mức `high` | — | — |

Bảng này **cố ý không ghi tên model đầy đủ**. Tên đổi theo đợt phát hành của nhà cung cấp,
và một tên cũ nằm trong tài liệu là job chết ngay lượt đầu (đo 16/10: `gemini-3.7-flash-medium`
và `gpt-5.5` cùng hỏng ở hai job đầu của một run). `--tier` chọn tên từ chính `agy models`
lúc ghi sổ (regex neo, lấy bản cao nhất); `crew doctor` in mỗi bậc đang ra tên nào. Bậc
không khớp tên còn sống thì `add-job` báo lỗi kèm danh sách, **không** trượt sang bậc khác.
Nhà cung cấp đổi lược đặt tên thì repo ghi đè bằng `modelTiers` trong `crew.config.json`
(`{"deep": {"agy": ["^gemini-[\\d.]+-pro$"]}}`; khoá `agy`/`app`/`codex`/`effort`), không cần sửa code.

**Anti từ agy 1.5.x (đo 23/11):** tên model là `<dòng>-<effort>` (`gemini-4-hydrogen-medium`,
`claude-sonnet-5-5-high`). Mỗi regex của bảng chỉ khớp **một** mức effort: `pickModel` so phiên bản
bằng cụm số nên `neon-high` và `neon-xhigh` hoà nhau, và khi hoà thì tên in trước trong `agy models`
thắng — một regex nhiều effort là âm thầm đổi giá. Gemini 4 Argon vào bậc `max` (không có thì rơi sang
`neon-xhigh`); lưu ý nó tiêu một nhóm quota riêng chỉ hồi theo tuần (`crew quota` in riêng dòng `Gemini 4 Argon`).

**Codex làm được việc khó**, không chỉ việc code thường: `deep` (Sol `xhigh`) và `max`
(Astra `max`) là chỗ giao suy luận nhiều bước, sửa bug khó, thiết kế lớn khi muốn đỡ token
Claude. Dòng → bậc theo mô tả catalog Codex và tài liệu OpenAI (research 07/11, Anti, có
nguồn): Luna "nhanh, rẻ, việc dễ"; Terra "cân bằng, việc thẳng"; Sol "chủ lực cho code và
việc hằng ngày", mặc định của Codex, benchmark code ngang Astra với giá ~1/5; Astra "đỉnh,
cho việc khắt khe nhất". Effort `ultra` (tự chia subagent bên trong Codex) **không** vào
bảng: trùng việc chia job của crew và nhân token theo số subagent — cần thì `--effort ultra` tay.

Bậc `claude`/`claude-max` chạy model Claude **bằng quota Antigravity**, không tốn token
Claude của owner (đo 06/11: chạy headless như Gemini, JSON cùng hình dạng). Chỉ Anti
headless. Credit Antigravity mỗi lượt chưa đo được từ CLI.

Bậc chỉ là điểm khởi đầu. Job fail vì model yếu thì **nâng đúng 1 bậc**:
`crew add-job --bump-from <seq>` (`light→standard→deep→max`, `code→max`; Anti app dừng ở `deep` vì không có bậc `max`;
tự ghi note), không nhảy thẳng
lên bậc cao nhất cho mọi thứ — làm vậy thì lần sau không ai biết việc nào thật sự cần
bậc cao. `deep` không tự nâng lên `claude`: đổi nhà cung cấp là quyết định có chủ ý,
ghi bằng `--tier` tay.

Ràng buộc từng runtime:

| Runtime | Ghi chú |
| --- | --- |
| `agy` | nhận tên model đầy đủ; `agy models` liệt kê bản còn sống |
| `agentapi` | **chỉ** nhận `flash_lite\|flash\|pro\|inherit`, không nhận tên đầy đủ |
| Codex | Từ 2.2.0 bậc chọn cả model lẫn effort: regex neo trên slug catalog của Codex (`~/.codex/models_cache.json`, model `hide` bị bỏ; không có cache thì `codex debug models`), bản cao nhất thắng (`gpt-6.1-sol` > `gpt-6-sol`), model không nhận effort của bậc thì báo lỗi. `crew run` truyền `-m` và effort từ sổ. `--model`/`--effort` tay chỉ đè đúng phần mình khai. Cache ghi `identity` của tài khoản; đo 07/11 mọi model `list` cùng quyền `standard`, và Sol/Terra/Luna chạy thật được (Astra là model config). Đo 2026-08-24: codex **im lặng bỏ qua** `model_reasoning_effort` sai chính tả, nên adapter tự whitelist để bắt typo |

**Không có `--tier` hay `--model` thì không dispatch.** Trước phase 03, mọi job trong mọi
manifest đều `"model": null` — knob có mà chưa ai bật, nên không có cách nào đo model
nào hay fail ngoài đoán. `crew add-job` ghi `model` (và `effort` cho Codex) để lần sau đo
được, và `crew run` lấy lại đúng giá trị đó từ sổ.

Dispatch Codex đi qua `crew run codex`, **không** qua subagent `codex:codex-rescue`.
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
