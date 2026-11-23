/**
 * `crew add-job --tier <bậc>` và `--bump-from <seq>`: đổi một chữ ra model/effort
 * mà job sẽ chạy, và ghi lý do vào notes của job.
 *
 * Cờ tay (`--model` cho Anti, `--effort` cho Codex) vẫn thắng `--tier`: có lúc
 * dispatcher biết hơn bảng. Khi đó bậc vẫn được kiểm có hợp worker/transport
 * không và vẫn ghi sổ, kèm một note nói cờ tay đã thắng.
 */
import { loadCrewConfig } from "../lib/crew-config.mjs";
import { bumpTier, liveAgyModels, liveCodexModels, resolveTier } from "../lib/model-tiers.mjs";
import { CliError } from "./run-commands.mjs";

/**
 * → `{tier, model?, effort?, notes}`. `model`/`effort` chỉ có khi bậc đã chọn
 * chúng; vắng thì add-job dùng cờ tay như cũ. `fetchAgyModels`/`fetchCodexModels`
 * thay được trong test.
 *
 * Codex: bậc chọn cả model lẫn effort; `--model`/`--effort` tay chỉ đè đúng phần
 * mình khai. Anti: `--model` tay thắng cả bậc.
 */
export function tierFields({ worker, flags, manifest, fetchAgyModels = liveAgyModels, fetchCodexModels = liveCodexModels }) {
  const notes = [];
  const transport = flags.transport ?? "headless";
  let tier = flags.tier ?? null;
  const bumpFrom = flags["bump-from"];
  if (bumpFrom !== undefined) {
    if (tier) throw new CliError("--tier và --bump-from loại nhau: --bump-from tự tính bậc từ job trước");
    const src = manifest.jobs.find((j) => String(j.seq) === String(bumpFrom));
    if (!src) throw new CliError(`--bump-from: sổ không có job ${bumpFrom}`);
    if (!src.tier) throw new CliError(`--bump-from: job ${bumpFrom} không ghi tier (chọn model/effort tay) — truyền --tier`);
    tier = bumpTier(src.tier, worker, transport);
    notes.push(tier === src.tier
      ? `nâng bậc từ job ${bumpFrom}: ${src.tier} không có bậc trên, giữ nguyên`
      : `nâng bậc từ job ${bumpFrom} (${src.tier} → ${tier})`);
  }
  const manualKeys = (worker === "codex" ? ["model", "effort"] : ["model"]).filter((k) => flags[k] !== undefined);
  if (!tier) {
    if (!manualKeys.length) {
      throw new CliError(worker === "codex"
        ? "job Codex cần --tier (light|standard|deep|code|max) hoặc --effort (model theo ~/.codex/config.toml)"
        : worker === "claude"
          ? "thiếu --model (job Claude dùng model của phiên)"
          : "thiếu --tier (light|standard|deep|code|max|claude|claude-max) hoặc --model (crew doctor in tên còn sống)");
    }
    return { tier: null, notes };
  }
  const { modelTiers } = loadCrewConfig(manifest.workspace);
  const allManual = worker === "codex" ? manualKeys.length === 2 : manualKeys.length === 1;
  const resolved = resolveTier({
    worker, transport, tier, overrides: modelTiers,
    liveAgyModels: worker === "antigravity" && transport === "headless" && !allManual ? fetchAgyModels() : null,
    liveCodexModels: worker === "codex" && !allManual ? fetchCodexModels() : null,
  });
  for (const k of manualKeys) notes.push(`--${k} tay thắng --tier ${tier}`);
  return {
    tier,
    ...(resolved.model && !manualKeys.includes("model") ? { model: resolved.model } : {}),
    ...(resolved.effort && !manualKeys.includes("effort") ? { effort: resolved.effort } : {}),
    notes,
  };
}
