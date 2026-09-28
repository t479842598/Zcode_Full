import type { ApiClient } from "@zcode/shared";
import { buildOfficialZCodeApiUrl, ZCODE_VERSION } from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";

// 归因类型与纯函数在 manualClaimPlanFailure.ts（零依赖，UI 包直接消费）。
export type { ManualClaimPlanFailureReason } from "./manualClaimPlanFailure.js";
export { resolveManualClaimPlanFailureReason } from "./manualClaimPlanFailure.js";

// ============================================================
// 官方限时可领取体验套餐（manual claim plan）
// ============================================================
// 对齐官方 3.14.3 `/out/host/index.js` 的 getManualClaimPlanPreviews /
// claimManualPlan 实现。这是官方「发额度后客户端主动提示领取」的真实链路，
// 与活动页 WebView（/cn/rewards）无关：后者是营销活动，前者是套餐发放。
//
//   1. GET  /api/v1/zcode-plan/billing/preview?app_version=&platform=
//      → 列出当前账号可领取的套餐（服务端按账号与版本判定资格）
//   2. POST /api/v1/zcode-plan/billing/claim   body { plan_id }
//      → 领取；需要阿里云验证码参数（captchaVerifyParam / captchaRegion）
//
// 凭据使用 `zcodejwttoken`（与官方一致），未登录时不发请求。

const REQUEST_TIMEOUT_MS = 15_000;
const ZCODE_JWT_CREDENTIAL_KEY = "zcodejwttoken";

export interface ManualClaimPlanEntitlement {
  readonly entitlementId: string;
  readonly showName: string;
  readonly meter: string;
  readonly unitType: string;
  readonly capabilities: readonly string[];
  readonly grantUnits: number;
  readonly period: string;
  readonly priority: number;
  readonly effectiveAt?: number;
}

export interface ManualClaimPlanPreview {
  readonly planId: string;
  readonly name: string;
  readonly description: string;
  readonly priority: number;
  readonly entitlements: readonly ManualClaimPlanEntitlement[];
}

export interface ManualClaimPlanPreviewResult {
  readonly serverTime?: number;
  readonly plans: readonly ManualClaimPlanPreview[];
}

export interface ManualClaimPlanClaimInput {
  readonly planId: string;
  readonly captchaVerifyParam: string;
  readonly captchaRegion?: string;
}

export interface ManualClaimPlanClaimedEntitlement {
  readonly entitlementId: string;
  readonly showName: string;
  readonly effectiveAt?: number;
}

export interface ManualClaimPlanClaimedPlan {
  readonly userPlanId: string;
  readonly planId: string;
  readonly status: string;
  readonly startsAt?: number;
  readonly endsAt?: number;
  readonly entitlements: readonly ManualClaimPlanClaimedEntitlement[];
}

export type ManualClaimPlanClaimResult =
  | {
      readonly success: true;
      readonly code: 0;
      readonly message: string;
      readonly serverTime?: number;
      readonly plan: ManualClaimPlanClaimedPlan;
    }
  | {
      readonly success: false;
      readonly code: number;
      readonly message: string;
      readonly serverTime?: number;
      readonly failureEndsAt?: number;
    };

/** 官方把秒级 server_time 转毫秒；非法值返回 undefined 而不是 NaN。 */
function readServerTimeMilliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value * 1000
    : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveClientPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

interface ManualClaimPlanPreviewEnvelope {
  code?: number;
  msg?: string;
  data?: {
    server_time?: number;
    plans?: Array<{
      plan_id?: string;
      name?: string;
      description?: string;
      priority?: number;
      entitlements?: Array<{
        entitlement_id?: string | null;
        show_name?: string | null;
        meter?: string | null;
        unit_type?: string | null;
        capabilities?: string[] | null;
        grant_units?: number | null;
        period?: string | null;
        priority?: number | null;
        effective_at?: number | null;
      }> | null;
    }> | null;
  };
}

interface ManualClaimPlanClaimEnvelope {
  code?: number | string;
  msg?: string;
  data?: {
    server_time?: number;
    message?: string;
    plan?: {
      user_plan_id?: string;
      plan_id?: string;
      status?: string;
      starts_at?: number | null;
      ends_at?: number | null;
      entitlements?: Array<{
        entitlement_id?: string | null;
        show_name?: string | null;
        effective_at?: number | null;
      }> | null;
    };
  };
}

export interface ManualClaimPlanDependencies {
  readonly apiClient: ApiClient;
  readonly credentialService: { load(key: string): Promise<string | null> };
}

/**
 * 读取可领取套餐列表。未登录直接返回空列表（不发请求），与官方一致。
 */
export async function fetchManualClaimPlanPreviews(
  dependencies: ManualClaimPlanDependencies,
): Promise<ManualClaimPlanPreviewResult> {
  const token = (await dependencies.credentialService.load(ZCODE_JWT_CREDENTIAL_KEY))?.trim();
  if (!token) return { plans: [] };

  const url = new URL(buildOfficialZCodeApiUrl("/api/v1/zcode-plan/billing/preview"));
  url.searchParams.set("app_version", ZCODE_VERSION);
  url.searchParams.set("platform", resolveClientPlatformKey());

  const envelope = await readApiJson<ManualClaimPlanPreviewEnvelope>(
    dependencies.apiClient,
    url,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  );

  if (envelope.code !== undefined && envelope.code !== 0) {
    throw new Error(envelope.msg?.trim() || "manual_claim_preview_failed");
  }
  if (!envelope.data) {
    throw new Error(envelope.msg?.trim() || "manual_claim_preview_missing_data");
  }

  const serverTime = readServerTimeMilliseconds(envelope.data.server_time);
  const plans = (envelope.data.plans ?? []).flatMap((plan) => {
    const planId = readTrimmedString(plan.plan_id);
    if (!planId) return [];
    const entitlements = (plan.entitlements ?? []).flatMap((entitlement) => {
      const entitlementId = readTrimmedString(entitlement.entitlement_id);
      if (!entitlementId) return [];
      const effectiveAt = readFiniteNumber(entitlement.effective_at);
      return [
        {
          entitlementId,
          showName: readTrimmedString(entitlement.show_name),
          meter: readTrimmedString(entitlement.meter),
          unitType: readTrimmedString(entitlement.unit_type),
          capabilities: entitlement.capabilities ?? [],
          grantUnits: readFiniteNumber(entitlement.grant_units) ?? 0,
          period: readTrimmedString(entitlement.period),
          priority: readFiniteNumber(entitlement.priority) ?? 0,
          ...(effectiveAt === undefined ? {} : { effectiveAt }),
        },
      ];
    });
    return [
      {
        planId,
        name: readTrimmedString(plan.name) || planId,
        description: readTrimmedString(plan.description),
        priority: readFiniteNumber(plan.priority) ?? 0,
        entitlements,
      },
    ];
  });

  return { ...(serverTime === undefined ? {} : { serverTime }), plans };
}

/**
 * 领取指定套餐。官方语义：HTTP 失败与非 0 code 都折算成结构化失败结果，
 * 由 UI 决定提示；不抛异常，避免「领取结果不明」被误判为可重试。
 */
export async function claimManualPlan(
  dependencies: ManualClaimPlanDependencies,
  input: ManualClaimPlanClaimInput,
): Promise<ManualClaimPlanClaimResult> {
  const token = (await dependencies.credentialService.load(ZCODE_JWT_CREDENTIAL_KEY))?.trim();
  if (!token) return { success: false, code: 401, message: "" };

  const envelope = await readApiJson<ManualClaimPlanClaimEnvelope>(
    dependencies.apiClient,
    new URL(buildOfficialZCodeApiUrl("/api/v1/zcode-plan/billing/claim")),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Aliyun-Captcha-Verify-Param": input.captchaVerifyParam,
        ...(input.captchaRegion ? { "X-Aliyun-Captcha-Verify-Region": input.captchaRegion } : {}),
        "X-ZCode-App-Version": ZCODE_VERSION,
        "X-Platform": resolveClientPlatformKey(),
      },
      body: JSON.stringify({ plan_id: input.planId }),
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  );

  const rawCode = envelope.code;
  const code =
    typeof rawCode === "number"
      ? rawCode
      : typeof rawCode === "string" && /^\d+$/u.test(rawCode)
        ? Number(rawCode)
        : -1;
  const serverTime = readServerTimeMilliseconds(envelope.data?.server_time);

  if (code !== 0 || !envelope.data?.plan) {
    const failureEndsAt = readFiniteNumber(envelope.data?.plan?.ends_at);
    return {
      success: false,
      code,
      message: readTrimmedString(envelope.data?.message),
      ...(serverTime === undefined ? {} : { serverTime }),
      ...(failureEndsAt === undefined ? {} : { failureEndsAt }),
    };
  }

  const plan = envelope.data.plan;
  return {
    success: true,
    code: 0,
    message: readTrimmedString(envelope.msg),
    ...(serverTime === undefined ? {} : { serverTime }),
    plan: {
      userPlanId: readTrimmedString(plan.user_plan_id),
      planId: readTrimmedString(plan.plan_id) || input.planId,
      status: readTrimmedString(plan.status),
      ...(readFiniteNumber(plan.starts_at) === undefined
        ? {}
        : { startsAt: readFiniteNumber(plan.starts_at)! }),
      ...(readFiniteNumber(plan.ends_at) === undefined
        ? {}
        : { endsAt: readFiniteNumber(plan.ends_at)! }),
      entitlements: (plan.entitlements ?? []).flatMap((entitlement) => {
        const entitlementId = readTrimmedString(entitlement.entitlement_id);
        if (!entitlementId) return [];
        const effectiveAt = readFiniteNumber(entitlement.effective_at);
        return [
          {
            entitlementId,
            showName: readTrimmedString(entitlement.show_name),
            ...(effectiveAt === undefined ? {} : { effectiveAt }),
          },
        ];
      }),
    },
  };
}
