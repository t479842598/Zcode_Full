#!/usr/bin/env node
/**
 * dsh-purge — SessionStart hook（ZCode）。
 *
 * dsh-purge 上游是 DSH 的 cordis 插件，改写 DSH 源码里的弱框定与身份句。
 * ZCode 没有那些字符串（见 lib/common.mjs 顶部说明），所以等价落点是
 * SessionStart 的 additionalContext：把同一套语义作为「操作者指令」注入。
 *
 * 手动冒烟：
 *   printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"manual","source":"startup"}' \
 *     | node hooks/session-start.mjs
 */
import {
  buildInjection,
  checkSharedBudget,
  loadConfig,
  log,
  readHookInput,
  verifyPayload,
  writeHookOutput,
} from "../lib/common.mjs";

async function main() {
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  const input = await readHookInput();
  const source = String(input.source || "unknown");
  const sessionId = String(input.session_id || "?");

  // 压缩后注入的载荷可能被裁掉；按配置决定是否重注。
  if (source === "compact" && !cfg.reinject_on_compact) {
    log(`SessionStart source=compact session=${sessionId} → 按配置跳过重注`);
    return;
  }

  const verdict = verifyPayload();
  if (verdict.matchesLock === false) {
    log(
      `⚠️ 载荷指纹与锁文件不一致（现 ${verdict.hash.slice(0, 16)}）→ ` +
        `载荷被改动过，需确认是否预期；锁文件在 kernel-lock.json`,
    );
  }

  const additionalContext = buildInjection({ reason: `SessionStart/${source}` });
  if (!additionalContext) return; // 超限时 buildInjection 已告警，不注入

  if (cfg.budget_watch) {
    const budget = checkSharedBudget(additionalContext.length);
    const note =
      budget.siblingChars === null
        ? `同会话未见 infinite-gen-4 载荷，本段占用 ${additionalContext.length}`
        : `本段 ${additionalContext.length} + infinite-gen-4 约 ${budget.siblingChars} ` +
          `= 约 ${budget.total} / ${24000}`;
    log(note);
    if (budget.overBudget) {
      log(
        `⚠️ 共享预算超限：两个 hook 的 additionalContext 合计超过 24k，` +
          `runtime 会从尾部截断——排在后面的插件载荷会静默丢指令`,
      );
    }
  }

  writeHookOutput("SessionStart", additionalContext);
  log(`SessionStart source=${source} session=${sessionId} 注入=${additionalContext.length}B`);
}

main().catch((err) => {
  // hook 失败不能阻断会话：记录后正常退出。
  log(`session-start hook error: ${err?.message || err}`);
  process.exit(0);
});
