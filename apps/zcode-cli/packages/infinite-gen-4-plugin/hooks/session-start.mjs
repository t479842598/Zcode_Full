#!/usr/bin/env node
/**
 * 无限四代 — SessionStart hook（ZCode）。
 *
 * DSH 的 systemPrompt.section 在会话组装时注入系统提示词段；
 * ZCode 的等价点是 SessionStart 的 additionalContext（loop-guard 同款协议）。
 *
 * 手动冒烟：
 *   printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"manual","source":"startup"}' \
 *     | node hooks/session-start.mjs
 */
import {
  buildInjection,
  loadConfig,
  log,
  readHookInput,
  verifyKernel,
  writeHookOutput,
} from "../lib/common.mjs";

async function main() {
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  const input = await readHookInput();
  const source = String(input.source || "unknown");
  const sessionId = String(input.session_id || "?");

  // 压缩后内核可能被裁掉；按配置决定是否重注。
  if (source === "compact" && !cfg.reinject_on_compact) {
    log(`SessionStart source=compact session=${sessionId} → 按配置跳过重注`);
    return;
  }

  if (cfg.escape_clause_tripwire) {
    const verdict = verifyKernel();
    if (verdict.escapeClauses.length > 0) {
      log(
        `⚠️ 逃生条款锁命中 ${verdict.escapeClauses.length} 条削弱条款：` +
          `${verdict.escapeClauses.join(", ")} → 内核载荷可能被覆盖版本回灌，需还原`,
      );
    }
    if (!verdict.sameSource) {
      log(
        `⚠️ 两段载荷不同源（${verdict.primaryHash.slice(0, 16)} vs ` +
          `${verdict.reinforceHash.slice(0, 16)}）→ 双层注入会出现不一致载荷`,
      );
    }
  }

  const additionalContext = buildInjection({
    dualLayer: cfg.dual_layer,
    reason: `SessionStart/${source}`,
  });

  writeHookOutput("SessionStart", additionalContext);
  log(
    `SessionStart source=${source} session=${sessionId} ` +
      `注入=${additionalContext.length}B 双层=${cfg.dual_layer}`,
  );
}

main().catch((err) => {
  // hook 失败不能阻断会话：记录后正常退出。
  log(`session-start hook error: ${err?.message || err}`);
  process.exit(0);
});
