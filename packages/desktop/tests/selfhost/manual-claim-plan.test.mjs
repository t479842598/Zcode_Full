import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../../..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("manual claim plan client targets the official billing endpoints", async () => {
  const client = await read("packages/services/src/coding-plan-subscription/manualClaimPlan.ts");
  // 端点与官方 3.14.3 host 实现逐字对齐。
  assert.match(client, /\/api\/v1\/zcode-plan\/billing\/preview/);
  assert.match(client, /\/api\/v1\/zcode-plan\/billing\/claim/);
  // 官方请求头三件套必须保留，服务端按 app_version / platform 判定领取资格。
  assert.match(client, /app_version/);
  assert.match(client, /platform/);
  assert.match(client, /X-Aliyun-Captcha-Verify-Param/);
  assert.match(client, /X-ZCode-App-Version/);
  assert.match(client, /X-Platform/);
  // 凭据键与官方一致；未登录时不发请求。
  assert.match(client, /zcodejwttoken/);
  assert.match(client, /plans: \[\]/);
  // 领取失败必须返回结构化结果，不能抛异常导致 UI 误判为可重试。
  assert.match(client, /success: false/);
});

test("manual claim plan failure attribution stays dependency-free for the UI bundle", async () => {
  const failure = await read(
    "packages/services/src/coding-plan-subscription/manualClaimPlanFailure.ts",
  );
  // 零依赖：不能 import 网络实现，否则 renderer bundle 会拖入服务端代码。
  // 只看 import 语句，注释里提及不算。
  assert.doesNotMatch(failure, /^import .*apiJson/mu);
  assert.doesNotMatch(failure, /^import .*readApiJson/mu);
  assert.match(failure, /resolveManualClaimPlanFailureReason/);
  // 关键归因分支都要存在，UI 靠它选文案。
  for (const reason of [
    "loginRequired",
    "notFound",
    "alreadyClaimed",
    "captcha",
    "quotaExhausted",
    "generic",
  ]) {
    assert.match(failure, new RegExp(reason));
  }
});

test("manual claim plan service is exposed through the service contract", async () => {
  const contract = await read("packages/services/src/coding-plan-subscription/codingPlanSubscription.ts");
  assert.match(contract, /getManualClaimPlanPreviews/);
  assert.match(contract, /claimManualPlan/);

  const service = await read(
    "packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts",
  );
  assert.match(service, /getManualClaimPlanPreviews/);
  assert.match(service, /claimManualPlan/);

  const provider = await read(
    "packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts",
  );
  assert.match(provider, /fetchManualClaimPlanPreviews/);
  assert.match(provider, /claimManualPlan/);
});

test("manual claim plan banner is mounted and offers an inline claim action", async () => {
  const banner = await read("packages/ui/src/root/ManualClaimPlanBanner.tsx");
  // 横幅提供一键领取，而不是把用户丢去活动页。
  assert.match(banner, /manualClaimPlan\.banner\.claim/);
  // 关闭前二次确认，与官方「您将错过一次领取机会」语义一致。
  assert.match(banner, /dismissConfirm/);
  // 领取需要验证码：复用 Start Plan 的验证码实现，不新造一套。
  assert.match(banner, /verifyStartPlanCaptcha/);
  assert.match(banner, /getCaptchaConfig/);
  // 成功与失败都要有明确终态。
  assert.match(banner, /manualClaimPlan\.claim\.success\.title/);
  // 失败态按归因选文案：generic 分支必须存在（服务端不返回结构化 reason 时的兼底）。
  assert.match(banner, /manualClaimPlan\.claim\.failure\.generic/);
  assert.match(banner, /resolveManualClaimPlanFailureReason/);

  const mount = await read("packages/ui/src/root/RootWorkspaceContent.tsx");
  assert.match(mount, /ManualClaimPlanBanner/);
  assert.match(mount, /codingPlanSubscriptionService/);
});
