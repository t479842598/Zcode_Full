import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, normalizeZCodeEndpointOrigin } from "@zcode/shared";

const DEFAULT_SELFHOST_UPDATE_ORIGIN = "https://zcode.tang74.top";

/** 更新清单和账号业务不能共用 origin；保留已有自建配置但不回退官方升级源。 */
export function resolveSelfhostUpdateOrigin(options: {
  env?: Record<string, string | undefined>;
  overrideOrigin?: string | null;
  envBaseOrigin?: string | null;
} = {}): string {
  const configured =
    options.env?.ZCODE_SELFHOST_UPDATE_ORIGIN?.trim() ||
    options.overrideOrigin?.trim() ||
    options.envBaseOrigin?.trim();
  // 打包态 loadHostProcessEnvFromLocalFiles() 返回空、settings 里 zcodeEndpointOrigin 默认也为空，
  // 此时 configured 为空 → 直接用自托管源。这正是「更新必须走自己的分发服务器」的常态。
  if (!configured) {
    return DEFAULT_SELFHOST_UPDATE_ORIGIN;
  }
  const origin = normalizeZCodeEndpointOrigin(configured);
  // 用户显式把 endpoint 指到官方（或旧配置残留官方值）时，更新源仍须留在自托管，
  // 否则账号业务的身份判定会连带把升级通道交回官方。
  return origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN ? DEFAULT_SELFHOST_UPDATE_ORIGIN : origin;
}
