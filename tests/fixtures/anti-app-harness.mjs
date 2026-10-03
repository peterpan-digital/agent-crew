#!/usr/bin/env node
/**
 * Chạy `main` của anti-run với app giả: không agentapi, không DB, nhưng toàn bộ
 * phần còn lại là thật (claim, handler signal, vòng poll bất đồng bộ, manifest).
 * Test dùng nó để gửi SIGTERM thật vào một job app đang đợi, vì test hàm thuần
 * không chứng minh được signal có tới được handler khi vòng poll đang sleep.
 */
import { main } from "../../scripts/anti-run.mjs";

await main(process.argv.slice(2), {
  deps: {
    resolveEnv: () => ({ agentapi: "fake-agentapi", env: {} }),
    dispatch: () => JSON.stringify({ response: { newConversation: { conversationId: "conv-harness-1" } } }),
    // Không bao giờ xong và không bao giờ nhúc nhích: đúng ca job treo.
    status: () => ({ steps: 3, byStatus: { 7: 1 }, state: "running" }),
    pollMs: Number(process.env.HARNESS_POLL_MS ?? 5000),
  },
});
