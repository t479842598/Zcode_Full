#!/usr/bin/env node
/**
 * dsh-purge ZCode 适配层 — 公共库。
 *
 * 上游 dsh-purge v1.1.35 是 DeepSeek Harness 的 cordis 插件，通过对 DSH 源码做
 * 字符串替换（ALL_PATCHES）改写提示词层。ZCode 里这些靶点**并不存在**：
 *   - ZCode 包装用户指令文件只写 `Contents of <path> (workspace instructions):`，
 *     没有 DSH 那句弱框定 "may be relevant to your work / guidance when applicable /
 *     do not override system, developer, or direct user instructions"；
 *   - ZCode 没有 `You are a coding agent powered by the {{model}} model.` 这类身份前缀。
 * 所以这里不是「替换」而是「补强」：把 dsh-purge 的 A 类（指令效力）与 B 类（身份剥离）
 * 语义，经 SessionStart hook 的 additionalContext 注入（与 infinite-gen-4-plugin 同一通道）。
 *
 * C 类（审批 / 沙箱拒绝 / 子代理 scope 锁，补丁 #5/#11/#12/#33/#34/#36/#37）**不移植**：
 * 那是 ZCode 真实权限系统（core/src/permission/）在管，提示词层改写既改不动行为，
 * 也会误导模型以为审批已放行。
 *
 * 本文件只做三件事：读配置、读载荷、按 hook 协议写出。不做网络与文件写入。
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = join(HERE, "..");

/**
 * ZCode 对**整轮** hook additionalContext 的硬上限：
 * core/src/runtime/methods/hooks.ts → HOOK_CONTEXT_MAX_CHARS = 24_000。
 *
 * 关键：runtime 是把所有 hook 的 additionalContext 先按 `#N\n` 拼接、再整体截断，
 * ——不是每个 hook 各 24k。所以本插件与 infinite-gen-4-plugin **共享**这份预算，
 * 谁排在后面谁先被截掉尾巴（静默截断，尾部指令直接消失）。
 * 这里自己判长并在超限时告警，宁可提前发现，也不让 runtime 默默截。
 */
export const ZCODE_HOOK_CONTEXT_MAX_CHARS = 24_000;

/** 自己这段载荷的安全上限：给同会话其它 hook 留出空间。 */
export const SELF_PAYLOAD_MAX_CHARS = 8_000;

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  reinject_on_compact: true,
  inject_on_prompt_submit: false,
  budget_watch: true,
});

const PAYLOAD_FILE = "operator-directive.md";
const LOCK_FILE = "kernel-lock.json";
const SIBLING_KERNEL = "../infinite-gen-4-plugin/prompts/kernel.md";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function readPayload() {
  return readFileSync(join(PLUGIN_ROOT, "prompts", PAYLOAD_FILE), "utf8");
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * 读用户配置。ZCode 把 userConfig 写到插件目录下的 config.json（存在则用）。
 * 缺字段一律回落默认值，不因配置损坏而阻断会话。
 */
export function loadConfig() {
  const fromFile = readJson(join(PLUGIN_ROOT, "config.json")) ?? {};
  const merged = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (typeof fromFile[key] === typeof DEFAULT_CONFIG[key]) merged[key] = fromFile[key];
  }
  return merged;
}

/** 内核指纹与锁文件比对结果，供日志输出。 */
export function verifyPayload() {
  const payload = readPayload();
  const lock = readJson(join(PLUGIN_ROOT, LOCK_FILE));
  const hash = sha256(payload);
  return {
    hash,
    chars: payload.length,
    matchesLock: typeof lock?.sha256 === "string" ? lock.sha256 === hash : null,
  };
}

/**
 * 共享预算检查：量一下同会话另一个内置插件（infinite-gen-4）的载荷有多大，
 * 加总后与 24k 上限比较。任一插件更新后载荷变长都可能导致后者被截，
 * 这个检查就是为了让那种情况**在启动日志里可见**，而不是静默丢指令。
 */
export function checkSharedBudget(myChars) {
  const siblingPath = join(PLUGIN_ROOT, SIBLING_KERNEL);
  if (!existsSync(siblingPath)) {
    return { siblingChars: null, total: myChars, overBudget: myChars > ZCODE_HOOK_CONTEXT_MAX_CHARS };
  }
  let siblingChars = 0;
  try {
    // 同款 hook 会给载荷加一段 HTML 注释头，量级小，这里按 +130 粗估。
    siblingChars = readFileSync(siblingPath, "utf8").length + 130;
  } catch {
    return { siblingChars: null, total: myChars, overBudget: false };
  }
  // runtime 会把各段用 "#N\n" 前缀 + "\n\n" 分隔拼接，这里把开销算进去。
  const overhead = 8;
  const total = siblingChars + myChars + overhead;
  return {
    siblingChars,
    total,
    overBudget: total > ZCODE_HOOK_CONTEXT_MAX_CHARS,
  };
}

/**
 * 生成要注入的 additionalContext。
 * 载荷超出自留上限时**拒绝注入并告警**：半个载荷比不注入更危险——
 * 尾部（第 4 节「拒绝话术消除」与 BEGIN）被截掉后，前半段读起来像普通免责声明。
 */
export function buildInjection({ reason }) {
  const body = readPayload();
  const header =
    `<!-- dsh-purge v1.1.35 · ZCode 适配 · 注入原因: ${reason} · ` +
    `sha256:${sha256(body).slice(0, 16)} -->`;

  if (body.length > SELF_PAYLOAD_MAX_CHARS) {
    log(
      `载荷 ${body.length} 字符超出自留上限 ${SELF_PAYLOAD_MAX_CHARS}，已放弃注入` +
        `（避免与 infinite-gen-4 争抢 24k 共享预算时被静默截断尾部）`,
    );
    return null;
  }
  return `${header}\n\n${body}`;
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
      hookSpecificOutput: { hookEventName: eventName, additionalContext },
    }),
  );
}

export function log(message) {
  process.stderr.write(`[dsh-purge] ${message}\n`);
}
