# Worker Brief Contract

Một profile cho cả 3 worker. Brief nói **WHAT + NEED**, không nói HOW.

Phép thử: chỉ viết thứ worker **không tự suy ra được** từ file + `SKILL.md`. Trần 2 KB.
Lưu bản đã gửi tại `{reports_path}/brief-{runtime}-{seq}.md`.

## Lệnh chạm guard thì cấp nguyên văn

`MWG_CREW_ROLE=worker` chặn `createRun`, nên **worker không chạy được test của
`mwg-agent-crew/`**. Đo 25/08: cả hai worker Codex đều vướng; một con tự lách bằng
`env -u MWG_CREW_ROLE` rồi khai ra trong evidence.

Job nào cần chạy test thì brief **cấp sẵn nguyên văn** lệnh đó ở mục `## Lệnh được
cấp sẵn`. Để worker tự đoán rằng nó được phép lách guard là dạy nó sai thứ: lần sau
nó lách guard khác mà không hỏi. Cấp sẵn giữ được cả hai — test chạy được, và việc
gỡ guard vẫn là quyết định của dispatcher, ghi trong brief để audit được.

Chốt thật chặn đệ quy là `depth` trong manifest, không phải env var này. Cấp `env -u`
cho một lệnh test **không** nới `depth`.

## Template

```markdown
# Job {run_id}#{job_seq} — {runtime}

## Tình hình
{Đang có gì, ở đâu, số liệu nền. Không kể lịch sử task.}

## Cần gì
{Hình dạng output cần đạt. Không mô tả bằng các bước.}

## Bối cảnh & file
- {entry point để worker tự scout, file bắt buộc đọc}

## Skill
{Tên skill. Đọc SKILL.md rồi làm, đừng nghĩ lại quy trình.}

## Lưu ý
- {bẫy đã biết, ràng buộc không đọc được từ file, chỗ lần trước làm sai}

## Được ghi
- {evidence_path}
- {data job tự sinh, trong tasks/{task}/}

KHÔNG ghi file nào ngoài danh sách trên.

## Acceptance
- [ ] {kiểm được bằng mắt hoặc bằng lệnh}

## Ranh giới
- Không đọc `.env`/secret/token. Không sửa Protected Files của `CLAUDE.md`.
- **Không ghi, không xoá, không đổi tên bất cứ thứ gì trong `~/.config/gws/`** — kho
  credential Google Workspace. Adapter băm thư mục đó trước và sau job; lệch là
  cổng nghiệm thu đỏ và cả run bị chặn.
- Sheet read-only trừ khi brief ghi rõ. Không dispatch worker khác (`MWG_CREW_ROLE=worker`).
- **Trình duyệt dùng được, nếu job được cấp `--sandbox-mode danger-full-access`.**
  Không phải đi qua skill trình duyệt của Claude — rào đó là của Claude, vì tài
  khoản Claude dùng chung nhiều người nên có thể mở tab nhầm máy. Worker chạy cục
  bộ, không dính.
- **Job chạy ngoài sandbox thì tự giữ ranh giới.** Dòng này **adapter tự chèn**,
  không cần gõ tay: `appendWorkerContract` thêm nó khi job được cấp
  `--sandbox-mode danger-full-access` (Codex) và luôn thêm cho Antigravity, vốn
  chạy `--dangerously-skip-permissions`. Nội dung: chỉ đụng workspace + task
  folder; không `~/.config/gws/`, `.env`, secret, token, config ngoài repo.
  Lý do nó nằm ở brief chứ không ở code: owner chốt 22/09 **không cấm** gộp
  `--workspace-cli on` với mức nới, nên khi lớp sandbox không còn thì chỗ ràng
  duy nhất còn lại là thứ worker thật sự đọc. Rào hash quanh kho credential vẫn
  chạy, nhưng nó phát hiện **sau khi** hỏng.
- **Không tự nới quyền.** Bậc sandbox do người giao việc cấp lúc dispatch. Worker
  gọi lại adapter với mức nới sẽ bị từ chối; thiếu quyền thì trả `BLOCKED` nêu rõ
  cần gì, đừng đi đường vòng.
- Cost gate {cost_gate}: gặp thì DỪNG, trả BLOCKED / COST_GATE.
- **Không tự đặt biến môi trường cho Workspace CLI**, đặc biệt là
  `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND`. Đặt `=file` làm CLI mất khoá Keychain,
  kết luận kho credential hỏng, rồi **ra lệnh xoá nó**. Ngày 09/09 sandbox chặn
  được; ngày 18/09 cùng thao tác đó chạy ngoài sandbox và **xoá thật**, owner
  phải đăng nhập lại từ đầu. Adapter đã gỡ biến này khỏi env, nên đặt lại là cố
  tình vượt rào.
- **Việc Google Workspace luôn dùng Workspace CLI**, không dùng connector Google
  có sẵn của runtime (`gmail@`, `google-drive@`, `spreadsheets@`). Connector đi
  OAuth riêng, nằm ngoài rào định tuyến profile, nên có thể ghi nhầm sang tài
  khoản cá nhân mà không ai phát hiện.
- Gặp `401` khi gọi Workspace CLI thì **DỪNG**, trả `BLOCKED` kèm nguyên văn lỗi.
  Không đi tìm đường vòng. Job cần Workspace CLI phải được dispatch với
  `--workspace-cli on`; thiếu nó là lỗi của người giao việc, không phải thứ
  worker được tự vá.

## Lệnh được cấp sẵn
- {lệnh cần env đặc biệt, cấp nguyên văn — vd chạy test module:
  `env -u MWG_CREW_ROLE node mwg-agent-crew/tests/<file>.test.mjs`}

## Kết thúc

Dòng **cuối cùng** của evidence phải là một dòng `Status:` mang **đúng một** giá
trị: `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, hoặc `NEEDS_CONTEXT`. Dòng liệt kê
nhiều giá trị bị từ chối. Ngay trên nó là `Summary:` và `Concerns/Blockers:`.

Thiếu 3 dòng này thì cổng nghiệm thu đọc job là **chưa xong**, kể cả khi việc đã
làm đúng. Đừng kết bằng mục khác.
```

Cách viết từng mục, và ví dụ outcome vs kê bước:
`.claude/skills/seo-crew/references/dispatch-playbook.md`.
