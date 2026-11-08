import type { Ctx } from "./db.js";
import { many, one } from "./db.js";
import { display } from "./ids.js";
import { rowsToIntervals, sessionMetrics, type SessionRow } from "./metrics.js";
import {
  addDays,
  addMonths,
  endOfLocalDay,
  formatDateShort,
  formatDuration,
  formatPercent,
  interval,
  localDateAt,
  startOfLocalDay,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subtractAll,
  totalSeconds,
  union,
  type Interval,
} from "./time.js";

export type Period = "day" | "week" | "month" | "quarter" | "year";

export interface PeriodRange {
  period: Period;
  fromDate: string;
  toDate: string;
  from: Date;
  to: Date;
  label: string;
}

export function periodRange(period: Period, date: string, timezone: string): PeriodRange {
  let fromDate = date;
  let toDate = date;
  if (period === "week") {
    fromDate = startOfWeek(date);
    toDate = addDays(fromDate, 6);
  } else if (period === "month") {
    fromDate = startOfMonth(date);
    toDate = addDays(addMonths(fromDate, 1), -1);
  } else if (period === "quarter") {
    fromDate = startOfQuarter(date);
    toDate = addDays(addMonths(fromDate, 3), -1);
  } else if (period === "year") {
    fromDate = startOfYear(date);
    toDate = `${date.slice(0, 4)}-12-31`;
  }
  return {
    period,
    fromDate,
    toDate,
    from: startOfLocalDay(fromDate, timezone),
    to: endOfLocalDay(toDate, timezone),
    label:
      fromDate === toDate
        ? formatDateShort(fromDate)
        : `${formatDateShort(fromDate)} – ${formatDateShort(toDate)}`,
  };
}

interface AttributionRow {
  id: number;
  observation_id: number | null;
  session_id: number | null;
  task_id: number | null;
  goal_id: number | null;
  start_utc: string;
  end_utc: string;
  status: string;
  method: string;
}

interface ObservationRow {
  id: number;
  start_utc: string;
  end_utc: string;
  idle: number;
}

interface CoverageRow {
  start_utc: string;
  end_utc: string;
  status: string;
}

interface TaskAccumulator {
  task_id: number;
  title: string;
  planned: number;
  accepted: number;
  covered: number;
  sessions: number;
}

export interface ReportTotals {
  planned_seconds: number;
  accepted_seconds: number;
  session_accepted_seconds: number;
  observed_seconds: number;
  idle_seconds: number;
  unassigned_seconds: number;
  ambiguous_seconds: number;
  paused_seconds: number;
  excluded_seconds: number;
  missing_seconds: number;
  goal_seconds: number;
  coverage: number;
  adherence: number;
  session_count: number;
}

export interface ReportSession {
  ref: string;
  task_ref: string;
  task_title: string;
  state: string;
  planned_seconds: number;
  accepted_seconds: number;
  coverage: number;
  adherence: number;
  status: string;
}

export interface ReportResult {
  period: Period;
  from_date: string;
  to_date: string;
  label: string;
  timezone: string;
  generated_at: string;
  totals: ReportTotals;
  by_task: Array<{
    ref: string;
    title: string;
    planned_seconds: number;
    accepted_seconds: number;
    coverage: number;
    adherence: number;
    sessions: number;
  }>;
  by_day: Array<{ date: string; label: string; accepted_seconds: number; goal_seconds: number }>;
  sessions: ReportSession[];
}

function rangeRows(ctx: Ctx, from: Date, to: Date) {
  return {
    sessions: many<SessionRow>(
      ctx.db,
      `SELECT * FROM sessions
       WHERE planned_start < ? AND planned_end > ? AND state != 'cancelled'
       ORDER BY planned_start`,
      to.toISOString(),
      from.toISOString(),
    ),
    attributions: many<AttributionRow>(
      ctx.db,
      `SELECT id, observation_id, session_id, task_id, goal_id, start_utc, end_utc, status, method
       FROM attributions WHERE superseded_by IS NULL AND start_utc < ? AND end_utc > ?`,
      to.toISOString(),
      from.toISOString(),
    ),
    observations: many<ObservationRow>(
      ctx.db,
      `SELECT id, start_utc, end_utc, idle FROM observations
       WHERE invalid_reason IS NULL AND start_utc < ? AND end_utc > ?`,
      to.toISOString(),
      from.toISOString(),
    ),
    coverage: many<CoverageRow>(
      ctx.db,
      `SELECT start_utc, end_utc, status FROM coverage_intervals
       WHERE start_utc < ? AND end_utc > ?`,
      to.toISOString(),
      from.toISOString(),
    ),
  };
}

function clippedSession(session: SessionRow, from: Date, to: Date): SessionRow | null {
  const value = interval(session.planned_start, session.planned_end);
  const start = Math.max(value.start, from.getTime());
  const end = Math.min(value.end, to.getTime());
  if (end <= start) return null;
  return {
    ...session,
    planned_start: new Date(start).toISOString(),
    planned_end: new Date(end).toISOString(),
  };
}

export function rangeTotals(
  ctx: Ctx,
  from: Date,
  to: Date,
): { totals: ReportTotals; byTask: Map<number, TaskAccumulator>; sessions: ReportSession[] } {
  const rows = rangeRows(ctx, from, to);
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const accepted = union(
    rowsToIntervals(
      rows.attributions.filter((row) => row.status === "accepted"),
      fromMs,
      toMs,
    ),
  );
  const ambiguous = subtractAll(
    union(
      rowsToIntervals(
        rows.attributions.filter((row) => row.status === "ambiguous"),
        fromMs,
        toMs,
      ),
    ),
    accepted,
  );
  const idle = union([
    ...rowsToIntervals(
      rows.observations.filter((row) => row.idle === 1),
      fromMs,
      toMs,
    ),
    ...rowsToIntervals(
      rows.coverage.filter((row) => row.status === "idle"),
      fromMs,
      toMs,
    ),
  ]);
  const paused = subtractAll(
    union(
      rowsToIntervals(
        rows.coverage.filter((row) => row.status === "paused"),
        fromMs,
        toMs,
      ),
    ),
    [...accepted, ...idle],
  );
  const excluded = subtractAll(
    union(
      rowsToIntervals(
        rows.coverage.filter((row) => row.status === "excluded"),
        fromMs,
        toMs,
      ),
    ),
    [...accepted, ...idle, ...paused],
  );
  const active = subtractAll(
    union([
      ...rowsToIntervals(
        rows.observations.filter((row) => row.idle === 0),
        fromMs,
        toMs,
      ),
      ...rowsToIntervals(
        rows.coverage.filter((row) => row.status === "healthy"),
        fromMs,
        toMs,
      ),
    ]),
    [...idle, ...paused],
  );
  const unassigned = subtractAll(active, [...accepted, ...ambiguous]);
  const goalTaskIds = new Set(
    many<{ id: number }>(ctx.db, "SELECT id FROM tasks WHERE goal_id IS NOT NULL").map(
      (row) => row.id,
    ),
  );
  const goalSeconds = totalSeconds(
    rowsToIntervals(
      rows.attributions.filter(
        (row) =>
          row.status === "accepted" && (goalTaskIds.has(row.task_id ?? -1) || row.goal_id !== null),
      ),
      fromMs,
      toMs,
    ),
  );

  const byTask = new Map<number, TaskAccumulator>();
  const sessions: ReportSession[] = [];
  const missing: Interval[] = [];
  let planned = 0;
  let sessionAccepted = 0;
  let sessionCovered = 0;
  for (const session of rows.sessions) {
    const clipped = clippedSession(session, from, to);
    if (!clipped) continue;
    const metrics = sessionMetrics(ctx, clipped);
    planned += metrics.planned_seconds;
    sessionAccepted += metrics.accepted_seconds;
    sessionCovered += metrics.observed_seconds;
    missing.push(...metrics.intervals.missing);
    const task = one<{ title: string }>(
      ctx.db,
      "SELECT title FROM tasks WHERE id = ?",
      session.task_id,
    );
    const taskAcc = taskAccumulator(byTask, session.task_id, task?.title ?? "Task");
    taskAcc.planned += metrics.planned_seconds;
    taskAcc.covered += metrics.observed_seconds;
    taskAcc.sessions += 1;
    sessions.push({
      ref: display("session", session.id),
      task_ref: display("task", session.task_id),
      task_title: task?.title ?? "Task",
      state: session.state,
      planned_seconds: metrics.planned_seconds,
      accepted_seconds: metrics.accepted_seconds,
      coverage: metrics.coverage,
      adherence: metrics.adherence,
      status: metrics.adherence_status,
    });
  }
  for (const row of rows.attributions) {
    if (row.status !== "accepted" || row.task_id === null) continue;
    const task = one<{ title: string }>(
      ctx.db,
      "SELECT title FROM tasks WHERE id = ?",
      row.task_id,
    );
    const taskAcc = taskAccumulator(byTask, row.task_id, task?.title ?? "Task");
    taskAcc.accepted += totalSeconds(rowsToIntervals([row], fromMs, toMs));
  }
  const totals: ReportTotals = {
    planned_seconds: planned,
    accepted_seconds: totalSeconds(accepted),
    session_accepted_seconds: sessionAccepted,
    observed_seconds: totalSeconds([...active, ...idle, ...excluded]),
    idle_seconds: totalSeconds(idle),
    unassigned_seconds: totalSeconds(unassigned),
    ambiguous_seconds: totalSeconds(ambiguous),
    paused_seconds: totalSeconds(paused),
    excluded_seconds: totalSeconds(excluded),
    missing_seconds: totalSeconds(missing),
    goal_seconds: goalSeconds,
    coverage: planned > 0 ? Math.min(sessionCovered / planned, 1) : 0,
    adherence: planned > 0 ? sessionAccepted / planned : 0,
    session_count: sessions.length,
  };
  return { totals, byTask, sessions };
}

function taskAccumulator(
  map: Map<number, TaskAccumulator>,
  taskId: number,
  title: string,
): TaskAccumulator {
  const existing = map.get(taskId);
  if (existing) return existing;
  const created = { task_id: taskId, title, planned: 0, accepted: 0, covered: 0, sessions: 0 };
  map.set(taskId, created);
  return created;
}

export function report(ctx: Ctx, period: Period, date: string): ReportResult {
  const range = periodRange(period, date, ctx.timezone);
  const { totals, byTask, sessions } = rangeTotals(ctx, range.from, range.to);
  const byTaskRows = [...byTask.values()]
    .map((task) => ({
      ref: display("task", task.task_id),
      title: task.title,
      planned_seconds: task.planned,
      accepted_seconds: task.accepted,
      coverage: task.planned > 0 ? Math.min(task.covered / task.planned, 1) : 0,
      adherence: task.planned > 0 ? task.accepted / task.planned : 0,
      sessions: task.sessions,
    }))
    .sort((a, b) => b.accepted_seconds - a.accepted_seconds);
  const byDay = bucketRanges(ctx, range).map((bucket) => {
    const totalsForBucket = rangeTotals(ctx, bucket.from, bucket.to).totals;
    return {
      date: bucket.date,
      label: bucket.label,
      accepted_seconds: totalsForBucket.accepted_seconds,
      goal_seconds: totalsForBucket.goal_seconds,
    };
  });
  return {
    period,
    from_date: range.fromDate,
    to_date: range.toDate,
    label: range.label,
    timezone: ctx.timezone,
    generated_at: ctx.now().toISOString(),
    totals,
    by_task: byTaskRows,
    by_day: byDay,
    sessions,
  };
}

function bucketRanges(
  ctx: Ctx,
  range: PeriodRange,
): Array<{ date: string; label: string; from: Date; to: Date }> {
  if (range.period === "quarter" || range.period === "year") {
    const months: Array<{ date: string; label: string; from: Date; to: Date }> = [];
    let cursor = startOfMonth(range.fromDate);
    while (cursor <= range.toDate) {
      const next = addMonths(cursor, 1);
      months.push({
        date: cursor,
        label: formatDateShort(cursor),
        from: startOfLocalDay(cursor, ctx.timezone),
        to: startOfLocalDay(next, ctx.timezone),
      });
      cursor = next;
    }
    return months;
  }
  const days: Array<{ date: string; label: string; from: Date; to: Date }> = [];
  let cursor = range.fromDate;
  while (cursor <= range.toDate) {
    days.push({
      date: cursor,
      label: formatDateShort(cursor),
      from: startOfLocalDay(cursor, ctx.timezone),
      to: endOfLocalDay(cursor, ctx.timezone),
    });
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function reportText(view: ReportResult, baseUrl: string): string[] {
  const totals = view.totals;
  const lines = [
    `${view.period[0]?.toUpperCase()}${view.period.slice(1)} ${view.label} — ${view.timezone}`,
    `Planned: ${formatDuration(totals.planned_seconds)}`,
    `Task time: ${formatDuration(totals.accepted_seconds)}`,
    `Session adherence: ${formatPercent(totals.adherence)}`,
    `Coverage: ${formatPercent(totals.coverage)}`,
    `Goal time: ${formatDuration(totals.goal_seconds)}`,
    `Unassigned: ${formatDuration(totals.unassigned_seconds)}`,
    `Idle: ${formatDuration(totals.idle_seconds)}`,
    `Missing: ${formatDuration(totals.missing_seconds)}`,
    `Sessions: ${totals.session_count}`,
  ];
  if (view.by_task.length > 0) {
    lines.push("Tasks:");
    for (const task of view.by_task) {
      lines.push(
        `  ${task.ref}  ${task.title}  ${formatDuration(task.accepted_seconds)} / ${formatDuration(task.planned_seconds)}  ${formatPercent(task.adherence)}`,
      );
    }
  }
  lines.push(`Website: ${baseUrl}/report?period=${view.period}&date=${view.from_date}`);
  return lines;
}

export function dayDate(ctx: Ctx, value: string): string {
  return value === "today" ? localDateAt(ctx.now(), ctx.timezone) : value;
}
