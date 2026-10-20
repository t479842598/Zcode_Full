// ============================================================
// 官方限时套餐领取失败的归因（零依赖，browser-safe）
// ============================================================
// 单独成文件的原因：`manualClaimPlan.ts` 要 import `readApiJson` 做网络请求，
// 而 UI 包需要这个纯函数来选提示文案。混在一起会让 renderer bundle 拖入服务端实现。
//
// 官方把非 0 code 映射到 `manualClaimPlan.claim.failure.*` 文案 key，
// 这里保留同一套语义（服务端不返回结构化 reason，只能按 code + message 判）。

export type ManualClaimPlanFailureReason =
  | "loginRequired"
  | "notFound"
  | "unavailable"
  | "alreadyClaimed"
  | "ineligible"
  | "invalidRequest"
  | "captcha"
  | "quotaExhausted"
  | "generic";

/** 按 HTTP 语义 code 优先，其次看服务端 message 关键词。 */
export function resolveManualClaimPlanFailureReason(
  code: number,
  message: string,
): ManualClaimPlanFailureReason {
  const normalized = message.trim().toLowerCase();
  if (code === 401 || code === 403) return "loginRequired";
  if (code === 404) return "notFound";
  if (code === 409) return "alreadyClaimed";
  if (code === 410) return "unavailable";
  if (normalized.includes("quota") || normalized.includes("名额")) return "quotaExhausted";
  if (normalized.includes("captcha") || normalized.includes("验证码")) return "captcha";
  if (normalized.includes("already") || normalized.includes("已经领取")) return "alreadyClaimed";
  if (
    normalized.includes("eligible") ||
    normalized.includes("version") ||
    normalized.includes("不满足")
  ) {
    return "ineligible";
  }
  if (code === 400 || code === 422) return "invalidRequest";
  return "generic";
}
