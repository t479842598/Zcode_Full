import { z } from "zod";

/**
 * 官方 client/configs 的验证配置；未返回配置与明确关闭必须区分。
 *
 * `skip_model_request`（snake_case，官方 3.14.4 新增）：服务端用它在不把 `enabled`
 * 置 false 的前提下关闭**模型请求侧**的验证码校验（保留其它场景仍需验证）。
 * 官方 asar 的 getCaptchaConfig 会把它映射为 `skipModelRequest` 并在判定处短路：
 *   `enabled===false || skipModelRequest===true` → 直接放行、不唤起 SDK。
 * 取证：docs/2026-10-08-captcha-forensics.md 第三节、docs/2026-10-08-official-upstream-delta.md。
 */
export const captchaConfigSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).passthrough(),
  z
    .object({
      enabled: z.literal(true).default(true),
      region: z.string().min(1),
      prefix: z.string().min(1),
      sceneId: z.string().min(1),
      skipModelRequest: z.boolean().optional(),
    })
    .passthrough(),
]);

export type CaptchaConfig = z.infer<typeof captchaConfigSchema>;

/** 窄化后的启用态配置：区域/前缀/场景 均为已验证的非空字符串。 */
export interface EnabledCaptchaConfig {
  enabled: true;
  region: string;
  prefix: string;
  sceneId: string;
  skipModelRequest?: boolean;
}

export function isEnabledCaptchaConfig(
  config: CaptchaConfig,
): config is CaptchaConfig & EnabledCaptchaConfig {
  return config.enabled === true;
}

/** 官方字段名（snake_case）→ 内部字段名，与官方 asar 的解构映射逐字对应。 */
export function parseCaptchaConfig(raw: unknown): CaptchaConfig | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const { skip_model_request: skipModelRequest, ...rest } = raw as Record<string, unknown>;
  const normalized =
    typeof skipModelRequest === "boolean" ? { ...rest, skipModelRequest } : rest;
  const result = captchaConfigSchema.safeParse(normalized);
  return result.success ? result.data : null;
}

/** 模型请求是否需要走验证码：配置缺失视为需要（fail-closed），显式关闭或跳过才算免验证。 */
export function isModelRequestVerificationRequired(config: CaptchaConfig | null): boolean {
  if (!config) return true;
  if (!config.enabled) return false;
  return config.skipModelRequest !== true;
}
