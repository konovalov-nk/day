import type { Ctx } from "./db.js";
import { many, one, run } from "./db.js";
import { AppError } from "./errors.js";
import { display } from "./ids.js";
import { progressForDate, sessionMetrics } from "./metrics.js";
import { rangeTotals } from "./reports.js";
import {
  daysBetween,
  endOfLocalDay,
  formatDuration,
  formatPercent,
  startOfLocalDay,
} from "./time.js";

export type ExperimentMetric =
  "session-adherence" | "goal-time" | "qualifying-tasks" | "progress-completeness";

export const METRIC_VERSION = 1;
export const METRICS: ExperimentMetric[] = [
  "session-adherence",
  "goal-time",
  "qualifying-tasks",
  "progress-completeness",
];

export interface ExperimentRow {
  id: number;
  title: string;
  hypothesis: string;
  change_text: string | null;
  metric: ExperimentMetric;
  metric_version: number;
  baseline_start: string;
  baseline_end: string;
  period_start: string;
  period_end: string;
  created_at: string;
  updated_at: string;
}

export function parseDateRange(value: string): { start: string; end: string } {
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value.trim());
  if (!match?.[1] || !match[2] || match[2] < match[1]) {
    throw new AppError("invalid_range", `Expected YYYY-MM-DD..YYYY-MM-DD. Got: ${value}`);
  }
  return { start: match[1], end: match[2] };
}

export function addExperiment(
  ctx: Ctx,
  input: {
    title: string;
    hypothesis: string;
    change?: string;
    metric: ExperimentMetric;
    baseline: string;
    period: string;
    noteIds?: number[];
  },
) {
  if (!METRICS.includes(input.metric)) {
    throw new AppError("invalid_metric", `Metric must be one of: ${METRICS.join(", ")}`);
  }
  const baseline = parseDateRange(input.baseline);
  const period = parseDateRange(input.period);
  const timestamp = ctx.now().toISOString();
  const id = ctx.db.transaction(() => {
    const result = run(
      ctx.db,
      `INSERT INTO experiments
       (title, hypothesis, change_text, metric, metric_version, baseline_start, baseline_end,
        period_start, period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.title,
      input.hypothesis,
      input.change ?? null,
      input.metric,
      METRIC_VERSION,
      baseline.start,
      baseline.end,
      period.start,
      period.end,
      timestamp,
      timestamp,
    );
    const experimentId = Number(result.lastInsertRowid);
    for (const noteId of input.noteIds ?? []) {
      run(
        ctx.db,
        "INSERT OR IGNORE INTO note_links (note_id, kind, ref_id) VALUES (?, 'experiment', ?)",
        noteId,
        experimentId,
      );
    }
    return experimentId;
  })();
  return showExperiment(ctx, id);
}

export function requireExperiment(ctx: Ctx, id: number): ExperimentRow {
  const experiment = one<ExperimentRow>(ctx.db, "SELECT * FROM experiments WHERE id = ?", id);
  if (!experiment) {
    throw new AppError(
      "experiment_not_found",
      `Experiment ${display("experiment", id)} was not found`,
    );
  }
  return experiment;
}

export function listExperiments(ctx: Ctx) {
  return many<ExperimentRow>(ctx.db, "SELECT * FROM experiments ORDER BY id").map((experiment) => ({
    ...experiment,
    ref: display("experiment", experiment.id),
  }));
}

interface MetricResult {
  value: number;
  coverage: number;
  available: boolean;
  status: "available" | "insufficient_data";
}

export function metricValue(
  ctx: Ctx,
  metric: ExperimentMetric,
  startDate: string,
  endDate: string,
): MetricResult {
  const from = startOfLocalDay(startDate, ctx.timezone);
  const to = endOfLocalDay(endDate, ctx.timezone);
  if (metric === "progress-completeness") return progressMetric(ctx, startDate, endDate);
  const { totals } = rangeTotals(ctx, from, to);
  if (metric === "session-adherence") {
    return metricResult(totals.adherence, totals.coverage, totals.session_count > 0, ctx);
  }
  if (metric === "goal-time") {
    return metricResult(
      totals.goal_seconds,
      totals.coverage,
      totals.session_count > 0 || totals.goal_seconds > 0,
      ctx,
    );
  }
  const qualifying = countQualifying(ctx, from, to);
  return metricResult(qualifying, totals.coverage, totals.session_count > 0, ctx);
}

function metricResult(value: number, coverage: number, available: boolean, ctx: Ctx): MetricResult {
  const status =
    available && coverage >= ctx.config.coverageThreshold ? "available" : "insufficient_data";
  return { value, coverage, available, status };
}

function countQualifying(ctx: Ctx, from: Date, to: Date): number {
  const rows = many<{ task_id: number }>(
    ctx.db,
    `SELECT DISTINCT task_id FROM sessions
     WHERE planned_start < ? AND planned_end > ? AND state != 'cancelled'`,
    to.toISOString(),
    from.toISOString(),
  );
  let qualifying = 0;
  for (const row of rows) {
    const taskSessions = many<{
      id: number;
      planned_start: string;
      planned_end: string;
    }>(
      ctx.db,
      `SELECT id, planned_start, planned_end FROM sessions
       WHERE task_id = ? AND planned_start < ? AND planned_end > ? AND state != 'cancelled'`,
      row.task_id,
      to.toISOString(),
      from.toISOString(),
    );
    let planned = 0;
    let accepted = 0;
    let covered = 0;
    for (const session of taskSessions) {
      const metrics = sessionMetrics(ctx, {
        id: session.id,
        task_id: row.task_id,
        goal_id: null,
        event_id: null,
        planned_start: session.planned_start,
        planned_end: session.planned_end,
        actual_start: null,
        actual_end: null,
        state: "ended",
        plan_revision: 1,
        operation_id: null,
        created_at: "",
        updated_at: "",
      });
      planned += metrics.planned_seconds;
      accepted += metrics.accepted_seconds;
      covered += metrics.observed_seconds;
    }
    if (
      planned > 0 &&
      covered / planned >= ctx.config.coverageThreshold &&
      accepted / planned >= ctx.config.adherenceThreshold
    ) {
      qualifying += 1;
    }
  }
  return qualifying;
}

/* Kept separate so the range metric stays readable. */
function progressMetric(ctx: Ctx, startDate: string, endDate: string): MetricResult {
  let required = 0;
  let completed = 0;
  for (const date of daysBetween(startDate, endDate)) {
    const day = progressForDate(ctx, date);
    required += day.required.length;
    completed += day.completed.length;
  }
  const value = required > 0 ? completed / required : 0;
  return {
    value,
    coverage: 1,
    available: required > 0,
    status: required > 0 ? "available" : "insufficient_data",
  };
}

export function showExperiment(ctx: Ctx, id: number) {
  const experiment = requireExperiment(ctx, id);
  const baseline = metricValue(
    ctx,
    experiment.metric,
    experiment.baseline_start,
    experiment.baseline_end,
  );
  const period = metricValue(
    ctx,
    experiment.metric,
    experiment.period_start,
    experiment.period_end,
  );
  const conclusions = many<{
    id: number;
    text: string;
    author: string;
    method: string;
    created_at: string;
  }>(
    ctx.db,
    "SELECT id, text, author, method, created_at FROM experiment_conclusions WHERE experiment_id = ? ORDER BY id",
    id,
  );
  const notes = many<{ id: number; text: string; created_at: string }>(
    ctx.db,
    `SELECT notes.id, notes.text, notes.created_at FROM notes
     JOIN note_links ON note_links.note_id = notes.id
     WHERE note_links.kind = 'experiment' AND note_links.ref_id = ? AND notes.deleted_at IS NULL`,
    id,
  );
  return {
    ...experiment,
    ref: display("experiment", id),
    baseline: { ...baseline, start: experiment.baseline_start, end: experiment.baseline_end },
    period: { ...period, start: experiment.period_start, end: experiment.period_end },
    changed_definition: experiment.metric_version !== METRIC_VERSION,
    conclusions: conclusions.map((item) => ({ ...item, ref: display("conclusion", item.id) })),
    notes: notes.map((note) => ({ ...note, ref: display("note", note.id) })),
  };
}

export function addConclusion(
  ctx: Ctx,
  id: number,
  input: { text: string; author?: string; method?: string },
) {
  requireExperiment(ctx, id);
  const text = input.text.trim();
  if (!text) throw new AppError("invalid_conclusion", "Conclusion text is required");
  const result = run(
    ctx.db,
    `INSERT INTO experiment_conclusions (experiment_id, text, author, method, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    text,
    input.author ?? ctx.config.actor,
    input.method ?? "manual",
    ctx.now().toISOString(),
  );
  return { id: Number(result.lastInsertRowid), text };
}

export function experimentText(view: ReturnType<typeof showExperiment>): string[] {
  const metric = view.metric;
  const format =
    metric === "goal-time"
      ? formatDuration
      : metric === "qualifying-tasks"
        ? String
        : formatPercent;
  const lines = [
    `${view.ref}  ${view.title}`,
    `Hypothesis: ${view.hypothesis}`,
    ...(view.change_text ? [`Change: ${view.change_text}`] : []),
    `Metric: ${metric} (v${view.metric_version})`,
    `Baseline ${view.baseline.start}..${view.baseline.end}: ${
      view.baseline.available ? format(view.baseline.value) : "unavailable"
    }  coverage ${formatPercent(view.baseline.coverage)}  ${view.baseline.status}`,
    `Period ${view.period.start}..${view.period.end}: ${
      view.period.available ? format(view.period.value) : "unavailable"
    }  coverage ${formatPercent(view.period.coverage)}  ${view.period.status}`,
  ];
  if (view.changed_definition)
    lines.push("Metric definition changed since this experiment was created.");
  if (view.notes.length > 0) lines.push(`Notes: ${view.notes.map((note) => note.ref).join(", ")}`);
  if (view.conclusions.length > 0) {
    for (const conclusion of view.conclusions) {
      lines.push(
        `Conclusion ${conclusion.ref}: ${conclusion.text} (${conclusion.author}, ${conclusion.method})`,
      );
    }
  } else {
    lines.push("Conclusion: not written yet");
  }
  return lines;
}
