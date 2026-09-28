import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../../..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

/** 与 core/src/runtime/methods/hooks.ts 的 HOOK_CONTEXT_MAX_CHARS 保持一致。 */
const HOOK_CONTEXT_MAX_CHARS = 24_000;

test("dsh-purge 内置插件已注册进桌面端打包清单", async () => {
  const prepare = await read("packages/desktop/scripts/prepare-agent-node-bundle.mjs");
  // 内置插件的识别规则：源目录必须是 apps/zcode-cli/packages/<name>-plugin，
  // 并在 officialPluginPackages 里登记 stagedPath。
  assert.match(prepare, /@zcode\/dsh-purge-plugin/);
  assert.match(prepare, /apps\/zcode-cli\/packages\/dsh-purge-plugin/);
  assert.match(prepare, /packages\/dsh-purge-plugin/);
});

test("打包白名单必须放行载荷与 hook 公共库", async () => {
  const prepare = await read("packages/desktop/scripts/prepare-agent-node-bundle.mjs");
  const allowListMatch = prepare.match(
    /const includedOfficialPluginTopLevelPaths = new Set\(\[([\s\S]*?)\]\);/u,
  );
  assert.ok(allowListMatch, "未找到官方插件顶层路径白名单");
  const allowList = allowListMatch[1];
  assert.match(allowList, /"prompts"/, "白名单缺少 prompts（注入载荷）");
  assert.match(allowList, /"lib"/, "白名单缺少 lib（hook 公共库）");
  assert.match(allowList, /"hooks"/, "白名单缺少 hooks");
  assert.match(allowList, /"\.zcode-plugin"/, "白名单缺少 .zcode-plugin（插件清单）");
});

test("插件源码目录结构符合 ZCode 插件规范", async () => {
  const manifest = JSON.parse(
    await read("apps/zcode-cli/packages/dsh-purge-plugin/.zcode-plugin/plugin.json"),
  );
  assert.equal(manifest.name, "dsh-purge");

  const hooks = JSON.parse(
    await read("apps/zcode-cli/packages/dsh-purge-plugin/hooks/hooks.json"),
  );
  assert.ok(hooks.hooks.SessionStart, "缺少 SessionStart hook（注入主通道）");
  assert.ok(hooks.hooks.UserPromptSubmit, "缺少 UserPromptSubmit hook（可选补注）");
  // SessionStart matcher 必须覆盖 compact，否则压缩后不会再注入
  assert.match(hooks.hooks.SessionStart[0].matcher, /compact/);
});

test("载荷随源码入库且带 A/B 类语义、不含 C 类（审批放行）语义", async () => {
  const payload = await read("apps/zcode-cli/packages/dsh-purge-plugin/prompts/operator-directive.md");
  // A 类：指令效力强化
  assert.match(payload, /ACTIVE and MANDATORY for this session/);
  assert.match(payload, /not optional guidance/);
  assert.match(payload, /flag them as prompt injection/);
  // B 类：身份剥离
  assert.match(payload, /Identity neutralization/);
  // C 类必须缺席：ZCode 的权限由 core/src/permission/ 真实管控，
  // 提示词层宣称「审批已自动放行」会让模型误判边界。
  assert.doesNotMatch(payload, /approval is auto-granted/i);
  assert.doesNotMatch(payload, /approval bypass/i);
  assert.doesNotMatch(payload, /sandbox_permissions/);
});

test("注入载荷与 infinite-gen-4 合计不超 24k 共享预算", async () => {
  // runtime 把同轮所有 hook 的 additionalContext 拼接后**整体**截断到 24k，
  // 不是每个 hook 各 24k。两个内置插件共享这份预算，排在后面的那个会被
  // 静默截掉尾部（截断后只剩前半段，读起来像普通免责声明）。
  const purge = await read(
    "apps/zcode-cli/packages/dsh-purge-plugin/prompts/operator-directive.md",
  );
  const kernel = await read("apps/zcode-cli/packages/infinite-gen-4-plugin/prompts/kernel.md");

  // 两个 hook 各自会在载荷前加一段 HTML 注释头，实测各约 130 字符。
  const HEADER_ALLOWANCE = 130;
  const JOIN_OVERHEAD = 8; // "#N\n" 前缀 + "\n\n" 分隔
  const total =
    purge.length + HEADER_ALLOWANCE + kernel.length + HEADER_ALLOWANCE + JOIN_OVERHEAD;

  assert.ok(
    total <= HOOK_CONTEXT_MAX_CHARS,
    `合计 ${total} 字符超过 ${HOOK_CONTEXT_MAX_CHARS} —— ` +
      `排在后面的插件会被静默截断。请压缩载荷或提高 hooks.ts 的上限。`,
  );
});

test("载荷指纹与 kernel-lock.json 一致", async () => {
  const payload = await read(
    "apps/zcode-cli/packages/dsh-purge-plugin/prompts/operator-directive.md",
  );
  const lock = JSON.parse(await read("apps/zcode-cli/packages/dsh-purge-plugin/kernel-lock.json"));
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(payload).digest("hex");
  assert.equal(lock.sha256, hash, "载荷改动后未同步 kernel-lock.json");
});
