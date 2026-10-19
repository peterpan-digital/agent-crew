/**
 * Vai trò của tiến trình trong một crew run. Adapter đặt cả hai tên cho worker:
 * `CREW_ROLE` là tên chung, `MWG_CREW_ROLE` là tên cũ mà hook và skill của
 * workspace gốc vẫn đọc. Guard nhận cả hai -- đổi tên ở một phía mà không đổi
 * phía kia là làm guard mất tác dụng một cách im lặng.
 *
 * Env là tín hiệu cho agent chịu hợp tác, không phải hàng rào: agent nào cũng
 * unset được. Chốt thật là `depth` trong manifest.
 */
export const ROLE_VARS = Object.freeze(["CREW_ROLE", "MWG_CREW_ROLE"]);

export function isWorkerRole(env = process.env) {
  return ROLE_VARS.some((k) => env[k] === "worker");
}

/** Không biến vai trò nào được đặt: tiến trình là dispatcher hoặc người dùng. */
export function hasNoRole(env = process.env) {
  return ROLE_VARS.every((k) => !env[k]);
}

/** Env vai trò worker để trộn vào env của tiến trình con. */
export const WORKER_ROLE_ENV = Object.freeze(Object.fromEntries(ROLE_VARS.map((k) => [k, "worker"])));
