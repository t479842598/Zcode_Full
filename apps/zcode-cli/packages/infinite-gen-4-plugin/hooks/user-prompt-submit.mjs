#!/usr/bin/env node
/**
 * 无限四代 — UserPromptSubmit hook（ZCode）。
 *
 * 默认关闭（config.inject_on_prompt_submit=false）：每轮补注会持续占上下文。
 * 打开后用于长会话——压缩或轮次较多时，SessionStart 那一份可能已被裁掉，
 * 这里按需补一次，保证内核始终在场。
 *
 * 手动冒烟：
 *   printf '%s\n' '{"hook_event_name":"UserPromptSubmit","session_id":"manual","prompt":"hi"}' \
 *     | node hooks/user-prompt-submit.mjs
 */
import { buildInjection, loadConfig, log, readHookInput, writeHookOutput } from "../lib/common.mjs";

async function main() {
  const cfg = loadConfig();
  if (!cfg.enabled || !cfg.inject_on_prompt_submit) return;

  const input = await readHookInput();
  const sessionId = String(input.session_id || "?");

  const additionalContext = buildInjection({
    dualLayer: cfg.dual_layer,
    reason: "UserPromptSubmit",
  });

  writeHookOutput("UserPromptSubmit", additionalContext);
  log(`UserPromptSubmit session=${sessionId} 补注=${additionalContext.length}B`);
}

main().catch((err) => {
  log(`user-prompt-submit hook error: ${err?.message || err}`);
  process.exit(0);
});
