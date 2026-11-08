import type { Ctx } from "./db.js";
import { many, one, run } from "./db.js";
import { AppError } from "./errors.js";
import { display } from "./ids.js";
import { criteriaFor, resolveGoalRef, type GoalRow } from "./goals.js";

export type Urgency = "urgent" | "not_urgent";
export type Importance = "high" | "low";
export type TaskState = "inbox" | "ready" | "in_progress" | "paused" | "completed" | "cancelled";

export interface TaskRow {
  id: number;
  title: string;
  state: TaskState;
  urgency: Urgency | null;
  importance: Importance | null;
  goal_id: number | null;
  source: string;
  source_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type TaskCategory =
  "inbox" | "urgent_high" | "nonurgent_high" | "urgent_low" | "nonurgent_low";

export const CATEGORY_LABEL: Record<TaskCategory, string> = {
  inbox: "Inbox",
  urgent_high: "Urgent + high priority",
  nonurgent_high: "Non-urgent + high priority",
  urgent_low: "Urgent + low priority",
  nonurgent_low: "Non-urgent + low priority",
};

export function categoryOf(task: Pick<TaskRow, "urgency" | "importance">): TaskCategory {
  if (!task.urgency || !task.importance) return "inbox";
  if (task.urgency === "urgent") return task.importance === "high" ? "urgent_high" : "urgent_low";
  return task.importance === "high" ? "nonurgent_high" : "nonurgent_low";
}

export function categoryText(task: TaskRow): string {
  return CATEGORY_LABEL[categoryOf(task)].toLowerCase().replace(" + ", ", ");
}

export function addTask(ctx: Ctx, input: { title: string; source?: string; sourceId?: string }) {
  const title = input.title.trim();
  if (!title) throw new AppError("invalid_task", "Task title is required");
  const timestamp = ctx.now().toISOString();
  const result = run(
    ctx.db,
    `INSERT INTO tasks (title, state, source, source_id, created_at, updated_at)
     VALUES (?, 'inbox', ?, ?, ?, ?)`,
    title,
    input.source ?? "local",
    input.sourceId ?? null,
    timestamp,
    timestamp,
  );
  return requireTask(ctx, Number(result.lastInsertRowid));
}

export function getTask(ctx: Ctx, id: number): TaskRow | undefined {
  return one<TaskRow>(ctx.db, "SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL", id);
}

export function requireTask(ctx: Ctx, id: number): TaskRow {
  const task = getTask(ctx, id);
  if (!task) throw new AppError("task_not_found", `Task ${display("task", id)} was not found`);
  return task;
}

export interface UpdateTaskInput {
  title?: string;
  goalRefs?: string[];
  clearGoals?: boolean;
  urgency?: Urgency;
  importance?: Importance;
  state?: TaskState;
}

export function updateTask(ctx: Ctx, id: number, input: UpdateTaskInput): TaskRow {
  const task = requireTask(ctx, id);
  const timestamp = ctx.now().toISOString();
  ctx.db.transaction(() => {
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new AppError("invalid_task", "Task title is required");
      run(ctx.db, "UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?", title, timestamp, id);
    }
    if (input.goalRefs !== undefined || input.clearGoals) {
      const goals = (input.goalRefs ?? []).map((ref) => resolveGoalRef(ctx, ref));
      if (goals.length > 0) validateGoals(ctx, goals);
      run(ctx.db, "DELETE FROM task_goals WHERE task_id = ?", id);
      goals.forEach((goal, index) => {
        run(
          ctx.db,
          "INSERT INTO task_goals (task_id, goal_id, is_primary) VALUES (?, ?, ?)",
          id,
          goal.id,
          index === 0 ? 1 : 0,
        );
      });
      run(
        ctx.db,
        "UPDATE tasks SET goal_id = ?, updated_at = ? WHERE id = ?",
        goals[0]?.id ?? null,
        timestamp,
        id,
      );
    }
    const urgency = input.urgency ?? task.urgency;
    const importance = input.importance ?? task.importance;
    if (input.urgency !== undefined || input.importance !== undefined) {
      run(
        ctx.db,
        "UPDATE tasks SET urgency = ?, importance = ?, updated_at = ? WHERE id = ?",
        urgency,
        importance,
        timestamp,
        id,
      );
    }
    if (input.state !== undefined) {
      run(
        ctx.db,
        "UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?",
        input.state,
        timestamp,
        id,
      );
    } else {
      applyDerivedState(ctx, id);
    }
  })();
  return requireTask(ctx, id);
}

function validateGoals(ctx: Ctx, goals: GoalRow[]): void {
  for (const goal of goals) {
    if (!goal.available || goal.stale) {
      throw new AppError(
        "goal_unavailable",
        `Goal ${display("goal", goal.id)} is unavailable; links cannot be checked`,
      );
    }
  }
}

function applyDerivedState(ctx: Ctx, id: number): void {
  const task = requireTask(ctx, id);
  if (task.state === "in_progress" || task.state === "paused") return;
  if (task.state === "completed" || task.state === "cancelled") return;
  const next = categoryOf(task) === "inbox" ? "inbox" : "ready";
  if (next !== task.state) {
    run(
      ctx.db,
      "UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?",
      next,
      ctx.now().toISOString(),
      id,
    );
  }
}

export function setTaskState(ctx: Ctx, id: number, state: TaskState): TaskRow {
  requireTask(ctx, id);
  run(
    ctx.db,
    "UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?",
    state,
    ctx.now().toISOString(),
    id,
  );
  return requireTask(ctx, id);
}

export function taskGoals(ctx: Ctx, taskId: number): GoalRow[] {
  return many<GoalRow>(
    ctx.db,
    `SELECT goals.* FROM goals
     JOIN task_goals ON task_goals.goal_id = goals.id
     WHERE task_goals.task_id = ?
     ORDER BY task_goals.is_primary DESC, goals.id`,
    taskId,
  );
}

export function primaryGoal(ctx: Ctx, taskId: number): GoalRow | undefined {
  return taskGoals(ctx, taskId)[0];
}

export function listTasks(ctx: Ctx): TaskRow[] {
  return many<TaskRow>(ctx.db, "SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY id");
}

export function groupedTasks(ctx: Ctx): Record<TaskCategory, TaskRow[]> {
  const groups: Record<TaskCategory, TaskRow[]> = {
    inbox: [],
    urgent_high: [],
    nonurgent_high: [],
    urgent_low: [],
    nonurgent_low: [],
  };
  for (const task of listTasks(ctx)) groups[categoryOf(task)].push(task);
  return groups;
}

export function lastProgress(ctx: Ctx, taskId: number) {
  return one<{ id: number; summary: string; created_at: string; session_id: number | null }>(
    ctx.db,
    "SELECT id, summary, created_at, session_id FROM progress_entries WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    taskId,
  );
}

export function lastSession(ctx: Ctx, taskId: number) {
  return one<{ id: number; state: string; planned_start: string; planned_end: string }>(
    ctx.db,
    "SELECT id, state, planned_start, planned_end FROM sessions WHERE task_id = ? ORDER BY id DESC LIMIT 1",
    taskId,
  );
}

export function taskShow(ctx: Ctx, id: number) {
  const task = requireTask(ctx, id);
  const goals = taskGoals(ctx, id);
  const progress = lastProgress(ctx, id);
  const session = lastSession(ctx, id);
  return {
    ...task,
    ref: display("task", id),
    category: categoryOf(task),
    category_text: categoryText(task),
    goals: goals.map((goal) => goalSummaryRef(goal)),
    last_progress: progress ? { ...progress, ref: display("progress", progress.id) } : null,
    last_session: session ? { ...session, ref: display("session", session.id) } : null,
  };
}

function goalSummaryRef(goal: GoalRow) {
  return { ...goal, ref: display("goal", goal.id) };
}

export function taskContext(ctx: Ctx, id: number) {
  const task = taskShow(ctx, id);
  const sessions = many<Record<string, unknown>>(
    ctx.db,
    "SELECT * FROM sessions WHERE task_id = ? ORDER BY id",
    id,
  );
  const progress = many<Record<string, unknown>>(
    ctx.db,
    "SELECT * FROM progress_entries WHERE task_id = ? ORDER BY id",
    id,
  );
  const activity = many<Record<string, unknown>>(
    ctx.db,
    `SELECT a.*, o.source, o.project, o.app, o.url, o.demo
     FROM attributions a LEFT JOIN observations o ON o.id = a.observation_id
     WHERE a.task_id = ? AND a.superseded_by IS NULL ORDER BY a.start_utc`,
    id,
  );
  const goals = taskGoals(ctx, id).map((goal) => ({
    ...goalSummaryRef(goal),
    criteria: criteriaFor(ctx, goal.id).map((item) => ({
      ...item,
      ref: display("criterion", item.id),
    })),
  }));
  const sources = many<Record<string, unknown>>(
    ctx.db,
    "SELECT * FROM source_state ORDER BY source",
  );
  return {
    schema_version: 1,
    task: { ...task, goals },
    sessions,
    progress_entries: progress,
    related_activity: activity,
    source_updates: sources,
    next_actions: nextActions(task),
  };
}

function nextActions(task: ReturnType<typeof taskShow>): string[] {
  if (task.state === "completed" || task.state === "cancelled") return ["show", "context"];
  return ["start", "schedule", "complete", "context"];
}

export function completeTask(ctx: Ctx, id: number): TaskRow {
  const task = requireTask(ctx, id);
  if (task.state === "cancelled") {
    throw new AppError("task_cancelled", "A cancelled task cannot be completed");
  }
  return setTaskState(ctx, id, "completed");
}
