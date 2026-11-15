# Sandbox ghi cho worker — bỏ đoán theo mtime

Status: done (PR sau) · Owner chốt 15/11/2026

## Vì sao
Cổng phạm vi ghi đoán "file đổi trong khoảng job chạy = của worker". Workspace đông session → 310 path bị bác tay trong 9/42 run, 0 path là worker ghi sai thật; session đã bác hàng loạt bằng script nên cổng thành hình thức.

## Hướng (đã đo 15/11, macOS 26.6, codex 0.164, agy 1.5.9)
Chặn ghi ở hệ điều hành để file ngoài vùng ghi **không thể** là của worker:
- Codex: permission profile qua `-c default_permissions=… -c permissions.<p>.filesystem={":root"="read", ":tmpdir"="write", ":slash_tmp"="write", <vùng>="write", <control plane trong vùng>="read"}` + `network={enabled=true,domains={"*"="allow"}}`; bỏ `--sandbox`. Chặn cả `apply_patch` lẫn shell, giữ qua `resume` (-c đặt sau `resume`).
- agy: bọc `sandbox-exec -f <profile>`: `(allow default)`, deny `file-write*` trong workspace, allow vùng ghi, deny lại control plane. Không lồng được với seatbelt của Codex nên mỗi worker một cách.
- Vùng ghi = `allowedFor(manifest,[seq])` (run home + `--allow`), cùng nguồn với cổng collect.

## Phase
1. `scripts/lib/write-sandbox.mjs`: tính vùng ghi, dựng args Codex / profile seatbelt, tự thử chặn (probe) trước job. Tắt được bằng `writeSandbox: false` trong crew.config.json.
2. Adapter: codex-run, anti-run dùng sandbox khi job có sổ; ghi `job.writeSandbox` ({kind, writable, readOnly} hoặc {kind:null, reason}); probe hỏng / `danger-full-access` → chạy như cũ, sổ ghi lý do.
3. Collect: job có `writeSandbox.kind` thì file ngoài vùng ghi không tính cho job đó (mục `sandboxExcluded`, chỉ báo số).
4. Worker bị chặn ("Operation not permitted", "writing outside of the project") → sổ ghi `sandboxDenied`, stderr gợi ý `--allow` + `--resume`.
5. Tài liệu (README, SKILL.md, references), version minor, chạy thật 1 job mỗi worker.

## Acceptance
- Test đỏ trước: collect của job sandbox không báo SCOPE_VIOLATION cho file session khác; agy (fake) dưới seatbelt bị chặn ghi ngoài vùng; argv Codex có profile, không có `--sandbox`; probe hỏng → rơi về cũ.
- Toàn bộ `plugins/agent-crew/tests/*.test.mjs` xanh.
- Job thật Codex + agy ở repo nháp: ghi trong vùng được, ngoài vùng bị chặn, collect sạch.

## Rủi ro / lui
- `sandbox-exec` lỗi thời, profile Codex mới → probe mỗi job, hỏng thì về cổng mtime như cũ.
- Job ghi sai phạm vi giờ hỏng ngay → gợi ý `--allow` + `--resume` (số liệu cũ: 0/92 job).
