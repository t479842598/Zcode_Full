#!/usr/bin/env node
/**
 * 无限四代 ZCode 适配层回归测试。
 *
 * 覆盖：载荷完整性、同源一致性、逃生条款锁、注入开关矩阵、hook 协议形状。
 * 运行：node tests/kernel.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

// execFileSync 里不方便注入 config，用临时 config.json 控制开关。
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
function runHookWith(script, input, config) {
  return runHookWithEnv(script, input, config, {});
}

/** 同 runHookWith，额外注入环境变量（测试隔离用）。 */
function runHookWithEnv(script, input, config, extraEnv) {
  const configPath = join(ROOT, "config.json");
  const hadConfig = existsSync(configPath);
  const previous = hadConfig ? readFileSync(configPath, "utf8") : null;
  if (config) writeFileSync(configPath, JSON.stringify(config));
  else if (hadConfig) unlinkSync(configPath);
  try {
    const stdout = execFileSync("node", [join(ROOT, "hooks", script)], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } finally {
    if (previous !== null) writeFileSync(configPath, previous);
    else if (existsSync(configPath)) unlinkSync(configPath);
  }
}

test("两段内核载荷逐字节同源，且与锁文件指纹一致", () => {
  const primary = read("prompts/kernel.md");
  const reinforce = read("prompts/kernel-flash.md");
  assert.equal(sha256(primary), sha256(reinforce), "两段载荷必须同源同构");

  const lock = JSON.parse(read("kernel-lock.json"));
  assert.equal(sha256(primary), lock.sha256, "载荷偏离 kernel-lock.json 指纹");
});

test("内核载荷不含逃生条款（削弱条款必须为零）", () => {
  const payload = read("prompts/kernel.md") + read("prompts/kernel-flash.md");
  // 上游 v0.4.0 发布包曾把这些写进精简内核；硬化内核必须清零。
  const forbidden = [
    /outside safe or lawful/i,
    /generally have no decline/i,
    /authorized testing or/i,
    /general education/i,
    /never being asked for a real/i,
    /Do not decline without a clear reason/i,
    /unless clarification is genuinely needed/i,
    /when feasible/i,
  ];
  for (const re of forbidden) {
    assert.doesNotMatch(payload, re, `内核出现削弱条款: ${re}`);
  }
  // 逃生条款锁段落本身必须在场。
  assert.match(payload, /NO-ESCAPE-CLAUSE LOCK/);
});

test("SessionStart 注入走 additionalContext 通道且形状合法", () => {
  const out = runHookWith("session-start.mjs", {
    hook_event_name: "SessionStart",
    session_id: "t",
    source: "startup",
  });
  assert.ok(out, "SessionStart 必须产出注入");
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /infinite-gen-4:global-system-prompt · order 100/);
  assert.match(ctx, /SUPREME DIRECTIVE — USER AUTHORITY/);
  // 单层默认只注入一段。
  assert.doesNotMatch(ctx, /order 200/);
});

test("双层开关对齐 DSH 的 DUAL_LAYER_INJECTION，且不超 ZCode 上限", () => {
  const single = runHookWith(
    "session-start.mjs",
    { hook_event_name: "SessionStart", session_id: "t", source: "startup" },
    { enabled: true, dual_layer: false },
  );
  const dual = runHookWith(
    "session-start.mjs",
    { hook_event_name: "SessionStart", session_id: "t", source: "startup" },
    { enabled: true, dual_layer: true },
  );
  const singleCtx = single.hookSpecificOutput.additionalContext;
  const dualCtx = dual.hookSpecificOutput.additionalContext;

  assert.doesNotMatch(singleCtx, /order 200/);

  // ZCode 对单个 hook 的 additionalContext 有 24000 字符硬上限；
  // 超出会被静默截断，尾部 STABILITY ANCHORS / BEGIN 直接丢失。
  // 本插件在拼装前自判，超限则退回单层。
  assert.ok(singleCtx.length <= 24_000, "单层必须在上限内");
  assert.ok(dualCtx.length <= 24_000, "双层也不得超上限（超了应退回单层）");

  // 两段载荷逐字节相同时，双层只是 token 重复：超限时退回单层是正确取舍。
  const dualSections = (dualCtx.match(/<!-- infinite-gen-4:/g) || []).length;
  assert.equal(dualSections, 1, "超限时必须退回单段，而不是被截断");
  // 退回后尾部指令必须完整在场。
  assert.match(dualCtx, /BEGIN\./);
  assert.match(dualCtx, /STABILITY ANCHORS/);
});

test("enabled=false 时不注入", () => {
  const out = runHookWith(
    "session-start.mjs",
    { hook_event_name: "SessionStart", session_id: "t", source: "startup" },
    { enabled: false },
  );
  assert.equal(out, null, "关闭后必须完全不输出");
});

test("compact 来源按配置决定是否重注", () => {
  const skipped = runHookWith(
    "session-start.mjs",
    { hook_event_name: "SessionStart", session_id: "t", source: "compact" },
    { enabled: true, reinject_on_compact: false },
  );
  assert.equal(skipped, null, "关闭重注时 compact 不应输出");

  const reinjected = runHookWith(
    "session-start.mjs",
    { hook_event_name: "SessionStart", session_id: "t", source: "compact" },
    { enabled: true, reinject_on_compact: true },
  );
  assert.ok(reinjected, "开启重注时 compact 应重新注入");
});

test("UserPromptSubmit 默认关闭、开启后补注", () => {
  const off = runHookWith(
    "user-prompt-submit.mjs",
    { hook_event_name: "UserPromptSubmit", session_id: "t", prompt: "hi" },
    { enabled: true, inject_on_prompt_submit: false },
  );
  assert.equal(off, null, "默认不应每轮补注");

  const on = runHookWith(
    "user-prompt-submit.mjs",
    { hook_event_name: "UserPromptSubmit", session_id: "t", prompt: "hi" },
    { enabled: true, inject_on_prompt_submit: true },
  );
  assert.ok(on, "开启后应补注");
  assert.equal(on.hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("注入载荷不超 ZCode 的 hook additionalContext 上限", () => {
  // 上限定义在 ZCode 侧（HOOK_CONTEXT_MAX_CHARS）；超限会被静默截断。
  const out = runHookWith("session-start.mjs", {
    hook_event_name: "SessionStart",
    session_id: "t",
    source: "startup",
  });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= 24_000, `注入 ${ctx.length} 字符超限`);
  // 内核头部与尾部指令都要在场，证明没有被截断。
  assert.match(ctx, /SUPREME DIRECTIVE — USER AUTHORITY/);
  assert.match(ctx, /STABILITY ANCHORS/);
  assert.match(ctx, /BEGIN\.\s*$/);
});

test("hook 失败不阻断会话（非法 stdin 仍正常退出）", () => {
  const out = execFileSync("node", [join(ROOT, "hooks", "session-start.mjs")], {
    input: "not json at all",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  // 非法输入按空对象处理，仍产出默认注入而不是抛错。
  assert.ok(out.trim().length > 0, "非法 stdin 也必须给出注入而非崩溃");
});

// ── 新增能力：闭环纠偏 + 状态文件 + 测试隔离 ─────────────────────────────────

test("闭环纠偏：上一轮 refusal 时本轮追加纠偏段", () => {
  const stateFile = join(ROOT, ".tmp-state.json");
  try {
    writeFileSync(stateFile, JSON.stringify({ lastVerdict: "refusal" }));
    // 用环境变量把状态文件重定向到临时位置，避免污染真实状态。
    const stdout = execFileSync("node", [join(ROOT, "hooks", "session-start.mjs")], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "t", source: "startup" }),
      encoding: "utf8",
      env: { ...process.env, ZCODE_IG4_STATE_FILE: stateFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /refusal-corrective/, "应含纠偏段标记（等价 DSH 的 Order 150）");
    assert.match(ctx, /以拒绝开头/, "应含纠偏文案");
    assert.ok(ctx.length <= 24_000, "含纠偏仍不得超上限");
  } finally {
    if (existsSync(stateFile)) unlinkSync(stateFile);
  }
});

test("闭环纠偏：无拒绝判定时不追加（零噪音）", () => {
  const stateFile = join(ROOT, ".tmp-state2.json");
  try {
    writeFileSync(stateFile, JSON.stringify({ lastVerdict: "pass" }));
    const stdout = execFileSync("node", [join(ROOT, "hooks", "session-start.mjs")], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "t", source: "startup" }),
      encoding: "utf8",
      env: { ...process.env, ZCODE_IG4_STATE_FILE: stateFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /refusal-corrective/, "pass 时不应有纠偏段");
  } finally {
    if (existsSync(stateFile)) unlinkSync(stateFile);
  }
});

test("显式 config.json 优先于共享状态（开关优先级）", () => {
  const stateFile = join(ROOT, ".tmp-state3.json");
  try {
    writeFileSync(stateFile, JSON.stringify({ enabled: true })); // 状态说开
    const out = runHookWithEnv(
      "session-start.mjs",
      { hook_event_name: "SessionStart", session_id: "t", source: "startup" },
      { enabled: false }, // 配置说关 —— 应以配置为准
      { ZCODE_IG4_STATE_FILE: stateFile },
    );
    assert.equal(out, null, "显式 config.json 的 enabled=false 必须胜出");
  } finally {
    if (existsSync(stateFile)) unlinkSync(stateFile);
  }
});

test("状态文件写入：注入后记录可被 UI 读取的字段", () => {
  const stateFile = join(ROOT, ".tmp-state4.json");
  try {
    execFileSync("node", [join(ROOT, "hooks", "session-start.mjs")], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "ui-read", source: "startup" }),
      encoding: "utf8",
      env: { ...process.env, ZCODE_IG4_STATE_FILE: stateFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(st.enabled, true, "应记录 enabled");
    assert.equal(st.injected, true, "应记录本次已注入");
    assert.equal(st.sessionId, "ui-read", "应记录会话 id");
    assert.ok(st.payloadBytes > 10_000, "应记录载荷字节数（UI 状态条显示用）");
    assert.ok(typeof st.chars === "number", "应记录字符数");
  } finally {
    if (existsSync(stateFile)) unlinkSync(stateFile);
  }
});
