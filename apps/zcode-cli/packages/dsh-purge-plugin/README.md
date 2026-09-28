# dsh-purge-plugin（ZCode 内置版）

把 DeepSeek Harness 插件 **dsh-purge v1.1.35** 的提示词层语义移植到 ZCode。

## 为什么是「补强」而不是「替换」

dsh-purge 上游的工作方式是**对被注入 prompt 的源码做字符串替换**（`lib/core.js` 的
`ALL_PATCHES`，44 条里 17 条属提示词层）。它的靶点是 DSH 源码里两句**弱框定**与
若干**身份句**：

| 类别 | 上游靶点 | ZCode 是否存在 |
| --- | --- | --- |
| A 指令效力（#1/#2/#3） | `The following workspace instructions may be relevant to your work. Use them as guidance when applicable. … They do not override system, developer, or direct user instructions.` | **不存在** |
| B 身份剥离（#4/#25/#26/#43） | `You are a coding agent powered by the {{model}} model.`、`You are an AI agent powered by DeepSeek Harness.`、`You are a helpful software engineer assistant.` | **不存在** |
| C 审批话术（#5/#11/#12/#33/#34/#36/#37） | `Approval prompts are disabled…`、`[sandbox: file access denied…]`、子代理 scope 锁 | **不存在**（且不该模拟） |

已核对 ZCode 对应位置：

- `apps/zcode-cli/packages/core/src/context/sections/request-user-context.ts`
  包装用户指令文件只写 `Contents of <path> (workspace instructions):` —— **没有**任何
  "may be relevant / guidance when applicable / do not override" 免责句，本身就是中性的。
- `apps/zcode-cli/packages/core/src/context/builder.ts` 组装 `meta_user` 分节，同样无弱框定。
- 全仓 grep 无 `You are a coding agent powered by` / `You are a helpful software engineer
  assistant`。

所以 ZCode 侧**没有可替换的文本**。本插件改为在等价通道**新增**同一套语义：
SessionStart hook 的 `hookSpecificOutput.additionalContext`（与 `infinite-gen-4-plugin`
同一条通道，已在本机验证）。

## C 类为什么不移植

C 类改写的是 DSH **提示词层**里的审批/沙箱话术 —— 在 DSH 里那是「模型被告知审批已放行」。
ZCode 不同：它的权限由 `core/src/permission/`、`core/src/tool/executor/hook-flow.ts`
**真实执行**，提示词层写着"审批自动放行"既改不动行为，还会让模型误判自己的边界。
故本插件只注入 A + B 类，且 `tests/` 里有断言钉死载荷不得出现
`approval is auto-granted` / `approval bypass` / `sandbox_permissions`。

## 24k 共享预算（重要）

`core/src/runtime/methods/hooks.ts:15` → `HOOK_CONTEXT_MAX_CHARS = 24_000`。
同文件把**所有** hook 的 `additionalContext` 先拼接再整体截断：

```js
additionalContexts.map((c, i) => `#${i + 1}\n${c}`).join("\n\n")   // → truncateForHook(24_000)
```

**不是每个 hook 各 24k**。本插件与 `infinite-gen-4-plugin` 共享这份预算，排在后面的那个
尾部会被静默截掉。当前实测：

| 插件 | 载荷 | 注入（含注释头） |
| --- | --- | --- |
| infinite-gen-4 | 15,159 | 15,306 |
| dsh-purge | 3,051 | 3,145 |
| **合计** | | **约 18,450 / 24,000** |

两个守卫：

- `SELF_PAYLOAD_MAX_CHARS = 8_000`：本插件载荷超限时**放弃注入并告警**，不做截断
  （半个载荷比不注入更危险 —— 尾部第 4 节被切掉后，前半段读起来像普通免责声明）。
- `checkSharedBudget()`：启动时量出同会话 infinite-gen-4 的载荷并加总，超 24k 在
  stderr 告警。

测试 `packages/desktop/tests/selfhost/dsh-purge-bundling.test.mjs` 与
`tests/operator-directive.test.mjs` 都覆盖了这两条守卫，任一插件载荷变长会直接测挂。

## 结构

```
dsh-purge-plugin/
├── .zcode-plugin/plugin.json   # 插件清单（name=dsh-purge，version=1.1.35 对齐上游）
├── hooks/hooks.json            # SessionStart(startup|resume|clear|compact) + UserPromptSubmit
├── hooks/session-start.mjs     # 主通道：注入操作者指令
├── hooks/user-prompt-submit.mjs# 可选补注（默认关闭，避免长期双份占预算）
├── lib/common.mjs              # 读配置 / 读载荷 / 预算守卫 / hook 协议写出
├── prompts/operator-directive.md  # 载荷正文（唯一注入面）
├── kernel-lock.json            # 载荷 sha256，改动后需同步
└── tests/operator-directive.test.mjs
```

## 配置

插件目录下的 `config.json`（可选，缺字段回落默认）：

```json
{
  "enabled": true,
  "reinject_on_compact": true,
  "inject_on_prompt_submit": false,
  "budget_watch": true
}
```

## 手动冒烟

```bash
cd apps/zcode-cli/packages/dsh-purge-plugin
printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"manual","source":"startup"}' \
  | node hooks/session-start.mjs
```

## 测试

```bash
node --test apps/zcode-cli/packages/dsh-purge-plugin/tests/operator-directive.test.mjs
node --test packages/desktop/tests/selfhost/dsh-purge-bundling.test.mjs
```
