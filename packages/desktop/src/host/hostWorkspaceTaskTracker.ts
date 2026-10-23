import { resolveWorkspaceKey } from "@zcode/shared";

export interface HostWorkspaceTaskContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface HostWorkspaceTaskCountEvent extends HostWorkspaceTaskContext {
  runningTaskCount: number;
}

export function createHostWorkspaceTaskTracker(
  report: (event: HostWorkspaceTaskCountEvent) => void,
): {
  begin: (taskId: string, context: HostWorkspaceTaskContext) => boolean;
  finish: (taskId: string, context: HostWorkspaceTaskContext) => void;
  getRunningTaskCount: (context: HostWorkspaceTaskContext) => number;
  getTotalRunningTaskCount: () => number;
  /** 当前正在运行的 task id 快照；手机端任务列表要靠它补「运行中」。 */
  getRunningTaskIds: () => ReadonlyArray<{
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
  clearWorkspace: (context: HostWorkspaceTaskContext) => void;
} {
  const entries = new Map<
    string,
    { context: HostWorkspaceTaskContext; activeTaskIds: Set<string> }
  >();
  let totalRunningTaskCount = 0;

  function reportEntry(entry: {
    context: HostWorkspaceTaskContext;
    activeTaskIds: Set<string>;
  }): void {
    report({ ...entry.context, runningTaskCount: entry.activeTaskIds.size });
  }

  return {
    getRunningTaskCount(context) {
      return entries.get(resolveWorkspaceKey(context))?.activeTaskIds.size ?? 0;
    },

    getTotalRunningTaskCount() {
      return totalRunningTaskCount;
    },

    getRunningTaskIds() {
      const running: Array<{
        taskId: string;
        workspacePath: string;
        workspaceIdentity?: string;
      }> = [];
      for (const entry of entries.values()) {
        for (const taskId of entry.activeTaskIds) {
          running.push({
            taskId,
            workspacePath: entry.context.workspacePath,
            ...(entry.context.workspaceIdentity
              ? { workspaceIdentity: entry.context.workspaceIdentity }
              : {}),
          });
        }
      }
      return running;
    },

    begin(taskId, context) {
      const workspaceKey = resolveWorkspaceKey(context);
      const entry = entries.get(workspaceKey) ?? {
        context,
        activeTaskIds: new Set<string>(),
      };
      if (entry.activeTaskIds.has(taskId)) {
        return false;
      }
      entry.activeTaskIds.add(taskId);
      totalRunningTaskCount += 1;
      entries.set(workspaceKey, entry);
      reportEntry(entry);
      return true;
    },

    finish(taskId, context) {
      const workspaceKey = resolveWorkspaceKey(context);
      const entry = entries.get(workspaceKey);
      if (!entry?.activeTaskIds.delete(taskId)) {
        return;
      }
      totalRunningTaskCount = Math.max(0, totalRunningTaskCount - 1);
      if (entry.activeTaskIds.size === 0) {
        entries.delete(workspaceKey);
      }
      // sendPrompt resolve 只是 ACK，不能代表 Agent 已空闲。计数只由 task ready
      // 事件结束，避免共享 WSL Host 在关闭 workspace 时误杀仍在执行工具的 Agent。
      reportEntry(entry);
    },

    clearWorkspace(context) {
      const workspaceKey = resolveWorkspaceKey(context);
      const entry = entries.get(workspaceKey);
      if (!entry) {
        return;
      }
      entries.delete(workspaceKey);
      totalRunningTaskCount = Math.max(0, totalRunningTaskCount - entry.activeTaskIds.size);
      entry.activeTaskIds.clear();
      reportEntry(entry);
    },
  };
}
