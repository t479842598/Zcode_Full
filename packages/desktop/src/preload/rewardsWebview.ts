import { contextBridge } from "electron";
import { installRewardsPageBridge, isTrustedRewardsUrl } from "@zcode/shared";

// 普通网页和三方导航不能继承邀请页的 bridge；仅宿主批准的开发模式允许 localhost。
if (
  isTrustedRewardsUrl(window.location.href, {
    dev: process.argv.includes("--zcode-rewards-dev"),
    e2e: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
  })
) {
  // 自托管：进入邀请页前先清掉上一轮嵌入式会话残留的凭据，
  // 否则陈旧 token 会盖过 renderer 在 dom-ready 之后注入的新 token。
  for (const key of ["oauth:zai:access_token", "oauth:bigmodel:access_token", "zcodejwttoken"]) {
    window.localStorage.removeItem(key);
  }
  contextBridge.executeInMainWorld({ func: installRewardsPageBridge, args: [] });
}
