import type { CaptchaConfig } from "@zcode/services";

const CAPTCHA_SCRIPT = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const VERIFY_TIMEOUT_MS = 120_000;
let verificationQueue: Promise<void> = Promise.resolve();

/**
 * 验证码失败的可归因分类。
 *
 * 背景：此前五类断点都折成同一句 "Captcha verification failed"，界面与日志无法区分
 * 「脚本没加载到」「SDK 没初始化」「无痕校验没过」「超时」「被取消」，
 * 导致线上「一直提示需要验证码且过不了」无法定位到具体环节。
 * 取证：docs/2026-10-08-captcha-forensics.md 第三节四段排除表。
 */
export type StartPlanCaptchaFailureReason =
  /** 配置缺失或结构不全（含 region/prefix/sceneId 任一为空）。 */
  | "config-unavailable"
  /** o.alicdn.com 的 SDK 脚本加载失败（网络/CSP/被拦截）。 */
  | "script-load-failed"
  /** 脚本加载超时（10s 未 onload）。 */
  | "script-load-timeout"
  /** 脚本已加载但未暴露 initAliyunCaptcha。 */
  | "sdk-unavailable"
  /** SDK 初始化抛错。 */
  | "sdk-init-failed"
  /** 无痕校验/交互校验未通过（阿里云返回失败）。 */
  | "verify-failed"
  /** 校验超时（120s）。 */
  | "verify-timeout"
  /** 用户或上层取消。 */
  | "cancelled";

/** 带归因原因的验证失败错误；`name` 固定，便于上层按类型判定。 */
export class StartPlanCaptchaError extends Error {
  readonly reason: StartPlanCaptchaFailureReason;

  constructor(reason: StartPlanCaptchaFailureReason, message?: string) {
    super(message ?? `Captcha verification failed: ${reason}`);
    this.name = "StartPlanCaptchaError";
    this.reason = reason;
  }
}

/** 从任意错误里取出可归因原因；非本模块错误返回 "unknown"。 */
export function resolveStartPlanCaptchaFailureReason(error: unknown): string {
  if (error instanceof StartPlanCaptchaError) return error.reason;
  if (error instanceof Error && error.message.includes("cancelled")) return "cancelled";
  return "unknown";
}

function fail(reason: StartPlanCaptchaFailureReason): StartPlanCaptchaError {
  return new StartPlanCaptchaError(reason);
}

async function claimVerificationSlot(signal: AbortSignal): Promise<() => void> {
  let release!: () => void;
  const previous = verificationQueue;
  verificationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(fail("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      previous.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      if (signal.aborted) onAbort();
    });
    signal.throwIfAborted();
    return release;
  } catch (error) {
    // 排队者取消后仍须等待前一轮释放，再交给后续请求；否则第三轮会并发进入SDK。
    void previous.then(release);
    throw error;
  }
}

interface CaptchaInstance {
  show?(): void;
  startTracelessVerification?(): void;
}

type CaptchaInitializer = (options: {
  SceneId: string;
  mode: "popup";
  language: "cn" | "en";
  element: string;
  button: string;
  getInstance: (instance: CaptchaInstance) => void;
  success: (value: string) => void;
  fail: (error: unknown) => void;
  onError: (error: unknown) => void;
}) => void;

async function loadCaptchaScript(signal: AbortSignal): Promise<void> {
  if ((window as Window & { initAliyunCaptcha?: CaptchaInitializer }).initAliyunCaptcha) return;
  const script = document.createElement("script");
  script.src = CAPTCHA_SCRIPT;
  script.async = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        script.onload = null;
        script.onerror = null;
      };
      const onAbort = () => {
        cleanup();
        reject(fail("cancelled"));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(fail("script-load-timeout"));
      }, 10_000);
      script.onload = () => {
        cleanup();
        resolve();
      };
      script.onerror = () => {
        cleanup();
        reject(fail("script-load-failed"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      document.head.appendChild(script);
    });
  } catch (error) {
    script.remove();
    throw error;
  }
}

/** 仅用官方配置初始化SDK；单次结果不落盘、不复用，不读取账号令牌。 */
export async function verifyStartPlanCaptcha(
  config: CaptchaConfig,
  signal: AbortSignal,
  locale: "zh-CN" | "en-US",
): Promise<string> {
  signal.throwIfAborted();
  if (!config.enabled || !config.region || !config.prefix || !config.sceneId) {
    throw fail("config-unavailable");
  }
  const releaseSlot = await claimVerificationSlot(signal);
  const previousConfig = (window as Window & { AliyunCaptchaConfig?: unknown }).AliyunCaptchaConfig;
  const container = document.createElement("div");
  const id = `zcode-captcha-${crypto.randomUUID()}`;
  const mountId = `${id}-mount`;
  const buttonId = `${id}-button`;
  container.id = id;
  container.className = "fixed bottom-4 right-4 z-[9999]";
  const mount = document.createElement("div");
  mount.id = mountId;
  const button = document.createElement("button");
  button.id = buttonId;
  button.type = "button";
  button.textContent = locale === "zh-CN" ? "进行安全验证" : "Verify request";
  button.className = "rounded border border-border bg-background px-3 py-2 text-foreground";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = locale === "zh-CN" ? "取消验证" : "Cancel verification";
  cancel.className = button.className;
  container.append(mount, button, cancel);
  document.body.appendChild(container);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await loadCaptchaScript(signal);
    signal.throwIfAborted();
    const initializer = (window as Window & { initAliyunCaptcha?: CaptchaInitializer })
      .initAliyunCaptcha;
    if (!initializer) throw fail("sdk-unavailable");
    (
      window as Window & { AliyunCaptchaConfig?: { region: string; prefix: string } }
    ).AliyunCaptchaConfig = {
      region: config.region,
      prefix: config.prefix,
    };
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (value?: string, error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else if (value?.trim()) resolve(value.trim());
        else reject(fail("verify-failed"));
      };
      abort = () => finish(undefined, fail("cancelled"));
      cancel.onclick = abort;
      signal.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(
        () => finish(undefined, fail("verify-timeout")),
        VERIFY_TIMEOUT_MS,
      );
      try {
        initializer({
          SceneId: config.sceneId,
          mode: "popup",
          language: locale === "zh-CN" ? "cn" : "en",
          element: `#${mountId}`,
          button: `#${buttonId}`,
          getInstance(instance) {
            if (settled) return;
            if (instance.startTracelessVerification) instance.startTracelessVerification();
            else button.click();
          },
          success(value) {
            finish(value);
          },
          fail(error) {
            if (settled) return;
            if (
              typeof error === "object" &&
              error !== null &&
              "verifyResult" in error &&
              (error as { verifyResult?: unknown }).verifyResult === false
            ) {
              button.click();
              return;
            }
            finish(undefined, fail("verify-failed"));
          },
          onError() {
            finish(undefined, fail("verify-failed"));
          },
        });
      } catch {
        finish(undefined, fail("sdk-init-failed"));
      }
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abort) signal.removeEventListener("abort", abort);
    cancel.onclick = null;
    container.remove();
    (window as Window & { AliyunCaptchaConfig?: unknown }).AliyunCaptchaConfig = previousConfig;
    releaseSlot();
  }
}
