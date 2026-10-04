# Quyền hạn của worker: Workspace CLI, sandbox, credential

Đọc khi: job Codex cần Google Workspace, trình duyệt, Computer Use, hoặc ghi ngoài repo;
job ra `401`; hoặc gate đỏ `KHO CREDENTIAL BỊ ĐỔI`. Bảng tra nhanh ở lõi `SKILL.md`
Bước 6. Nhật ký đo nằm ở `mwg-agent-crew/docs/transport-measurements.md`.

## Job cần Google Workspace CLI — `--workspace-cli on` (thêm 2026-09-19)

**Job cần Google Workspace CLI thì phải thêm `--workspace-cli on`.** Thiếu cờ này là
nguyên nhân của `401` → `BLOCKED`, và worker **không được** tự vá:

```bash
node mwg-agent-crew/scripts/codex-run.mjs \
  --mode headless --effort medium --workspace-cli on \
  --prompt-file "$RUN_DIR/brief-codex-2.md" \
  --evidence "$RUN_DIR/worker-codex-2.md" \
  --timeout 15m --workspace "$PWD" \
  --manifest "$PWD/$RUN_DIR/manifest.json" --job 2
```

Vì sao phải bật tay: `codex exec` chạy dưới Seatbelt `workspace-write`, cấm ghi ngoài
workspace. `gws` ghi đè `~/.config/gws/token_cache.json` mỗi lần refresh — nên token còn
hạn thì job chạy ngon, token hết hạn thì `401`. Đó là lý do lỗi trông "lúc được lúc
không". Cờ này làm dispatcher mint access token **ngoài** sandbox rồi bơm qua env, worker
không ghi vào kho credential lần nào.

**Triệu chứng → nguyên nhân, để khỏi debug lại từ đầu:**

| Thấy gì | Nghĩa là | Làm gì |
| --- | --- | --- |
| `401 authError` + `Operation not permitted` tại `~/.config/gws` | Job thiếu `--workspace-cli on`, token cache hết hạn, sandbox chặn ghi | Thêm cờ rồi chạy lại |
| `401` mà job **đã có** cờ | Refresh token bị thu hồi, hoặc kho credential hỏng | Owner phải `auth login` lại — worker không tự vá được |
| Cổng đỏ `KHO CREDENTIAL BỊ ĐỔI` | `credentials.enc` hoặc `client_secret.json` đã đổi trong lúc job chạy | **Sự cố.** Dừng, kiểm kho, đọc `worker-brief.md` mục Ranh giới trước khi chạy tiếp |

Không bao giờ để worker tự xử `401` bằng đường vòng: đường vòng duy nhất nó nghĩ ra
(`GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file`) đã **xoá thật** kho credential của owner
ngày 18/09. Biến đó giờ bị adapter gỡ khỏi env, và kho bị canh bằng hash.

**Mặc định `off`, và giữ nguyên vậy.** Token đọc được **toàn bộ** Workspace của owner —
mail, Drive, Sheets. Job chỉ sửa script thì không có lý do cầm. Bật cho mọi job là đổi
một lỗi 401 lấy một bề mặt lộ dữ liệu.

Hai giới hạn đã đo, không phải suy đoán:

- **App mode không dùng được cờ này.** Broker `codex app-server` được tái dùng giữa các
  phiên nên env bơm lúc dispatch không tới được nó. Adapter **từ chối thẳng**, không âm
  thầm chạy tiếp. Job cần Workspace CLI → dispatch `--mode headless`.
- **Anti không cần cờ.** `anti-run.mjs` không truyền cờ sandbox nào nên Antigravity chạy
  ngoài Seatbelt, refresh token bình thường. Chỉ Codex dính.

Đo 18/09: token sống 3599s, grant **không** rotate refresh token. Trần run là 30 phút
(`MAX_TIMEOUT_MS`), nằm gọn trong giờ đó, nên mint **mỗi job một lần** và không có xử lý
hết hạn giữa chừng. Ba job song song cũng không đua nhau vì không job nào ghi cache chung.

**Config dir giữ mặc định.** Đo 19/09: cache discovery ghi hỏng **không** chí mạng —
  CLI fetch qua mạng rồi gọi API bình thường, exit 0. Khác với ca 18/09 (config dir rỗng
  và chỉ đọc, CLI phải **tạo** thư mục cache — ca đó mới chết).

## Sandbox là cờ của adapter, không phải của Codex (đo 2026-09-22)

Chỉ **crew headless** bị sandbox. Terminal gõ tay và **app Codex đều không**, nên cả hai
dùng Workspace CLI bình thường — không cần wrapper, không cần sửa `config.toml`.

Nguồn của sandbox là đúng một dòng trong `codex-run.mjs:buildArgs` (từ 22/09 là
biến, mặc định vẫn y nguyên giá trị dưới đây — xem mục `--sandbox-mode` bên dưới):

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

Bản plan cũ định thêm `[sandbox_workspace_write] network_access = true` vào `config.toml`
  cho "phiên tương tác bị chặn mạng". Tiền đề đó **sai** — phiên tương tác không bị chặn.
  Không thêm dòng đó; nó sẽ cấp quyền mạng cho mọi phiên Codex ở mọi repo trên máy.

### Tool nào dùng được ở bề mặt nào — đo 2026-09-22, Codex `0.154.0` cả ba

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

## Job cần trình duyệt / Computer Use — `--sandbox-mode danger-full-access`

**Worker không thiếu tool. Nó bị cấm dùng tool.** Đo 22/09: cả ba bề mặt Codex thấy
**đúng 18 tool giống hệt nhau**, Computer Use nằm trong đó. Thứ quyết định chúng có làm
được gì không là bậc sandbox.

| Bề mặt | Ghi ngoài repo | Trình duyệt | Computer Use |
| --- | --- | --- | --- |
| headless mặc định | ❌ | ✅ | ❌ |
| headless + `--sandbox-mode danger-full-access` | ✅ | ✅ | ✅ |
| `--mode app` | ❌ | ❌ | ❌ |

```bash
node mwg-agent-crew/scripts/codex-run.mjs \
  --mode headless --effort medium --sandbox-mode danger-full-access \
  --prompt-file "$RUN/brief-codex-1.md" ...
```

**Mặc định `workspace-write`, và giữ nguyên vậy.** Chỉ gõ cờ khi việc **thật sự** cần
trình duyệt, màn hình, hoặc ghi ngoài repo.

**Đừng dùng cờ này để chữa lỗi Workspace CLI.** Việc đó đã có `--workspace-cli on`,
đường riêng đã nghiệm thu. Gộp hai cờ thì worker vừa cầm token vừa ghi được kho
credential — đúng hình dạng sự cố 18/09, và rào hash chỉ **phát hiện sau** chứ không
chặn. **Owner chốt 22/09: không cấm** — nhưng phải có lý do.

Bốn điều adapter tự lo, khỏi nhớ:

- **Brief tự có thêm dòng ranh giới** khi job chạy ngoài sandbox: chỉ đụng workspace +
  task folder, không `~/.config/gws/`, `.env`, secret, token, config ngoài repo. Không
  cần gõ tay. Antigravity luôn nhận dòng này.
- Giá trị lạ bị **từ chối**, không âm thầm rơi về mặc định.
- `--mode app` chỉ nhận mức mặc định; mức nới bị từ chối vì app tự sandbox job dispatch.
- Worker **không tự nới được** — `MWG_CREW_ROLE=worker` gặp mức nới là bị chặn.

Dấu vết để lại: `sandboxMode` trong manifest (**cả khi job chết**), cảnh báo ở stderr và
trong sidecar `*.codex-stream.jsonl`, và cờ `FULL-ACCESS` trên dòng job của `crew-collect`.
Cờ đó **không** làm cổng đỏ — nới quyền là cố ý, nhưng người chấm phải nhìn thấy nó.

### `--sandbox-mode` — nới quyền, opt-in (thêm 2026-09-22)

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

Gộp `--workspace-cli on` với mức nới thì worker vừa cầm token vừa ghi được kho
credential — đúng hình dạng sự cố 18/09, và rào hash chỉ **phát hiện** sau chứ không
chặn. **Owner chốt 22/09: không cấm** — một job cần cả trình duyệt lẫn Sheet mà phải
tách làm hai là trả giá quá đắt cho rủi ro chưa xảy ra.

Đổi lại, ràng buộc chuyển vào **brief**: mọi job chạy ngoài sandbox được adapter tự
chèn thêm một dòng ranh giới (chỉ đụng workspace + task folder; không `~/.config/gws/`,
`.env`, secret, token, config ngoài repo). Tự chèn theo bậc sandbox, không trông vào
việc người giao việc nhớ gõ. Antigravity luôn nhận dòng này vì nó luôn chạy
`--dangerously-skip-permissions`. Cảnh báo stderr + `stream.note()` vẫn nêu thẳng cặp cờ.

## Connector có sẵn của worker: đừng dùng mặc định — ĐIỀN VÀO

Worker thường được nhà cung cấp bật sẵn connector (mail, drive, spreadsheet...). Chúng
đi OAuth **riêng của worker**, nằm ngoài mọi rào định tuyến tài khoản mà workspace bạn
dựng. Máy nào có nhiều tài khoản đăng nhập — công ty và cá nhân — thì gọi nhầm tài khoản
là kịch bản có thật, không phải giả định.

Rule mặc định: **worker không dùng connector sẵn có để chạm dữ liệu thật.** Muốn chạm
thì đi qua đúng CLI/credential mà workspace bạn đã định tuyến.

`ĐIỀN VÀO`: liệt kê connector nào bị cấm ở workspace bạn, và đường thay thế là gì.
Adapter Codex có cờ `--workspace-cli on` để mint credential **ngoài** sandbox rồi bơm
qua env — dùng nó nếu workspace bạn đi theo hướng đó.

### Connector Google của OpenAI — **không dùng** (owner chốt 22/09)

Codex có sẵn `gmail@openai-curated`, `google-drive@openai-curated`,
`spreadsheets@openai-primary-runtime`, tất cả `enabled`. **Đừng dùng chúng cho việc
Google Workspace.**

Lý do không phải vì chúng kém: chúng đi **OAuth riêng của Codex**, nằm **ngoài** mọi
rào định tuyến tài khoản mà workspace bạn dựng. Rào kiểu đó thường soi lệnh shell —
mà connector không đi qua shell. Máy nào có nhiều tài khoản cùng đăng nhập (công ty và
cá nhân) thì "gọi nhầm tài khoản mà không ai biết" là kịch bản có thật, không phải lý
thuyết.

Ghi ở đây để lần sau không ai "phát hiện" lại rồi bật lên.

## Cổng canh kho credential (thêm 2026-09-22)

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
job chết giữa chừng mới là job đáng nghi nhất. Anti app cũng có 3 từ 03/10 (thêm handler
SIGTERM/SIGINT). **Anti headless vẫn chỉ có 2**: nó đợi `agy` trong `spawnSync` nên signal
không tới được handler nào; adapter Anti headless bị kill thì không ghi được gì, kể cả phần
credential.
