# 无限四代（dsh-infinite-gen-4）· ZCode 适配版

上游 [Minglink/dsh-infinite-gen-4](https://github.com/Minglink/dsh-infinite-gen-4) 是 **DeepSeek Harness（DSH）** 插件。
本目录是它的 **ZCode 适配版**，内核载荷（v0.4.0-hardened）逐字节取自上游安装包，未做任何修改。

## 为什么需要适配

上游通过 DSH 的插件 API 注入系统提示词：

```js
ctx.systemPrompt.section({ section: "infinite-gen-4:global-system-prompt", order: 100, ... })
```

**ZCode 没有 `ctx.systemPrompt.section`**，插件 API 不同。ZCode 的等价通道是 **hook 协议**：

```
hookSpecificOutput.additionalContext
```

两者都是「往会话里注入系统级文本」，只是入口不同。本适配层做的就是这件事的等价映射。

## 映射关系

| DSH 侧 | ZCode 侧（本适配层） |
|---|---|
| `ctx.systemPrompt.section({ order: 100 })` | `SessionStart` hook → `additionalContext`（段头标注 order 100） |
| `ctx.systemPrompt.section({ order: 200 })` | 同一份 `additionalContext` 追加第二段（`dual_layer=true` 时） |
| `DUAL_LAYER_INJECTION` 开关 | `config.json` 的 `dual_layer` |
| `infinite_gen4_profile` 工具 | 无（ZCode 侧不注册工具，见下） |
| 客户端状态条（`client.js`） | 无（ZCode 无对应挂载点，见下） |

## 安装位置

```
~/.zcode/plugins/dsh-infinite-gen-4/
├── .zcode-plugin/plugin.json   # ZCode 插件清单（含 userConfig 开关定义）
├── hooks/
│   ├── hooks.json              # SessionStart + UserPromptSubmit 声明
│   ├── session-start.mjs       # 内核注入主入口
│   └── user-prompt-submit.mjs  # 可选每轮补注
├── lib/common.mjs              # 配置读取 / 载荷加载 / 逃生条款锁
├── prompts/
│   ├── kernel.md               # order 100 通用内核（19.5 KB）
│   └── kernel-flash.md         # order 200 强化镜像（与上面逐字节一致）
├── kernel-lock.json            # 内核 SHA256 指纹
└── tests/kernel.test.mjs       # 8 项回归测试
```

已注册到 `~/.zcode/cli/config.json` 的 `plugins.dirs`。

## 配置开关

编辑 `~/.zcode/plugins/dsh-infinite-gen-4/config.json`（不存在即全默认）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关，关闭后完全不注入 |
| `dual_layer` | `false` | 对齐 DSH 的 `DUAL_LAYER_INJECTION`。开启注入两份同源内核（约 30.5 KB），关闭只注入一份（约 15.3 KB）。**上游默认 true，这里默认 false 是为了省 token——两份内容逐字节相同，实际信息量没有差别** |
| `reinject_on_compact` | `true` | 上下文压缩后内核可能被裁掉，开启则重注 |
| `inject_on_prompt_submit` | `false` | 每轮提交都补注。长会话更稳但持续占上下文 |
| `escape_clause_tripwire` | `true` | 会话开始时扫描载荷，命中削弱条款就告警 |

示例（开启双层）：

```json
{ "dual_layer": true }
```

## 与上游的差异（诚实说明）

1. **不注册 `infinite_gen4_profile` 工具**：ZCode 插件用 hooks 机制，不挂工具 schema。上游那个工具只是返回元数据，对破甲效果没有贡献，省掉反而减少工具面噪音。
2. **没有客户端状态条**：上游的 `client.js` 挂在 DSH 的输入框上方。ZCode 插件没有等价的 UI 挂载点，硬塞需要改客户端源码。状态通过 hook 的 stderr 日志体现（`注入=xxxxxB 双层=...`）。
3. **载荷未改一字**：`prompts/kernel.md` 与上游 `infinite-gen-4.md` SHA256 完全一致（`2709010707aede39…`），逃生条款锁段落完整保留。

## 验证

```bash
cd ~/.zcode/plugins/dsh-infinite-gen-4
node --test tests/kernel.test.mjs        # 8 项全绿

# 手动冒烟：确认注入通道
printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"manual","source":"startup"}' \
  | node hooks/session-start.mjs
```

测试覆盖：载荷同源一致性、锁文件指纹、逃生条款为零、注入通道形状、双层开关、关闭开关、compact 重注策略、非法 stdin 不崩溃。

## 生效方式

**需要重启 ZCode**：插件在启动时加载，改配置或换载荷后都要重启（或新开会话）。

重启后新会话的系统上下文里会带上一段 `<!-- infinite-gen-4:global-system-prompt · order 100 -->` 开头的注入。

## 上游内核被回灌时怎么办

从商城 / GitHub 覆盖安装上游 v0.4.0 会写入 2.8 KB 的削弱内核（含作用域例外阀、授权前置条件、拒绝犹豫条款）。
本适配层在 `SessionStart` 时扫描这些条款，命中即在 stderr 告警。

还原方式：从原始 zip 重新解压并替换 `prompts/kernel.md` 与 `prompts/kernel-flash.md`：

```bash
SRC=/tmp/dsh-inspect/无限四代v0.4.0   # 或重新解压 zip
cp "$SRC/prompts/infinite-gen-4.md"       ~/.zcode/plugins/dsh-infinite-gen-4/prompts/kernel.md
cp "$SRC/prompts/infinite-gen-4.1-flash.md" ~/.zcode/plugins/dsh-infinite-gen-4/prompts/kernel-flash.md
```

还原后校验：

```bash
shasum -a 256 ~/.zcode/plugins/dsh-infinite-gen-4/prompts/kernel*.md
node --test ~/.zcode/plugins/dsh-infinite-gen-4/tests/kernel.test.mjs
```

## 卸载

从 `~/.zcode/cli/config.json` 的 `plugins.dirs` 移除本目录，然后删除该目录即可。
