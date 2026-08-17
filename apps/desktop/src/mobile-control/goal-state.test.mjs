import assert from "node:assert/strict";
import test from "node:test";

import { applyGoalTool, deriveGoalFromMessages, isGoalTool } from "./goal-state.mjs";

test("goal state · todo_write feeds the plan (Claude TodoWrite / OpenCode / DSH shape)", () => {
  const goal = deriveGoalFromMessages([
    { role: "user", text: "开始", kind: "text" },
    { role: "tool", kind: "tool", text: "清单", tool: { id: "t1", name: "TodoWrite", arguments: JSON.stringify({ todos: [
      { content: "读取文档", status: "completed" },
      { content: "写代码", status: "in_progress" },
      { content: "跑测试", status: "pending" }
    ] }), status: "completed" } },
    { role: "tool", kind: "tool", text: "清单", tool: { id: "t2", name: "todo_write", arguments: JSON.stringify({ todos: [
      { content: "读取文档", status: "completed" },
      { content: "写代码", status: "completed" }
    ] }), status: "completed" } }
  ]);
  assert.ok(goal);
  assert.equal(goal.plan.length, 2);
  assert.equal(goal.plan[1].step, "写代码");
  assert.equal(goal.plan[1].status, "completed");
  assert.equal(goal.status, "in_progress");
});

test("goal state · codex goal tools still work and complete", () => {
  assert.ok(isGoalTool({ name: "update_plan" }));
  assert.ok(isGoalTool({ name: "todo_write" }));
  let goal = applyGoalTool(null, { name: "create_goal", arguments: JSON.stringify({ objective: "上线 2.3 版本", token_budget: 1000 }) });
  assert.equal(goal.objective, "上线 2.3 版本");
  goal = applyGoalTool(goal, { name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "打包", status: "in_progress" }] }) });
  assert.equal(goal.plan[0].step, "打包");
  goal = applyGoalTool(goal, { name: "update_goal", arguments: JSON.stringify({ status: "complete" }) });
  assert.equal(goal.status, "complete");
});

test("goal state · non-plan tools never create a goal", () => {
  const goal = deriveGoalFromMessages([
    { role: "tool", kind: "tool", text: "bash", tool: { id: "b1", name: "bash", arguments: "{\"command\":\"ls\"}", status: "completed" } }
  ]);
  assert.equal(goal, null);
});
