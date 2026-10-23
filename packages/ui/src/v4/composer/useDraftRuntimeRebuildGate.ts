import { useCallback, useEffect, useReducer, useRef } from "react";

/**
 * 重建窗口上限。实测 agent start→ready 约 550-650ms，createSession 再数百 ms，5s 有充分余量。
 * 超时只解除门禁，不取消重建——迟到的 binding 仍会正常更新 effectiveSessionId 并唤醒附件重传。
 */
export const DRAFT_RUNTIME_REBUILD_TIMEOUT_MS = 5000;

export interface DraftRuntimeRebuildGateState {
  rebuilding: boolean;
  /** 换代发生时的预热会话 id；出现与之不同的非空 id 即视为重建完成。 */
  pendingFrom: string | null;
  /** 单调递增，仅用于让计时器 effect 在「重建中再次换代」时重新起算。 */
  epoch: number;
  /** 换代后预热会话已随旧 runtime 消失，残留 binding 不可再作为绑定目标暴露。 */
  stale: boolean;
}

export type DraftRuntimeRebuildGateEvent =
  | { type: "runtimeUnavailable"; prewarmSessionId: string | null }
  | { type: "prewarmSessionChanged"; prewarmSessionId: string | null }
  | { type: "rebuildTimeout" };

export const DRAFT_RUNTIME_REBUILD_GATE_IDLE: DraftRuntimeRebuildGateState = {
  epoch: 0,
  pendingFrom: null,
  rebuilding: false,
  stale: false,
};

export function reduceDraftRuntimeRebuildGate(
  state: DraftRuntimeRebuildGateState,
  event: DraftRuntimeRebuildGateEvent,
): DraftRuntimeRebuildGateState {
  switch (event.type) {
    case "runtimeUnavailable":
      return {
        epoch: state.epoch + 1,
        pendingFrom: event.prewarmSessionId,
        rebuilding: true,
        stale: true,
      };
    case "prewarmSessionChanged": {
      // retire 到重建完成之间 binding 为 null，不能据此解除门禁。
      if (event.prewarmSessionId === null) return state;
      if (event.prewarmSessionId === state.pendingFrom) return state;
      // 稳态（既不 rebuilding 也不 stale）下会话 id 变化无需改状态，保持对象同一性避免多余渲染。
      if (!state.rebuilding && !state.stale) return state;
      // 超时后 rebuilding 已解除、stale 仍在：迟到的新会话到达同样必须清掉 stale，
      // 否则 effectiveSessionId 永远为 null、附件永久停在 waitingSession。
      return { epoch: state.epoch, pendingFrom: null, rebuilding: false, stale: false };
    }
    case "rebuildTimeout":
      if (!state.rebuilding) return state;
      // 超时只解除发送门禁；预热会话是否已消失由 stale 表达，不能顺手清掉。
      return { ...state, rebuilding: false };
  }
}

export interface DraftRuntimeRebuildGate {
  /** 预热会话正在重建；true 时必须禁止发送，否则附件会挂在已消失的会话上。 */
  rebuilding: boolean;
  /** 预热会话已随旧 runtime 消失；true 时不得再把它的 sessionId 当绑定目标。 */
  stale: boolean;
}

/**
 * CUA Helper 就绪、liveness 恢复、会话泳道空闲回收都会回收 agent runtime
 * （workspace-dispose / idle-timeout），把草稿态尚未持久化的预热会话一并冲掉。
 * 此 hook 只记录这个事实并给出发送门禁与 stale 标记。
 *
 * 关键纪律：这里**不递增 draftRuntimeInvalidationVersion**（早期实现会，那会立刻触发预热
 * owner 重新 createSession，写路径又把 agent 拉回来，形成 idle 回收 → 重建 → 再回收的
 * 永久自激）。重建改由发送路径的 waitForDraftSession() 懒触发：用户不发消息就不重建，
 * runtime 才能真正回到 0 个 agent 进程。详见 docs/ui/draft-prewarm-runtime-reclaim.md。
 *
 * 换代信号优先取 onRuntimeLifecycle 的 unavailable：它在 dispose 当场到达。onRuntimeRestart
 * 只在新 agent 进程 spawn 时才发，而 agent 是懒启动——没人发请求就不 spawn，于是换代通知
 * 永不到达、附件一直卡在 waitingSession，直到用户手动点一次发送才被踹活。
 *
 * 正式会话态（sessionId !== null）不启用：那条路径由 CLI 的 cold-session-resume 负责。
 */
export function useDraftRuntimeRebuildGate(params: {
  /** 仅草稿态（sessionId === null）启用。 */
  enabled: boolean;
  /** 当前预热会话 id；出现新的非空值即视为重建完成。 */
  prewarmSessionId: string | null;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** 承载 transport 暴露 runtime 存活态时优先用它，替代 onRuntimeRestart。 */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  /** runtime 被回收当场（lifecycle unavailable）回调：由 pane 作废当前预热 binding。 */
  onRuntimeUnavailable?: () => void;
  timeoutMs?: number;
}): DraftRuntimeRebuildGate {
  const {
    enabled,
    onRuntimeLifecycle,
    onRuntimeRestart,
    onRuntimeUnavailable,
    prewarmSessionId,
    timeoutMs = DRAFT_RUNTIME_REBUILD_TIMEOUT_MS,
  } = params;
  const [state, dispatch] = useReducer(
    reduceDraftRuntimeRebuildGate,
    DRAFT_RUNTIME_REBUILD_GATE_IDLE,
  );

  // enabled / prewarmSessionId 走 ref：若让 handleRuntimeUnavailable 依赖它们，每次会话 id
  // 变化都会取消订阅再重订阅，而 transport 在 listeners 清空时会 dispose upstream——那个窗口
  // 里到达的换代事件会被丢掉。
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const prewarmSessionIdRef = useRef(prewarmSessionId);
  prewarmSessionIdRef.current = prewarmSessionId;
  const onRuntimeUnavailableRef = useRef(onRuntimeUnavailable);
  onRuntimeUnavailableRef.current = onRuntimeUnavailable;

  const handleRuntimeUnavailable = useCallback(() => {
    if (!enabledRef.current) return;
    dispatch({ prewarmSessionId: prewarmSessionIdRef.current, type: "runtimeUnavailable" });
    // 作废这一代预热会话，但绝不递增 invalidationVersion（那会立即重建 → 自激）。
    onRuntimeUnavailableRef.current?.();
  }, []);

  useEffect(() => {
    // 二选一订阅：两条通道都订会让同一次换代被处理两次，白作废一遍。
    if (onRuntimeLifecycle) {
      return onRuntimeLifecycle((state) => {
        // available 不必处理：重建由用户发送时发起，门禁解除交给 prewarmSessionChanged。
        if (state === "unavailable") handleRuntimeUnavailable();
      });
    }
    if (!onRuntimeRestart) return;
    return onRuntimeRestart(handleRuntimeUnavailable);
  }, [handleRuntimeUnavailable, onRuntimeLifecycle, onRuntimeRestart]);

  useEffect(() => {
    dispatch({ prewarmSessionId, type: "prewarmSessionChanged" });
  }, [prewarmSessionId]);

  // 依赖 epoch 而非 rebuilding：重建中再次换代时 rebuilding 保持 true，
  // 只有 epoch 变化才能让计时器重新起算。
  useEffect(() => {
    if (!state.rebuilding) return;
    const timer = setTimeout(() => dispatch({ type: "rebuildTimeout" }), timeoutMs);
    return () => clearTimeout(timer);
  }, [state.epoch, state.rebuilding, timeoutMs]);

  return { rebuilding: state.rebuilding, stale: state.stale };
}
