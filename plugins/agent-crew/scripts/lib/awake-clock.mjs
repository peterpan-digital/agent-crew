/**
 * Đồng hồ "thời gian máy thức" cho watchdog của worker: thời gian máy ngủ không
 * tính vào --timeout, cũng không tính là worker im lặng.
 *
 * Vì sao (đo 24/11, Digital Project run 261124-2119 job 2): Mac gập nắp ngủ lúc
 * 14:43:47Z, job Codex mới chạy ~21 phút. setTimeout của Node trên macOS chạy
 * theo CLOCK_MONOTONIC, mà đồng hồ này vẫn chạy khi máy ngủ: lúc máy thức tạm
 * (DarkWake 15:04:24Z), mốc 30m đã quá nên crew cắt ngay "exceeded 30m" dù job
 * chỉ được ~22 phút thức. Lượt cứu handoff (trần 180s) bị cắt tiếp sau 1044s vì
 * "no stdout event for 60s" — máy lại ngủ 17 phút giữa chừng. Session đọc lỗi
 * thành "Codex chạy hết 30 phút", làm tay phần còn lại. Ca 23/11 (run
 * 261123-0017 job 2, agy dừng ở 1558s thay vì 1230s, 6 giây sau một DarkWake)
 * cùng gốc.
 *
 * Cách đo: một nhịp đều `tickMs`; hai lần đọc đồng hồ cách nhau quá `tickMs +
 * gapMs` thì khoảng dư là máy ngủ (vòng lặp sự kiện của adapter không có việc
 * đồng bộ nào dài cỡ đó). Đồng hồ `now` tiêm được để test giả lập giấc ngủ —
 * CI không gập nắp được.
 *
 * Thuần, không throw.
 */

export const SLEEP_TICK_MS = 5_000;
export const SLEEP_GAP_MS = 30_000;

/**
 * → `{poll, now, sleptMs, awakeMs}`. `poll()` đọc đồng hồ một lần; thấy khoảng
 * ngủ thì cộng dồn, gọi `onSleep(gapMs)` và trả về gap (không thì 0).
 */
export function createAwakeClock({ now = Date.now, tickMs = SLEEP_TICK_MS, gapMs = SLEEP_GAP_MS, onSleep = () => {} } = {}) {
  const startedAt = now();
  let last = startedAt;
  let slept = 0;
  const poll = () => {
    const t = now();
    const dt = t - last;
    last = t;
    if (dt <= tickMs + gapMs) return 0;
    const gap = dt - tickMs;
    slept += gap;
    try { onSleep(gap); } catch { /* ghi chú thôi, không được làm hỏng watchdog */ }
    return gap;
  };
  return { poll, now, sleptMs: () => slept, awakeMs: () => now() - startedAt - slept };
}

/**
 * Hạn chót theo thời gian thức: mỗi nhịp đọc đồng hồ, đủ `ms` thời gian thức
 * thì gọi `onExpire()` đúng một lần. Trễ tối đa một nhịp so với setTimeout.
 * → `{check, clear}`.
 */
export function awakeDeadline({ ms, clock, onExpire, tickMs = SLEEP_TICK_MS }) {
  let done = false;
  let timer = null;
  const clear = () => {
    done = true;
    if (timer) clearInterval(timer);
  };
  const check = () => {
    if (done) return;
    clock.poll();
    if (clock.awakeMs() >= ms) {
      clear();
      onExpire();
    }
  };
  timer = setInterval(check, Math.max(10, Math.min(tickMs, ms)));
  return { check, clear };
}

/** Đuôi cho lý do cắt: có ngủ thì nói rõ đã trừ bao lâu. */
export function sleptSuffix(clock) {
  const s = Math.round(clock.sleptMs() / 1000);
  return s > 0 ? ` (máy ngủ thêm ${s}s, không tính)` : "";
}

/** Câu ghi vào sidecar lúc phát hiện máy vừa ngủ. */
export function sleepNote(gapMs) {
  return `máy ngủ ${Math.round(gapMs / 1000)}s (gập nắp/sleep) — không tính vào --timeout và giờ im`;
}
