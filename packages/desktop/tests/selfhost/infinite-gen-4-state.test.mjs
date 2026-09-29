/**
 * 无限四代内核状态：宿主侧读写回归。
 *
 * 覆盖：路径约定（与插件侧一致）、正常往返、合并写、损坏/缺失的容错。
 *
 * 注意：模块路径由 homedir() 决定，不可注入。测试会备份真实状态文件、
 * 跑完恢复，避免污染用户当前会话的状态条。
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  infiniteGen4StateFile,
  readInfiniteGen4State,
  writeInfiniteGen4Enabled,
} from "../../src/main/infiniteGen4/index.ts";

const STATE = infiniteGen4StateFile();

/** 每条用例前备份、后恢复，保证不残留测试数据。 */
function withStateBackup(run) {
  const had = existsSync(STATE);
  const previous = had ? readFileSync(STATE, "utf8") : null;
  try {
    return run();
  } finally {
    if (previous !== null) {
      mkdirSync(dirname(STATE), { recursive: true });
      writeFileSync(STATE, previous, "utf8");
    } else if (existsSync(STATE)) {
      rmSync(STATE);
    }
  }
}

test("状态文件路径与插件侧约定一致（~/.zcode/infinite-gen-4/state.json）", () => {
  assert.equal(STATE, join(homedir(), ".zcode", "infinite-gen-4", "state.json"));
});

test("缺失状态文件返回 null（不抛错）", () => {
  withStateBackup(() => {
    if (existsSync(STATE)) rmSync(STATE);
    assert.equal(readInfiniteGen4State(), null);
  });
});

test("损坏状态文件返回 null（不抛错）", () => {
  withStateBackup(() => {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, "{ 这不是合法 JSON", "utf8");
    assert.equal(readInfiniteGen4State(), null);
  });
});

test("非对象 JSON（数组/字符串）返回 null", () => {
  withStateBackup(() => {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, "[1,2,3]", "utf8");
    assert.equal(readInfiniteGen4State(), null);
  });
});

test("写开关 → 读回，且 enabled 生效", () => {
  withStateBackup(() => {
    const res = writeInfiniteGen4Enabled(false);
    assert.equal(res.success, true, res.error);
    const state = readInfiniteGen4State();
    assert.equal(state.enabled, false);
    assert.ok(typeof state.updatedAt === "string" && state.updatedAt.length > 0, "应写时间戳");
  });
});

test("合并写：保留 hook 写的其它字段", () => {
  withStateBackup(() => {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(
      STATE,
      JSON.stringify({ enabled: true, injected: true, payloadBytes: 19730, sessionId: "s1" }),
      "utf8",
    );
    writeInfiniteGen4Enabled(false);
    const state = readInfiniteGen4State();
    assert.equal(state.enabled, false, "开关应被改写");
    assert.equal(state.injected, true, "hook 写的 injected 必须保留");
    assert.equal(state.payloadBytes, 19730, "payloadBytes 必须保留");
    assert.equal(state.sessionId, "s1", "sessionId 必须保留");
  });
});

test("开关往返：false → true", () => {
  withStateBackup(() => {
    writeInfiniteGen4Enabled(false);
    assert.equal(readInfiniteGen4State().enabled, false);
    writeInfiniteGen4Enabled(true);
    assert.equal(readInfiniteGen4State().enabled, true);
  });
});

// ── 渲染进程平台服务接线（曾漏登记，导致状态条不渲染）──────────────────────
test("desktopPlatform 把两个方法接到 window.zcode（漏登记会让状态条静默消失）", () => {
  const src = readFileSync(
    new URL("../../src/renderer/src/desktopPlatform.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /readInfiniteGen4State:\s*\(\)\s*=>\s*window\.zcode\.readInfiniteGen4State\(\)/,
    "desktopPlatform 必须登记 readInfiniteGen4State",
  );
  assert.match(
    src,
    /writeInfiniteGen4Enabled:\s*\(payload\)\s*=>\s*window\.zcode\.writeInfiniteGen4Enabled\(payload\)/,
    "desktopPlatform 必须登记 writeInfiniteGen4Enabled",
  );
});

test("preload 暴露了两个方法（暴露面缺失同样让状态条消失）", () => {
  const src = readFileSync(new URL("../../src/preload/index.ts", import.meta.url), "utf8");
  assert.match(src, /readInfiniteGen4State:/, "preload 必须暴露 readInfiniteGen4State");
  assert.match(src, /writeInfiniteGen4Enabled:/, "preload 必须暴露 writeInfiniteGen4Enabled");
});

test("宿主注册了两条 IPC handler", () => {
  const src = readFileSync(
    new URL("../../src/main/desktopMainIpcPlatform.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /PlatformChannels\.ReadInfiniteGen4State/, "宿主须处理读状态通道");
  assert.match(src, /PlatformChannels\.WriteInfiniteGen4Enabled/, "宿主须处理写开关通道");
});
