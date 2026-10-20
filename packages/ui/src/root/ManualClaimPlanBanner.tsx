import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ICodingPlanSubscriptionService,
  ManualClaimPlanPreview,
  ManualClaimPlanClaimResult,
} from "@zcode/services";
import { resolveManualClaimPlanFailureReason } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { verifyStartPlanCaptcha } from "@/root/startPlanCaptcha.js";

// ============================================================
// 官方限时可领取体验套餐横幅
// ============================================================
// 对齐官方 3.14.3 的 manualClaimPlan banner：官方发放额度时，客户端在对话页顶部
// 显示「限时可领取」横幅，用户点「领取」即完成领取，不需要自己去找活动页。
//
// 数据源是独立 billing 端点（见 services/manualClaimPlan.ts），不是活动页 WebView。
// 领取需要阿里云验证码：复用 Start Plan 已有的 verifyStartPlanCaptcha，不新造一套。
//
// 关闭语义与官方一致：关闭时弹二次确认（官方文案「您将错过一次领取机会」），
// 确认后本次会话内不再提示该 plan（不落盘，避免用户下次打开被永久静默）。

type ClaimPhase = "idle" | "verifying" | "submitting" | "success" | "failure";

interface ClaimOutcome {
  readonly phase: ClaimPhase;
  readonly result: ManualClaimPlanClaimResult | null;
  readonly reason: string | null;
}

const IDLE_OUTCOME: ClaimOutcome = { phase: "idle", result: null, reason: null };

/** 取套餐里第一个 entitlement 的展示信息，用于「{model} 每日额度」这类副标题。 */
function describePlan(plan: ManualClaimPlanPreview): {
  model: string;
  period: "daily" | "oneTime";
  amount: number;
} {
  const entitlement = [...plan.entitlements].sort((left, right) => right.priority - left.priority)[0];
  const model = entitlement?.showName || plan.name || plan.planId;
  const period = entitlement?.period?.toLowerCase() === "daily" ? "daily" : "oneTime";
  return { model, period, amount: entitlement?.grantUnits ?? 0 };
}

function formatGrantAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "";
  if (amount >= 100_000_000) return `${Number((amount / 100_000_000).toFixed(2))}亿`;
  if (amount >= 10_000) return `${Number((amount / 10_000).toFixed(2))}万`;
  return String(amount);
}

export function ManualClaimPlanBanner({
  codingPlanService,
  enabled,
  userId,
}: {
  codingPlanService: Pick<
    ICodingPlanSubscriptionService,
    "getManualClaimPlanPreviews" | "claimManualPlan" | "getCaptchaConfig"
  >;
  enabled: boolean;
  userId: string | null;
}) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const [plan, setPlan] = useState<ManualClaimPlanPreview | null>(null);
  const [outcome, setOutcome] = useState<ClaimOutcome>(IDLE_OUTCOME);
  const [dismissConfirmOpen, setDismissConfirmOpen] = useState(false);
  const dismissedPlanIds = useRef(new Set<string>());
  const claimAbort = useRef<AbortController | null>(null);

  // 只在已登录时查询；未登录官方也是直接返回空列表，这里省掉一次无效往返。
  useEffect(() => {
    if (!enabled || !userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await codingPlanService.getManualClaimPlanPreviews();
        if (cancelled) return;
        const next =
          [...result.plans]
            .sort((left, right) => right.priority - left.priority)
            .find((candidate) => !dismissedPlanIds.current.has(candidate.planId)) ?? null;
        setPlan(next);
      } catch {
        // 查询失败静默：这是营销提示，失败不该打断用户工作。
        if (!cancelled) setPlan(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [codingPlanService, enabled, userId]);

  useEffect(() => () => claimAbort.current?.abort(), []);

  const claim = useCallback(async () => {
    if (!plan) return;
    const controller = new AbortController();
    claimAbort.current?.abort();
    claimAbort.current = controller;
    setOutcome({ phase: "verifying", result: null, reason: null });
    try {
      const captchaConfig = await codingPlanService.getCaptchaConfig();
      if (!captchaConfig) {
        setOutcome({
          phase: "failure",
          result: null,
          reason: intl.formatMessage({ id: "manualClaimPlan.claim.failure.generic" }),
        });
        return;
      }
      const captchaVerifyParam = await verifyStartPlanCaptcha(
        captchaConfig,
        controller.signal,
        locale === "zh-CN" ? "zh-CN" : "en-US",
      );
      controller.signal.throwIfAborted();
      setOutcome({ phase: "submitting", result: null, reason: null });
      // captchaConfig.region 经 zod 推断为 {} | undefined；官方把它当字符串直传，这里同样取值。
      const captchaRegion = String(captchaConfig.region ?? "");
      const result = await codingPlanService.claimManualPlan({
        planId: plan.planId,
        captchaVerifyParam,
        ...(captchaRegion ? { captchaRegion } : {}),
      });
      if (controller.signal.aborted) return;
      if (result.success) {
        setOutcome({ phase: "success", result, reason: null });
        return;
      }
      const reasonKey = resolveManualClaimPlanFailureReason(result.code, result.message);
      setOutcome({
        phase: "failure",
        result,
        reason: intl.formatMessage({ id: `manualClaimPlan.claim.failure.${reasonKey}` }),
      });
    } catch {
      if (controller.signal.aborted) return;
      setOutcome({
        phase: "failure",
        result: null,
        reason: intl.formatMessage({ id: "manualClaimPlan.claim.failure.generic" }),
      });
    }
  }, [codingPlanService, intl, locale, plan]);

  const closePlan = useCallback(() => {
    if (plan) dismissedPlanIds.current.add(plan.planId);
    setPlan(null);
    setDismissConfirmOpen(false);
    setOutcome(IDLE_OUTCOME);
  }, [plan]);

  const summary = useMemo(() => (plan ? describePlan(plan) : null), [plan]);
  const amountLabel = summary ? formatGrantAmount(summary.amount) : "";
  const busy = outcome.phase === "verifying" || outcome.phase === "submitting";

  // 成功态：官方展示「{plan} 领取成功」+ 生效时间，提供查看套餐入口。
  if (outcome.phase === "success") {
    const claimed = outcome.result?.success === true ? outcome.result.plan : null;
    const startsAt = claimed?.startsAt;
    const description = startsAt
      ? `${intl.formatMessage(
          { id: "manualClaimPlan.claim.success.pending.description.beforeTime" },
          {},
        )}${new Date(startsAt).toLocaleString(locale)}${intl.formatMessage(
          { id: "manualClaimPlan.claim.success.pending.description.afterTime" },
          {},
        )}`
      : intl.formatMessage({ id: "manualClaimPlan.claim.success.description" });
    return (
      <BannerShell>
        <div className="flex flex-1 flex-col gap-1">
          <p className="text-ui-base font-medium text-foreground">
            {intl.formatMessage(
              { id: "manualClaimPlan.claim.success.title" },
              { plan: claimed?.planId || plan?.name || "" },
            )}
          </p>
          <p className="text-ui-base text-foreground-subtle">{description}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" onClick={() => platform.openExternal(OFFICIAL_PLAN_URL)}>
            {intl.formatMessage({ id: "manualClaimPlan.claim.dialog.modelSettings" })}
          </Button>
          <Button variant="outline" size="sm" onClick={closePlan}>
            {intl.formatMessage({ id: "manualClaimPlan.claim.success.acknowledge" })}
          </Button>
        </div>
      </BannerShell>
    );
  }

  if (!plan) return null;

  return (
    <>
      <BannerShell>
        <div className="flex flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-ui-xs font-medium text-primary">
              {intl.formatMessage({ id: "manualClaimPlan.banner.tag" })}
            </span>
            {summary ? (
              <span className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({
                  id:
                    summary.period === "daily"
                      ? "manualClaimPlan.banner.period.daily"
                      : "manualClaimPlan.banner.period.oneTime",
                })}
              </span>
            ) : null}
          </div>
          {summary ? (
            <p className="text-ui-base text-foreground">
              {intl.formatMessage(
                {
                  id:
                    summary.period === "daily"
                      ? "manualClaimPlan.banner.subtitle.daily"
                      : "manualClaimPlan.banner.subtitle.oneTime",
                },
                { model: summary.model },
              )}
              {amountLabel ? (
                <span className="ml-2 font-medium text-primary">
                  {amountLabel} {intl.formatMessage({ id: "manualClaimPlan.banner.unit.tokens" })}
                </span>
              ) : null}
            </p>
          ) : null}
          {outcome.phase === "failure" && outcome.reason ? (
            <p role="alert" className="text-ui-base text-destructive">
              {outcome.reason}
            </p>
          ) : null}
          {busy ? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id:
                  outcome.phase === "verifying"
                    ? "manualClaimPlan.claim.verifying"
                    : "manualClaimPlan.claim.submitting",
              })}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void claim()}>
            {intl.formatMessage({ id: "manualClaimPlan.banner.claim" })}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={intl.formatMessage({ id: "manualClaimPlan.banner.close" })}
            onClick={() => setDismissConfirmOpen(true)}
          >
            {intl.formatMessage({ id: "manualClaimPlan.banner.close" })}
          </Button>
        </div>
      </BannerShell>
      {dismissConfirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-xl border border-border bg-card p-5 text-card-foreground shadow-lg"
          >
            <p className="text-ui-lg font-medium">
              {intl.formatMessage({ id: "manualClaimPlan.banner.dismissConfirm.title" })}
            </p>
            <p className="mt-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "manualClaimPlan.banner.dismissConfirm.description" })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closePlan}>
                {intl.formatMessage({ id: "manualClaimPlan.banner.dismissConfirm.close" })}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setDismissConfirmOpen(false);
                  void claim();
                }}
              >
                {intl.formatMessage({ id: "manualClaimPlan.banner.dismissConfirm.claim" })}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

const OFFICIAL_PLAN_URL = "https://zcode.z.ai/cn/settings/plan";

function BannerShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-primary/5 px-4 py-2.5">
      {children}
    </div>
  );
}
