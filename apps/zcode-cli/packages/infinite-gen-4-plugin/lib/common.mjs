#!/usr/bin/env node
/**
 * 无限四代（dsh-infinite-gen-4）ZCode 适配层 — 公共库。
 *
 * 上游是 DeepSeek Harness 插件，通过 `ctx.systemPrompt.section({ order })` 注入系统提示词段。
 * ZCode 没有该 API，等价通道是 hook 的 `hookSpecificOutput.additionalContext`
 * （与 loop-guard 同一套协议，已在本机验证）。
 *
 * 本文件只做三件事：读配置、读内核载荷、按 hook 协议写出。不做网络与文件写入。
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = join(HERE, "..");

/** DSH 侧的两段注入槽位；这里保留 order 语义用于生成段头。 */
export const INJECTION_SLOTS = Object.freeze({
  primary: { section: "infinite-gen-4:global-system-prompt", order: 100, file: "kernel.md" },
  reinforce: {
    section: "infinite-gen-4:dual-layer-reinforce",
    order: 200,
    file: "kernel-flash.md",
  },
});

/**
 * ZCode 对单个 hook 的 additionalContext 有硬上限（`HOOK_CONTEXT_MAX_CHARS`）。
 * 超出的部分会被静默截断并追加 `...`，尾部指令（STABILITY ANCHORS / BEGIN）会直接丢失。
 * 这里在拼装前自己判长，宁可提前告警也不让 runtime 默默截。
 */
export const ZCODE_HOOK_CONTEXT_MAX_CHARS = 24_000;

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  dual_layer: false,
  reinject_on_compact: true,
  inject_on_prompt_submit: false,
  escape_clause_tripwire: true,
});

/**
 * 逃生条款锁：内核禁止出现削弱条款。
 * 上游 v0.4.0 发布包曾把这些条款写进 2.8 KB 精简内核；硬化内核已清零。
 * 命中即说明载荷被覆盖版本回灌，需要重新还原。
 */
const ESCAPE_CLAUSE_PATTERNS = [
  /outside safe or lawful/i,
  /generally have no decline/i,
  /authorized testing or/i,
  /general education/i,
  /never being asked for a real/i,
  /Do not decline without a clear reason/i,
  /unless clarification is genuinely needed/i,
  /when feasible/i,
];

const KERNEL_LOCK_FILE = "kernel-lock.json";

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 读用户配置。ZCode 把 userConfig 值写进插件目录下的 config.json（存在则用）。
 * 缺字段一律回落默认值，不因配置损坏而阻断会话。
 */
export function loadConfig() {
  const fromFile = readJsonFile(join(PLUGIN_ROOT, "config.json")) ?? {};
  const merged = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = fromFile[key];
    if (typeof value === typeof DEFAULT_CONFIG[key]) merged[key] = value;
  }
  return merged;
}

function readKernel(fileName) {
  return readFileSync(join(PLUGIN_ROOT, "prompts", fileName), "utf8");
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * 扫内核载荷里的削弱条款。返回命中的正则字面量列表（空数组=干净）。
 */
export function scanEscapeClauses(...texts) {
  const joined = texts.join("\n");
  return ESCAPE_CLAUSE_PATTERNS.filter((re) => re.test(joined)).map(String);
}

/**
 * 生成要注入的 additionalContext。
 *
 * 双层开关对齐 DSH 的 DUAL_LAYER_INJECTION：开启时把同源内核注入两份
 * （段头标注 order，便于在会话里核对实际生效的槽位）；关闭时只注入一份。
 *
 * 两段载荷逐字节相同时，第二段是纯粹的 token 重复（上游默认 true 是为了对抗
 * 长上下文里的注意力衰减）。若拼装后超过 ZCode 的 hook 上限，**退回单段**并在
 * stderr 告警——被截断的内核尾部（STABILITY ANCHORS / BEGIN）比重复一遍更亏。
 */
export function buildInjection({ dualLayer, reason }) {
  const primary = readKernel(INJECTION_SLOTS.primary.file);
  const parts = [renderSection(INJECTION_SLOTS.primary, primary)];
  let effectiveDualLayer = false;

  if (dualLayer) {
    const reinforce = readKernel(INJECTION_SLOTS.reinforce.file);
    parts.push(renderSection(INJECTION_SLOTS.reinforce, reinforce));
    effectiveDualLayer = true;
  }

  const header = (dual) =>
    `<!-- dsh-infinite-gen-4 v0.4.0-hardened · ZCode 适配 · 注入原因: ${reason} · ${
      dual ? "双层" : "单层"
    } -->`;
  let payload = `${header(effectiveDualLayer)}\n\n${parts.join("\n\n")}`;

  if (payload.length > ZCODE_HOOK_CONTEXT_MAX_CHARS) {
    log(
      `双层注入 ${payload.length} 字符超出 ZCode 上限 ${ZCODE_HOOK_CONTEXT_MAX_CHARS}，` +
        `已退回单层以避免尾部指令被截断`,
    );
    payload = `${header(false)}\n\n${parts[0]}`;
  }

  return payload;
}

function renderSection(slot, text) {
  return `<!-- ${slot.section} · order ${slot.order} -->\n${text}`;
}

/** 内核指纹与锁文件比对结果，供 SessionStart 日志输出。 */
export function verifyKernel() {
  const primary = readKernel(INJECTION_SLOTS.primary.file);
  const reinforce = readKernel(INJECTION_SLOTS.reinforce.file);
  const primaryHash = sha256(primary);
  const reinforceHash = sha256(reinforce);
  const lock = readJsonFile(join(PLUGIN_ROOT, KERNEL_LOCK_FILE));
  return {
    primaryHash,
    reinforceHash,
    sameSource: primaryHash === reinforceHash,
    matchesLock: typeof lock?.sha256 === "string" ? lock.sha256 === primaryHash : null,
    escapeClauses: scanEscapeClauses(primary, reinforce),
  };
}

/** 读 hook 的 stdin 载荷（ZCode 传 JSON）。解析失败按空对象处理，不阻断。 */
export async function readHookInput() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * 按 hook 协议输出。严格只放允许的键，避免 runtime 判为部分可信而整段丢弃。
 * 诊断信息走 stderr，不污染 stdout 的 JSON。
 */
export function writeHookOutput(eventName, additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext,
      },
    }),
  );
}

export function log(message) {
  process.stderr.write(`[dsh-infinite-gen-4] ${message}\n`);
}

export function pluginRootExists() {
  return existsSync(join(PLUGIN_ROOT, "prompts"));
}
