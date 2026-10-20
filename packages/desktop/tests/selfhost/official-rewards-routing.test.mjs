import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../../..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("official rewards entry stays on the official origin and injects account context", async () => {
  const endpoint = await read("packages/shared/src/zcodeEndpoint.ts");
  const embedded = await read("packages/shared/src/rewardsEmbedded.ts");
  const preload = await read("packages/desktop/src/preload/rewardsWebview.ts");
  const ui = await read("packages/ui/src/settings/OfficialRewardsSection.tsx");
  // 自托管：权益页地址必须钉在官方 origin，不继承自建中继/更新站的 endpoint 覆盖。
  assert.match(endpoint, /DEFAULT_ZCODE_REWARDS_ORIGIN/);
  assert.match(endpoint, /\/cn\/rewards/);
  assert.match(endpoint, /embedded.*app/);
  // 官方 3.16 起可信 URL 门禁与上下文事件收在 shared/rewardsEmbedded.ts：
  // 事件名仍是 zcode-rewards-context，可信判定改为 isTrustedRewardsUrl（同源钉死 + /(cn|en)/rewards + embedded=app）。
  assert.match(embedded, /export const REWARDS_CONTEXT_EVENT = "zcode-rewards-context"/);
  assert.match(embedded, /export function isTrustedRewardsUrl/);
  assert.match(embedded, /https:\/\/zcode\.z\.ai/);
  // preload 只在可信页面里装 bridge，并在业务脚本前清掉上一轮残留凭据。
  assert.match(preload, /isTrustedRewardsUrl/);
  assert.match(preload, /installRewardsPageBridge/);
  assert.match(preload, /oauth:zai:access_token/);
  assert.match(preload, /oauth:bigmodel:access_token/);
  assert.match(preload, /zcodejwttoken/);
  assert.match(ui, /zcode-rewards-context/);
  assert.match(ui, /oauth:zai:access_token/);
  assert.match(ui, /oauth:bigmodel:access_token/);
  assert.match(ui, /zcodejwttoken/);
  assert.match(ui, /providerCredentialKey/);
  assert.match(ui, /oauthService\.getActiveProvider/);
  assert.match(ui, /userId/);
  assert.match(ui, /credentialService\.load/);
});

test("desktop webview build includes a dedicated rewards preload", async () => {
  const tsup = await read("packages/desktop/tsup.config.ts");
  const chrome = await read("packages/desktop/src/main/desktopWindowChrome.ts");
  assert.match(tsup, /preload\/rewardsWebview/);
  // 官方 3.16 起 rewards preload 路径内联在 webview attach 分支里（没有 rewardsWebviewPreloadPath 常量），
  // 判定入口是局部变量 isRewardsWebview = isTrustedRewardsUrl(...)，开发态追加 --zcode-rewards-dev。
  assert.match(chrome, /preload\/rewardsWebview\.cjs/);
  assert.match(chrome, /const isRewardsWebview = isTrustedRewardsUrl\(/);
  assert.match(chrome, /--zcode-rewards-dev/);
});
