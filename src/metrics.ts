import type { Ctx } from "./db.js";
import { many, one } from "./db.js";
import {
  clip,
  endOfLocalDay,
  interval,
  localDateAt,
  parseInstant,
  startOfLocalDay,
  subtract,
  subtractAll,
  totalSeconds,
  union,
  type Interval,
} from "./time.js";

export interface SessionRow {
  id: number;
  task_id: number;
  goal_id: number | null;
  event_id: number | null;
  planned_start: string;
  planned_end: string;
  actual_start: string | null;
  actual_end: string | null;
  state: string;
  plan_revision: number;
  operation_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AttributionRow {
  id: number;
  start_utc: string;
  end_utc: string;
  status: string;
  task_id: number | null;
  goal_id: number | null;
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

export interface SessionMetrics {
  planned_seconds: number;
  accepted_seconds: number;
  observed_seconds: number;
  idle_seconds: number;
  unassigned_seconds: number;
  ambiguous_seconds: number;
  paused_seconds: number;
  excluded_seconds: number;
  missing_seconds: number;
  coverage: number;
  adherence: number;
  adherence_status: "met" | "not_met" | "insufficient_data";
  intervals: {
    accepted: Interval[];
    idle: Interval[];
    unassigned: Interval[];
    ambiguous: Interval[];
    paused: Interval[];
    excluded: Interval[];
    missing: Interval[];
  };
}

export function rowsToIntervals<T extends { start_utc: string; end_utc: string }>(
  rows: T[],
  from: number,
  to: number,
): Interval[] {
  return rows
    .map((row) => clip(interval(row.start_utc, row.end_utc), from, to))
    .filter((value): value is Interval => value !== null);
}

export function sessionMetrics(ctx: Ctx, session: SessionRow): SessionMetrics {
  const from = parseInstant(session.planned_start).getTime();
  const to = parseInstant(session.planned_end).getTime();
  const planned = Math.max(0, (to - from) / 1000);
  const observations = many<ObservationRow>(
    ctx.db,
    `SELECT id, start_utc, end_utc, idle FROM observations
     WHERE invalid_reason IS NULL AND start_utc < ? AND end_utc > ?`,
    session.planned_end,
    session.planned_start,
  );
  const coverage = many<CoverageRow>(
    ctx.db,
    `SELECT start_utc, end_utc, status FROM coverage_intervals
     WHERE start_utc < ? AND end_utc > ?`,
    session.planned_end,
    session.planned_start,
  );
  const attributions = many<AttributionRow>(
    ctx.db,
    `SELECT id, start_utc, end_utc, status, task_id, goal_id FROM attributions
     WHERE superseded_by IS NULL AND start_utc < ? AND end_utc > ?`,
    session.planned_end,
    session.planned_start,
  );

  const activeObservations = observations.filter((row) => row.idle === 0);
  const idleObservations = observations.filter((row) => row.idle === 1);
  const accepted = union(
    rowsToIntervals(
      attributions.filter((row) => row.status === "accepted" && row.task_id === session.task_id),
      from,
      to,
    ),
  );
  const ambiguous = subtractAll(
    union(
      rowsToIntervals(
        attributions.filter((row) => row.status === "ambiguous"),
        from,
        to,
      ),
    ),
    accepted,
  );
  const idle = subtractAll(
    union([
      ...rowsToIntervals(idleObservations, from, to),
      ...rowsToIntervals(
        coverage.filter((row) => row.status === "idle"),
        from,
        to,
      ),
    ]),
    accepted,
  );
  const paused = subtractAll(
    union(
      rowsToIntervals(
        coverage.filter((row) => row.status === "paused"),
        from,
        to,
      ),
    ),
    [...accepted, ...idle],
  );
  const excluded = subtractAll(
    union(
      rowsToIntervals(
        coverage.filter((row) => row.status === "excluded"),
        from,
        to,
      ),
    ),
    [...accepted, ...idle, ...paused],
  );
  const active = subtractAll(
    union([
      ...rowsToIntervals(activeObservations, from, to),
      ...rowsToIntervals(
        coverage.filter((row) => row.status === "healthy"),
        from,
        to,
      ),
    ]),
    [...idle, ...paused],
  );
  const uncovered = subtract({ start: from, end: to }, [
    ...active,
    ...idle,
    ...paused,
    ...excluded,
  ]);
  const unassigned = subtractAll(active, [...accepted, ...ambiguous]);
  const coverageSeconds = totalSeconds([...active, ...idle, ...excluded]);

  return {
    planned_seconds: planned,
    accepted_seconds: totalSeconds(accepted),
    observed_seconds: totalSeconds([...active, ...idle, ...excluded]),
    idle_seconds: totalSeconds(idle),
    unassigned_seconds: totalSeconds(unassigned),
    ambiguous_seconds: totalSeconds(ambiguous),
    paused_seconds: totalSeconds(paused),
    excluded_seconds: totalSeconds(excluded),
    missing_seconds: totalSeconds(uncovered),
    coverage: planned > 0 ? coverageSeconds / planned : 0,
    adherence: planned > 0 ? totalSeconds(accepted) / planned : 0,
    adherence_status: adherenceStatus(ctx, planned, coverageSeconds, totalSeconds(accepted)),
    intervals: {
      accepted,
      idle,
      unassigned,
      ambiguous,
      paused,
      excluded,
      missing: uncovered,
    },
  };
}

function adherenceStatus(
  ctx: Ctx,
  planned: number,
  covered: number,
  accepted: number,
): SessionMetrics["adherence_status"] {
  if (planned <= 0) return "insufficient_data";
  if (covered / planned < ctx.config.coverageThreshold) return "insufficient_data";
  return accepted / planned >= ctx.config.adherenceThreshold ? "met" : "not_met";
}

export interface TaskDayMetrics {
  task_id: number;
  planned_seconds: number;
  accepted_seconds: number;
  covered_seconds: number;
  coverage: number;
  adherence: number;
  qualifying: boolean;
  sessions: number;
}

export function taskDayMetrics(ctx: Ctx, taskId: number, date: string): TaskDayMetrics {
  const dayStart = startOfLocalDay(date, ctx.timezone);
  const dayEnd = endOfLocalDay(date, ctx.timezone);
  const sessions = many<SessionRow>(
    ctx.db,
    `SELECT * FROM sessions
     WHERE task_id = ? AND planned_start < ? AND planned_end > ?
       AND state != 'cancelled' AND actual_start IS NOT NULL
     ORDER BY planned_start`,
    taskId,
    dayEnd.toISOString(),
    dayStart.toISOString(),
  );
  const acceptedRanges: Interval[] = [];
  const coveredRanges: Interval[] = [];
  let planned = 0;
  for (const session of sessions) {
    const plan = interval(session.planned_start, session.planned_end);
    const clipped = clip(plan, dayStart.getTime(), dayEnd.getTime());
    if (!clipped) continue;
    const metrics = sessionMetrics(ctx, {
      ...session,
      planned_start: new Date(clipped.start).toISOString(),
      planned_end: new Date(clipped.end).toISOString(),
    });
    planned += metrics.planned_seconds;
    acceptedRanges.push(...metrics.intervals.accepted);
    coveredRanges.push(
      ...union([
        ...metrics.intervals.accepted,
        ...metrics.intervals.unassigned,
        ...metrics.intervals.ambiguous,
        ...metrics.intervals.idle,
        ...metrics.intervals.excluded,
      ]),
    );
  }
  const accepted = totalSeconds(union(acceptedRanges));
  const covered = totalSeconds(union(coveredRanges));
  const coverage = planned > 0 ? Math.min(covered / planned, 1) : 0;
  const adherence = planned > 0 ? accepted / planned : 0;
  return {
    task_id: taskId,
    planned_seconds: planned,
    accepted_seconds: accepted,
    covered_seconds: covered,
    coverage,
    adherence,
    qualifying:
      planned > 0 &&
      coverage >= ctx.config.coverageThreshold &&
      adherence >= ctx.config.adherenceThreshold,
    sessions: sessions.length,
  };
}

export function goalTimeSeconds(ctx: Ctx, date: string): number {
  const from = startOfLocalDay(date, ctx.timezone).getTime();
  const to = endOfLocalDay(date, ctx.timezone).getTime();
  const rows = many<{ start_utc: string; end_utc: string }>(
    ctx.db,
    `SELECT a.start_utc, a.end_utc FROM attributions a
     JOIN tasks t ON t.id = a.task_id
     WHERE a.status = 'accepted' AND a.superseded_by IS NULL
       AND (t.goal_id IS NOT NULL OR a.goal_id IS NOT NULL)
       AND a.start_utc < ? AND a.end_utc > ?`,
    new Date(to).toISOString(),
    new Date(from).toISOString(),
  );
  return totalSeconds(rowsToIntervals(rows, from, to));
}

export function daySessionCoverage(ctx: Ctx, date: string): number {
  const dayStart = startOfLocalDay(date, ctx.timezone);
  const dayEnd = endOfLocalDay(date, ctx.timezone);
  const sessions = many<SessionRow>(
    ctx.db,
    `SELECT * FROM sessions WHERE planned_start < ? AND planned_end > ? AND state != 'cancelled'`,
    dayEnd.toISOString(),
    dayStart.toISOString(),
  );
  let planned = 0;
  let covered = 0;
  for (const session of sessions) {
    const metrics = sessionMetrics(ctx, session);
    planned += metrics.planned_seconds;
    covered += metrics.observed_seconds;
  }
  return planned > 0 ? Math.min(covered / planned, 1) : 0;
}

export function tasksWithStartedSessions(ctx: Ctx, date: string): number[] {
  const rows = many<{ task_id: number; actual_start: string }>(
    ctx.db,
    `SELECT DISTINCT task_id, actual_start FROM sessions
     WHERE actual_start IS NOT NULL AND state IN ('running', 'ended', 'paused')`,
  );
  const ids = new Set<number>();
  for (const row of rows) {
    if (localDateAt(parseInstant(row.actual_start), ctx.timezone) === date) ids.add(row.task_id);
  }
  return [...ids];
}

export interface ProgressDayMetrics {
  required: number[];
  completed: number[];
  missing: number[];
}

export function progressForDate(ctx: Ctx, date: string): ProgressDayMetrics {
  const taskIds = tasksWithStartedSessions(ctx, date);
  const dayStart = startOfLocalDay(date, ctx.timezone);
  const dayEnd = endOfLocalDay(date, ctx.timezone);
  const rows = many<{ task_id: number }>(
    ctx.db,
    `SELECT DISTINCT task_id FROM progress_entries WHERE created_at >= ? AND created_at < ?`,
    dayStart.toISOString(),
    dayEnd.toISOString(),
  );
  const completed = new Set(rows.map((row) => row.task_id));
  return {
    required: taskIds,
    completed: taskIds.filter((id) => completed.has(id)),
    missing: taskIds.filter((id) => !completed.has(id)),
  };
}

export interface ActivitySegment {
  start: string;
  end: string;
  minutes: number;
  kind: "accepted" | "unassigned" | "ambiguous" | "idle" | "missing" | "paused" | "excluded";
  task_id: number | null;
  task_ref: string | null;
  session_ref: string | null;
  label: string;
}

interface SegmentInput {
  intervals: Interval[];
  kind: ActivitySegment["kind"];
  taskId?: number | null;
  taskRef?: string | null;
  sessionRef?: string | null;
  label: string;
}

export function daySegments(ctx: Ctx, date: string): ActivitySegment[] {
  const dayStart = startOfLocalDay(date, ctx.timezone);
  const dayEnd = endOfLocalDay(date, ctx.timezone);
  const sessionRows = many<SessionRow>(
    ctx.db,
    `SELECT * FROM sessions WHERE planned_start < ? AND planned_end > ? AND state != 'cancelled'`,
    dayEnd.toISOString(),
    dayStart.toISOString(),
  );
  const inputs: SegmentInput[] = [];
  for (const session of sessionRows) {
    const metrics = sessionMetrics(ctx, session);
    const task = one<{ title: string }>(
      ctx.db,
      "SELECT title FROM tasks WHERE id = ?",
      session.task_id,
    );
    const taskRef = session.task_id ? `T${String(session.task_id).padStart(2, "0")}` : null;
    const sessionRef = `S${String(session.id).padStart(2, "0")}`;
    inputs.push(
      {
        intervals: metrics.intervals.accepted,
        kind: "accepted",
        taskId: session.task_id,
        taskRef,
        sessionRef,
        label: task?.title ?? "Task",
      },
      { intervals: metrics.intervals.unassigned, kind: "unassigned", label: "Unassigned" },
      { intervals: metrics.intervals.ambiguous, kind: "ambiguous", label: "Ambiguous" },
      { intervals: metrics.intervals.idle, kind: "idle", label: "Idle" },
      { intervals: metrics.intervals.paused, kind: "paused", label: "Paused" },
      { intervals: metrics.intervals.excluded, kind: "excluded", label: "Excluded" },
      { intervals: metrics.intervals.missing, kind: "missing", label: "Missing" },
    );
  }
  const segments: ActivitySegment[] = [];
  for (const input of inputs) {
    for (const value of input.intervals) {
      segments.push({
        start: new Date(value.start).toISOString(),
        end: new Date(value.end).toISOString(),
        minutes: Math.round((value.end - value.start) / 60_000),
        kind: input.kind,
        task_id: input.taskId ?? null,
        task_ref: input.taskRef ?? null,
        session_ref: input.sessionRef ?? null,
        label: input.label,
      });
    }
  }
  return segments.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

export interface AttributionDetailRow {
  id: number;
  observation_id: number | null;
  session_id: number | null;
  task_id: number | null;
  goal_id: number | null;
  start_utc: string;
  end_utc: string;
  status: string;
  method: string;
  rule_id: number | null;
  rule_version: number | null;
  reason: string | null;
  revision: number;
  superseded_by: number | null;
  created_at: string;
  source: string | null;
  project: string | null;
  app: string | null;
  url: string | null;
  demo: number | null;
  source_event_id: string | null;
}

export function attributionsForSession(ctx: Ctx, session: SessionRow): AttributionDetailRow[] {
  return many<AttributionDetailRow>(
    ctx.db,
    `SELECT a.*, o.source, o.project, o.app, o.url, o.demo, o.event_id AS source_event_id
     FROM attributions a LEFT JOIN observations o ON o.id = a.observation_id
     WHERE a.superseded_by IS NULL AND a.start_utc < ? AND a.end_utc > ?
     ORDER BY a.start_utc`,
    session.planned_end,
    session.planned_start,
  );
}
