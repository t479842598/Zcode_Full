import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { collectBuildMetadata } from "../../scripts/build-metadata.mjs";

test("selfhost version tracks the official stable line", async () => {
  const root = new URL("../../../../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(root, "utf8"));
  // F-15：自托管版本号与官方稳定版对齐，不自增补丁号去冒充官方新版。
  // 本轮官方线是 3.14.3，本版在其之上做了三件事（同步官方 3.14.3 增量、内置 dsh-purge
  // 增强内核、内置 23 个红队技能），必须比 3.14.3 大客户端才收得到自建更新清单——
  // autoUpdater 用 semver.gt 判定，同版本号不更新。故取 3.14.5。
  assert.equal(pkg.version, "3.14.5");
  assert.equal(collectBuildMetadata().appVersion, pkg.version);
  const publish = await readFile(
    new URL("../../../../scripts/publish-release.mjs", import.meta.url),
    "utf8",
  );
  assert.match(publish, /ZCODE_RELEASE_GITHUB_REPO/);
  assert.match(publish, /github\.com\/\$\{GITHUB_REPO\}\/releases\/download/);
  assert.doesNotMatch(publish, /const GITHUB_REPO =[^\n]*"zai-org\//);
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
