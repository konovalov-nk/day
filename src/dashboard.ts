import type { Ctx } from "./db.js";
import { many, one } from "./db.js";
import { activityStatus, sourceStates } from "./activity.js";
import { evaluateIntentionalDay } from "./evaluations.js";
import { eventsOnDate, nextEvent } from "./events.js";
import { categoryOf, groupedTasks, lastProgress, primaryGoal, type TaskRow } from "./tasks.js";
import { sessionMetrics, daySegments, type SessionRow } from "./metrics.js";
import { runningSession } from "./sessions.js";
import { rangeTotals, report } from "./reports.js";
import { display } from "./ids.js";
import {
  endOfLocalDay,
  formatDateLong,
  formatDuration,
  formatPercent,
  localDateAt,
  localTimeAt,
  parseInstant,
  startOfLocalDay,
} from "./time.js";

export interface DashboardTask {
  ref: string;
  id: number;
  title: string;
  state: string;
  category: string;
  goal_refs: string[];
  goal_titles: string[];
}

export interface DashboardSession {
  ref: string;
  task_ref: string;
  title: string;
  state: string;
  planned_start: string;
  planned_end: string;
  planned_seconds: number;
  accepted_seconds: number;
  coverage: number;
  adherence: number;
  status: string;
}

export interface DashboardData {
  schema_version: number;
  timezone: string;
  date: string;
  date_label: string;
  now: string;
  now_time: string;
  generated_at: string;
  stale: boolean;
  current_task: DashboardSession | null;
  ready_to_continue: { task_ref: string; title: string; last_progress: string | null } | null;
  next_event: {
    ref: string;
    title: string;
    time_label: string;
    start: string;
    end: string;
    minutes_until: number;
  } | null;
  free_minutes: number | null;
  calendar: Array<{
    ref: string;
    title: string;
    time_label: string;
    kind: string;
    reminder_minutes: number | null;
    cancelled: boolean;
  }>;
  task_groups: Record<string, DashboardTask[]>;
  sessions: DashboardSession[];
  metrics: {
    planned_seconds: number;
    accepted_seconds: number;
    goal_seconds: number;
    coverage: number;
    adherence: number;
    unassigned_seconds: number;
    idle_seconds: number;
    missing_seconds: number;
  };
  activity: ReturnType<typeof daySegments>;
  evaluation: { ref: string; revision: number; final_status: string; coverage: number };
  sources: Array<{
    source: string;
    last_success_at: string | null;
    stale: boolean;
    consecutive_errors: number;
    retry_status: string;
  }>;
  tracker: { capture: string; last_update: string | null };
  counts: { inbox: number; tasks: number; sessions: number };
}

function taskView(ctx: Ctx, task: TaskRow): DashboardTask {
  const goal = primaryGoal(ctx, task.id);
  return {
    ref: display("task", task.id),
    id: task.id,
    title: task.title,
    state: task.state,
    category: categoryOf(task),
    goal_refs: goal ? [display("goal", goal.id)] : [],
    goal_titles: goal ? [goal.title] : [],
  };
}

function sessionView(ctx: Ctx, session: SessionRow): DashboardSession {
  const metrics = sessionMetrics(ctx, session);
  const task = one<{ title: string }>(
    ctx.db,
    "SELECT title FROM tasks WHERE id = ?",
    session.task_id,
  );
  return {
    ref: display("session", session.id),
    task_ref: display("task", session.task_id),
    title: task?.title ?? "Task",
    state: session.state,
    planned_start: session.planned_start,
    planned_end: session.planned_end,
    planned_seconds: metrics.planned_seconds,
    accepted_seconds: metrics.accepted_seconds,
    coverage: metrics.coverage,
    adherence: metrics.adherence,
    status: metrics.adherence_status,
  };
}

function sessionsForDate(ctx: Ctx, date: string): SessionRow[] {
  const from = startOfLocalDay(date, ctx.timezone);
  const to = endOfLocalDay(date, ctx.timezone);
  return many<SessionRow>(
    ctx.db,
    `SELECT * FROM sessions
     WHERE planned_start < ? AND planned_end > ? AND state != 'cancelled'
     ORDER BY planned_start`,
    to.toISOString(),
    from.toISOString(),
  );
}

export function buildDashboard(ctx: Ctx, requestedDate?: string): DashboardData {
  const now = ctx.now();
  const today = localDateAt(now, ctx.timezone);
  const date = requestedDate ?? today;
  const events = eventsOnDate(ctx, date);
  const groups = groupedTasks(ctx);
  const sessions = sessionsForDate(ctx, date).map((session) => sessionView(ctx, session));
  const running = runningSession(ctx);
  const current = running && date === today ? sessionView(ctx, running) : null;
  const next = nextEvent(ctx, date === today ? now : startOfLocalDay(date, ctx.timezone));
  const dayStart = startOfLocalDay(date, ctx.timezone);
  const dayEnd = endOfLocalDay(date, ctx.timezone);
  const freeMinutes = next
    ? Math.max(0, Math.round((parseInstant(next.start_utc).getTime() - now.getTime()) / 60_000))
    : Math.max(0, Math.round((dayEnd.getTime() - now.getTime()) / 60_000));
  const totals = rangeTotals(ctx, dayStart, dayEnd).totals;
  const lastEvaluation = one<{
    id: number;
    revision: number;
    final_status: string;
    coverage: number;
  }>(
    ctx.db,
    "SELECT id, revision, final_status, coverage FROM evaluations WHERE period_date = ? ORDER BY revision DESC LIMIT 1",
    date,
  );
  const evaluation = lastEvaluation
    ? {
        ref: display("evaluation", lastEvaluation.id),
        revision: lastEvaluation.revision,
        final_status: lastEvaluation.final_status,
        coverage: lastEvaluation.coverage ?? 0,
      }
    : date > today
      ? { ref: "—", revision: 0, final_status: "pending", coverage: 0 }
      : liveEvaluation(ctx, date);
  const sources = sourceStates(ctx).map((source) => ({
    source: source.source,
    last_success_at: source.last_success_at,
    stale: Boolean(source.stale),
    consecutive_errors: source.consecutive_errors,
    retry_status: source.stale ? "retrying" : source.consecutive_errors > 0 ? "degraded" : "ok",
  }));
  const status = activityStatus(ctx);
  const lastWin = lastProgressTask(ctx);
  return {
    schema_version: 1,
    timezone: ctx.timezone,
    date,
    date_label: formatDateLong(date),
    now: now.toISOString(),
    now_time: localTimeAt(now, ctx.timezone),
    generated_at: now.toISOString(),
    stale: sources.some((source) => source.stale),
    current_task: current,
    ready_to_continue: lastWin
      ? {
          task_ref: display("task", lastWin.task.id),
          title: lastWin.task.title,
          last_progress: lastWin.progress,
        }
      : null,
    next_event: next
      ? {
          ref: next.occurrence_ref,
          title: next.title,
          time_label: next.time_label,
          start: next.start_utc,
          end: next.end_utc,
          minutes_until: Math.max(
            0,
            Math.round((parseInstant(next.start_utc).getTime() - now.getTime()) / 60_000),
          ),
        }
      : null,
    free_minutes: date === today ? freeMinutes : null,
    calendar: events.map((event) => ({
      ref: event.occurrence_ref,
      title: event.title,
      time_label: event.time_label,
      kind: event.kind,
      reminder_minutes: event.reminder_minutes,
      cancelled: event.cancelled,
    })),
    task_groups: Object.fromEntries(
      Object.entries(groups).map(([key, tasks]) => [key, tasks.map((task) => taskView(ctx, task))]),
    ),
    sessions,
    metrics: {
      planned_seconds: totals.planned_seconds,
      accepted_seconds: totals.accepted_seconds,
      goal_seconds: totals.goal_seconds,
      coverage: totals.coverage,
      adherence: totals.adherence,
      unassigned_seconds: totals.unassigned_seconds,
      idle_seconds: totals.idle_seconds,
      missing_seconds: totals.missing_seconds,
    },
    activity: daySegments(ctx, date),
    evaluation,
    sources,
    tracker: {
      capture: status.capture,
      last_update: status.last_observation?.end_time ?? null,
    },
    counts: {
      inbox: groups.inbox.length,
      tasks: Object.values(groups).reduce((sum, list) => sum + list.length, 0),
      sessions: sessions.length,
    },
  };
}

function liveEvaluation(ctx: Ctx, date: string) {
  const live = evaluateIntentionalDay(ctx, date, { save: false });
  return {
    ref: live.ref,
    revision: live.revision,
    final_status: live.final_status,
    coverage: live.coverage,
  };
}

function lastProgressTask(ctx: Ctx): { task: TaskRow; progress: string | null } | null {
  const row = one<TaskRow>(
    ctx.db,
    "SELECT * FROM tasks WHERE state = 'paused' AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 1",
  );
  if (!row) return null;
  return { task: row, progress: lastProgress(ctx, row.id)?.summary ?? null };
}

export function dashboardText(data: DashboardData): string[] {
  const lines = [
    `${data.date_label} — ${data.timezone}`,
    `Now: ${data.now_time}`,
    `Current task: ${
      data.current_task
        ? `${data.current_task.task_ref} ${data.current_task.title} (${data.current_task.ref}, ends ${localTimeAt(data.current_task.planned_end, data.timezone)})`
        : "none"
    }`,
    `Next event: ${
      data.next_event ? `${data.next_event.title}, ${data.next_event.time_label}` : "none"
    }`,
    `Free until next event: ${data.free_minutes === null ? "—" : formatDuration(data.free_minutes * 60)}`,
    `Inbox: ${data.counts.inbox} task${data.counts.inbox === 1 ? "" : "s"}`,
    `Activity tracker: ${data.tracker.capture === "paused" ? "paused" : data.sources.length > 0 ? "running" : "not started"}`,
    `Last update: ${data.tracker.last_update ?? "never"}`,
  ];
  if (data.ready_to_continue) {
    lines.push(
      `Ready to continue: ${data.ready_to_continue.task_ref} — ${data.ready_to_continue.title}`,
    );
    if (data.ready_to_continue.last_progress) {
      lines.push(`Last progress: ${data.ready_to_continue.last_progress}`);
    }
  }
  lines.push(`Goal check: ${data.evaluation.final_status} (${data.evaluation.ref})`);
  return lines;
}

export function reportSummary(ctx: Ctx, date: string) {
  return report(ctx, "day", date);
}

export function staleLabel(data: DashboardData): string {
  return data.stale ? "stale" : "fresh";
}

export function goalCoverageText(value: number): string {
  return formatPercent(value);
}
