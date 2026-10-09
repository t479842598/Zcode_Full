// 由各 bundler 通过 define 注入，避免运行时 JSON import 的跨 bundler 兼容问题。
// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，
// 用 typeof 检查 + fallback 避免 ReferenceError。
declare const __ZCODE_VERSION__: string;
declare const __ZCODE_COMMIT__: string;
declare const __ZCODE_BUILD_TIME__: string;

/** 剥离自托管后缀，得到对外上报官方接口的纯 semver 版本。 */
export function stripSelfhostSuffix(version: string): string {
  const separator = version.indexOf("-selfhost");
  return separator === -1 ? version : version.slice(0, separator);
}

export const ZCODE_VERSION: string =
  typeof __ZCODE_VERSION__ !== "undefined" ? __ZCODE_VERSION__ : "0.0.0-dev";

// 对外上报官方接口的版本：自托管版本形如 `3.14.4-selfhost.1`，后缀段不能出现在
// app_version / X-ZCode-App-Version 里。官方只认它自己发行过的号。
// 取证：docs/2026-10-08-captcha-forensics.md 第三节、docs/2026-10-08-official-upstream-delta.md 三之二。
export const ZCODE_REPORT_VERSION: string = stripSelfhostSuffix(ZCODE_VERSION);
export const ZCODE_COMMIT: string =
  typeof __ZCODE_COMMIT__ !== "undefined" ? __ZCODE_COMMIT__ : "unknown";
export const ZCODE_BUILD_TIME: string =
  typeof __ZCODE_BUILD_TIME__ !== "undefined" ? __ZCODE_BUILD_TIME__ : "unknown";
