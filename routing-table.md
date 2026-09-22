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

| Worker | Việc |
| --- | --- |
| **Claude** | `seo-gsc-category-review`, `seo-action-impact-review`, `seo-daily-reporter`, `seo-task-state-audit`, viết report chính thức, `seo-log-cv`, `seo-log-weekly-work` |
| **Codex** | tool trong `mwg-seo-analytics/`, `mwg-seo-planning/scripts/`, workflow n8n, dedup/clustering, `batch-llm-skill` runs, transform data phức tạp |
| **Antigravity** | `seo-keyword-research`, `seo-gsc-rank-check` (bulk), `image-seo-pipeline`, `content-html-optimizer`, readback/export Sheet, chuẩn hoá bảng, fill metadata theo mẫu, research đối thủ, audit outline nhiều URL, việc cần browser tools |

Bảng này chỉ trả lời **ai làm**. Nó không có cột transport: transport không phải thuộc
tính của loại việc. Cùng một việc `seo-gsc-rank-check` có thể là owner hay assist tuỳ ai
chịu trách nhiệm về đầu ra — và cả hai đều chạy `headless` trừ khi có lý do viết ra.

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

### Job cần Google Workspace CLI — `--workspace-cli on` (thêm 2026-09-19)

Chỉ **Codex headless** cần cờ này, và phải bật tay.

`codex exec` chạy dưới Seatbelt `--sandbox workspace-write`, cấm ghi ngoài workspace.
`gws` ghi đè `~/.config/gws/token_cache.json` mỗi lần refresh access token. Nên:

| Tình huống | Kết quả |
| --- | --- |
| Token trong cache còn hạn | Job chạy tốt — chỉ đọc, không cần ghi |
| Token hết hạn | CLI phải refresh → ghi bị chặn → `401` → job `BLOCKED` |

Đó là lý do lỗi này trông "lúc được lúc không": nó phụ thuộc cache còn hạn hay không tại
đúng thời điểm job chạy, không phụ thuộc job làm gì.

Cờ `--workspace-cli on` làm dispatcher (chạy **ngoài** sandbox) mint access token bằng
`grant_type=refresh_token` rồi bơm `GOOGLE_WORKSPACE_CLI_TOKEN` qua env. Worker không ghi
vào kho credential lần nào — đường xoá `credentials.enc` vẫn bị sandbox chặn nguyên.

Đo 18/09: token sống 3599s, grant **không** rotate refresh token. Trần run là 30 phút
(`MAX_TIMEOUT_MS`), nằm gọn trong giờ đó, nên mint **mỗi job một lần** và không có xử lý
hết hạn giữa chừng. Ba job song song cũng không đua nhau vì không job nào ghi cache chung.

**Mặc định `off` là cố ý.** Access token đọc được toàn bộ Workspace của owner. Job chỉ
refactor script thì không có lý do cầm nó.

Ba giới hạn đã đo:

- **App mode không dùng được.** Broker `codex app-server` tái dùng giữa các phiên, env
  bơm lúc dispatch không tới được broker đang sống. Adapter từ chối thẳng, không âm thầm
  chạy tiếp mà rơi về 401.
- **Anti không cần.** `anti-run.mjs` không truyền cờ sandbox nào → chạy ngoài Seatbelt.
- **Config dir giữ mặc định.** Đo 19/09: cache discovery ghi hỏng **không** chí mạng —
  CLI fetch qua mạng rồi gọi API bình thường, exit 0. Khác với ca 18/09 (config dir rỗng
  và chỉ đọc, CLI phải **tạo** thư mục cache — ca đó mới chết).

Worker gặp `401` thì **DỪNG**, trả `BLOCKED` kèm nguyên văn. Thiếu cờ là lỗi người giao
việc, không phải thứ worker được tự vá — và đường vòng duy nhất nó nghĩ ra
(`KEYRING_BACKEND=file`) đã **xoá thật** kho credential của owner ngày 18/09.

### Sandbox là cờ của adapter, không phải của Codex (đo 2026-09-22)

Chỉ **crew headless** bị sandbox. Terminal gõ tay và **app Codex đều không**, nên cả hai
dùng Workspace CLI bình thường — không cần wrapper, không cần sửa `config.toml`.

Nguồn của sandbox là đúng một dòng trong `codex-run.mjs:buildArgs` (từ 22/09 là
biến, mặc định vẫn y nguyên giá trị dưới đây — xem `--sandbox-mode` cuối mục này):

```
"--sandbox", "workspace-write",
```

`~/.codex/config.toml` **không có key `sandbox` nào**, nên mặc định của máy là
`filesystem unrestricted`. Phiên tương tác và app đọc đúng file đó.

| Bề mặt | Sandbox | `gws` ghi lại `token_cache.json`? |
| --- | --- | --- |
| crew headless (`codex exec` qua adapter) | `workspace-write` — **adapter tự áp** | ❌ → `401` |
| terminal gõ tay `codex` | unrestricted | ✅ |
| app Codex | unrestricted, cùng `config.toml` | ✅ |

Bằng chứng, không suy từ config: chạy `codex exec` **bỏ cờ `--sandbox`**, bảo nó
`touch ~/.codex-sandbox-probe`. Lệnh exit 0 và file **tạo thật ở `$HOME`** — ngoài
workspace. Đo `codex doctor` khớp: `filesystem unrestricted · network enabled`.

Hệ quả cho người đọc sau:

- Đừng đi debug "app Codex có bị sandbox không" nữa. Không.
- `--workspace-cli on` vẫn bị **từ chối** ở `--mode app` (`codex-run.mjs:825`), và từ chối
  đó vẫn đúng — broker dùng lại nên env tiêm sau không tới.
- ~~Job chạy trong app không bị sandbox nên tự refresh token được~~ — **sai, đã bác bỏ
  22/09 13:3x.** Job crew dispatch vào app **bị sandbox**: probe ghi file ra `$HOME` trả
  `Operation not permitted`, y hệt headless. Mà `gws` phải ghi `token_cache.json` ra
  `~/.config/gws`, tức ngoài repo. Nên **việc cần Workspace CLI phải đi headless +
  `--workspace-cli on`**, không có lối tắt qua app.
- App mode còn hỏng trình duyệt: `Browser is not available: iab`. Nó **không** phải bề mặt
  "đủ quyền" như từng nghĩ.
- **Owner tự ngồi gõ trong app Codex là bề mặt THỨ TƯ, khác hẳn** (đo 22/09/2026, owner
  chạy probe 3 bước và dán nguyên văn kết quả). Nó **không bị sandbox**: `date >
  ~/codex-sandbox-probe.txt` chạy được, ghi thẳng ra ngoài repo. Trình duyệt mở được
  example.com và trả accessibility tree; Computer Use chụp được screenshot. Cả ba thứ
  mà crew `--mode app` đều bị chặn.

  Bộ tool cũng **không phải 18 tool** của ba bề mặt dispatch, mà là bộ khác hẳn:
  `exec_command`, `apply_patch`, `web.run`, `image_gen`, `multi_tool_use.parallel`, cộng
  ~40 tool `mcp__codex_app.*` (`send_message_to_thread`, `list_threads`, `read_thread`,
  `fork_thread`, `create_worktree`...).

  Kết luận đúng, và nó hẹp hơn nghe tưởng: **sandbox là thuộc tính của lệnh gọi**, và
  crew tự áp nó ở cả hai transport dispatch. Owner gõ tay không đi qua crew nên không
  dính. Điều này **không** biến `--mode app` thành lối thoát — đường dispatch vẫn y cũ.

  Ba phép đo chức năng là kết quả thật. Danh sách tool thì runtime **tự khai**, nên đọc
  nó như lời khai, không như phép đo.
- Bản plan cũ định thêm `[sandbox_workspace_write] network_access = true` vào `config.toml`
  cho "phiên tương tác bị chặn mạng". Tiền đề đó **sai** — phiên tương tác không bị chặn.
  Không thêm dòng đó; nó sẽ cấp quyền mạng cho mọi phiên Codex ở mọi repo trên máy.

#### Tool nào dùng được ở bề mặt nào — đo 2026-09-22, Codex `0.154.0` cả ba

| Phép đo | Crew headless (mặc định) | `exec` **không** cờ sandbox | Crew `--mode app` |
| --- | --- | --- | --- |
| Số tool gọi được | **18** | **18** | **18** |
| Ghi file ngoài repo | ❌ `Operation not permitted` | ✅ `WRITE_OK` | ❌ `Operation not permitted` |
| Trình duyệt (`web.run`) | ✅ | ✅ | ❌ `Browser is not available: iab` |
| Computer Use (chụp màn hình) | ❌ `was not approved` | ✅ **được** | ❌ `was not approved` |

**Không tool nào bị mất — danh sách 18 tool giống hệt nhau ở cả ba.** Worker bị chặn
lúc *dùng*, không phải lúc *thấy*. Nên đừng đi tìm cách "thêm tool cho worker": thứ
duy nhất cần đổi là bậc sandbox.

`--mode app` **không** phải lối thoát: bị sandbox y hệt headless, và trình duyệt còn
hỏng hẳn. Bằng chứng: `tasks/260818-agent-crew-build/reports/260922-1340-tool-parity-3-be-mat.md`.

#### Luật chọn transport theo loại việc

| Việc | Đường | Vì sao |
| --- | --- | --- |
| Đọc/ghi file, Sheet, script, code | **headless**, mặc định | Quyền hẹp nhất đủ dùng, đã nghiệm thu |
| Google Workspace | **headless + `--workspace-cli on`** | Owner chốt 22/09: luôn đi Workspace CLI. **Không có lối tắt qua app** — app cũng bị sandbox nên `gws` không ghi nổi `token_cache.json` |
| Cần trình duyệt / Computer Use / ghi ngoài repo | **headless + `--sandbox-mode danger-full-access`** | Bậc sandbox là thứ duy nhất chặn; app mode không thay thế được |
| Việc cần ngữ cảnh một thread app đang sống | `--mode app` | Xem "Ba ca `app` đáng giá" |

#### Connector Google của OpenAI — **không dùng** (owner chốt 22/09)

Codex có sẵn `gmail@openai-curated`, `google-drive@openai-curated`,
`spreadsheets@openai-primary-runtime`, tất cả `enabled`. **Đừng dùng chúng cho việc
Google Workspace.**

Lý do không phải vì chúng kém: chúng đi **OAuth riêng của Codex**, nằm **ngoài** rào
`gws-ntcong-routing.cjs`. Rào đó chặn `gws` trần và profile cá nhân, nhưng nó chỉ soi
lệnh shell — connector không đi qua shell. Máy này có cả `~/.config/gws-personal`, nên
"gọi nhầm tài khoản mà không ai biết" là kịch bản có thật, không phải lý thuyết.

Ghi ở đây để lần sau không ai "phát hiện" lại rồi bật lên.

#### `--sandbox-mode` — nới quyền, opt-in (thêm 2026-09-22)

| | |
| --- | --- |
| Mặc định | `workspace-write`. Không gõ cờ thì argv **y hệt** trước khi có cờ |
| Nới quyền | `--sandbox-mode danger-full-access` — mở khoá Computer Use, trình duyệt, ghi ngoài repo |
| Giá trị lạ | Bị **từ chối**, không rơi về mặc định |
| App mode | Chỉ từ chối mức nới; mức mặc định vẫn nhận. Job app ghi `sandboxMode: "app-managed"` vì app tự quyết sandbox, adapter không có tiếng nói |
| Worker | **Không được tự nới.** `MWG_CREW_ROLE=worker` + mức nới → từ chối |

Ghi lại ở: manifest (`sandboxMode`, **mọi** đường thoát kể cả job chết), stderr, và
sidecar `*.codex-stream.jsonl`. `crew-collect` gắn cờ `FULL-ACCESS` vào dòng job —
**không** tính vào `violation`: nới quyền là cố ý, nhưng người đọc phải thấy nó khi
chấm mọi thứ còn lại.

Khi nào dùng: việc cần trình duyệt, cần màn hình, hoặc cần ghi ngoài repo. **Không**
dùng để chữa lỗi Workspace CLI — việc đó đã có `--workspace-cli on`, đường riêng đã
nghiệm thu.

Gộp `--workspace-cli on` với mức nới thì worker vừa cầm token vừa ghi được kho
credential — đúng hình dạng sự cố 18/09, và rào hash chỉ **phát hiện** sau chứ không
chặn. **Owner chốt 22/09: không cấm** — một job cần cả trình duyệt lẫn Sheet mà phải
tách làm hai là trả giá quá đắt cho rủi ro chưa xảy ra.

Đổi lại, ràng buộc chuyển vào **brief**: mọi job chạy ngoài sandbox được adapter tự
chèn thêm một dòng ranh giới (chỉ đụng workspace + task folder; không `~/.config/gws/`,
`.env`, secret, token, config ngoài repo). Tự chèn theo bậc sandbox, không trông vào
việc người giao việc nhớ gõ. Antigravity luôn nhận dòng này vì nó luôn chạy
`--dangerously-skip-permissions`. Cảnh báo stderr + `stream.note()` vẫn nêu thẳng cặp cờ.

### Cổng canh kho credential (thêm 2026-09-22)

Hai adapter băm `credentials.enc` và `client_secret.json` trong `~/.config/gws` **trước khi
spawn** và so lại trên mọi đường thoát. Lệch là ghi `credentialTamper` vào job, và
`crew-collect` tính nó vào `violation` → **exit 2**.

| Điểm thiết kế | Vì sao |
| --- | --- |
| Chỉ canh 2 file đó | `token_cache.json` bị ghi đè mỗi lần refresh — canh nó là báo động trên đường lành, và báo động kêu lúc bình thường là báo động bị tắt |
| Băm, không đoán theo mtime | `crew-scope.mjs` đã bác mtime thành văn: 3 job chạy chồng nhau thì cửa sổ thời gian trùng, và kẻ ghi được file cũng `touch -r` được |
| Không quy trách nhiệm cho job nào | Hai file này không bao giờ đổi hợp lệ, nên đổi là **sự cố**, không cần biết ai — đây cũng là lớp duy nhất còn đúng khi `MAX_PARALLEL` = 3 |
| Manifest chỉ ghi tên file + động từ, **không ghi hash** | Manifest nằm trong `reports/` và được commit; một digest của `client_secret.json` trong git là oracle vĩnh viễn để dò đoán, đổi lấy đúng số không lợi ích |
| Phủ **cả Anti**, không riêng Codex | Vụ xoá thật 18/09 xảy ra **ngoài** sandbox — tức đường Anti. Guard chỉ phủ Codex là phủ đúng đường an toàn hơn |

Codex có 3 đường thoát (signal handler, `catch`, thành công) và cả 3 đều chụp lại —
job chết giữa chừng mới là job đáng nghi nhất. **Anti chỉ có 2**: nó không có signal
handler, nên adapter Anti bị kill thì không ghi được gì, kể cả phần credential. Khoảng
trống đó có trước guard này và guard này không thu hẹp nó.

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
   --resume <conversationId>` cho Anti (thêm 2026-09-17) — cả hai chỉ có với thread app.

Ngoài 3 ca này, chọn `app` là đang trả giá quan sát để lấy một thứ chưa nêu được.

### Resume cho Anti app — `--resume <conversationId>` (thêm 2026-09-17)

Trước 17/09, `anti-run.mjs --mode app` chỉ biết `agentapi new-conversation`: mỗi job app
luôn mở một conversation mới, kể cả khi đang tiếp tục đúng việc một conversation trước đó
vừa làm. Ca thật gây ra thay đổi: job lập kế hoạch ảnh AI (`image-ai-generate` Bước 0→4)
dừng ở `COST_GATE`, user duyệt qua chat, và bước tiếp theo (Bước 5 generate +
`image-seo-pipeline`) là **đúng việc của cùng conversation đó** — nó đã đọc bài, đã chọn
archetype, đã tra product ID. Mở conversation mới bắt nó làm lại toàn bộ từ đầu, tốn token
và có nguy cơ đổi kế hoạch đã duyệt.

`agentapi` có sẵn lệnh thứ ba ngoài `new-conversation` và `get-conversation-metadata`:
`send-message [--title=<title>] <recipient_id> <content>` — gửi tiếp một prompt vào đúng
conversation đang có. `anti-run.mjs` giờ dùng nó khi được truyền `--resume`:

```bash
MWG_CREW_ROLE=worker node mwg-agent-crew/scripts/anti-run.mjs \
  --mode app --resume <conversationId> --title "Generate ảnh - {bài}" \
  --prompt-file "$RUN_DIR/brief-anti-4.md" \
  --evidence "$RUN_DIR/worker-anti-4.md" \
  --timeout 30m --workspace "$PWD" \
  --manifest "$PWD/$RUN_DIR/manifest.json" --job 4
```

Bốn điều cần biết trước khi dùng:

- **Transport vẫn ghi là `"app"`** trong manifest, không phải một transport thứ ba. `--resume`
  là cờ trực giao, không phải mode riêng — `assertTransport` vẫn so `--mode app` với
  `job.transport`, không biết gì về resume. Lý do giữ vậy: TRANSPORTS chỉ có 2 giá trị
  (`app`/`headless`), thêm giá trị thứ ba kéo theo sửa `resolveRouting`, `addJob`, và mọi chỗ
  đọc lại field này — trong khi bản chất resume vẫn là "mở một hộp cho user xem", chỉ khác ở
  chỗ hộp đã mở sẵn.
- **`conversationId` lấy từ job trước, không tự đoán.** Đọc field `conversationId` của job đã
  xong trong manifest (`m.jobs.find(j => j.seq === N).conversationId`) — đây là id
  `runApp()` trả về sau `new-conversation`, không phải id do dispatcher đặt tên.
- **Không truyền `--model`. Từ 22/09 đây là lỗi cứng, không còn bị bỏ qua.** `send-message`
  không có tham số model — conversation đã có model từ lúc `new-conversation`. Trước đây cặp
  `--model` + `--resume` chạy tiếp và bỏ qua `--model` lặng lẽ; giờ `resolveResume` từ chối cả
  job. Luật này áp cho **cả 4 bề mặt**, kể cả những bề mặt runtime có nhận `--model` — một luật
  dễ nhớ hơn bốn, và đổi bậc model giữa chừng là lý do để mở phiên mới chứ không phải dùng lại
  phiên cũ. Lưu ý rule "`--model` (anti) là bắt buộc": nó **không** áp cho job resume.
- **Evidence path vẫn phải mới**, đúng rule "hai job không bao giờ nhận cùng evidence path" —
  resume là một **job mới** (seq mới, `addJob` mới) tiếp tục một **conversation cũ**, không phải
  sửa lại job cũ. Job cũ giữ nguyên verdict (`blocked` ở ca COST_GATE) làm bằng chứng cho quyết
  định dừng đúng lúc; job resume ghi bằng chứng cho phần làm tiếp.

Cách poll hoàn thành, cổng evidence, và `judgeJob()` giữ nguyên y hệt `new-conversation` —
`runApp()` chỉ khác ở cách lấy `conversationId` (từ tham số thay vì từ output lệnh), phần còn
lại của vòng đời job không đổi.

### Lịch sử: vì sao có `role`

Tiêu chí cũ hơn nữa dựa vào việc user có thích theo dõi trong app hay không — đó không
phải rule, vì không có cách nào kiểm. Kết quả: 34 job lịch sử chia 10 app / 24 headless
mà không truy được vì sao job nào đi đường nào. `addJob` giờ đòi `role` và ghi cả `role`
lẫn `transport` vào manifest: `role` là **lý do**, `transport` là **hệ quả**. Chính vì
tách ra mà lần đổi mặc định này không làm run cũ thành vô nghĩa — run cũ vẫn đọc được
quyết định của nó dựa trên gì.

Job `worker: claude` có `role` nhưng `transport: null`: không có process nào được bắn,
ghi transport vào đó là ghi một box chat chưa từng mở.

| Transport | Cơ chế | Có stdout? |
| --- | --- | --- |
| `headless` | Anti: `agy -p --output-format json`. Codex: `codex exec` | **Có** — trả về Claude |
| `app` | Anti: `agentapi new-conversation` (hoặc `send-message` khi có `--resume`, xem mục Resume ở trên) → session **hiện trong Antigravity 2.0**; adapter poll bằng file evidence. Codex: `codex-run.mjs --mode app` → companion `task --background` → thread **hiện trong app Codex**, tên `Codex Companion Task: {dòng đầu brief}`; chờ bằng `status --wait`. Cả hai đã kiểm bằng mắt 25/08 | Anti **không**; Codex **có** (`result <job-id>`) |

Hai runtime lệch nhau chỗ stdout — đừng suy từ Anti sang Codex. Cả hai đều lấy **file
evidence** làm phán quyết, stdout chỉ là tiện.

### Đo được về app mode (2026-08-19)

Worker app mode ghi xong report sau 23 giây, nhưng để step `write_to_file` ở status `7`
suốt 8 phút còn lại. Nếu phát hiện "xong" bằng step status thì job đã hoàn thành vẫn bị
coi là đang chạy rồi bị đánh fail. Vì vậy `anti-run.mjs` lấy **file evidence** làm tín
hiệu hoàn thành, step chỉ là dự phòng. Sau khi sửa, cùng job đó chạy 55 giây.

Hệ quả khi dùng app mode:

- Luôn chạy `crew-reconcile.mjs` sau một run có job app. Job app có thể hoàn thành sau
  khi adapter đã bỏ cuộc; evidence trên đĩa mới là sự thật.
- Job app từng dừng hẳn sau 1 tool call mà không ghi gì (conversation 6 step, không có
  error, không có permission blob). Evidence gate bắt được. Đừng giao việc bắt buộc phải
  ra file cho app mode nếu không ai ngồi xem.

### Worker ghi file bằng shell — đo 2026-08-25

Probe Anti headless: nó gọi `write_to_file` → **TOOL_ERROR**
(`artifacts must be in ~/.gemini/antigravity-cli/brain/`, xảy ra **cả khi file nằm trong
workspace**), rồi quay sang `run_command`:

```text
echo "hello-authorship" > probe.txt && echo "line-two" >> probe.txt
```

Hệ quả cho mọi thứ đọc "worker đã ghi file nào":

- Danh sách file runtime tự khai (`touchedFiles`, event `file_change`) là sổ của **tool ghi
  file**. File ghi bằng shell không có trong đó.
- Nên nó xác nhận được, **không** loại trừ được: khai X thì X là của job đó; không khai gì
  thì không suy ra được là không ghi.
- Với Anti thì đây là **thường lệ**, không phải ngoại lệ — `write_to_file` trên máy này đang
  từ chối mọi đường ngoài `brain/`.
- Anti `--output-format json` không trả field nào về file. Muốn có phải đổi sang
  `stream-json` (`step_type: "tool"` + `tool_info.parameters`), nhưng đó là viết lại toàn bộ
  đường parse của `anti-run.mjs` kể cả phép phát hiện silent-fail — chưa làm.

Bằng chứng: `tasks/260825-crew-app-mode-acceptance/data/260825-2150-probe-anti-stream-json.jsonl`.

### `result` của companion — đo 2026-08-25 (bản 1.0.5)

`codex-run.mjs --mode app` giờ gọi `result <job-id>` sau khi job settle. Hình dạng thật:

| Field | Là gì |
| --- | --- |
| `storedJob.result.rawOutput` | Câu trả lời của worker. Đây là cái adapter lưu, ghi ra `{job}.codex-app-reply.md`, manifest trỏ qua `lastMessage` |
| `storedJob.rendered` | Cùng nội dung + footer "Resume in Codex" của companion. Fallback khi `rawOutput` rỗng |
| `storedJob.result.status` | **Exit status thật** (0 trên cả 2 job đo được). Ghi vào `companionExitStatus`, **không** vào `exitCode` — job fail trả gì thì chưa đo được |
| `storedJob.result.touchedFiles` | **Danh sách file runtime tự khai đã ghi**, per-job. Job thật 25/08 trả đúng 1 file khớp evidence path |
| `job.summary` vs `storedJob.summary` | Hai thứ khác nhau: `job.summary` là trích câu trả lời; `storedJob.summary` là dòng đầu brief bị cắt. Cái app hiển thị là `storedJob.summary` |

`touchedFiles` là tín hiệu tác giả mà cổng write-scope hôm nay không có. Nó quy kết bằng
mtime, nên một session khác sửa file trong lúc run là gate báo oan — đúng ca Run A exit 2
ngày 25/08.

Mọi lỗi của `result` đều **không** làm job fail: ghi vào `replyError` rồi đi tiếp. Job đã
ghi evidence hợp lệ thì không được fail vì mất phần ghi chép.

### Ba job app song song — đo 2026-08-25

3 job app cùng lúc (2 Codex `--effort low` + 1 Anti `flash`): 3/3 xong, **0 job mất,
0 job fail**, cổng nghiệm thu exit 0. Tổng 132 giây so với 228 giây khi chạy tuần tự 2
job — song song ăn được thật.

> **Sửa lại con số này ngày 25/08 (chiều), có căn cứ.** Đoạn dưới từng ghi "số app-server
> đi từ 1 lên 2", suy ra từ việc job thứ hai có process companion **detached** (ppid 1).
> Phép đo trực tiếp cho thấy suy luận đó sai: `task-worker` của companion **luôn** có
> ppid 1 ngay từ lúc sinh ra (đo: pid 10778, ppid 1,
> `codex-companion.mjs task-worker --job-id ...`). Đó là cách companion detach job nền,
> **không** phải dấu hiệu có app-server thứ hai. Đo lại với quy chủ theo broker: 2 job app
> chạy song song dùng **chung 1** app-server của broker, ở cả mốc dispatch và mốc settle.
>
> Chưa đo lại đúng hỗn hợp cũ (2 Codex + 1 Anti), nên không kết luận con số cho ca đó.
> Chỉ kết luận: cách đếm cũ không phân biệt được app-server với task-worker detached.

Đường phân nhánh ở `codex.mjs:623-637` có thật, nhưng `broker.log` rỗng nên chưa biết
cơ chế là `BROKER_BUSY` fallback hay mỗi background job vốn tự mở runtime.

### Codex app transport — đo 2026-08-25

Đường vào app của Codex là `codex-companion.mjs` trong plugin `codex-plugin-cc`, gọi
**thẳng**, không qua subagent. Hình dạng đã đo với companion 1.0.5:

| Lệnh | Trả về |
| --- | --- |
| `task --background --json` | `{ jobId, status:"queued", title, summary, logFile }` |
| `status <id> --wait --json` | `{ workspaceRoot, job, waitTimedOut, timeoutMs }` |
| `job.status` | `queued` / `running` / `completed` / `failed` / `cancelled` |
| `job.threadId` | id thread trong app — đã có sẵn lúc job settle, dùng làm `conversationId` |

Khác app mode của Anti ở một chỗ quan trọng: Codex **có tín hiệu hoàn thành thật**
(`--wait` chặn tới khi settle), nên adapter không phải poll file evidence để đoán. Trần
timeout vẫn giữ riêng vì `--wait` cũng treo được nếu broker chết; hết trần thì gọi
`cancel` trước khi báo lỗi.

Ba chỗ đã đo và **không** suy diễn được:

- Field `title` trong JSON luôn là `"Codex Task"`, không có cờ đặt tên — **nhưng app
  hiển thị theo `summary`**: danh sách thread hiện `Codex Companion Task: {dòng đầu brief}`
  (kiểm bằng mắt 25/08). Nên dòng đầu brief phải là title job; đó là thứ duy nhất phân biệt
  các thread trong app. Đừng kết luận từ riêng field `title` như phase 2 từng làm.
- Thread **hiện trong app Codex**, và 2 job Codex song song thì **hiện đủ 2**, không cái
  nào bị nuốt (đo 25/08, run B). Thread cũng lưu trên đĩa ở
  `~/.codex/sessions/.../rollout-*.jsonl` và resume được bằng `codex resume <id>`.
- **Nhưng KHÔNG hiện live.** Đo 25/08 bằng một job sống 224 giây: rollout có trên đĩa sau
  **8 giây**, app vẫn không thấy suốt cả job; phải **tắt app rồi mở lại** mới hiện. Cơ chế
  khớp dữ liệu (suy luận, chưa đo trực tiếp): app làm chủ backend riêng và chỉ đọc lại
  session store lúc khởi động, nên thread do backend khác ghi thì nó không hay.

  Hệ quả vận hành, khác nhau rõ giữa hai runtime:

  | | Anti app | Codex app |
  | --- | --- | --- |
  | Xem tiến trình lúc job chạy | **Được** — session hiện live trong Antigravity 2.0 | **Không** |
  | Mở lại sau khi xong | được | được, nhưng phải restart app; hoặc `codex resume <id>` |
  | Can thiệp giữa chừng | được | không |

  Nên với Codex, `transport: app` mua được **biên bản mở lại được + `conversationId` làm
  provenance**, không mua được **mặt điều khiển**. Đừng chọn `app` cho Codex vì nghĩ sẽ
  ngồi xem được.
- **Cảnh báo cho lần đo sau:** companion `spawn("codex", ["app-server"])`
  (`app-server.mjs:190`) nên process app-server đó *không phải* process của app desktop.
  Từ đó **không** suy ra được thread vắng mặt trong app: app đọc rollout theo yêu cầu, nên
  `lsof` không thấy handle và storage app không chứa thread id. Cả hai đều là bằng chứng
  vắng mặt vô giá trị — 25/08 đã kết luận sai một lần vì chúng. Chỉ mắt người mới trả lời
  được câu này.
- `sessionRuntime` **không** có ở `status <job-id>` (trả `null`). Nó chỉ có ở lệnh
  `setup` (`codex-companion.mjs:208`) — và `setup --json` chỉ mất **0.45-0.52s**, nên gọi
  nó là được, không cần tự suy. Suy từ `broker.json` là **đường dự phòng**, và phải kiểm
  pid: file sống lâu hơn tiến trình, nên "có `endpoint`" một mình sẽ báo `shared` cho một
  runtime đã chết.
- **Broker được dựng bởi chính lệnh dispatch**, không phải có sẵn hay không. Đo 25/08:
  trước job nào thì `direct`; sau job đầu thì broker sống và mọi job sau là `shared`.
  Đừng đo trạng thái broker khi chưa chạy job rồi kết luận máy không có broker.
  Bổ sung 25/08 (tối): reading còn **tự đổi** mà mình không làm gì — `direct` lúc 21:47,
  `shared` lúc 22:05, không dispatch gì ở giữa (broker của session khác lên). Nên một
  reading đơn lẻ không mô tả được cái máy lúc job thật sự chạy; xem mục dưới.
- `--write` là **bắt buộc**, không theo `role`: mọi job crew đều phải tự ghi file
  evidence, nên app mode read-only thì không job nào qua được cổng evidence.

### Runtime Codex ghi ở hai mốc — đo 2026-08-25

Manifest có ba field khác nhau, đừng lẫn: `role` là **lý do** chọn, `transport` là **lựa
chọn**, `codexRuntime` là **máy đã làm gì với lựa chọn đó**. Field thứ ba chỉ để đọc lại,
không có gì route theo nó.

Ghi **hai** mốc chứ không một, vì reading không ổn định: `direct` lúc 21:47 → `shared` lúc
22:05, không dispatch gì ở giữa. `atDispatch` do job **đầu tiên** bắn ghi (ghi một lần rồi
khoá), `atSettle` do job **cuối cùng** lắng ghi (ghi đè mỗi lần) — nhờ vậy các adapter chạy
song song không cần phối hợp gì mà ngữ nghĩa vẫn đúng.

Chỉ app mode ghi field này. Headless là `codex exec`, process riêng, không qua broker —
"chung hay riêng runtime" không phải câu hỏi tồn tại với nó, và lấy reading trong lúc chạy
headless sẽ gán broker của session khác cho job đó.

**Đếm app-server phải có quy chủ.** Đo 25/08, cùng một lúc có 5 process khớp mẫu và chỉ 3
là của ta:

| pid | chủ |
| --- | --- |
| 18224 | ChatGPT.app — không liên quan crew |
| 55831 | extension VS Code — không liên quan crew |
| 65720 | broker của plugin (`app-server-broker.mjs`) — **không phải** app-server |
| 65736 → 65737 | app-server của ta: node wrapper + native child = **một** server |

Nên một con số đếm trần là con số đổi khi user mở VS Code. Ba phân biệt bắt buộc: broker
không phải server; hai process là một server; server ngoài báo riêng, không cộng vào.

### Dispatch app cùng lúc bị đua — đo 2026-08-25

Bắn 2 job app **cùng lúc** (không nghỉ giữa hai lệnh): cả hai chết ngay ~15s, hai kiểu
khác nhau, và hai job id chia chung tiền tố thời gian `task-mt8to8sy-`:

| job | companion trả về |
| --- | --- |
| 1 | `status --wait` trả job **không có field `status`** (chỉ `phase: "starting"`) → adapter coi là vỡ giao thức |
| 2 | `status --wait` báo **`No job found`** cho job vừa queue thành công |

Bắn lại **lệch 5 giây**: 2/2 `done`, id khác nhau ở phần thời gian, cổng exit 0. Nên
nguyên nhân khu trú được ở **dispatch đồng thời**, không phải ở `status` nói chung.

Hai điều quan trọng hơn con số:

- **Worker vẫn làm xong việc.** Cả hai job "chết" đều đã ghi evidence đầy đủ với
  `Status: DONE`. `crew-reconcile.mjs` sửa cả hai về `done` và ghi lại chỗ bất đồng. Đây là
  bằng chứng sống cho doctrine: evidence trên đĩa thắng phán quyết runtime.
- **Job 1 sau đó companion không còn nhớ id** (`No job found` khi tra `result`). Đó đúng
  lớp `unknown_to_runtime` mà reconcile mới biết phân loại — nhưng vì có evidence nên đường
  evidence xử lý trước, không bị gọi là orphan.

**Đã khoan nhượng ở adapter (25/08).** `codex-run.mjs` chịu đúng hai hình dạng trên trong
`SETTLE_RACE_WINDOW_MS` = 45s kể từ lần hỏi đầu, hỏi lại mỗi 3s, rồi mới bỏ. Trần tính theo
**đồng hồ** chứ không theo số lần — vì `status --wait` chặn tới khi job settle, nên đếm lần
sẽ biến một lần chờ 8 phút thành ba. Một lệnh đã thật sự chờ thì đã quá cửa sổ, không bị hỏi
lại.

Chỉ hai hình dạng đó được khoan nhượng. Mọi lỗi khác vẫn chết ngay lần đầu: retry rộng tay
sẽ biến một job chết thật thành một job chết chậm, mà adapter này tồn tại chính vì một job
chết từng không ai hay trong 20 phút.

Số lần hỏi lại được **ghi vào manifest** (`settleRetries`, `settleRaceWhy`), không nuốt: một
cuộc đua được khoan nhượng mà không ai đo được tần suất là cuộc đua không ai sửa. Gốc vẫn ở
job store của companion, không ở đây.

Vận hành: vẫn nên **giãn các lệnh dispatch app ra** ~5s. Khoan nhượng làm job không chết
oan, nhưng mỗi lần hỏi lại vẫn tốn một vòng gọi process.

### Orphan: reconcile được quyền quyết cái gì — đo 2026-08-25

`crew-reconcile.mjs` trước đây từ chối phán bất cứ job nào không có evidence, lý do viết
thẳng trong file: "chỉ dispatcher biết runtime còn sống không". Điều đó đúng khi đầu vào
chỉ có manifest và đĩa. Vì `companionJobId` giờ được ghi **ngay lúc dispatch** (trước đây
chỉ ghi trên đường trả về — nên đúng ca cần nó thì không có), runtime hỏi được trực tiếp.

Bảng phán quyết, cho job còn ở trạng thái sổ sách và không có evidence:

| `result <id>` trả về | kết luận |
| --- | --- |
| exit ≠ 0, `No job found` | orphan `unknown_to_runtime` |
| pid **còn sống**, bất kể status là gì | vẫn chờ, **không** động vào |
| `queued`/`running` + pid chết hoặc không có | orphan `active_without_process` |
| `completed`/`failed`/`cancelled` + không pid | orphan `settled_without_evidence` |
| status **rỗng hoặc lạ** (vd `starting`) | vẫn chờ — chưa nhận ra thì chưa được kết |
| probe lỗi, không trả lời được | vẫn chờ — im lặng không phải là chết |

Hai dòng cuối là **sửa ngày 25/08**, sau khi worker Codex rà lại hàm này. Bảng cũ coi mọi
status ngoài `queued`/`running` là đã kết thúc, kể cả khi payload **không có** field `status`.
Đó không phải giả thuyết: đúng cái payload thiếu `status` này đã đo được trong ca đua dispatch
đêm 25/08. Hậu quả là giết một job đang sống — hậu quả nặng nhất hàm này có thể gây ra. Giờ
chỉ ba từ trong allowlist `COMPANION_TERMINAL` mới được quyền kết, và pid sống thắng mọi status.

Ba phép đo làm bảng này an toàn:

- Job **đang chạy** có pid thật; job **đã xong** có `pid: null`. Nếu job chạy cũng null thì
  quy tắc "pid chết = orphan" sẽ giết mọi job sống.
- `result <id>` **vẫn tra được** job của 7 giờ trước, trong khi `status --all` liệt kê 0
  job. Nên "không có trong danh sách" không chứng minh gì; `result` là oracle duy nhất.
- id không tồn tại thì exit 1 và in **text thường**, không phải JSON → phát hiện bằng exit
  code, không phải bằng cách đọc chuỗi lỗi.

`completed` mà không có evidence **không** được tính là đậu: chạy xong mà không ghi gì đúng
là kiểu thất bại im lặng mà harness này tồn tại để bắt. Chỉ evidence cho đậu.

Hủy job ở runtime là **tự chọn**, mặc định tắt: phát hiện là một phép đọc, hủy là thay đổi
thứ nằm ngoài repo. Muốn hủy thì `crew-reconcile.mjs <manifest> --cancel-orphans`.

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
