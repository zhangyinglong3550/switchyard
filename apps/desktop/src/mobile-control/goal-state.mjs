import { cleanMobileText } from "./dto.mjs";

const DONE = new Set(["completed", "complete", "done"]);
const ACTIVE = new Set(["in_progress", "running", "doing", "active"]);
// Codex 目标模式（create/update_goal + update_plan）、Claude TodoWrite、
// OpenCode/DSH todo_write 都视为目标/计划来源，统一喂给手机端目标面板。
const GOAL_TOOL_NAMES = new Set(["create_goal", "get_goal", "update_goal", "update_plan", "todo_write", "todowrite", "write_todo"]);

function objectValue(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return {}; }
}

function planItems(value) {
  const raw = Array.isArray(value) ? value : [];
  return raw.map((item) => ({
    step: cleanMobileText(item?.step || item?.title || item?.task || item?.content || "", 500).trim(),
    status: String(item?.status || "pending").toLowerCase()
  })).filter((item) => item.step);
}

export function isGoalTool(tool = {}) {
  return GOAL_TOOL_NAMES.has(String(tool?.name || "").trim().toLowerCase());
}

export function projectGoal(goal = {}) {
  if (!goal || typeof goal !== "object") return null;
  const plan = planItems(goal.plan);
  const status = ["in_progress", "complete", "blocked"].includes(String(goal.status))
    ? String(goal.status)
    : plan.some((item) => ACTIVE.has(item.status)) ? "in_progress" : plan.length && plan.every((item) => DONE.has(item.status)) ? "complete" : "in_progress";
  const objective = cleanMobileText(goal.objective || "", 500).trim();
  if (!objective && !plan.length) return null;
  return {
    objective: objective || "执行计划",
    status,
    createdAt: goal.createdAt ? String(goal.createdAt) : null,
    updatedAt: goal.updatedAt ? String(goal.updatedAt) : null,
    completedAt: goal.completedAt ? String(goal.completedAt) : null,
    blockedReason: cleanMobileText(goal.blockedReason || "", 1000).trim() || null,
    tokenBudget: Number.isFinite(Number(goal.tokenBudget)) ? Number(goal.tokenBudget) : null,
    tokenUsage: Number.isFinite(Number(goal.tokenUsage)) ? Number(goal.tokenUsage) : null,
    plan
  };
}

export function applyGoalTool(previous, tool = {}, { at = new Date().toISOString() } = {}) {
  const name = String(tool?.name || "").trim().toLowerCase();
  if (!isGoalTool(tool)) return projectGoal(previous);
  const args = objectValue(tool.arguments);
  const output = objectValue(tool.output);
  const source = Object.keys(output).length ? { ...args, ...output } : args;
  const next = { ...(previous || {}), updatedAt: at };
  if (name === "create_goal") {
    next.objective = source.objective || source.goal || next.objective;
    next.tokenBudget = source.token_budget ?? source.tokenBudget ?? next.tokenBudget;
    next.status = "in_progress";
    next.createdAt = next.createdAt || at;
  }
  if (name === "update_goal") {
    const status = String(source.status || source.goal_status || "").toLowerCase();
    if (["complete", "completed", "done"].includes(status)) {
      next.status = "complete"; next.completedAt = at;
    } else if (status === "blocked") {
      next.status = "blocked";
      next.blockedReason = source.reason || source.blocked_reason || source.message || next.blockedReason;
    } else if (status) next.status = "in_progress";
    next.tokenUsage = source.token_usage ?? source.tokenUsage ?? next.tokenUsage;
  }
  if (name === "get_goal") {
    next.objective = source.objective || source.goal || next.objective;
    next.status = source.status || next.status;
    next.tokenBudget = source.token_budget ?? source.tokenBudget ?? next.tokenBudget;
    next.tokenUsage = source.token_usage ?? source.tokenUsage ?? next.tokenUsage;
  }
  if (name === "update_plan") {
    const plan = planItems(source.plan || source.steps);
    if (plan.length) next.plan = plan;
    if (!next.status || next.status === "complete") next.status = "in_progress";
  }
  if (name === "todo_write" || name === "todowrite" || name === "write_todo") {
    const plan = planItems(source.todos || source.plan || source.steps);
    if (plan.length) next.plan = plan;
    if (!next.status || next.status === "complete") next.status = "in_progress";
  }
  return projectGoal(next);
}

export function deriveGoalFromMessages(messages = []) {
  let goal = null;
  for (const message of messages) {
    if (message?.tool) goal = applyGoalTool(goal, message.tool, { at: message.timestamp || new Date().toISOString() });
  }
  return goal;
}
