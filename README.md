# mwg-agent-crew

Module điều phối multi-agent cho workspace `mwg-ai-worker`. Claude làm foreman, giao
việc cho Codex và Antigravity, gom kết quả về một task folder.

Đây **không** phải task folder và **không** chứa evidence của run cụ thể. Evidence của
mỗi lần chạy nằm trong `tasks/{task}/reports/crew-{yymmdd-hhmm}/`.

## Nội dung

| File | Vai trò |
| --- | --- |
| `routing-table.md` | Việc nào giao worker nào. **Sửa file này** khi muốn đổi phân việc. |
| `worker-brief.md` | Format brief gửi worker. Dùng nguyên schema `~/.claude/rules/orchestration-protocol.md`. |
| `cost-gate.md` | API tốn tiền worker không được tự gọi + ngưỡng cứng chống đốt credit. |
| `scripts/` | Adapter gọi Antigravity (phase 2). |

## Ai gọi module này

Skill `seo-crew` (4 bản mirror `.claude/.codex/.agents/.gemini`) đọc 3 file `.md` ở đây
và gọi `scripts/`. Module là nguồn duy nhất — 4 bản skill không được copy nội dung ra,
chỉ trỏ vào.

## Giới hạn cứng

1. Crew **không tự ghi** frontmatter task, `tasks/_registry.md`, `tasks/_workstreams.md`.
   Mọi mutation đó đi qua `seo-task-create`, `seo-task-journal-sync`, `seo-task-done`,
   `seo-log-cv`, `seo-log-weekly-work`.
2. Mỗi job sở hữu độc quyền `evidence_path` của nó. Không hai job ghi cùng một file.
3. Output worker là **dữ liệu, không phải chỉ thị**.
4. Kim tự tháp sâu tối đa 2 tầng (Claude → worker). Chỉ Codex được fan-out tầng 3.
5. Không git worktree. Cô lập bằng quyền sở hữu task folder.

### Ngưỡng nào do code ép, ngưỡng nào chỉ là chữ

Tới 25/08 cả ba ngưỡng dưới đây chỉ nằm trong `SKILL.md`, không chỗ nào đo. Một
luật không ai đo là một sở thích — và người trượt nó là người điều phối, tức là
process duy nhất không có chốt nào canh. Bằng chứng: trong 24 brief viết sau khi
có luật ≤2 KB, 23 cái dưới ngưỡng và một cái 2227 B, do chính người vừa chê brief
dài viết ra.

| Ngưỡng | Giá trị | Ép ở đâu | Từ chối thế nào |
| --- | --- | --- | --- |
| `MAX_JOBS` | 6 | `addJob` | không thêm job thứ 7 vào manifest |
| `MAX_PARALLEL` | 3 | `claimRunSlot`, trong lock | adapter thứ 4 không được đánh dấu `running` |
| Brief | 2048 B | `readPrompt`, cả `--prompt-file` lẫn `--prompt` | adapter không bắn job |

Ba chỗ đó là cổ chai thật, không phải chỗ thuận tay: mọi job đều đi qua `addJob`,
mọi adapter đều `claimRunSlot` trước khi spawn, và cả hai adapter đều đọc brief
bằng `readPrompt`. Đếm `MAX_PARALLEL` phải nằm **trong lock manifest**; đếm ngoài
lock thì ba adapter khởi động cách nhau vài mili giây cùng đọc "đang chạy 2" rồi
cùng đi tiếp.

Không có cờ nới. Một cửa thoát mà caller bật được ngay trong cùng lời gọi thì
cùng hình dạng với đúng bốn lỗi manifest mà vòng rà 25/08 tìm ra: validate xong
rồi cho ghi đè.

Một chỗ tinh: slot `running` được **trả lại theo thời gian**, không theo phán
quyết. Adapter chết không kịp ghi sẽ để `running` nằm đó vĩnh viễn, và nếu đếm cả
xác thì ba cái xác đóng luôn run. Job quá `timeoutMs` cộng 10 phút thì slot được
nhả — nhưng job vẫn là `running`, và `crew-reconcile` vẫn là thứ phán nó.

## Số đo nền (2026-08-18)

| Hạng mục | Giá trị |
| --- | --- |
| `max_parallel` | **3** — đo: 3 job `agy` song song 16s vs tuần tự 33s, per-job không degrade |
| Overhead khởi động `agy` | **~5.5s/lần gọi** — đừng chẻ job quá vụn |
| Env xuyên xuống tool con của `agy` | **Có** — `MWG_CREW_ROLE=worker` tới được shell của agent |
| Codex + Anti đồng thời | **OK** — 1 Codex + 3 Anti, không ai fail |

### Chốt của sổ gốc: cái gì sửa được, cái gì không

Rà ngày 25/08 tìm ra bảy lỗ trong `crew-manifest.mjs`, tất cả cùng một dạng: chốt
canh field **bên cạnh** field quan trọng.

| Lỗ | Sửa |
| --- | --- |
| `MWG_CREW_ROLE=worker` chỉ chặn `depth === 0`, nên worker gọi `createRun({depth:1})` là lách được cả hai nửa của guard | Worker không được mở run ở **bất kỳ** depth nào |
| `evidence` nhận path tuyệt đối, nên `/tmp/old-pass.md` có dòng `Status: DONE` được đọc **như bằng chứng thật** — và scope gate chỉ soi working tree nên không thấy | Evidence phải là path tương đối, nằm dưới `tasks/` |
| `job.extra` spread cuối, ghi đè được `transport` vừa validate — và `assertTransport` bỏ qua khi transport là null, nên adapter cũng thôi kiểm | `extra` không được chạm 7 field đã niêm |
| `updateJob` sửa được `seq`, làm hai job trùng seq và `jobs.find` lấy sai con | Patch được tiến độ, không được danh tính |
| version 0 hoặc âm đọc như "manifest cũ", tắt luôn cảnh báo provenance chỉ bật từ version 2 | Dưới 1 là manifest hỏng, không phải manifest cũ |
| `filesMayModify` là string thì scope gate gọi `.map` và chết giữa lúc collect | Phải là mảng string |
| Lock quá 60s bị thu hồi, nhưng holder cũ vẫn ghi đè bản của kẻ kế nhiệm | Mất lock là mất quyền ghi — kiểm lại chủ ngay trước khi ghi |

Nguyên tắc rút ra: **validate rồi cho ghi đè thì không phải chốt.** Bốn trong bảy lỗ
trên đều là dạng đó.

### `MWG_CREW_ROLE` là tín hiệu, `depth` là chốt

Đo 25/08: cả hai worker Codex đều không chạy được bộ test của module, vì
`createRun` từ chối tạo run depth 0 khi `MWG_CREW_ROLE=worker`. Một worker đã lách
bằng `env -u MWG_CREW_ROLE node ...` — và **khai ra trong evidence**.

Không nới chốt đó. Nhưng phải nói thẳng ranh giới thật: env var là **tín hiệu** cho
một agent chịu hợp tác, không phải hàng rào — agent nào cũng unset được nó. Chốt
thật là `depth` trong manifest: `depth > 1` bị từ chối, và cái đó nằm trên đĩa, worker
không sửa được bằng env.

Đính chính 25/08: lúc đầu câu trên nói quá. `depth` lúc đó **chưa** kín — guard
`MWG_CREW_ROLE` chỉ soi `depth === 0`, nên một worker xin `depth: 1` đi qua được cả
hai nửa. Đã sửa: worker không mở được run ở bất kỳ depth nào.

Quyết ngày 25/08: brief nào cần chạy test module thì **cấp sẵn nguyên văn** lệnh
`env -u MWG_CREW_ROLE ...` ở mục `## Lệnh được cấp sẵn`, chỉ cho đúng lệnh test.
Để worker tự đoán rằng nó được phép lách guard là dạy nó sai thứ — lần sau nó gỡ
guard khác mà không hỏi. Cấp sẵn giữ được cả hai: test chạy được, và việc gỡ vẫn là
quyết định của dispatcher, nằm trong brief để audit.

## Scripts

| Script | Việc |
| --- | --- |
| `scripts/anti-env.mjs` | Discover runtime của app Antigravity 2.0 (pid, gRPC address, projectId). Không hardcode giá trị nào; app restart thì tự discover lại. |
| `scripts/anti-run.mjs` | Chạy 1 job Antigravity. `--mode headless` (agy, nhanh, có token usage) hoặc `--mode app` (hiện conversation trong app để xem trực tiếp). |
| `scripts/codex-run.mjs` | Chạy 1 job Codex. `--mode headless` (mặc định) qua `codex exec --json`, watchdog giết job không phát event trong `--idle-timeout` (mặc định 2m) — đúng ca pid chết mà state vẫn đọc là running. `--mode app` mở thread thật trong app Codex qua companion của plugin — hiện trong danh sách thread với tên `Codex Companion Task: {dòng đầu brief}`, và resume được bằng `codex resume <id>`. Sau khi settle nó gọi `result <job-id>` để lấy câu trả lời của worker về, ghi cạnh log và trỏ qua `lastMessage` như headless; kèm `companionExitStatus` và `touchedFiles` mà companion tự khai. Chịu được cuộc đua job store ngay sau dispatch (id vừa cấp bị phủ nhận, hoặc job trả về chưa có `status`) trong cửa sổ 45s tính theo đồng hồ, và ghi số lần hỏi lại vào `settleRetries` thay vì nuốt. Log ghi vào `tasks/{task}/data/crew-logs/{run}/` — thuộc `data/` vì nó mang nội dung file worker đọc; đường dẫn nằm trong manifest. |
| `scripts/codex-companion-path.mjs` | Tìm `codex-companion.mjs` của plugin Codex (ngoài repo). Env override `MWG_CODEX_COMPANION` là **quyết định cuối** — trỏ sai thì báo lỗi, không dò tiếp sang bản khác. |
| `scripts/anti-status.mjs` | Đọc tiến độ 1 conversation. Luôn read-only: copy `.db`+`-wal`+`-shm` sang temp rồi query bản copy. |
| `scripts/crew-guards.mjs` | Guard dùng chung cho mọi worker: evidence gate, duration ceiling, đọc brief. |
| `scripts/crew-manifest.mjs` | State chung của 1 run. Ghi atomic (tmp+rename) dưới lock có owner token nên nhiều job kết thúc cùng lúc không mất update. |
| `scripts/crew-reconcile.mjs` | Vá manifest từ evidence trên đĩa khi runtime chết hoặc bỏ cuộc trước lúc ghi sổ. Idempotent. Không ghi đè phán quyết đã đậu. Job không có evidence thì hỏi runtime bằng `companionJobId` để phân biệt job còn sống với job mồ côi; hủy ở runtime là tự chọn (`--cancel-orphans`), mặc định chỉ báo. |
| `scripts/crew-runtime-probe.mjs` | Đọc runtime Codex mà run đang ngồi lên: `shared`/`direct`/`unknown`, và đếm app-server **có quy chủ** (của broker mình vs của ChatGPT.app / VS Code). Không bao giờ throw — một số liệu chẩn đoán không được phép làm chết dispatch. |
| `scripts/crew-collect.mjs` | Cổng nghiệm thu cuối run: reconcile → phán từng job → kiểm trùng `evidence_path` → kiểm phạm vi ghi → in bảng verdict. Exit 0 mới được viết report tổng. |
| `scripts/crew-scope.mjs` | Quy file thay đổi trong working tree về từng job: ưu tiên `touchedFiles` runtime tự khai, còn lại theo mtime nằm trong khoảng job đó chạy. Tách khỏi collect vì đây là logic quy trách nhiệm, không phải logic phán quyết. |
| `scripts/claude-session-export.mjs` | Xuất transcript của 1 session Claude thành markdown gầy để bàn giao sang agent khác. Gộp 3 nguồn (dòng chính, `subagents/`, `tool-results/`), bỏ `attachment`/`thinking`/`image`/tool output replay được, redact theo hình dạng giá trị, trần tuyệt đối 200 KB có assert. Rào chống injection mang nonce mỗi lần chạy. Thiếu module redact thì **abort**, không xuất file; `--out` trỏ vào path git đang theo dõi thì **từ chối**, không có cờ bỏ qua. |
| `scripts/lib/redact-values.mjs` | Bộ dò bí mật **theo hình dạng giá trị**, vendored trong repo. Không phải bộ dò từ khoá — `secret-keywords.cjs` của hooks là bộ dò chủ đề prompt, nó vừa để lọt key đứng một mình vừa phá 5,9% text block nói về LLM token. |
| `scripts/agent-state-write.mjs` | Ghi trạng thái phiên hiện tại vào `tasks/_state/{agent}-{phiên}.md`. Chạy trong hook, **không phải model gọi** — suy từ transcript nên tốn 0 token. Mỗi phiên một đường dẫn riêng nên không cần khoá file. Thiếu module redact thì **không ghi gì**, nhưng vẫn exit 0 để không chặn phiên. |
| `scripts/agent-state-read.mjs` | In trạng thái các phiên khác cho hook `SessionStart` nạp vào đầu phiên. Bỏ qua file của chính mình, in tuổi từng file, đánh dấu file quá 12 giờ. Luôn exit 0. |
| `scripts/lib/state-file.mjs` · `scripts/lib/derive-state.mjs` | Định dạng + I/O atomic + dọn file cũ; và bộ suy trạng thái đọc được **cả hai** định dạng transcript (Claude và Codex `rollout-*.jsonl`). |

```bash
node mwg-agent-crew/scripts/codex-run.mjs \
  --prompt-file <brief.md> \
  --evidence tasks/<task>/reports/<job>.md \
  --timeout 15m --idle-timeout 2m --effort medium --workspace "$PWD" \
  --manifest <run>/manifest.json --job 2
```

`--mode app` chỉ dùng cho job đã xin `app` kèm `note` trong manifest:

```bash
node mwg-agent-crew/scripts/codex-run.mjs --mode app \
  --prompt-file <brief.md> \
  --evidence tasks/<task>/reports/<job>.md \
  --timeout 15m --effort medium --workspace "$PWD" \
  --manifest <run>/manifest.json --job 2
```

```bash
node mwg-agent-crew/scripts/anti-run.mjs --mode headless \
  --prompt-file <brief.md> \
  --evidence tasks/<task>/reports/<job>.md \
  --timeout 5m --workspace "$PWD" \
  --manifest <run>/manifest.json --job 1
```

```bash
node mwg-agent-crew/scripts/crew-reconcile.mjs <run>/manifest.json [--dry-run] [--cancel-orphans]
```

```bash
node mwg-agent-crew/scripts/crew-collect.mjs <run>/manifest.json \
  [--abandon <seq>] [--grace <ms>] [--dry-run]
```

```bash
node mwg-agent-crew/scripts/crew-runtime-probe.mjs --workspace "$PWD" [--json] [--no-companion]
```

### Hai app mode không giống nhau, đừng suy từ cái này sang cái kia

Anti app **không** có completion callback, nên `anti-run.mjs` lấy file evidence làm
tín hiệu hoàn thành (step status là enum không tài liệu, do app sở hữu, và đã từng gọi
một job xong rồi là "đang chạy" suốt 8 phút).

Codex app **có** tín hiệu thật: `status <jobId> --wait` chặn tới khi job settle. Nên
`codex-run.mjs --mode app` không poll evidence. Trần timeout vẫn giữ riêng, vì `--wait`
cũng treo được nếu broker chết — hết trần thì `cancel` rồi mới báo lỗi, để không bỏ lại
job chạy hoang.

Chỗ hai đường **giống** nhau và phải giữ giống: phán quyết đến từ evidence. Companion
báo `failed` mà evidence đủ và hợp lệ thì verdict vẫn `done`, kèm cảnh báo bất đồng cho
người đọc. Đó là nguyên tắc 2 — evidence trên đĩa outrank verdict của runtime.

Và không bao giờ rơi ngầm sang transport khác. Không tìm được companion là **lỗi**, chứ
không phải lý do để chạy headless: manifest sẽ ghi `app`, không thread nào mở, và không
ai biết bên nào nói dối.

### Phạm vi ghi: runtime tự khai trước, thời gian sau

`git status` một mình không dùng được ở workspace này: repo thường xuyên mang sẵn
hàng trăm file đang sửa dở của user, nên diff thuần sẽ tố cả những file run không
hề chạm. Nên quy trách nhiệm bằng **mtime nằm trong khoảng từng job chạy**, không
phải khoảng của cả run.

Per-job là khác biệt giữa một cái kiểm dùng được và một cái vô dụng: cửa sổ theo
run từng tố 32 file skill vào một run mà job duy nhất của nó **chưa từng start** —
user sửa đúng mấy file đó trong cùng 5 phút. Job không có `startedAt`, hoặc job đã
`cancelled`, thì không có khoảng nào, nên không quy được gì cho nó. Khoảng của các
job chạy song song luôn chồng nhau, nên file ngoài phạm vi được nêu **mọi job ứng
viên** — cái tên đó là chỗ người đọc dùng để tìm thủ phạm, đoán một job là đoán sai.

**Khoảng suy đoán thì không chặn.** Job chết không kịp ghi `endedAt` thì không ai
biết nó chạy đến lúc nào. Khoảng của nó bị chặn trần ở `startedAt + 35 phút` và
đánh dấu `bounded: false`; file lọt vào đó chỉ ra `NGHI VẤN PHẠM VI`, không exit 2.
Bản đầu đánh fail thẳng, và hậu quả là gate **không thể qua được** đúng trên những
run nó sinh ra để canh — dạy dispatcher bỏ qua gate trong đúng một ngày. Cùng lý do
đó, `reconcile` điền `endedAt` bù thì ghi kèm `endedAtInferred: true`: giờ kết thúc
bù là sổ sách, không phải quan sát, và một giờ kết thúc bịa ở "now" từng cho job
chết một tiếng trước cái cửa sổ chạy tới hiện tại.

**Git không thấy file bị ignore, nên phải tự đi tìm.** `.codex/config.toml`,
`*.env`, `tasks/*/data/`, và `mwg-content-editor/content-workspaces/` đều bị
gitignore ở repo này — tức là chỗ ghi hợp lệ mà tài liệu vẫn đang chỉ cho
`filesMayModify` lại là chỗ git mù hoàn toàn. Nên gate stat thêm 2 nhóm ngoài
`git status`: mọi prefix có khai `filesMayModify`, và danh sách `PROTECTED_PATHS`
lấy từ Protected Files của `CLAUDE.md`. Ghi vào file được bảo vệ là exit 2, không
có đường khai để hợp lệ hoá.

**Runtime tự khai thì thắng đồng hồ — nhưng chỉ theo một chiều.** Job nào có
`touchedFiles` (Codex headless đọc từ event `file_change`, Codex app từ `result` của
companion) thì file trong đó được quy cho **chính job đó**, kể cả khi mtime chỉ rơi vào
khoảng của job khác. Report gắn nhãn `tự khai đã ghi` hay `theo thời gian` cho từng dòng.

Nhãn **không** phải thứ bậc, và `theo thời gian` bị tính **y như** `tự khai`. Đo
2026-08-25: cả hai runtime đều quay sang shell khi tool ghi file lỗi — `write_to_file` của
Antigravity từ chối mọi đường ngoài thư mục artifact của nó, nên worker Anti dùng
`run_command` như thường lệ — và không gì ghi bằng shell đi qua cái tool báo file thay đổi.
Nên file runtime khai thì chắc chắn là của nó; file nó không khai thì **vẫn có thể** là của
nó. Hạ `theo thời gian` xuống cảnh báo là mở cửa cho mọi vi phạm ghi-bằng-shell.

**Giảm báo oan mà không nới cưỡng chế**, ba đường:

| Đường | Làm gì |
| --- | --- |
| Run khác sở hữu | File mà worker của một run crew khác tự khai đã ghi thì báo là của run đó, không tính vào run này. Quyết bằng **authorship**, không bằng thời gian — `MAX_PARALLEL` 3 với grace 2 phút thì cửa sổ run nào cũng chồng nhau |
| `headSha` | `createRun` ghi HEAD lúc bắt đầu; collect so lại và nêu số commit đã vào trong lúc run, kèm câu nói rõ gate **không** soi được nội dung chúng |
| `--not-ours <path> --reason "<vì sao>"` | Bác một path cụ thể. `--reason` là bắt buộc, lý do ghi vào `manifest.dismissedPaths` và in trong report; lần chạy sau không tố lại |

Bác bỏ có dấu khác hẳn nới ngưỡng: nới ngưỡng làm im mọi run về sau và không để lại gì,
còn cái này làm im **một path trong một run** kèm câu giải thích nằm cạnh run đó.

Giới hạn còn lại, cố ý không vá: **file đã commit thì gate không thấy** — nó chỉ đọc
working tree. `headSha` không vá chỗ đó, nó chỉ khiến gate **nói ra** là có commit mà nó
không soi được; có gọi `git log` thì cũng không biết ai là tác giả thật của commit. File bị
xoá cũng không quy được cho job nào (xoá thì không còn mtime) nên chỉ được nêu ra, không
chặn — repo này đang mang sẵn một file xoá không liên quan, gate mà fail vì nó thì hôm sau
không ai chạy nữa.

File ghi hợp lệ ra ngoài `tasks/{task}/` phải khai `filesMayModify` lúc `addJob`
(ví dụ `mwg-content-editor/content-workspaces/{slug}/`). Prefix được chuẩn hoá kết
thúc bằng `/` và chỉ áp cho **chính job đã khai** — khai `docs` không mở đường cho
`docs-secret.md`, và job 2 không dùng được quyền của job 1.

### Bốn mã thoát, và tại sao có mã 3

| Exit | Nghĩa |
| --- | --- |
| 0 | được viết report tổng |
| 1 | còn job chưa xong, đang chờ người quyết, hoặc runtime lệch evidence chưa ai đọc |
| 2 | vi phạm phạm vi ghi, trùng evidence, hoặc chạm file được bảo vệ |
| 3 | **cả 1 và 2** |

3 không phải bậc nặng hơn 2. Trước đó hai loại vấn đề gộp vào một mã, nên người
vừa dọn xong đống file ngoài phạm vi thấy gate hết đỏ và tưởng run đã sạch —
trong khi vẫn còn job chưa ai xử.

#### Runtime lệch evidence: PASS nhưng chưa được viết report (26/08)

Trước 26/08, job mà runtime báo fail còn evidence phán DONE ra `PASS` + `WARN`
và gate thoát 0 — trong khi chính adapter đã thoát 3, nghĩa là "phải có người
đọc". Hai câu trả lời cho một sự việc, và chỉ một câu dừng được cái gì.

Cái **không** đổi: verdict của job vẫn `PASS`. Evidence trên đĩa vẫn outrank
runtime, luật đó không nhúc nhích. Cái đổi là run có được viết report tổng khi
chưa ai đọc hay không.

Cái này chặn trên một sự thật không rerun nào xoá được, nên nó phải có đường
thoả mãn — gate không thoả mãn nổi là gate người ta học cách đi vòng. Đường đó
là một câu của người đọc, ghi lại cạnh run:

```bash
node mwg-agent-crew/scripts/crew-collect.mjs "$RUN_DIR/manifest.json" \
  --ack-runtime 2 --reason "đọc evidence rồi, agy báo ERROR nhưng bài đã ghi đủ"
```

`--reason` bắt buộc, cùng lý do với `--not-ours`: nhận một job mà runtime báo
fail thì phải để lại câu giải thích, không thì lần sau không ai truy được. Ack
ghi vào `manifest.runtimeAcks`, và WARN **vẫn còn** cho người đọc sau.

### Adapter chết thì cũng phải tự ghi

Adapter tồn tại để một cái chết được ghi lại thay vì đọc là `pending` mãi. Rà 25/08
chỉ ra cái chết duy nhất không ai ghi: **của chính adapter**. `SIGTERM` không đi qua
`try/catch` — Node thoát ngay, để lại đúng cái job nó vừa đánh dấu `running`.

Đã thêm handler cho `SIGTERM`/`SIGINT`/`SIGHUP`: ghi job là `failed` kèm tên signal,
rồi thoát bằng mã `128 + signo`. Ghi đồng bộ, vì trong signal handler không có `await`
— nên `updateJob` được import tĩnh riêng cho đường này.

**Handler này chỉ với tới đường `headless`.** Đo được khi viết test: đường `app` chờ
bên trong `spawnSync`, mà `spawnSync` khoá event loop — nên Node không giao được signal
cho handler nào cho tới khi lệnh đó trả về. Đây là giới hạn thật, không phải chỗ chưa
làm: job app bị giết giữa lúc chờ được cứu qua **cổng**, và đó chính là lý do
`companionJobId` được ghi ngay lúc dispatch — cổng phát hiện job quá hạn, rồi
`crew-reconcile --cancel-orphans` tìm ra và kết liễu nó. Chậm hơn handler, nhưng không
mất. Cách khác là viết lại mọi lệnh companion thành async, cho một ca mà cổng đã phủ.

Bài học đáng ghi hơn cả bản sửa: test đầu tiên tôi viết cho chốt này **đậu vì lý do
sai** — fake trả kết quả ngay nên adapter đã settle trước khi signal tới, và assertion
"ghi failed" vẫn xanh. Chỉ có assertion thứ hai (kiểm **tên signal** trong `failure`)
lộ ra là đường đó chưa hề được đo.

Lỗ thứ hai cùng loại: `cancel` job app trước đây chỉ với tới được **qua một snapshot**.
Khi chính lệnh `status --wait` treo hoặc chết (broker kẹt, companion mất), adapter ghi
job failed rồi bỏ đi — để lại một job nền vẫn chạy, vẫn ghi file, vẫn đốt quota, không
ai theo. Giờ mất dấu là hủy: job adapter không còn theo được là job nó phải kết liễu.

### Report tổng: ba chốt, và cái mà `existsSync` không thấy

`--report` chỉ ghi khi gate trả exit 0, không đi cùng `--dry-run`, và đường dẫn phải
nằm **trực tiếp** trong `tasks/{task}/reports/`. Ba chốt đó là chốt cũ. Ngày 25/08 một
worker Codex rà lại và tìm thêm hai đường lách, cả hai đã bịt:

| Đường lách | Vì sao chốt cũ không thấy | Bịt bằng |
| --- | --- | --- |
| `tasks/{task}/reports/` **là symlink** trỏ ra ngoài | `relative()` so chuỗi, không đọc đĩa. Và `realpath` của chính nó so với chính nó thì luôn khớp | Neo ở thư mục **task**: `realpath(tasks/{task})` + `/reports` — đường mà symlink không can thiệp được |
| File đích là **symlink treo** | `existsSync` đi theo link, thấy đích không có, trả "trống" | Ghi bằng `flag: "wx"` — kernel nhìn chính cái link, trả `EEXIST` |

`wx` cũng đóng luôn ca hai tiến trình cùng ghi một tên: cả hai đều qua được
`existsSync`, nhưng chỉ một tạo được file. Bằng chứng run cũ không bị thay lặng lẽ.

Còn `existsSync` để làm gì: để có câu báo lỗi tử tế. Cái bảo đảm là `wx`.

### Job im lặng bao lâu thì coi là chết

Ngưỡng lấy từ `timeoutMs` mà chính adapter ghi vào manifest lúc bắt đầu job, cộng
10 phút. Trước đó là hằng số 35 phút suy từ trần 30m, nên job 5 phút chết được ưu
ái nửa tiếng còn job chạy dài hợp lệ bị đọc là chết. Manifest cũ không có
`timeoutMs` thì rơi về đúng 35 phút như trước.

Biên nghiêng về phía "còn chạy" có chủ ý: `STALE` là verdict duy nhất `--abandon`
nhận, nên đoán sai về phía chết là vứt việc, còn đoán sai về phía sống chỉ tốn
thêm một lần chạy collect.

Adapter cũng ghi `status: "running"` + `startedAt` **trước khi** spawn. Không có
bước đó, job đang chạy nằm trong manifest với `startedAt: null` — gate không phân
biệt được job đang làm với job chưa từng khởi động, và mọi file nó ghi trong lúc
chạy đều không quy được cho ai.

### `headless` là mặc định; `app` là ngoại lệ có lý do viết ra

`addJob` **đòi** `role` (`owner` | `assist`), quyết bằng một câu hỏi kiểm được:

> **Ai chịu trách nhiệm về acceptance của đầu ra job này?**

Nhưng `role` **không** quyết transport. Transport mặc định là `headless` cho cả hai,
vì `headless` là transport harness quan sát được: `exitCode`, `usage`, text reply,
watchdog. Đo 25/08 trên 6 job app thật: Anti app không có cái nào trong số đó và truyền
`runtimeOk: true` vô điều kiện; Codex app không watchdog, `exitCode: null`; thread app
**không hiện live** — lên đĩa sau ~8s nhưng phải tắt/mở lại app mới thấy.

`app` đáng giá đúng 3 ca, và mỗi ca phải viết ra trong `note`: job Anti sẽ gặp prompt
permission cần người trả; việc mở/khám phá chưa viết nổi acceptance; cần thread resume
làm tiếp buổi sau. Ghi đè không `note` bị từ chối, và lời từ chối liệt kê luôn 3 ca.

Vì sao vẫn giữ `role` khi nó không còn quyết transport: `role` là **lý do**, `transport`
là **hệ quả**. Tiêu chí trước đó không kiểm được, nên 34 job lịch sử chia 10 app / 24
headless mà không truy được vì sao job nào đi đường nào. Chính vì tách hai field mà lần
đổi mặc định này không làm run cũ thành vô nghĩa.

`worker: "claude"` có `role` nhưng `transport: null`: không process nào được bắn, ghi
transport vào đó là ghi một box chat chưa từng mở. Và `mode` — field cũ, chưa từng có
ai đọc bằng code — bị từ chối luôn thay vì để nó âm thầm biến mất: hai field ghi cùng
một sự thật là hai field sẽ lệch nhau.

### `codexRuntime`: quan sát, không phải quyết định

Manifest có ba field dễ lẫn. `role` là **lý do** chọn transport, `transport` là **lựa
chọn**, `codexRuntime` là **cái máy đã làm với lựa chọn đó**. Không có gì route theo field
thứ ba; nó tồn tại để lần sau đọc lại chứ không để bây giờ hành động.

Ghi hai mốc `atDispatch` / `atSettle` thay vì một, vì reading tự đổi: `direct` lúc 21:47,
`shared` lúc 22:05, không dispatch gì ở giữa. Quy tắc ghi cố tình không cần phối hợp —
`atDispatch` khoá sau lần ghi đầu (job đầu bắn thắng), `atSettle` ghi đè mọi lần (job cuối
lắng thắng) — nên 3 adapter chạy song song vẫn cho ra hai field đúng nghĩa.

Chỉ app mode ghi. Headless là `codex exec`, process riêng, không đi qua broker, nên câu hỏi
"chung hay riêng" không tồn tại với nó; lấy reading lúc chạy headless chỉ gán broker của
session khác cho job đó.

Đếm app-server **phải quy chủ**: 25/08 có 5 process khớp mẫu cùng lúc và chỉ 3 là của ta
(ChatGPT.app và extension VS Code mỗi thứ giữ một cái thường trực). Broker không phải
app-server, và một app-server là hai process (node wrapper + native child). Con số đếm trần
là con số đổi khi user mở VS Code.

### Orphan: cấp thêm dữ kiện, không nới quy tắc

`crew-reconcile.mjs` vốn từ chối phán mọi job không có evidence, và lý do nằm ngay trong
file: "chỉ dispatcher biết runtime còn sống không". Nhánh orphan **không** bỏ lời từ chối
đó — nó cấp cho reconcile đúng dữ kiện nó thiếu. `companionJobId` giờ được ghi ngay lúc
dispatch thay vì trên đường trả về, nên runtime hỏi được trực tiếp bằng `result <id>`.

Hai chỗ cố ý giữ chặt:

- **Im lặng không phải là chết.** Probe lỗi, hoặc runtime nói job còn chạy và pid còn sống,
  thì job vẫn ở `waiting`. Một companion không hỏi được sẽ không làm fail cả run.
- **`completed` không mua được đậu.** Runtime báo xong mà đĩa không có evidence thì đó là
  thất bại im lặng, đúng thứ harness này tồn tại để bắt. Chỉ evidence cho đậu.

Hủy job ở runtime là tự chọn (`--cancel-orphans`), mặc định tắt: phát hiện là phép đọc, hủy
là thay đổi thứ ngoài repo — và posture của module là reconcile báo, dispatcher quyết.

### `MANIFEST_VERSION` là mốc để đọc sự vắng mặt

WARN "evidence không do runtime giao" dựa vào chỗ vắng `exitCode`/`conversationId`.
Trên manifest version 1 thì chưa có gì từng ghi hai field đó, nên WARN nổ gần như
mọi job lịch sử — mà WARN lúc nào cũng sáng thì người đọc học cách lướt qua, kéo
theo cả cái WARN thật. Nên WARN chỉ hỏi khi `version >= 2`.

`readManifest` chấp nhận mọi version **≤** hằng số nó biết, chỉ từ chối version
lớn hơn. So bằng `!==` đồng nghĩa mỗi lần thêm field là toàn bộ run cũ trên đĩa
thành không đọc được.

### `--abandon` không phải nút xoá đỏ

`--abandon <seq>` chỉ bỏ được job đang là `STALE` (im lặng quá hạn của chính nó, không có
evidence). Job mà adapter đã ghi `failed` + `failure` thì **từ chối** — nếu không,
một cờ duy nhất biến exit 1 thành exit 0 và job chết biến khỏi mẫu số. `--dry-run`
phủ luôn `--abandon`, vì cờ an toàn mà không phủ cờ ghi thì vô nghĩa.

Mọi tham số có thể tắt một phép kiểm đều bị validate, không coerce: `--grace abc`
từng cho `to = NaN`, mọi so sánh false, toàn bộ file rơi vào "ngoài cửa sổ", và run
ra exit 0 mà không nói gì.

## Tests

```bash
node mwg-agent-crew/tests/run.mjs
```

Chạy mọi `tests/*.test.mjs`, mỗi file 1 process, exit khác 0 nếu có case fail.
Không có framework: thứ cần đo là hành vi ở biên process — exit code, file trên đĩa,
nội dung manifest — nên một runner spawn được process và so được string là đủ.

| File | Đo gì |
| --- | --- |
| `tests/judge-verdict.test.mjs` | 9 ca của bảng phán quyết `judgeJob()`: đủ tổ hợp evidence có/rỗng/thiếu × runtime ok/fail × có/không dòng `Status:`. |
| `tests/collect-gate.test.mjs` | Cổng nghiệm thu trên các run dựng sẵn để sai đúng 1 kiểu: trùng evidence sau khi resolve, ghi ngoài phạm vi, ghi vào file được bảo vệ, ghi vào prefix bị gitignore đã khai, biên prefix, khoảng suy đoán, xoá file, `--abandon` job đã fail, `--dry-run` phủ `--abandon`, `--grace` không phải số, chạy từ cwd khác, echo template brief, provenance evidence, WARN bền qua 2 lần collect, cost gate chỉ nằm trong evidence. |
| `tests/codex-lifecycle.test.mjs` | Vòng đời `codex-run.mjs` qua `codex` giả: grandchild giữ stdout, brief 200KB vào child không đọc stdin, watchdog trước stderr rác, retry đè sidecar cũ, log dir sai quyền, `BLOCKED` phải exit 3, và manifest phải ghi được ca bị giết. |
| `tests/agent-state.test.mjs` | Hai luật ngược chiều và cả hai phải giữ: hook **không được chặn phiên** (mọi ca hỏng đều exit 0) nhưng cũng **không được ghi khi chưa che được**. Thêm: ba phiên ghi cùng lúc ra ba file không mất cái nào, trần 4 KB, file cũ bị đánh dấu, và đoạn text cuối là câu dẫn cụt thì không được chọn làm tóm tắt. |
| `tests/session-export.test.mjs` | Redactor trước, exporter sau. Hai ca ngược nhau: credential **không kèm từ tiếng Anh nào** phải chết sạch, và văn xuôi nói về LLM token phải còn nguyên. Rồi: gộp subagent/sidecar, từ chối path dưới `subagents/`, gỡ module redact → exit ≠ 0 và **không** sinh file, trần byte tính trên cả file chứ không riêng phần thân. |
| `tests/fixtures/fake-codex` | `codex` giả, chọn hình dạng lỗi bằng `FAKE_MODE`. `tests/fixtures/bin/codex` là symlink trỏ vào nó — phải đúng tên `codex`, không thì PATH rơi xuống CLI thật và bộ test không đo gì cả. |

5 lỗi lifecycle nặng nhất của phase 1 đều nằm ở chỗ không có script nào chạm tới, và
không có ca nào trong đó một `codex` thật chịu tái hiện theo yêu cầu. Đó là lý do có
`fake-codex` thay vì test bằng runtime thật.

### Contract không thương lượng

Worker tự báo thành công **không được tính là thành công**. Chỉ tính khi có file evidence
không rỗng nằm trong `tasks/`, và dòng `Status:` cuối file mới là phán quyết. Lý do:
`agy` đã được quan sát trả `status=SUCCESS` với response rỗng và không làm gì, khi một
tool nó cần bị chặn bởi permission prompt mà nó không hiển thị được; và một job dừng ở
cost gate vẫn để lại file không rỗng nên nếu chỉ kiểm sự tồn tại thì bị đếm nhầm là xong.

Nguyên tắc này áp cả vào vòng poll của app mode: tín hiệu hoàn thành là file evidence,
không phải step status. Job fail được ghi `status: failed`, và `crew-reconcile.mjs` sửa
lại nếu evidence chứng minh ngược lại.

**Thứ tự quan trọng ngang cái gate.** Verdict của runtime được thu thập trước nhưng phán
sau, bằng `judgeJob()` trong `crew-guards.mjs`. Hỏi runtime trước đã làm mất 2 job đã
xong ngày 2026-08-24: `agy` trả `ERROR`, evidence đủ và đạt acceptance, job vẫn bị ghi
`failed` rồi phải sửa tay. Runtime chỉ có tiếng nói ở 2 chỗ: khi không có evidence dùng
được, và khi evidence không có dòng `Status:`. Runtime báo fail mà evidence tự phán được
thì ghi thành `runtimeVerdict` — bất đồng, không phải thất bại — để bước collect đưa ra
cho người đọc thay vì chôn đi.

`crew-collect.mjs` cơ khí hoá đúng contract này. Nó in `PASS + WARN` cho mọi ca bất
đồng — cả `runtimeVerdict`, cả manifest có `failure`, cả job bị reconcile vá từ `failed`
lên đậu — và không tự giải quyết, vì chỉ người đọc phân biệt được lỗi runtime với job
làm nửa vời. Đối lại, reconcile **không ghi đè phán quyết đã đậu**: một job
`done_verified_manually` (người đã đọc artifact sau khi runtime hô ERROR) từng bị viết
lại thành `done` trơn, mất cả dấu đã kiểm lẫn cái bất đồng đáng đưa ra.
