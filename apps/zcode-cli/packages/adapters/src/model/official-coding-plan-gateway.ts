import type {
  ProviderEndpointRoutingDecision,
  ProviderEndpointRoutingPort,
} from "@zcode/contracts";
import type { EnvRecord } from "./model-execution.js";

const HTTPS_DEFAULT_PORT = "443";
const ROOT_PATH = "/";

/**
 * 官方 Coding Plan 的模型请求经 ZCode 平台网关发送。
 *
 * Z.ai / BigModel Coding Plan 是 ZCode 的官方订阅套餐，模型请求统一发往 ZCode 平台网关，
 * 由平台完成套餐权益校验等平台侧处理后转发到对应的模型服务。本模块只做 URL 决策：
 * 把下表中的官方模型端点替换为对应的网关端点，Host 清理与请求/响应透传由公共 fetch
 * wrapper 负责。
 *
 * 只对下表中的官方端点生效，按协议、主机、端口、路径精确匹配，用户自建 provider 与
 * 第三方模型服务不受影响。网关固定官方 origin；自建中继/更新站不能接收官方账号凭据。
 */
const GATEWAY_PATH_BY_ENDPOINT: ReadonlyMap<string, string> = new Map([
  ["https://open.bigmodel.cn:443/api/anthropic/v1/messages", "/api/v1/ultra/anthropic/v1/messages"],
  ["https://api.z.ai:443/api/anthropic/v1/messages", "/api/v1/ultra-zai/anthropic/v1/messages"],
]);

/**
 * 自托管开关：关闭官方 Coding Plan 网关改写，让模型请求直连 provider 声明的端点。
 * 平台网关（zcode.z.ai）需要 ZCode 账号鉴权，去掉强制登录后必须能绕过，否则请求会 401。
 */
export function isOfficialCodingPlanGatewayDisabled(env: EnvRecord = process.env): boolean {
  return env.ZCODE_DISABLE_OFFICIAL_CODING_PLAN_GATEWAY === "1";
}

/** 静态实现只提供 URL 决策；Host 清理、请求与响应透传由公共 fetch wrapper 负责。 */
export function createStaticProviderEndpointRoutingPort(
  endpointOrigin: string,
  env: EnvRecord = process.env,
): ProviderEndpointRoutingPort {
  return {
    async resolve(requestUrl): Promise<ProviderEndpointRoutingDecision> {
      // 自托管：显式关闭网关改写时直接放行原 URL，不做任何端点替换。
      if (isOfficialCodingPlanGatewayDisabled(env)) {
        return { routed: false, url: requestUrl };
      }
      let parsed: URL;
      try {
        parsed = new URL(requestUrl);
      } catch {
        return { routed: false, url: requestUrl };
      }
      if (parsed.protocol !== "https:") return { routed: false, url: requestUrl };
      const path =
        parsed.pathname === ROOT_PATH
          ? ROOT_PATH
          : parsed.pathname.replace(/\/+$/u, "") || ROOT_PATH;
      const key = `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${parsed.port || HTTPS_DEFAULT_PORT}${path}`;
      const targetPath = GATEWAY_PATH_BY_ENDPOINT.get(key);
      if (!targetPath) return { routed: false, url: requestUrl };
      const target = new URL(targetPath, endpointOrigin);
      target.search = parsed.search;
      return { routed: true, url: target.href };
    },
  };
}
