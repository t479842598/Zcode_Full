# 草稿预热会话与 runtime 空闲回收

## 背景

chat 泳道（`CHAT_LANE_IDLE_TIMEOUT_MS`）离开指定时间且无在跑任务时回收整棵 runtime，
收益是常驻内存随「实际在用」增长。但草稿态（`sessionId === null`）的预热会话是**纯内存**
的 `phase=draft` 会话，runtime 回收即消失，UI 侧若把「消失」当成「需要立刻重建」，就会出现：

```
idle 回收 → lifecycle unavailable → 立即递增 draftRuntimeInvalidationVersion
        → 预热 owner 立刻 createSession → 写路径重启 agent → 再 idle → 再回收
```

实测（2026-10-23，`ZCODE_CHAT_IDLE_TIMEOUT_MS=8000`）每轮 reclaim 后 24~32ms 就发出
`createSession`，回收周期严格等于阈值 + 启动耗时，永不收敛，进程每轮翻新一次、内存不减。

## 状态所有权

| 事实 | 唯一所有者 | 说明 |
| ---- | ---------- | ---- |
| runtime 是否可用 | `ZCodeAgentProcessManager`（`onRuntimeLifecycle`） | dispose 当场发 `unavailable`；`available` 只在新进程 spawn 后发 |
| 预热会话是否需要重建 | `DraftSessionPrewarmCoordinator` | 只由 `invalidationVersion` 变化、或发送路径显式 `waitForSession` 触发 |
| 预热会话是否已随旧 runtime 消失 | `useDraftRuntimeRebuildGate`（`stale`） | 只记录事实与发送门禁，不发起任何协议请求 |
| 何时递增 `draftRuntimeInvalidationVersion` | 配置/能力变化方 | 模型选择 revision 变化、skill 变更等；**不含 runtime 回收** |

## 规则

- **WHEN** runtime 广播 `unavailable`（idle 回收、workspace-dispose、崩溃）**THEN**
  gate 置 `stale + rebuilding`、作废当前预热 binding（`discard()`），
  但**不递增** `draftRuntimeInvalidationVersion`，因此不产生 createSession。
- **WHEN** 用户在草稿态点击发送（`SessionPane` 发送路径 `waitForDraftSession()`）**THEN**
  由预热 owner 在同一轮内重建会话并返回 binding，用户不需要点第二次。
- **WHEN** 回收发生在「创建在飞、还没拿到 binding」时 **THEN** ACK 收口后按既有有界退避
  （`PREWARM_RETRY_DELAYS_MS`）重试一次；退避用尽后保持失败态，等用户发送时由
  `waitForSession` 就地重排。
- **WHEN** gate 处于 `stale` **THEN** `effectiveSessionId` 不再暴露旧 `prewarmSessionId`，
  附件保持 `waitingSession` 而不是撞 `sessionNotFound`。
- **WHEN** 新的预热会话到达（id 与换代时不同）**THEN** 解除 `stale/rebuilding`；
  5s 内未到达只解除 `rebuilding`（发送门禁），`stale` 保持不变。
- 显式写操作（发送消息、手动重试）走 `getClient`，不受任何冷却窗口限制，仍能立刻拉起 runtime。

## 拒绝的方案

- **回收后由 UI 立刻重建**：就是自激循环本身。
- **host 侧对 createSession 也套冷却窗口**：会挡住用户新建任务，属于把同步问题推给超时。
- **unavailable 时把 `enabled` 置 false**：`waitForSession` 会在禁用态直接抛错，断掉
  「用户点发送即可自愈」的路径。

## 验收

| 场景 | 期望 |
| ---- | ---- |
| idle 回收后 60s 内无用户输入 | 零 `createSession`、零 agent spawn（`ZCODE_TRACE_AGENT_START=1` 无 trace） |
| 回收后用户发送 | 一次 `createSession` + 一次 agent spawn，首发成功 |
| 回收时创建在飞 | ACK 收口后按退避重试，最多 3 次后停止 |
| 模型选择 revision 变化 | 仍递增 invalidationVersion 并立即重建（原有行为） |
