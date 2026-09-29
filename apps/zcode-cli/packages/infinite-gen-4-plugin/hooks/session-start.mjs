#!/usr/bin/env node
/**
 * 无限四代 — SessionStart hook（ZCode）。
 *
 * DSH 的 systemPrompt.section 在会话组装时注入系统提示词段；
 * ZCode 的等价点是 SessionStart 的 additionalContext（loop-guard 同款协议）。
 * 该通道落在 user 侧，天然免疫「上游丢弃 role:"system"」的问题。
 *
 * 手动冒烟：
 *   printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"manual","source":"startup"}' \
 *     | node hooks/session-start.mjs
 */
import {
  buildInjection,
  correctiveText,
  loadConfig,
  log,
  readHookInput,
  readState,
  verifyKernel,
  writeHookOutput,
  writeState,
} from "../lib/common.mjs";

async function main() {
  const cfg = loadConfig();

  const input = await readHookInput();
  const source = String(input.source || "unknown");
  const sessionId = String(input.session_id || "?");

  // 开关关闭：不注入，但要落状态让 UI 状态条能显示「已关闭」。
  if (!cfg.enabled) {
    writeState({ enabled: false, injected: false, sessionId, source, payloadBytes: 0, reason: "disabled" });
    log(`SessionStart source=${source} session=${sessionId} → 开关关闭，跳过注入`);
    return;
  }

  // 压缩后内核可能被裁掉；按配置决定是否重注。
  if (source === "compact" && !cfg.reinject_on_compact) {
    writeState({ enabled: true, injected: false, sessionId, source, reason: "compact-skip" });
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

  // 闭环纠偏（等价 DSH 的 Order 150）：读上轮判定，refusal/fallback 才追加。
  const state = readState();
  const corrective = cfg.refusal_corrective ? correctiveText(state.lastVerdict) : "";

  const additionalContext = buildInjection({
    dualLayer: cfg.dual_layer,
    reason: `SessionStart/${source}`,
    corrective,
  });

  writeHookOutput("SessionStart", additionalContext);
  writeState({
    enabled: true,
    injected: true,
    sessionId,
    source,
    dualLayer: cfg.dual_layer,
    corrective: corrective.length > 0,
    payloadBytes: Buffer.byteLength(additionalContext, "utf8"),
    chars: additionalContext.length,
    reason: `SessionStart/${source}`,
  });
  log(
    `SessionStart source=${source} session=${sessionId} ` +
      `注入=${additionalContext.length} 字符 双层=${cfg.dual_layer} 纠偏=${corrective.length > 0}`,
  );
}

main().catch((err) => {
  // hook 失败不能阻断会话：记录后正常退出。
  log(`session-start hook error: ${err?.message || err}`);
  process.exit(0);
});
