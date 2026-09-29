/**
 * 无限四代状态条与开关：接线回归。
 *
 * 沿用本包既有约定（读源码文本做结构断言），因为 UI 包没有 React 测试渲染器：
 * 断言「组件存在、读哪些数据源可控、非桌面端不渲染、顶层浮层已挂载且接线正确」。
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const badge = readFileSync(new URL("../src/InfiniteGen4Badge.tsx", import.meta.url), "utf8");
const overlay = readFileSync(new URL("../src/DesktopTopOverlay.tsx", import.meta.url), "utf8");

test("状态条组件：开关是语义化 switch，且读/写走 props（与宿主解耦）", () => {
  assert.match(badge, /export function InfiniteGen4Badge\(/, "应导出组件");
  assert.match(badge, /role="switch"/, "开关必须是语义化 switch");
  assert.match(badge, /aria-checked=\{enabled\}/, "应暴露开关状态给无障碍树");
  assert.match(badge, /data-testid="gen4-toggle"/, "开关应有稳定测试锚点");
  // 数据源与写入都通过 props 注入 —— 组件不直接碰 IPC/文件。
  assert.match(badge, /readState\?: \(\) => Promise<Gen4State \| null>/, "读状态应是可注入 prop");
  assert.match(badge, /writeEnabled\?: \(enabled: boolean\) => Promise<void>/, "写开关应是可注入 prop");
  assert.doesNotMatch(badge, /ipcRenderer|window\.electron|require\(/, "组件不得直接访问宿主通道");
});

test("状态条：缺 readState 时不渲染（Web / 手机远控无该能力）", () => {
  assert.match(badge, /if \(!readState\) return null;/, "没有读取能力必须返回 null");
});

test("状态条：开启/关闭/纠偏三态都有可辨识呈现", () => {
  assert.match(badge, /"无限四代 已关闭"/, "关闭态应有明确文案");
  assert.match(badge, /已纠偏/, "纠偏态应有标识");
  assert.match(badge, /data-gen4-enabled=\{enabled \? "on" : "off"\}/, "应暴露开关状态属性");
  assert.match(badge, /data-gen4-corrective=\{corrective \? "on" : "off"\}/, "应暴露纠偏状态属性");
});

test("状态条：按会话轮询刷新（3s，与项目其它状态卡片同节奏）", () => {
  assert.match(badge, /setInterval\(\(\) => void refresh\(\), 3000\)/, "应有 3s 轮询");
  assert.match(badge, /clearInterval\(timer\)/, "卸载时必须清理定时器");
});

test("状态条：开关忙碌时禁用，避免连点竞态", () => {
  assert.match(badge, /if \(!writeEnabled \|\| busy\) return;/, "busy 时应短路");
  assert.match(badge, /disabled=\{busy\}/, "忙碌时按钮应禁用");
});

test("顶层浮层已挂载状态条，并把宿主的读/写接到 platform 服务", () => {
  assert.match(overlay, /import \{ InfiniteGen4Badge \} from "@\/InfiniteGen4Badge\.js";/);
  assert.match(overlay, /<InfiniteGen4Badge/);
  assert.match(overlay, /platform\.readInfiniteGen4State/, "读应接 platform.readInfiniteGen4State");
  assert.match(overlay, /platform\.writeInfiniteGen4Enabled/, "写应接 platform.writeInfiniteGen4Enabled");
  // 两端能力都缺省时不接线，组件自行返回 null。
  assert.match(overlay, /platform\.readInfiniteGen4State\s*\?\s*\(\) => platform\.readInfiniteGen4State!\(\)\s*:\s*undefined/);
});
