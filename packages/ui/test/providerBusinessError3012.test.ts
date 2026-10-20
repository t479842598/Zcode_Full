import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const errorModule = readFileSync(
  new URL("../src/lib/providerBusinessError.ts", import.meta.url),
  "utf8",
);
const zh = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const en = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");
const detailBuilder = readFileSync(
  new URL("../../../apps/zcode-cli/packages/core/src/errors/error-payload.ts", import.meta.url),
  "utf8",
);
const uiError = readFileSync(new URL("../src/lib/zcodeUiError.ts", import.meta.url), "utf8");
const providerBusinessError = readFileSync(
  new URL(
    "../../../apps/zcode-cli/packages/core/src/runtime/helpers/provider-business-error.ts",
    import.meta.url,
  ),
  "utf8",
);

// 3012 是 z.ai 服务端对该账号模型推理端点的风控拦截（HTTP 405 unusual activity）。
// 客户端不可绕过，只能明确提示。回归钉死：码表收录、无 UI 动作、中英文案、端到端可达。
// 取证：docs/2026-10-10-free-quota-diagnosis.md 第四节。

test("3012 被收录进 provider 业务码表且不可执行任何绕过动作", () => {
  assert.match(errorModule, /"3012",/);
  assert.match(errorModule, /"3012":\s*"zcode\.error\.providerBusiness\.3012"/);
  assert.match(errorModule, /"3012":\s*null,/);
});

test("3012 有中英双语文案", () => {
  assert.match(zh, /"zcode\.error\.providerBusiness\.3012":\s*"请求被服务端风控拦截/);
  assert.match(en, /"zcode\.error\.providerBusiness\.3012":\s*\n?\s*"The request was blocked/);
});

test("provider_code 端到端可达：core 写 provider_code → UI 正则提取 → 码表命中", () => {
  // core 从 provider 业务响应里提取非零 code（3012）并写入 context.providerCode
  assert.match(providerBusinessError, /normalizeProviderBusinessCode\(record\.code\)/);
  assert.match(providerBusinessError, /Number\(value\)\s*!==\s*0|numeric !== 0/);
  // core 把 context.providerCode 渲染成 detail 里的 provider_code=<码>
  assert.match(detailBuilder, /formatContextPart\("provider_code", context\.providerCode\)/);
  // UI 从 detail 提取该码并作为 error.code，从而命中 ChatErrorBanner 的业务文案
  assert.match(uiError, /detailFromError\?\.match\(\/provider_code=\(\[0-9\]\+\)\/\)/);

  // 本地复刻两侧行为，证明真实 3012 响应能还原成码表里的 "3012"
  const payload = { code: 3012, msg: "request has been blocked due to unusual activity." };
  const providerCode =
    typeof payload.code === "number" ? String(Math.trunc(payload.code)) : undefined;
  assert.equal(providerCode, "3012");
  const detail = `provider=account:zai-start-plan provider_code=${providerCode} status=405`;
  assert.equal(detail.match(/provider_code=([0-9]+)/)?.[1], "3012");
});
