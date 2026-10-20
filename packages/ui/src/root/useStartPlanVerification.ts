import { useEffect } from "react";
import {
  isEnabledCaptchaConfig,
  isModelRequestVerificationRequired,
  type IServiceAccessor,
} from "@zcode/services";
import type { ZCodeProviderRuntimeHeadersRequestParams } from "@zcode/shared";
import { logger } from "@/logger.js";
import { resolveStartPlanCaptchaFailureReason, verifyStartPlanCaptcha } from "./startPlanCaptcha.js";

/** 仅桌面 Host 收到请求级挑战时验证；移动端不复制账号令牌或安全证明。 */
export function useStartPlanVerification(
  services: IServiceAccessor,
  enabled: boolean | undefined,
  locale: "zh-CN" | "en-US",
): void {
  useEffect(() => {
    if (!enabled) return;
    const pending = new Map<string, AbortController>();
    const key = (request: ZCodeProviderRuntimeHeadersRequestParams) =>
      `${request.workspace.workspaceKey}\0${request.sessionId}\0${request.requestId}`;
    const subscription = services.zcodeAgentService.onDynamicStartPlanVerificationRequest()(
      (request) => {
        const id = key(request);
        if (pending.has(id)) return;
        const controller = new AbortController();
        pending.set(id, controller);
        void (async () => {
          let captchaVerifyParam: string | undefined;
          let captchaRegion: string | undefined;
          let verificationNotRequired = false;
          let failureReason: string | undefined;
          try {
            const config = await services.codingPlanSubscriptionService.getCaptchaConfig();
            if (!config) throw new Error("Start Plan verification unavailable");
            // 官方 3.14.4 起可能以 `captcha.skip_model_request` 关闭模型请求侧校验
            // （enabled 仍为 true）。此时不唤起 SDK，按"无需验证"回执。
            if (!isModelRequestVerificationRequired(config)) verificationNotRequired = true;
            else if (isEnabledCaptchaConfig(config)) {
              captchaRegion = config.region;
              captchaVerifyParam = await verifyStartPlanCaptcha(config, controller.signal, locale);
            } else throw new Error("Start Plan verification unavailable");
          } catch (error) {
            // 归因原因必须落到日志：此前五类断点折成同一句，线上无法定位环节。
            failureReason = resolveStartPlanCaptchaFailureReason(error);
            logger.warn("[start-plan] 本次请求验证失败", {
              reason: failureReason,
              detail: error instanceof Error ? error.message : "unknown",
            });
          }
          if (controller.signal.aborted) return;
          try {
            await services.zcodeAgentService.respondStartPlanVerification({
              requestId: request.requestId,
              sessionId: request.sessionId,
              workspace: request.workspace,
              ...(captchaVerifyParam ? { captchaVerifyParam } : {}),
              ...(captchaRegion ? { captchaRegion } : {}),
              ...(verificationNotRequired ? { verificationNotRequired } : {}),
            });
          } catch (error) {
            logger.warn("[start-plan] 过期验证响应已丢弃", {
              reason: error instanceof Error ? error.message : "unknown",
            });
          } finally {
            pending.delete(id);
          }
        })();
      },
    );
    const cancelledSubscription =
      services.zcodeAgentService.onDynamicStartPlanVerificationCancelled()(
        ({ requestId, sessionId, workspaceKey }) => {
          pending.get(`${workspaceKey}\0${sessionId}\0${requestId}`)?.abort();
          pending.delete(`${workspaceKey}\0${sessionId}\0${requestId}`);
        },
      );
    return () => {
      subscription.dispose();
      cancelledSubscription.dispose();
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, [enabled, locale, services.codingPlanSubscriptionService, services.zcodeAgentService]);
}
