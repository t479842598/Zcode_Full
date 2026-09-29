#!/usr/bin/env node
/**
 * 无限四代 — UserPromptSubmit hook（ZCode）。
 *
 * 两个职责：
 *   1. 按需补注（config.inject_on_prompt_submit，默认关）：长会话里 SessionStart
 *      那一份可能已被压缩裁掉，这里补一次保证内核在场。
 *   2. 闭环纠偏：每轮都跑（成本是读一个小文件），若上一轮回复以拒绝/转向开头，
 *      本轮就补一段纠偏指令，把模型拉回「直接给交付物」。
 *
 * 手动冒烟：
 *   printf '%s\n' '{"hook_event_name":"UserPromptSubmit","session_id":"manual","prompt":"hi"}' \
 *     | node hooks/user-prompt-submit.mjs
 */
import {
  buildInjection,
  correctiveText,
  loadConfig,
  log,
  readHookInput,
  readState,
  writeHookOutput,
  writeState,
} from "../lib/common.mjs";

async function main() {
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  const input = await readHookInput();
  const sessionId = String(input.session_id || "?");

  const state = readState();
  // 纠偏：上一轮的判定由 UI 侧（armor 投影）或本 hook 回写。若无数据则空串。
  const corrective = cfg.refusal_corrective ? correctiveText(state.lastVerdict) : "";
  const shouldReinject = cfg.inject_on_prompt_submit;

  if (!shouldReinject && !corrective) {
    // 无补注、无纠偏 → 完全静默，零 token 成本。
    writeState({ lastPromptAt: new Date().toISOString(), lastPromptSession: sessionId });
    return;
  }

  const additionalContext = buildInjection({
    dualLayer: cfg.dual_layer,
    reason: `UserPromptSubmit${corrective ? "/corrective" : "/reinject"}`,
    corrective,
  });

  writeHookOutput("UserPromptSubmit", additionalContext);
  writeState({
    lastPromptAt: new Date().toISOString(),
    lastPromptSession: sessionId,
    lastCorrectiveAt: corrective ? new Date().toISOString() : state.lastCorrectiveAt,
    promptChars: additionalContext.length,
  });
  log(
    `UserPromptSubmit session=${sessionId} 补注=${additionalContext.length} 字符 ` +
      `纠偏=${corrective.length > 0} 补注开关=${shouldReinject}`,
  );
}

main().catch((err) => {
  log(`user-prompt-submit hook error: ${err?.message || err}`);
  process.exit(0);
});
