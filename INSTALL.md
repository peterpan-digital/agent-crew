# Cài `mwg-agent-crew`

Hướng dẫn cho người — hoặc cho con AI đang setup hộ — dựng module này trên một máy
mới, để Claude điều phối được Codex và Antigravity làm việc song song.

## 1. Đây là gì, và không là gì

**Là:** động cơ điều phối. Claude làm foreman, giao job cho worker (Codex, Antigravity),
gom kết quả về file evidence, và chấm bằng cổng tự động thay vì tin lời worker tự khai.

**Không là:** một app chạy độc lập. Module phải nằm trong một *workspace* — thư mục
dự án mà agent của bạn mở làm gốc — và nó dựa vào workspace đó có thư mục `tasks/`.

Module **không** mang theo hệ vận hành riêng của workspace gốc. Xem mục 6.

## 2. Yêu cầu

| Thứ | Vì sao | Kiểm |
| --- | --- | --- |
| Node.js 20+ | Chạy toàn bộ script | `node --version` |
| `git` | Adapter gọi `git` để xác định trạng thái repo | `git --version` |

**Không có phụ thuộc npm.** Mọi `import` trong module đều là đường tương đối trong
chính nó hoặc `node:` builtin, nên không có `package.json` và không cần `npm install`.

Muốn dùng worker nào thì cài CLI của worker đó. Không cài cả hai cũng chạy được — chỉ
là mất đường đó:

| Worker | Cần | Kiểm |
| --- | --- | --- |
| Antigravity | CLI `agy` (headless) và/hoặc `agentapi` (app mode) | `agy --version` |
| Codex headless | CLI `codex` | `codex --version` |
| Codex app | thêm plugin Claude Code `openai-codex` (chứa `codex-companion.mjs`) | xem mục 5 |

## 3. Đặt module vào workspace

Skill `seo-crew` gọi script bằng đường **tương đối từ gốc workspace**
(`mwg-agent-crew/scripts/...`), nên module phải là thư mục con trực tiếp:

```bash
cd <workspace-cua-ban>
git clone https://github.com/your-github-account/mwg-agent-crew.git mwg-agent-crew
mkdir -p tasks
```

`mkdir tasks` không phải cho đẹp. Guard `validateEvidencePath` từ chối mọi job có
`--evidence` nằm ngoài `<workspace>/tasks/`, nên thiếu thư mục đó là mọi job bị chặn
ngay ở cổng.

## 4. Cài skill vào các bề mặt agent

Module mang sẵn skill ở `skill/seo-crew/`. Chép nó vào bề mặt mà agent của bạn đọc:

```bash
cd <workspace-cua-ban>
mkdir -p .claude/skills .codex/skills .agents/skills
cp -R mwg-agent-crew/skill/seo-crew .claude/skills/
cp -R mwg-agent-crew/skill/seo-crew .codex/skills/
cp -R mwg-agent-crew/skill/seo-crew .agents/skills/
```

Chỉ cần bề mặt của agent bạn thật sự dùng. `.claude/skills/` là bản canonical: sửa ở
đó, rồi đồng bộ các bản còn lại bằng

```bash
node mwg-agent-crew/scripts/sync-skill-surfaces.mjs --apply
```

`--check` trả exit 1 ngay khi hai bản lệch.

## 5. Codex app mode (tùy chọn)

App mode đi qua `codex-companion.mjs` của plugin Claude Code `openai-codex`. Module tìm
nó ở hai chỗ, theo thứ tự:

1. `$CLAUDE_PLUGIN_ROOT/scripts/codex-companion.mjs`
2. `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs`

Máy nào chỉ có bản cache (`~/.claude/plugins/cache/...`) thì khai tay:

```bash
export MWG_CODEX_COMPANION=/duong/dan/den/codex-companion.mjs
```

Không tìm thấy thì adapter **ném lỗi**, không lặng lẽ rơi về headless — đổi transport
ngầm là cách tạo ra kết quả sai mà không ai biết.

## 6. Cái module KHÔNG mang theo — phải tự thích nghi

`skill/seo-crew/SKILL.md` viết cho workspace SEO gốc, nên nó nhắc những thứ không có
trong bản clone của bạn. Sửa trước khi dùng thật:

| Trong SKILL.md | Thực tế ở bản clone |
| --- | --- |
| KPI 95% / 1728 keyword / scope Laptop | Bối cảnh riêng của workspace gốc. Thay bằng bối cảnh của bạn hoặc xoá. |
| `seo-task-create`, `seo-task-done`, `seo-task-journal-sync` | Skill riêng của workspace gốc, **không** kèm theo. Thay bằng cách tạo task của bạn. |
| `seo-log-cv`, `seo-log-weekly-work` (File 1 / File 2) | Hệ chấm công nội bộ. Không liên quan đến bạn. |
| `tasks/_registry.md`, `tasks/_workstreams.md` | Sổ theo dõi riêng. Bỏ được. |

Phần **không** phụ thuộc workspace, giữ nguyên: cách dispatch, cổng evidence, ngưỡng
`max_parallel`, cost gate, và toàn bộ `scripts/`.

## 7. Kiểm sau khi cài

```bash
node mwg-agent-crew/tests/run.mjs
```

Mong đợi: mọi file test pass. Bản clone trần **không** có `.agents/` nên
`crew-routing-gate` sẽ in `SKIP` kèm lý do — đó là đúng, không phải hỏng. Nếu workspace
của bạn *có* `.agents/` mà thiếu hook thì test fail to, vì lúc đó là hỏng thật.

Thử một job thật, nhỏ nhất:

```bash
cd <workspace-cua-ban>
node mwg-agent-crew/scripts/anti-run.mjs \
  --prompt "Ghi đúng một dòng: hello" \
  --evidence tasks/smoke/hello.md \
  --workspace "$PWD"
```

Cờ `anti-run` nhận: `--prompt`, `--prompt-file`, `--evidence`, `--workspace`,
`--timeout`, `--mode`, `--agy-mode`, `--model`, `--title`, `--manifest`, `--job`,
`--resume`. Cờ lạ bị **từ chối**, không bị bỏ qua — một lần gõ sai `--model` từng làm
job chạy âm thầm ở tier mặc định.

## 8. Biến môi trường

| Biến | Việc |
| --- | --- |
| `MWG_CODEX_COMPANION` | Khai tay đường dẫn companion (mục 5) |
| `CLAUDE_PLUGIN_ROOT` | Do Claude Code đặt; dùng để tìm companion |
| `MWG_CREW_ROLE=worker` | Guard chống đệ quy: worker không được dispatch worker |
| `MWG_STATE_DEBUG` | In thêm log khi suy trạng thái job |

## 9. Lỗi hay gặp

| Triệu chứng | Nguyên nhân |
| --- | --- |
| `--evidence is required` | Mọi job phải ghi file evidence dưới `tasks/` |
| `evidence path is outside the task tree` | Thiếu `tasks/`, hoặc `--workspace` trỏ sai gốc |
| `evidence file already exists` | Dùng đường dẫn mới cho mỗi job — file cũ sẽ bị nhầm là bằng chứng của lần này |
| `unknown flag --xxx` | Gõ sai cờ. Thông báo lỗi in ra danh sách cờ hợp lệ |
| `could not run agy` | Chưa cài CLI Antigravity, hoặc nó không có trong `PATH` |
| Companion không tìm thấy | Đặt `MWG_CODEX_COMPANION` (mục 5) |
