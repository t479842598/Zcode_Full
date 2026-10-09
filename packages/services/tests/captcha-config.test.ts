import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isModelRequestVerificationRequired,
  parseCaptchaConfig,
} from "../src/coding-plan-subscription/captchaConfig.js";
import { startPlanVerificationHeaders } from "../src/zcode-agent/startPlanVerification.js";

test("正常验证配置只接受完整字段", () => {
  assert.equal(parseCaptchaConfig(null), null);
  assert.equal(parseCaptchaConfig({ enabled: true, sceneId: "s", prefix: "p" }), null);
  assert.deepEqual(parseCaptchaConfig({ enabled: false }), { enabled: false });
  assert.equal(parseCaptchaConfig({ sceneId: "s", prefix: "p", region: "r" })?.enabled, true);
  assert.equal(
    parseCaptchaConfig({ enabled: true, sceneId: "s", prefix: "p", region: "r" })?.sceneId,
    "s",
  );
});

test("官方 skip_model_request 被解析为内部 skipModelRequest（snake→camel 映射）", () => {
  // 官方 3.14.4 用该字段在 enabled 仍为 true 时关闭模型请求侧校验。
  // 官方 asar 的解构：let {skip_model_request:r, ...o}=n; return {...o, ...skipModelRequest:r}
  const config = parseCaptchaConfig({
    enabled: true,
    sceneId: "11xygtvd",
    prefix: "no8xfe",
    region: "cn",
    skip_model_request: true,
  });
  assert.equal(config?.enabled, true);
  assert.equal(config?.enabled === true ? config.skipModelRequest : undefined, true);
  // 非布尔值不映射，避免把服务端脏数据当成跳过指令。
  const dirty = parseCaptchaConfig({
    enabled: true,
    sceneId: "s",
    prefix: "p",
    region: "r",
    skip_model_request: "yes",
  });
  assert.equal(dirty?.enabled === true ? dirty.skipModelRequest : undefined, undefined);
});

test("skip_model_request 语义：仅显式关闭或显式跳过才免验证（fail-closed）", () => {
  // 配置缺失 → 需要验证（绝不能当作关闭）。
  assert.equal(isModelRequestVerificationRequired(null), true);
  // 显式 enabled:false → 免验证。
  assert.equal(isModelRequestVerificationRequired(parseCaptchaConfig({ enabled: false })), false);
  // enabled:true 且无 skip 字段 → 需要验证。
  assert.equal(
    isModelRequestVerificationRequired(
      parseCaptchaConfig({ enabled: true, sceneId: "s", prefix: "p", region: "r" }),
    ),
    true,
  );
  // enabled:true + skip_model_request:true → 模型请求免验证（官方 3.14.4 的实际线上配置）。
  assert.equal(
    isModelRequestVerificationRequired(
      parseCaptchaConfig({
        enabled: true,
        sceneId: "11xygtvd",
        prefix: "no8xfe",
        region: "cn",
        skip_model_request: true,
      }),
    ),
    false,
  );
  // enabled:true + skip_model_request:false → 仍需验证。
  assert.equal(
    isModelRequestVerificationRequired(
      parseCaptchaConfig({
        enabled: true,
        sceneId: "s",
        prefix: "p",
        region: "r",
        skip_model_request: false,
      }),
    ),
    true,
  );
});

test("startPlanVerificationHeaders 在 skip 时返回空 headers，不要求验证参数", () => {
  const skipped = parseCaptchaConfig({
    enabled: true,
    sceneId: "11xygtvd",
    prefix: "no8xfe",
    region: "cn",
    skip_model_request: true,
  });
  // 无 captchaVerifyParam 也放行（返回空 headers，不抛错）——这是修复「一直过不了验证码」的关键。
  assert.deepEqual(startPlanVerificationHeaders(skipped, { captchaVerifyParam: "" }), {});
  // 常规开启时仍然强制要求验证参数。
  const enabled = parseCaptchaConfig({ enabled: true, sceneId: "s", prefix: "p", region: "r" });
  assert.throws(() => startPlanVerificationHeaders(enabled, { captchaVerifyParam: "" }));
  assert.deepEqual(startPlanVerificationHeaders(enabled, { captchaVerifyParam: "proof" }), {
    "X-Aliyun-Captcha-Verify-Param": "proof",
    "X-Aliyun-Captcha-Verify-Region": "r",
  });
  // 配置缺失是 fail-closed：抛错而不是静默放行。
  assert.throws(() => startPlanVerificationHeaders(null, { captchaVerifyParam: "proof" }));
});

test("服务读取官方client/configs内的验证码参数，不读取账号凭据", async () => {
  const { BigModelCodingPlanSubscriptionProvider } =
    await import("../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js");
  let calls = 0;
  let credentials = 0;
  const provider = new BigModelCodingPlanSubscriptionProvider({
    apiClient: {
      async request(input: string | URL) {
        calls++;
        assert.match(String(input), /\/api\/v1\/client\/configs/);
        return Response.json({
          code: 0,
          data: {
            configs: {
              captcha: { enabled: true, sceneId: "scene", prefix: "prefix", region: "cn" },
            },
          },
        });
      },
    },
    credentialService: {
      async load() {
        credentials++;
        return null;
      },
    },
  } as never);
  assert.equal((await provider.getCaptchaConfig())?.enabled, true);
  assert.equal((await provider.getCaptchaConfig())?.region, "cn");
  assert.equal(calls, 2, "verification config cannot use the one-hour product cache");
  assert.equal(credentials, 0);
});
