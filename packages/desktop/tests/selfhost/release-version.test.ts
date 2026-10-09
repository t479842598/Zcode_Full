import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import semver from "semver";
import { collectBuildMetadata } from "../../scripts/build-metadata.mjs";
import { stripSelfhostSuffix, ZCODE_REPORT_VERSION } from "../../../shared/src/version.ts";

// 官方实际发行过的版本（取证：docs/2026-10-08-official-upstream-delta.md）。
// GitHub tag 只有 v3.14.3；官方 CDN 更新清单已到 3.14.4。
const OFFICIAL_RELEASED_VERSIONS = ["3.14.3", "3.14.4"] as const;

test("selfhost version uses official number plus selfhost suffix", async () => {
  const root = new URL("../../../../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(root, "utf8"));
  // 命名策略（已批准）：官方号 + `-selfhost.N`。
  // 形态实测（plan_step_07）：`+selfhost.N` 是 build metadata，semver 不参与比较
  // （gt(.2,.1)=false、eq=true），electron-updater 会因 semver.eq 短路而永远推不出更新；
  // `-selfhost.N` 是 prerelease，可正常递增（gt(.2,.1)=true），且 electron-builder 已设
  // detectUpdateChannel:false，清单名不被 prerelease 段改写。
  assert.match(pkg.version, /^\d+\.\d+\.\d+-selfhost\.\d+$/);
  assert.equal(collectBuildMetadata().appVersion, pkg.version);
  const publish = await readFile(
    new URL("../../../../scripts/publish-release.mjs", import.meta.url),
    "utf8",
  );
  assert.match(publish, /ZCODE_RELEASE_GITHUB_REPO/);
  assert.match(publish, /github\.com\/\$\{GITHUB_REPO\}\/releases\/download/);
  assert.doesNotMatch(publish, /const GITHUB_REPO =[^\n]*"zai-org\//);
});

test("outbound reported version is pure semver without selfhost suffix", () => {
  const reported = ZCODE_REPORT_VERSION;
  // 永远不含自托管后缀段，官方拿不到 selfhost 标识。
  assert.doesNotMatch(reported, /selfhost/);
  // 纯 semver 核心段（X.Y.Z，可带 prerelease，但不含自托管后缀）。
  assert.match(reported, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  // 派生结果与 stripSelfhostSuffix 逐字一致（幂等）。
  assert.equal(reported, stripSelfhostSuffix(reported));
});

test("package.json version strips to a version the official actually shipped", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../../../../package.json", import.meta.url), "utf8"),
  );
  const base = stripSelfhostSuffix(pkg.version);
  assert.ok(
    (OFFICIAL_RELEASED_VERSIONS as readonly string[]).includes(base),
    `对外上报的基础段 ${base} 必须是官方实际发行过的版本之一：${OFFICIAL_RELEASED_VERSIONS.join(", ")}`,
  );
});

test("stripSelfhostSuffix drops only the selfhost segment", () => {
  assert.equal(stripSelfhostSuffix("3.14.4-selfhost.1"), "3.14.4");
  assert.equal(stripSelfhostSuffix("3.14.4-selfhost.12"), "3.14.4");
  assert.equal(stripSelfhostSuffix("3.14.4"), "3.14.4");
  assert.equal(stripSelfhostSuffix("0.0.0-dev"), "0.0.0-dev");
});

test("selfhost prerelease form is strictly increasing (update chain works)", () => {
  // 形态选择的技术依据（plan_step_07 实测）：`+selfhost.N` 是 build metadata，
  // semver 不比较 → electron-updater 的 semver.eq 短路会让同基础号迭代永远推不出去。
  // `-selfhost.N` 是 prerelease，可严格递增。
  assert.ok(semver.gt("3.14.4-selfhost.2", "3.14.4-selfhost.1"));
  assert.ok(semver.gt("3.14.5-selfhost.1", "3.14.4-selfhost.3"));
  // 反向确认 `+` 形态确实不可用（锁住这个结论，防止有人改回去）。
  assert.ok(!semver.gt("3.14.4+selfhost.2", "3.14.4+selfhost.1"));
  assert.ok(semver.eq("3.14.4+selfhost.2", "3.14.4+selfhost.1"));
});

test("release pipeline keys stay inside the selfhost suffix space", async () => {
  const publish = await readFile(
    new URL("../../../../scripts/publish-release.mjs", import.meta.url),
    "utf8",
  );
  // tag 直接由版本号拼接 → 3.14.4-selfhost.1 得到 v3.14.4-selfhost.1，
  // 不再占用官方未发布的补丁号空间（历史 3.14.5/3.14.6/3.14.7 的抢号问题）。
  assert.match(publish, /const tag = `v\$\{version\}`/);
  // 产物筛选与发布后自检都以版本号做子串匹配 → 带后缀版本同样命中。
  assert.match(publish, /f\.includes\(version\)/);
  assert.match(publish, /name\.includes\(`-\$\{version\}-`\)/);
  // 安装包托管在 GitHub Releases（自建服务器只放几百字节的清单）。
  assert.match(publish, /releases\/download\/\$\{tag\}/);
});

test("packaged app-update.yml is a placeholder; runtime update source is the manifest provider", async () => {
  // 打包产物里的 app-update.yml 不是运行时更新源：
  // autoUpdater 用 provider:"custom" + ManifestUpdateProvider，端点在运行时解析，
  // app-update.yml 只满足 electron-builder 的 generic publish 必需项。
  const builderConfig = await readFile(
    new URL("../../electron-builder.config.js", import.meta.url),
    "utf8",
  );
  assert.match(builderConfig, /url: "http:\/\/localhost:8081"/);
  // 关闭按 prerelease 段自动切换通道，保证带 -selfhost.N 的版本仍写 latest-mac.yml。
  assert.match(builderConfig, /detectUpdateChannel: false/);

  const autoUpdaterSource = await readFile(
    new URL("../../src/main/autoUpdater.ts", import.meta.url),
    "utf8",
  );
  assert.match(autoUpdaterSource, /updateProvider: ManifestUpdateProvider/);
});

test("official release monitor auto-refreshes and renders release notes", async () => {
  const section = await readFile(
    new URL("../../../ui/src/settings/OfficialReleaseSection.tsx", import.meta.url),
    "utf8",
  );
  // 实时监测：定时自动轮询 + 手动刷新，且不新增后台常驻定时器。
  assert.match(section, /AUTO_REFRESH_INTERVAL_MS/);
  assert.match(section, /setInterval/);
  assert.match(section, /clearInterval/);
  // 更新内容按行渲染成结构化列表，而不是一整块 pre 文本。
  assert.match(section, /noteLines/);
  assert.match(section, /official-release-notes/);
  // 有新版时必须给出可辨识的提示态。
  assert.match(section, /hasNewerOfficialRelease/);
  assert.match(section, /settings\.officialRelease\.newer/);
});
