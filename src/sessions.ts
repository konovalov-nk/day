import type { Ctx } from "./db.js";
import { many, one, run } from "./db.js";
import { AppError } from "./errors.js";
import { addEvent, eventConflicts, getEvent, updateEvent } from "./events.js";
import { display } from "./ids.js";
import { attributionsForSession, sessionMetrics, type SessionRow } from "./metrics.js";
import { primaryGoal, requireTask } from "./tasks.js";
import { formatDuration, formatPercent, localDateAt, localTimeAt, parseInstant } from "./time.js";

export interface StartSessionInput {
  taskId: number;
  durationSeconds: number;
  start?: Date;
  operationId?: string;
  allowOverlap?: boolean;
  replace?: boolean;
}

export function startSession(ctx: Ctx, input: StartSessionInput): SessionRow {
  const task = requireTask(ctx, input.taskId);
  if (task.state === "completed" || task.state === "cancelled") {
    throw new AppError("task_closed", `Task ${display("task", task.id)} cannot start a session`);
  }
  const goal = primaryGoal(ctx, task.id);
  if (!goal) {
    throw new AppError(
      "goal_required",
      `Task ${display("task", task.id)} needs a goal before it can start`,
    );
  }
  if (goal.stale || !goal.available) {
    throw new AppError("goal_unavailable", `Goal ${display("goal", goal.id)} is unavailable`);
  }
  const start = input.start ?? ctx.now();
  const end = new Date(start.getTime() + input.durationSeconds * 1000);
  resolveConflicts(ctx, start, end, input);
  return createSession(ctx, {
    taskId: task.id,
    goalId: goal.id,
    start,
    end,
    state: "running",
    operationId: input.operationId,
  });
}

export interface ScheduleSessionInput {
  taskId: number;
  start: Date;
  durationSeconds: number;
  operationId?: string;
  allowOverlap?: boolean;
  replace?: boolean;
}

export function scheduleSession(ctx: Ctx, input: ScheduleSessionInput): SessionRow {
  const task = requireTask(ctx, input.taskId);
  if (task.state === "completed" || task.state === "cancelled") {
    throw new AppError("task_closed", `Task ${display("task", task.id)} cannot be scheduled`);
  }
  const goal = primaryGoal(ctx, task.id);
  if (!goal) {
    throw new AppError(
      "goal_required",
      `Task ${display("task", task.id)} needs a goal before it can be scheduled`,
    );
  }
  const end = new Date(input.start.getTime() + input.durationSeconds * 1000);
  resolveConflicts(ctx, input.start, end, input);
  return createSession(ctx, {
    taskId: task.id,
    goalId: goal.id,
    start: input.start,
    end,
    state: "planned",
    operationId: input.operationId,
  });
}

interface CreateSessionInput {
  taskId: number;
  goalId: number;
  start: Date;
  end: Date;
  state: "running" | "planned";
  operationId?: string;
}

function createSession(ctx: Ctx, input: CreateSessionInput): SessionRow {
  const timestamp = ctx.now().toISOString();
  return ctx.db.transaction(() => {
    const result = run(
      ctx.db,
      `INSERT INTO sessions
       (task_id, goal_id, planned_start, planned_end, actual_start, state, operation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.taskId,
      input.goalId,
      input.start.toISOString(),
      input.end.toISOString(),
      input.state === "running" ? input.start.toISOString() : null,
      input.state,
      input.operationId ?? null,
      timestamp,
      timestamp,
    );
    const sessionId = Number(result.lastInsertRowid);
    const event = addEvent(ctx, {
      title: requireTask(ctx, input.taskId).title,
      start: input.start,
      end: input.end,
      kind: "block",
      taskId: input.taskId,
      sessionId,
      sourceId: `session-${sessionId}`,
    });
    run(
      ctx.db,
      "UPDATE sessions SET event_id = ?, updated_at = ? WHERE id = ?",
      event.id,
      timestamp,
      sessionId,
    );
    if (input.state === "running") {
      run(
        ctx.db,
        "UPDATE tasks SET state = 'in_progress', updated_at = ? WHERE id = ? AND state NOT IN ('completed', 'cancelled')",
        timestamp,
        input.taskId,
      );
    }
    return requireSession(ctx, sessionId);
  })();
}

function resolveConflicts(
  ctx: Ctx,
  start: Date,
  end: Date,
  input: { allowOverlap?: boolean; replace?: boolean },
): void {
  const conflicts = eventConflicts(ctx, start, end);
  const running = runningSession(ctx);
  if (running && !conflicts.some((event) => event.session_id === running.id)) {
    const event = running.event_id ? getEvent(ctx, running.event_id) : undefined;
    if (event) {
      conflicts.push({
        ...event,
        ref: display("event", event.id),
        occurrence_ref: display("event", event.id),
        local_date: localDateAt(parseInstant(event.start_utc), event.timezone),
        start_time: localTimeAt(event.start_utc, event.timezone),
        end_time: localTimeAt(event.end_utc, event.timezone),
        time_label: `${localTimeAt(event.start_utc, event.timezone)}–${localTimeAt(event.end_utc, event.timezone)}`,
        day_label: "Today",
        cancelled: false,
        task_ref: event.task_id ? display("task", event.task_id) : null,
        session_ref: display("session", running.id),
      });
    }
  }
  if (conflicts.length === 0 || input.allowOverlap) return;
  if (input.replace) {
    const appointments = conflicts.filter((conflict) => !conflict.session_id);
    if (appointments.length > 0) {
      throw new AppError(
        "time_conflict",
        `An appointment still overlaps: ${appointments.map((item) => `${item.title} (${item.time_label})`).join("; ")}`,
        { exitCode: 3 },
      );
    }
    for (const conflict of conflicts) {
      if (conflict.session_id)
        endSessionRecording(ctx, conflict.session_id, "Replaced by a new session", null);
    }
    return;
  }
  throw new AppError(
    "time_conflict",
    `The interval overlaps: ${conflicts.map((item) => `${item.title} (${item.time_label})`).join("; ")}`,
    {
      exitCode: 3,
      details: {
        conflicts: conflicts.map((item) => ({
          ref: item.ref,
          title: item.title,
          time: item.time_label,
          session: item.session_ref,
        })),
      },
    },
  );
}

function endSessionRecording(
  ctx: Ctx,
  sessionId: number,
  summary: string,
  artifact: string | null,
) {
  const session = requireSession(ctx, sessionId);
  if (session.state !== "running") return;
  const timestamp = ctx.now().toISOString();
  run(
    ctx.db,
    "UPDATE sessions SET state = 'ended', actual_end = ?, updated_at = ? WHERE id = ?",
    timestamp,
    timestamp,
    sessionId,
  );
  run(
    ctx.db,
    `INSERT INTO progress_entries (task_id, session_id, status, summary, artifact, created_at)
     VALUES (?, ?, 'replaced', ?, ?, ?)`,
    session.task_id,
    sessionId,
    summary,
    artifact,
    timestamp,
  );
  run(
    ctx.db,
    "UPDATE tasks SET state = 'paused', updated_at = ? WHERE id = ? AND state NOT IN ('completed', 'cancelled')",
    timestamp,
    session.task_id,
  );
}

export function getSession(ctx: Ctx, id: number): SessionRow | undefined {
  return one<SessionRow>(ctx.db, "SELECT * FROM sessions WHERE id = ?", id);
}

export function requireSession(ctx: Ctx, id: number): SessionRow {
  const session = getSession(ctx, id);
  if (!session) {
    throw new AppError("session_not_found", `Session ${display("session", id)} was not found`);
  }
  return session;
}

export function runningSession(ctx: Ctx): SessionRow | undefined {
  return one<SessionRow>(
    ctx.db,
    "SELECT * FROM sessions WHERE state = 'running' ORDER BY actual_start DESC, id DESC LIMIT 1",
  );
}

export interface EndSessionInput {
  progress: string;
  artifact?: string;
  operationId?: string;
}

export function endSession(ctx: Ctx, id: number, input: EndSessionInput) {
  const session = requireSession(ctx, id);
  if (session.state !== "running" && session.state !== "planned") {
    throw new AppError(
      "session_closed",
      `Session ${display("session", id)} is already ${session.state}`,
    );
  }
  const summary = input.progress.trim();
  if (!summary)
    throw new AppError("progress_required", "A progress summary is required to end a session");
  const timestamp = ctx.now().toISOString();
  const result = ctx.db.transaction(() => {
    run(
      ctx.db,
      "UPDATE sessions SET state = 'ended', actual_end = ?, updated_at = ? WHERE id = ?",
      timestamp,
      timestamp,
      id,
    );
    const progress = run(
      ctx.db,
      `INSERT INTO progress_entries (task_id, session_id, status, summary, artifact, created_at, operation_id)
       VALUES (?, ?, 'progress', ?, ?, ?, ?)`,
      session.task_id,
      id,
      summary,
      input.artifact ?? null,
      timestamp,
      input.operationId ?? null,
    );
    run(
      ctx.db,
      "UPDATE tasks SET state = 'paused', updated_at = ? WHERE id = ? AND state NOT IN ('completed', 'cancelled')",
      timestamp,
      session.task_id,
    );
    return Number(progress.lastInsertRowid);
  })();
  return { session: requireSession(ctx, id), progressId: result };
}

export function cancelSession(ctx: Ctx, id: number): SessionRow {
  const session = requireSession(ctx, id);
  if (session.state === "ended" || session.state === "cancelled") {
    throw new AppError(
      "session_closed",
      `Session ${display("session", id)} is already ${session.state}`,
    );
  }
  const timestamp = ctx.now().toISOString();
  ctx.db.transaction(() => {
    run(
      ctx.db,
      "UPDATE sessions SET state = 'cancelled', actual_end = ?, updated_at = ? WHERE id = ?",
      timestamp,
      timestamp,
      id,
    );
    if (session.event_id) updateEvent(ctx, session.event_id, { status: "cancelled" });
    run(
      ctx.db,
      "UPDATE tasks SET state = 'paused', updated_at = ? WHERE id = ? AND state = 'in_progress'",
      timestamp,
      session.task_id,
    );
  })();
  return requireSession(ctx, id);
}

export function retimeSession(ctx: Ctx, id: number, start: Date, end: Date): SessionRow {
  if (end <= start) throw new AppError("invalid_event", "Session end must be after its start");
  const session = requireSession(ctx, id);
  if (session.planned_start === start.toISOString() && session.planned_end === end.toISOString()) {
    return session;
  }
  const timestamp = ctx.now().toISOString();
  const nextRevision = session.plan_revision + 1;
  ctx.db.transaction(() => {
    run(
      ctx.db,
      `INSERT INTO session_plan_revisions (session_id, revision, planned_start, planned_end, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      session.plan_revision,
      session.planned_start,
      session.planned_end,
      timestamp,
    );
    run(
      ctx.db,
      `UPDATE sessions SET planned_start = ?, planned_end = ?, plan_revision = ?, updated_at = ? WHERE id = ?`,
      start.toISOString(),
      end.toISOString(),
      nextRevision,
      timestamp,
      id,
    );
    if (session.event_id) updateEvent(ctx, session.event_id, { start, end });
  })();
  return requireSession(ctx, id);
}

export function sessionShow(ctx: Ctx, id: number) {
  const session = requireSession(ctx, id);
  const task = requireTask(ctx, session.task_id);
  const goal = session.goal_id
    ? one<{ id: number; title: string }>(
        ctx.db,
        "SELECT id, title FROM goals WHERE id = ?",
        session.goal_id,
      )
    : undefined;
  const metrics = sessionMetrics(ctx, session);
  const progress = many<{
    id: number;
    summary: string;
    artifact: string | null;
    created_at: string;
  }>(
    ctx.db,
    "SELECT id, summary, artifact, created_at FROM progress_entries WHERE session_id = ? ORDER BY id",
    id,
  );
  const event = session.event_id ? getEvent(ctx, session.event_id) : undefined;
  const planRevisions = many<Record<string, unknown>>(
    ctx.db,
    "SELECT * FROM session_plan_revisions WHERE session_id = ? ORDER BY revision",
    id,
  );
  return {
    ...session,
    ref: display("session", id),
    task: { ...task, ref: display("task", task.id) },
    goal: goal ? { ...goal, ref: display("goal", goal.id) } : null,
    event: event
      ? {
          ...event,
          ref: display("event", event.id),
          start_time: localTimeAt(event.start_utc, event.timezone),
          end_time: localTimeAt(event.end_utc, event.timezone),
        }
      : null,
    metrics,
    progress: progress.map((item) => ({ ...item, ref: display("progress", item.id) })),
    plan_revisions: planRevisions,
    attribution: attributionsForSession(ctx, session),
  };
}

export function sessionShowText(ctx: Ctx, id: number): string[] {
  const view = sessionShow(ctx, id);
  const timezone = ctx.timezone;
  const planned = `${localTimeAt(view.planned_start, timezone)}–${localTimeAt(view.planned_end, timezone)}`;
  const metrics = view.metrics;
  const lines = [
    `${view.ref}  ${view.task.title}`,
    `State: ${view.state}`,
    `Goal: ${view.goal?.ref ?? "none"}${view.goal ? ` — ${view.goal.title}` : ""}`,
    `Planned: ${planned}  ${formatDuration(metrics.planned_seconds)}`,
  ];
  if (metrics.accepted_seconds > 0) {
    lines.push(`Task ${view.task.ref}: ${formatDuration(metrics.accepted_seconds)}`);
  }
  if (metrics.unassigned_seconds > 0)
    lines.push(`Unassigned: ${formatDuration(metrics.unassigned_seconds)}`);
  if (metrics.ambiguous_seconds > 0)
    lines.push(`Ambiguous: ${formatDuration(metrics.ambiguous_seconds)}`);
  if (metrics.idle_seconds > 0) lines.push(`Idle: ${formatDuration(metrics.idle_seconds)}`);
  if (metrics.paused_seconds > 0) lines.push(`Paused: ${formatDuration(metrics.paused_seconds)}`);
  if (metrics.excluded_seconds > 0)
    lines.push(`Excluded: ${formatDuration(metrics.excluded_seconds)}`);
  lines.push(`Missing: ${formatDuration(metrics.missing_seconds)}`);
  lines.push(`Coverage: ${formatPercent(metrics.coverage)}`);
  lines.push(
    `Session adherence: ${formatPercent(metrics.adherence)} (${formatDuration(metrics.accepted_seconds)} / ${formatDuration(metrics.planned_seconds)})`,
  );
  if (metrics.adherence_status === "insufficient_data") {
    lines.push(
      `Result: insufficient_data (coverage below ${formatPercent(ctx.config.coverageThreshold)})`,
    );
  } else {
    lines.push(`Result: ${metrics.adherence_status}`);
  }
  if (view.progress.length > 0) {
    lines.push(`Progress: ${view.progress.map((item) => item.ref).join(", ")}`);
  }
  return lines;
}
