import { buildZCodeEndpointUrls, DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";

// 自托管：套餐页/官网购买页会接收账号凭据，不能复用自托管中继或自建更新站注入的
// Vite base url（VITE_ZCODE_BASE_URL / VITE_ZCODE_ENDPOINT_ORIGIN），必须固定走官方域名。
export const RENDERER_ZCODE_ENDPOINT_URLS = buildZCodeEndpointUrls(DEFAULT_ZCODE_ENDPOINT_ORIGIN);
