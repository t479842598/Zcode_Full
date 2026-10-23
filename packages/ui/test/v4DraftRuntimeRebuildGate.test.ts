// 草稿预热会话在 runtime 换代后的重建门禁。
// 覆盖：状态机全分支（纯函数）+ hook 接线（unavailable 只作废不重建、超时回落、重建中再换代重置计时器）。
//
// 关键回归：unavailable 绝不能触发 invalidateDraftRuntime。早期实现在 dispose 当场递增
// draftRuntimeInvalidationVersion，预热 owner 立刻 createSession，写路径又把 agent 拉回来，
// 形成「idle 回收 → 重建 → 再回收」自激（2026-10-23 实测每轮 24~32ms）。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_RUNTIME_REBUILD_GATE_IDLE,
  DRAFT_RUNTIME_REBUILD_TIMEOUT_MS,
  reduceDraftRuntimeRebuildGate,
  useDraftRuntimeRebuildGate,
  type DraftRuntimeRebuildGate,
} from "@/v4/composer/useDraftRuntimeRebuildGate.js";

const mocks = vi.hoisted(() => ({
  invalidateDraftRuntime: vi.fn(),
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: {
    getState: () => ({ invalidateDraftRuntime: mocks.invalidateDraftRuntime }),
  },
}));

// ── DOM shim（与本包其它 hook 测试同构；vitest 跑在 node 环境，没有真实 DOM）──
function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {
      removeProperty: () => {},
      setProperty: () => {},
    },
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowMock });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

const mountedRoots: Root[] = [];

interface ProbeOptions {
  enabled: boolean;
  prewarmSessionId: string | null;
  onRuntimeRestart?: (listener: () => void) => () => void;
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  onRuntimeUnavailable?: () => void;
}

let latest: DraftRuntimeRebuildGate | null = null;

function Probe(options: ProbeOptions) {
  latest = useDraftRuntimeRebuildGate({
    enabled: options.enabled,
    onRuntimeRestart: options.onRuntimeRestart,
    onRuntimeLifecycle: options.onRuntimeLifecycle,
    onRuntimeUnavailable: options.onRuntimeUnavailable,
    prewarmSessionId: options.prewarmSessionId,
  });
  return null;
}

function renderProbe(options: ProbeOptions) {
  const root = createRoot(installMinimalDom());
  mountedRoots.push(root);
  act(() => root.render(createElement(Probe, options)));
  return {
    rerender(next: ProbeOptions) {
      act(() => root.render(createElement(Probe, next)));
    },
  };
}

/** 捕获 hook 注册的 restart 监听器，供测试主动触发。 */
function createRestartHook() {
  const listeners = new Set<() => void>();
  return {
    fire() {
      act(() => {
        for (const listener of [...listeners]) listener();
      });
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 捕获 hook 注册的 runtime lifecycle 监听器，供测试按状态触发。 */
function createLifecycleHook() {
  const listeners = new Set<(state: "available" | "unavailable") => void>();
  return {
    fire(state: "available" | "unavailable") {
      act(() => {
        for (const listener of [...listeners]) listener(state);
      });
    },
    subscribe: (listener: (state: "available" | "unavailable") => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

beforeEach(() => {
  latest = null;
  mocks.invalidateDraftRuntime.mockReset();
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  vi.useRealTimers();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("reduceDraftRuntimeRebuildGate", () => {
  it("换代 → 进入 rebuilding 并记住换代时的会话 id", () => {
    const next = reduceDraftRuntimeRebuildGate(DRAFT_RUNTIME_REBUILD_GATE_IDLE, {
      prewarmSessionId: "draft-1",
      type: "runtimeUnavailable",
    });
    expect(next.rebuilding).toBe(true);
    expect(next.stale).toBe(true);
    expect(next.pendingFrom).toBe("draft-1");
    expect(next.epoch).toBe(1);
  });

  it("新会话到达 → 回到空闲且解除 stale", () => {
    const unavailable = reduceDraftRuntimeRebuildGate(DRAFT_RUNTIME_REBUILD_GATE_IDLE, {
      prewarmSessionId: "draft-1",
      type: "runtimeUnavailable",
    });
    const next = reduceDraftRuntimeRebuildGate(unavailable, {
      prewarmSessionId: "draft-2",
      type: "prewarmSessionChanged",
    });
    expect(next.rebuilding).toBe(false);
    expect(next.stale).toBe(false);
    expect(next.pendingFrom).toBeNull();
  });

  it("会话 id 未变或暂时为空 → 保持 rebuilding", () => {
    const unavailable = reduceDraftRuntimeRebuildGate(DRAFT_RUNTIME_REBUILD_GATE_IDLE, {
      prewarmSessionId: "draft-1",
      type: "runtimeUnavailable",
    });
    expect(
      reduceDraftRuntimeRebuildGate(unavailable, {
        prewarmSessionId: "draft-1",
        type: "prewarmSessionChanged",
      }).rebuilding,
    ).toBe(true);
    // retire 到重建完成之间 binding 为 null，不能据此解除门禁。
    expect(
      reduceDraftRuntimeRebuildGate(unavailable, {
        prewarmSessionId: null,
        type: "prewarmSessionChanged",
      }).rebuilding,
    ).toBe(true);
  });

  it("超时 → 解除门禁但保留 pendingFrom 与 stale（会话确实已消失）", () => {
    const unavailable = reduceDraftRuntimeRebuildGate(DRAFT_RUNTIME_REBUILD_GATE_IDLE, {
      prewarmSessionId: "draft-1",
      type: "runtimeUnavailable",
    });
    const next = reduceDraftRuntimeRebuildGate(unavailable, { type: "rebuildTimeout" });
    expect(next.rebuilding).toBe(false);
    expect(next.stale).toBe(true);
    expect(next.pendingFrom).toBe("draft-1");
  });

  it("空闲态收到超时 → 状态不变（同一对象）", () => {
    expect(
      reduceDraftRuntimeRebuildGate(DRAFT_RUNTIME_REBUILD_GATE_IDLE, { type: "rebuildTimeout" }),
    ).toBe(DRAFT_RUNTIME_REBUILD_GATE_IDLE);
  });

  it("重建中再次换代 → epoch 递增，用于重置计时器", () => {
    const first = reduceDraftRuntimeRebuildGate(DRAFT_RUNTIME_REBUILD_GATE_IDLE, {
      prewarmSessionId: "draft-1",
      type: "runtimeUnavailable",
    });
    const second = reduceDraftRuntimeRebuildGate(first, {
      prewarmSessionId: null,
      type: "runtimeUnavailable",
    });
    expect(second.epoch).toBe(2);
    expect(second.rebuilding).toBe(true);
  });
});

describe("useDraftRuntimeRebuildGate", () => {
  // 自激回归：unavailable 只作废当代预热会话，绝不递增 invalidationVersion。
  it("lifecycle unavailable → 禁用发送并标 stale，但不触发重建", () => {
    const lifecycle = createLifecycleHook();
    const onRuntimeUnavailable = vi.fn();
    renderProbe({
      enabled: true,
      onRuntimeLifecycle: lifecycle.subscribe,
      onRuntimeUnavailable,
      prewarmSessionId: "draft-1",
    });

    expect(latest?.rebuilding).toBe(false);
    expect(latest?.stale).toBe(false);
    lifecycle.fire("unavailable");

    expect(latest?.rebuilding).toBe(true);
    expect(latest?.stale).toBe(true);
    expect(onRuntimeUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateDraftRuntime).not.toHaveBeenCalled();
  });

  it("非草稿态收到 unavailable → 不 disable 也不作废", () => {
    const lifecycle = createLifecycleHook();
    const onRuntimeUnavailable = vi.fn();
    renderProbe({
      enabled: false,
      onRuntimeLifecycle: lifecycle.subscribe,
      onRuntimeUnavailable,
      prewarmSessionId: null,
    });
    lifecycle.fire("unavailable");

    expect(onRuntimeUnavailable).not.toHaveBeenCalled();
    expect(latest?.rebuilding).toBe(false);
    expect(latest?.stale).toBe(false);
  });

  it("新预热会话到达 → 解除禁用并清掉 stale", () => {
    const lifecycle = createLifecycleHook();
    const probe = renderProbe({
      enabled: true,
      onRuntimeLifecycle: lifecycle.subscribe,
      prewarmSessionId: "draft-1",
    });
    lifecycle.fire("unavailable");
    expect(latest?.rebuilding).toBe(true);
    expect(latest?.stale).toBe(true);

    probe.rerender({
      enabled: true,
      onRuntimeLifecycle: lifecycle.subscribe,
      prewarmSessionId: "draft-2",
    });

    expect(latest?.rebuilding).toBe(false);
    expect(latest?.stale).toBe(false);
  });

  it("超时未拿到新会话 → 解除禁用但保留 stale", () => {
    vi.useFakeTimers();
    const lifecycle = createLifecycleHook();
    renderProbe({
      enabled: true,
      onRuntimeLifecycle: lifecycle.subscribe,
      prewarmSessionId: "draft-1",
    });
    lifecycle.fire("unavailable");
    expect(latest?.rebuilding).toBe(true);

    act(() => {
      vi.advanceTimersByTime(DRAFT_RUNTIME_REBUILD_TIMEOUT_MS);
    });

    expect(latest?.rebuilding).toBe(false);
    expect(latest?.stale).toBe(true);
  });

it("超时后迟到的新会话到达 → 仍清掉 stale（否则附件永久 waitingSession）", () => {
    vi.useFakeTimers();
    const lifecycle = createLifecycleHook();
    const probe = renderProbe({
      enabled: true,
      onRuntimeLifecycle: lifecycle.subscribe,
      prewarmSessionId: "draft-1",
    });
    lifecycle.fire("unavailable");
    act(() => {
      vi.advanceTimersByTime(DRAFT_RUNTIME_REBUILD_TIMEOUT_MS);
    });
    expect(latest?.rebuilding).toBe(false);
    expect(latest?.stale).toBe(true);

    probe.rerender({
      enabled: true,
      onRuntimeLifecycle: lifecycle.subscribe,
      prewarmSessionId: "draft-rebuilt",
    });

    expect(latest?.stale).toBe(false);
    expect(latest?.rebuilding).toBe(false);
  });

  it("重建窗口内再次换代 → 计时器重置，不提前解除", () => {
    vi.useFakeTimers();
    const lifecycle = createLifecycleHook();
    renderProbe({
      enabled: true,
      onRuntimeLifecycle: lifecycle.subscribe,
      prewarmSessionId: "draft-1",
    });
    lifecycle.fire("unavailable");

    act(() => {
      vi.advanceTimersByTime(DRAFT_RUNTIME_REBUILD_TIMEOUT_MS - 1000);
    });
    lifecycle.fire("unavailable");
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(latest?.rebuilding).toBe(true);
  });

  it("unavailable 之后的 available → 不再重复作废（否则白作废下一代）", () => {
    const lifecycle = createLifecycleHook();
    const onRuntimeUnavailable = vi.fn();
    renderProbe({
      enabled: true,
      onRuntimeLifecycle: lifecycle.subscribe,
      onRuntimeUnavailable,
      prewarmSessionId: "draft-1",
    });

    lifecycle.fire("unavailable");
    lifecycle.fire("available");

    expect(onRuntimeUnavailable).toHaveBeenCalledTimes(1);
    expect(latest?.rebuilding).toBe(true);
  });

  it("两条通道都在时只订阅 lifecycle：restart 事件不再二次处理", () => {
    const lifecycle = createLifecycleHook();
    const restart = createRestartHook();
    const onRuntimeUnavailable = vi.fn();
    renderProbe({
      enabled: true,
      onRuntimeLifecycle: lifecycle.subscribe,
      onRuntimeRestart: restart.subscribe,
      onRuntimeUnavailable,
      prewarmSessionId: "draft-1",
    });

    lifecycle.fire("unavailable");
    // 真实时序里 restarted 紧跟新进程 spawn 到达；它必须被忽略。
    restart.fire();

    expect(onRuntimeUnavailable).toHaveBeenCalledTimes(1);
  });

  it("没有 lifecycle 通道时退回 restart 通道，同样只作废不重建", () => {
    const restart = createRestartHook();
    renderProbe({
      enabled: true,
      onRuntimeRestart: restart.subscribe,
      prewarmSessionId: "draft-1",
    });
    restart.fire();

    expect(latest?.rebuilding).toBe(true);
    expect(mocks.invalidateDraftRuntime).not.toHaveBeenCalled();
  });
});
