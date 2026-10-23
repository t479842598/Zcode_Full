import type { IZCodeAgentService } from "@zcode/services";
import type { ZCodeSessionInfo } from "@zcode/shared";

type TaskStatus = "running" | "completed" | "error";
type Task = {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  status?: TaskStatus;
};
type ListSessions = (
  params: Parameters<IZCodeAgentService["listSessions"]>[0],
) => Promise<ReadonlyArray<Pick<ZCodeSessionInfo, "sessionId" | "workspace" | "status">>>;

function workspaceKeyOf(task: { workspacePath: string; workspaceIdentity?: string }): string {
  return task.workspaceIdentity?.trim() || task.workspacePath;
}

/**
 * 会话状态 → 任务列表状态。
 * waiting/paused 都是「这一轮还在跑」：Agent 在等工具结果或等用户确认，任务并没有结束。
 * 手机端只认 displayStatus === "running"，把这两个状态丢掉会让运行中的任务显示成「空闲」。
 */
export function relayTaskStatusFromSessionStatus(
  status: ZCodeSessionInfo["status"],
): TaskStatus | undefined {
  if (status === "running" || status === "waiting" || status === "paused") {
    return "running";
  }
  if (status === "completed") {
    return "completed";
  }
  if (status === "error") {
    return "error";
  }
  return undefined;
}

/** 列表索引可能晚于正在运行的Agent；仅合并同一已有runtime的同身份会话。 */
export async function overlayLiveRelayTaskStatus<T extends Task>(
  tasks: ReadonlyArray<T>,
  listSessions: ListSessions,
): Promise<T[]> {
  const byWorkspace = new Map<string, T[]>();
  for (const task of tasks) {
    const key = workspaceKeyOf(task);
    const existing = byWorkspace.get(key) ?? [];
    existing.push(task);
    byWorkspace.set(key, existing);
  }
  const current = new Map<string, ZCodeSessionInfo["status"]>();
  await Promise.all([...byWorkspace.entries()].map(async ([key, scoped]) => {
    const first = scoped[0]!;
    try {
      const sessions = await listSessions({
        workspacePath: first.workspacePath,
        ...(first.workspaceIdentity ? { workspaceIdentity: first.workspaceIdentity } : {}),
        sessionIds: scoped.map((task) => task.taskId),
        runtimePolicy: "existing-only",
      });
      for (const session of sessions) {
        if (session.workspace.workspaceKey === key) current.set(`${key}\0${session.sessionId}`, session.status);
      }
    } catch {
      // 没有活跃runtime或查询失败时保持持久化索引，不为手机列表启动Agent。
    }
  }));
  return tasks.map((task) => {
    const key = workspaceKeyOf(task);
    const status = current.get(`${key}\0${task.taskId}`);
    const mapped = status === undefined ? undefined : relayTaskStatusFromSessionStatus(status);
    return mapped ? { ...task, status: mapped } : { ...task };
  });
}

/**
 * 把「正在运行」的权威 task id 按 workspace key 归组。
 * 来源有两处，缺一不可：
 * - taskService.listActiveTaskIds：syncer 的实时活动集合，覆盖 CLI 侧跑起来的会话；
 * - Host 内存 tracker：本进程 sendPrompt 起、task ready 结束的运行集合，覆盖纯 v4 命令路径
 *   （v4 不经过 zcodeSessionService，syncer 可能没有订阅）。
 */
export function collectActiveRelayTaskIds(
  entries: ReadonlyArray<{ taskId: string; workspacePath: string; workspaceIdentity?: string }>,
): Map<string, Set<string>> {
  const byWorkspace = new Map<string, Set<string>>();
  for (const entry of entries) {
    const key = workspaceKeyOf(entry);
    const existing = byWorkspace.get(key) ?? new Set<string>();
    existing.add(entry.taskId);
    byWorkspace.set(key, existing);
  }
  return byWorkspace;
}

/**
 * 用权威活动集合覆盖任务状态。
 * tasks-index 的行状态只镜像 CLI 的 last_outcome，永远是终态，所以「运行中」只能由这里补上；
 * 优先级高于 overlay：syncer 说在跑就是在跑，不受 listSessions 拿不到 runtime 的影响。
 */
export function applyActiveRelayTaskStatus<T extends Task>(
  tasks: ReadonlyArray<T>,
  activeTaskIdsByKey: ReadonlyMap<string, ReadonlySet<string>>,
): T[] {
  if (activeTaskIdsByKey.size === 0) {
    return [...tasks];
  }
  return tasks.map((task) => {
    const active = activeTaskIdsByKey.get(workspaceKeyOf(task));
    return active?.has(task.taskId) ? { ...task, status: "running" as const } : { ...task };
  });
}
