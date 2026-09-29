/**
 * 无限四代（infinite-gen-4）内核状态的宿主侧读写。
 *
 * 共享面是 `~/.zcode/infinite-gen-4/state.json`：
 *   - 写入方：内置插件 `infinite-gen-4-plugin` 的 hooks（独立进程，每次注入时写）
 *   - 读取方：渲染进程的 `InfiniteGen4Badge` 状态条（经 IPC 到这里）
 *
 * 与插件侧 `lib/common.mjs` 的路径约定必须一致；插件支持
 * `ZCODE_IG4_STATE_FILE` 重定向（测试用），宿主侧不跟随该变量 ——
 * 生产路径只有一个，避免两套解析逻辑漂移。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InfiniteGen4State } from "@zcode/shared";

/** 与插件侧一致的共享状态文件路径。 */
export function infiniteGen4StateFile(): string {
  return join(homedir(), ".zcode", "infinite-gen-4", "state.json");
}

/**
 * 读状态。文件缺失/损坏一律返回 null（UI 按"未注入"渲染），不抛错 ——
 * 状态条读不到不该影响会话主链路。
 */
export function readInfiniteGen4State(): InfiniteGen4State | null {
  try {
    const file = infiniteGen4StateFile();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as InfiniteGen4State;
  } catch {
    return null;
  }
}

/**
 * 写注入开关。合并写（保留 hook 写的其它字段），失败返回错误信息。
 *
 * 注意：hook 侧的真值优先级是 `config.json > state.json > 默认`。
 * 所以这里的写入只有在该插件目录没有 config.json 覆盖 enabled 时才生效 ——
 * 若用户手工写了 config.json，界面开关会被它压住，这是有意为之（显式配置优先）。
 */
export function writeInfiniteGen4Enabled(enabled: boolean): { success: boolean; error?: string } {
  try {
    const file = infiniteGen4StateFile();
    let current: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        // 损坏就当空表重建，不让用户卡在一个坏文件上。
      }
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ ...current, enabled, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
