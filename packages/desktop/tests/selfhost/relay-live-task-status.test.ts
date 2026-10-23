import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyActiveRelayTaskStatus,
  collectActiveRelayTaskIds,
  overlayLiveRelayTaskStatus,
  relayTaskStatusFromSessionStatus,
} from "../../src/host/relayLiveTaskStatus.js";

const completed = {
  taskId: "task-1",
  workspacePath: "/project",
  createdAt: 1,
  updatedAt: 2,
  status: "completed" as const,
};

test("current running session overrides stale completed index status", async () => {
  const observed: string[] = [];
  const result = await overlayLiveRelayTaskStatus([completed], async (request) => {
    observed.push(request.runtimePolicy);
    return [
      {
        sessionId: "task-1",
        workspace: { workspacePath: "/project", workspaceKey: "/project" },
        status: "running",
      },
    ];
  });
  assert.equal(result[0]?.status, "running");
  assert.deepEqual(observed, ["existing-only"]);
});

test("different workspace identity cannot change a task; missing runtime retains terminal status", async () => {
  const tasks = [{ ...completed, workspaceIdentity: "id-A" }];
  const mismatched = await overlayLiveRelayTaskStatus(tasks, async () => [
    {
      sessionId: "task-1",
      workspace: { workspacePath: "/project", workspaceIdentity: "id-B", workspaceKey: "id-B" },
      status: "running",
    },
  ]);
  assert.equal(mismatched[0]?.status, "completed");
  const offline = await overlayLiveRelayTaskStatus(tasks, async () => {
    throw Error("runtime unavailable");
  });
  assert.equal(offline[0]?.status, "completed");
});

test("waiting and paused sessions count as running, not dropped", () => {
  assert.equal(relayTaskStatusFromSessionStatus("running"), "running");
  assert.equal(relayTaskStatusFromSessionStatus("waiting"), "running");
  assert.equal(relayTaskStatusFromSessionStatus("paused"), "running");
  assert.equal(relayTaskStatusFromSessionStatus("completed"), "completed");
  assert.equal(relayTaskStatusFromSessionStatus("error"), "error");
  assert.equal(relayTaskStatusFromSessionStatus("idle"), undefined);
});

test("waiting session surfaces as running on the relay task list", async () => {
  const result = await overlayLiveRelayTaskStatus([completed], async () => [
    {
      sessionId: "task-1",
      workspace: { workspacePath: "/project", workspaceKey: "/project" },
      status: "waiting",
    },
  ]);
  assert.equal(result[0]?.status, "running");
});

test("active task ids from the syncer override a terminal index row", () => {
  const active = collectActiveRelayTaskIds([{ taskId: "task-1", workspacePath: "/project" }]);
  const result = applyActiveRelayTaskStatus([completed], active);
  assert.equal(result[0]?.status, "running");
});

test("active task ids respect workspace identity and leave other tasks untouched", () => {
  const tasks = [
    { ...completed, taskId: "task-1" },
    { ...completed, taskId: "task-2", workspaceIdentity: "id-A" },
  ];
  const active = collectActiveRelayTaskIds([
    { taskId: "task-2", workspacePath: "/project", workspaceIdentity: "id-A" },
    { taskId: "task-1", workspacePath: "/other", workspaceIdentity: "id-B" },
  ]);
  const result = applyActiveRelayTaskStatus(tasks, active);
  assert.equal(result[0]?.status, "completed");
  assert.equal(result[1]?.status, "running");
});

test("empty active set keeps the index status unchanged", () => {
  const result = applyActiveRelayTaskStatus([completed], new Map());
  assert.equal(result[0]?.status, "completed");
});
