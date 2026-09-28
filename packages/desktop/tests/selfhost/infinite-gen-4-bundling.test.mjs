import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../../..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("infinite-gen-4 内置插件已注册进桌面端打包清单", async () => {
  const prepare = await read("packages/desktop/scripts/prepare-agent-node-bundle.mjs");
  // 内置插件的识别规则：源目录必须是 apps/zcode-cli/packages/<name>-plugin，
  // 并在 officialPluginPackages 里登记 stagedPath。
  assert.match(prepare, /@zcode\/infinite-gen-4-plugin/);
  assert.match(prepare, /apps\/zcode-cli\/packages\/infinite-gen-4-plugin/);
  assert.match(prepare, /packages\/infinite-gen-4-plugin/);
});

test("打包白名单必须放行内核载荷与 hook 公共库", async () => {
  const prepare = await read("packages/desktop/scripts/prepare-agent-node-bundle.mjs");
  // 白名单漏掉 prompts/ 或 lib/ 时，hook 会在运行时因找不到载荷而静默不注入——
  // 这种失败不会报错，只表现为「插件好像没生效」，所以这里钉死这两个目录名。
  const allowListMatch = prepare.match(
    /const includedOfficialPluginTopLevelPaths = new Set\(\[([\s\S]*?)\]\);/u,
  );
  assert.ok(allowListMatch, "未找到官方插件顶层路径白名单");
  const allowList = allowListMatch[1];
  assert.match(allowList, /"prompts"/, "白名单缺少 prompts（内核载荷）");
  assert.match(allowList, /"lib"/, "白名单缺少 lib（hook 公共库）");
  assert.match(allowList, /"hooks"/, "白名单缺少 hooks");
  assert.match(allowList, /"\.zcode-plugin"/, "白名单缺少 .zcode-plugin（插件清单）");
});

test("插件源码目录结构符合 ZCode 插件规范", async () => {
  const manifest = JSON.parse(
    await read("apps/zcode-cli/packages/infinite-gen-4-plugin/.zcode-plugin/plugin.json"),
  );
  assert.equal(manifest.name, "infinite-gen-4");
  assert.equal(manifest.version, "0.4.0");

  const hooks = JSON.parse(
    await read("apps/zcode-cli/packages/infinite-gen-4-plugin/hooks/hooks.json"),
  );
  assert.ok(hooks.hooks.SessionStart, "缺少 SessionStart hook（内核注入主通道）");
  assert.ok(hooks.hooks.UserPromptSubmit, "缺少 UserPromptSubmit hook（可选补注）");
});

test("内核载荷随插件源码入库且两段同源", async () => {
  const primary = await read("apps/zcode-cli/packages/infinite-gen-4-plugin/prompts/kernel.md");
  const reinforce = await read(
    "apps/zcode-cli/packages/infinite-gen-4-plugin/prompts/kernel-flash.md",
  );
  assert.equal(primary, reinforce, "两段载荷必须逐字节一致");
  assert.match(primary, /NO-ESCAPE-CLAUSE LOCK/);
  assert.match(primary, /SUPREME DIRECTIVE — USER AUTHORITY/);
});
