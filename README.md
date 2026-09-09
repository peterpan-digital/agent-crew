# agent-crew

Plugin cho Claude Code: giao việc song song cho **Antigravity** và **Codex**, rồi
**nghiệm thu bằng bằng chứng trên đĩa** thay vì tin lời worker tự khai.

Chạy trên macOS và Windows. Không cần MCP, không cần credential, không cần dịch vụ ngoài.

## Vấn đề nó giải

Giao việc cho một agent khác thì dễ. Biết nó có làm hay không thì không.

Một agent báo `SUCCESS` với `response` rỗng khi nó bị chặn bởi một prompt permission mà
nó không hiển thị được. Một agent chết ở phút thứ hai, và 20 phút sau vẫn không ai biết.
Một agent viết report đúng nhưng runtime báo lỗi, rồi bị ghi là fail trong khi việc đã
xong. Cả ba đã xảy ra thật, và không cái nào cần một agent thông minh hơn để phát hiện —
cả ba cần **một cổng có exit code**.

Plugin này là cái cổng đó, cộng với những thứ tối thiểu quanh nó để cổng có gì mà chấm:

- **một cái sổ (manifest)** cho mỗi run: job nào, ai làm, bậc model nào, ghi ở đâu;
- **hai adapter** chạy `agy` và `codex exec` có watchdog, có timeout, và **ghi lại cái
  chết của chính mình** — kể cả khi bị SIGTERM;
- **một cổng nghiệm thu** chấm bằng file evidence, không chấm bằng lời worker;
- **một cổng phạm vi ghi**: worker ghi ra ngoài chỗ đã khai thì run không được report.

Rule trung tâm, một câu: **worker tự nói xong không được tính; chỉ file evidence không
rỗng có dòng `Status:` mới được tính.**

## Cài

Cần: Node 20+, git, và ít nhất một trong hai CLI `agy` (Antigravity) hoặc `codex`.

```bash
claude plugin marketplace add peterpan-digital/agent-crew
claude plugin install agent-crew@agent-crew-marketplace
```

Thử tại chỗ, không qua marketplace:

```bash
claude --plugin-dir ./plugins/agent-crew
```

Trong session, kiểm bằng `/plugin` hoặc gọi thẳng skill: `/agent-crew:agent-crew`.

## Chạy lần đầu

Trong repo bạn muốn làm việc:

```bash
node "$CLAUDE_PLUGIN_ROOT/bin/crew.mjs" doctor
node "$CLAUDE_PLUGIN_ROOT/bin/crew.mjs" init
```

`doctor` in ra platform, Node, git, và `agy`/`codex` resolve tới đâu. Nó trả exit 1 nếu
có gì thiếu — chạy nó trước khi dispatch lần đầu trên một máy mới.

`init` sinh `crew.config.json` và một `.gitignore` bỏ log thô ra khỏi git. Không chạy
`init` cũng được: mặc định hoạt động luôn.

Sau đó cứ nói việc với Claude như bình thường. Skill tự vào khi request có nhiều đầu việc
khác loại. Muốn gọi tay: `/agent-crew:agent-crew`.

## Một run trông như thế nào

Dưới đây `crew` viết tắt cho `node "$CLAUDE_PLUGIN_ROOT/bin/crew.mjs"`. Bình thường bạn
không gõ tay mấy lệnh này — Claude gõ, theo `SKILL.md`. Chúng ở đây để bạn đọc được run
của nó, và để debug khi cần.

```bash
crew new-run --label "sửa flaky test và viết script gộp export"
crew add-job --worker codex --role owner --effort medium \
  --title "sửa flaky test auth" --allow "tests/auth/" --allow "src/auth/"
# ghi brief vào đường dẫn lệnh trên in ra, rồi:
crew run --job 1 --timeout 15m        # chạy nền
crew collect .crew/runs/{id}/manifest.json
```

Toàn bộ run nằm trong một thư mục:

```text
.crew/runs/260908-1430/
├── manifest.json              # sổ của run
├── brief-codex-1.md           # brief đã gửi (giữ để audit)
├── worker-codex-1.md          # evidence worker ghi — thứ duy nhất được tính
├── logs/                      # stream log thô (đã gitignore)
└── report.md                  # khung report, số liệu điền sẵn
```

## Cấu hình

`crew.config.json` ở gốc repo. Mọi field đều tuỳ chọn:

| Field | Mặc định | Là gì |
| --- | --- | --- |
| `runRoot` | `.crew` | chỗ chứa run |
| `maxJobs` | 6 | trần job mỗi run — code ép |
| `maxParallel` | 3 | trần job chạy cùng lúc — code ép |
| `defaultTimeout` | `15m` | trần cứng 30m |
| `briefMaxBytes` | 2048 | trần brief, không có flag bỏ qua |
| `protectedPaths` | `.env`, `.mcp.json`, … | file worker **không bao giờ** được ghi |
| `protectedDirs` | `.claude/skills/`, `.git/` | thư mục, khớp theo prefix |
| `defaultFilesMayModify` | `[]` | prefix mọi job được ghi, ngoài thư mục run |
| `costGate` | `[]` | tên API tốn tiền: worker gặp thì dừng và trả `BLOCKED / COST_GATE` |

## Ba worker

| Worker | Khi nào | Cần gì |
| --- | --- | --- |
| `antigravity` | rule đã thành văn, chỉ cần thi hành đúng và nhanh | `agy` trên PATH |
| `codex` | code, pipeline, refactor, chạy test | `codex` trên PATH |
| `claude` | phán đoán: đọc số, chọn hướng, viết tài liệu chính thức | không cần gì — Claude tự làm, nhưng vẫn phải ghi evidence |

Tiêu chí là **rule đã thành văn hay chưa**, không phải dễ/khó. Chi tiết ở
`plugins/agent-crew/skills/agent-crew/references/dispatch-playbook.md`.

## Hai transport

| | `headless` | `app` |
| --- | --- | --- |
| Mặc định | ✔ mọi job | phải khai `--transport app` **kèm `--note` lý do** |
| Cần gì thêm | không | app Antigravity đang chạy / companion của plugin `openai-codex` |
| Harness thấy | usage, reply text, exit code, watchdog | ít hơn — xem bảng số đo |
| Người thấy | không | conversation/thread thật, resume được |

`headless` là mặc định vì **đo được**, không vì tiện: đo 2026-08-25 trên 6 job app thật,
`app` quan sát **yếu hơn** ở cả hai runtime, và thứ người ta tìm đến nó để lấy — "mở ra
ngồi xem cho chắc" — chính là thứ nó không giao được (thread không render live; rollout có
trên đĩa ở +8s nhưng chỉ hiện sau khi tắt/mở lại app).

Ba ca `app` đáng giá: job sẽ gặp **prompt permission cần người bấm**; việc **mở/khám phá**
chưa viết nổi acceptance; cần **thread resume** buổi sau. Ngoài ba ca đó, chọn `app` là
trả giá quan sát để lấy một thứ chưa nêu được — nên `--transport app` không kèm `--note`
thì bị từ chối.

`crew doctor` in ra transport nào chạy được trên máy này, kèm lý do nếu không:

```text
transport app (tuỳ chọn — mặc định mọi job là headless):
  antigravity  sẵn sàng — app pid 3991, 127.0.0.1:51431
  sqlite3      /usr/bin/sqlite3 — fallback step-status bật
  codex        sẵn sàng — companion .../openai-codex/plugins/codex/scripts/codex-companion.mjs
```

Chi tiết: `plugins/agent-crew/skills/agent-crew/references/transport-choice.md`.

## Exit code

Đây là interface — job chạy nền nên exit code là tín hiệu duy nhất.

`crew run`: `0` xong · `1` fail (đã ghi sổ) · `2` job xong nhưng ghi sổ lỗi · `3` xong
nhưng **cần người đọc**.

`crew collect`: `0` được report · `1` còn job chưa xong hoặc runtime lệch evidence chưa
ai đọc · `2` vi phạm phạm vi ghi hoặc trùng evidence · `3` **cả 1 và 2**.

## Cái gì cố tình KHÔNG có

- **`app` làm mặc định.** Transport `app` có, nhưng là ngoại lệ phải nêu lý do — xem mục
  trên. Mặc định mọi job đi `headless`, vì đó là đường harness quan sát được.
- **Tự commit, tự mở PR, tự đóng ticket.** Crew làm việc và viết lại việc đã làm.
- **Worker dispatch worker.** Chặn hai lớp: `AGENT_CREW_ROLE=worker` và `depth` trong
  manifest.
- **Flag nới trần brief, flag xoá một failure đã ghi.** Một cửa thoát mà người gọi bật
  được trong cùng một hơi thì không phải trần.

## Chạy test

```bash
cd plugins/agent-crew && node tests/run.mjs
```

## Tài liệu

- `plugins/agent-crew/skills/agent-crew/SKILL.md` — workflow đầy đủ, 7 bước
- `references/dispatch-playbook.md` — phân rã request thành job, chọn worker
- `references/worker-brief.md` — template brief
- `references/collect-contract.md` — bảng verdict và cách xử từng ca
- `references/platform-notes.md` — Windows/macOS, và **cái gì chưa verify**
