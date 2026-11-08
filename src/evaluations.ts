import { createHash } from "node:crypto";
import type { Ctx } from "./db.js";
import { many, one, run } from "./db.js";
import { AppError } from "./errors.js";
import { display } from "./ids.js";
import {
  daySessionCoverage,
  goalTimeSeconds,
  progressForDate,
  taskDayMetrics,
  tasksWithStartedSessions,
} from "./metrics.js";
import { intentionalDayGoal } from "./goals.js";
import {
  endOfLocalDay,
  formatDuration,
  formatPercent,
  localDateAt,
  localTimeAt,
  startOfLocalDay,
} from "./time.js";

const CALCULATION_VERSION = 1;

export type AcStatus = "met" | "not_met" | "insufficient_data";
export type FinalStatus = AcStatus | "pending";

interface AcResult {
  ac_id: string;
  title: string;
  status: AcStatus;
  value: number;
  threshold: number;
  coverage: number;
  evidence: Record<string, unknown>;
}

export interface EvaluationView {
  ref: string;
  id: number;
  goal_ref: string | null;
  goal_revision: number;
  period_date: string;
  revision: number;
  calculation_version: number;
  final_status: FinalStatus;
  coverage: number;
  as_of: string;
  results: AcResult[];
}

function finalFrom(results: AcResult[]): FinalStatus {
  if (results.some((result) => result.status === "not_met")) return "not_met";
  if (results.some((result) => result.status === "insufficient_data")) return "insufficient_data";
  return "met";
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function acTwo(ctx: Ctx, date: string, coverage: number): AcResult {
  const seconds = goalTimeSeconds(ctx, date);
  const threshold = ctx.config.goalHours * 3600;
  let status: AcStatus = "not_met";
  if (seconds >= threshold) status = "met";
  else if (coverage < ctx.config.coverageThreshold) status = "insufficient_data";
  return {
    ac_id: "AC-G01-02",
    title: "Three goal hours",
    status,
    value: seconds,
    threshold,
    coverage,
    evidence: { goal_seconds: seconds },
  };
}

function acThree(ctx: Ctx, date: string): AcResult {
  const progress = progressForDate(ctx, date);
  return {
    ac_id: "AC-G01-03",
    title: "Capture work results",
    status: progress.missing.length === 0 ? "met" : "not_met",
    value:
      progress.required.length === 0 ? 1 : progress.completed.length / progress.required.length,
    threshold: 1,
    coverage: 1,
    evidence: {
      required_task_refs: progress.required.map((id) => display("task", id)),
      missing_task_refs: progress.missing.map((id) => display("task", id)),
    },
  };
}

export function evaluateIntentionalDay(
  ctx: Ctx,
  date: string,
  options: { final?: boolean; save?: boolean } = {},
): EvaluationView {
  const today = localDateAt(ctx.now(), ctx.timezone);
  if (date > today) throw new AppError("future_evaluation", "A future day cannot be evaluated");
  const goal = intentionalDayGoal(ctx);
  const goalRevision = goal?.revision ?? 0;
  const taskIds = tasksWithStartedSessions(ctx, date);
  const coverage = daySessionCoverage(ctx, date);
  const results = [
    acOneForDate(ctx, taskIds, date),
    acTwo(ctx, date, coverage),
    acThree(ctx, date),
  ];
  const isClosed = options.final === true || date < today;
  const finalStatus: FinalStatus = isClosed ? finalFrom(results) : "pending";
  const snapshot = buildSnapshot(ctx, date, goal?.id ?? null, goalRevision, results, coverage);
  const hash = createHash("sha256").update(stableStringify(snapshot)).digest("hex");
  if (options.save === false) {
    return {
      ref: "V00",
      id: 0,
      goal_ref: goal ? display("goal", goal.id) : null,
      goal_revision: goalRevision,
      period_date: date,
      revision: 0,
      calculation_version: CALCULATION_VERSION,
      final_status: finalStatus,
      coverage,
      as_of: ctx.now().toISOString(),
      results,
    };
  }
  return persistEvaluation(ctx, {
    goalId: goal?.id ?? null,
    goalSlug: "intentional-day",
    goalRevision,
    date,
    coverage,
    finalStatus,
    snapshot,
    hash,
    results,
  });
}

function acOneForDate(ctx: Ctx, taskIds: number[], date: string): AcResult {
  const metrics = taskIds.map((taskId) => taskDayMetrics(ctx, taskId, date));
  const qualifying = metrics.filter((metric) => metric.qualifying);
  let status: AcStatus = "not_met";
  if (taskIds.length === 0) status = "not_met";
  else if (qualifying.length >= 2) status = "met";
  else if (metrics.some((metric) => metric.coverage < ctx.config.coverageThreshold)) {
    status = "insufficient_data";
  }
  return {
    ac_id: "AC-G01-01",
    title: "Two aligned tasks",
    status,
    value: qualifying.length,
    threshold: 2,
    coverage: average(metrics.map((metric) => metric.coverage)),
    evidence: {
      tasks: metrics.map((metric) => ({
        task_ref: display("task", metric.task_id),
        planned_seconds: metric.planned_seconds,
        accepted_seconds: metric.accepted_seconds,
        coverage: metric.coverage,
        adherence: metric.adherence,
        qualifying: metric.qualifying,
      })),
    },
  };
}

function buildSnapshot(
  ctx: Ctx,
  date: string,
  goalId: number | null,
  goalRevision: number,
  results: AcResult[],
  coverage: number,
) {
  const from = startOfLocalDay(date, ctx.timezone).toISOString();
  const to = endOfLocalDay(date, ctx.timezone).toISOString();
  const sessions = many<{ id: number; state: string; actual_start: string | null }>(
    ctx.db,
    "SELECT id, state, actual_start FROM sessions WHERE planned_start < ? AND planned_end > ? ORDER BY id",
    to,
    from,
  );
  const observations = many<{ id: number; start_utc: string; end_utc: string }>(
    ctx.db,
    `SELECT id, start_utc, end_utc FROM observations
     WHERE invalid_reason IS NULL AND start_utc < ? AND end_utc > ? ORDER BY id`,
    to,
    from,
  );
  const rules = many<{ id: number; version: number }>(
    ctx.db,
    "SELECT id, version FROM rules ORDER BY id",
  );
  const attribution = one<{ revision: number }>(
    ctx.db,
    `SELECT MAX(revision) AS revision FROM attributions
     WHERE start_utc < ? AND end_utc > ?`,
    to,
    from,
  );
  return {
    date,
    timezone: ctx.timezone,
    goal_id: goalId,
    goal_revision: goalRevision,
    thresholds: {
      adherence: ctx.config.adherenceThreshold,
      coverage: ctx.config.coverageThreshold,
      goal_hours: ctx.config.goalHours,
    },
    results,
    coverage,
    sessions,
    observations,
    rules,
    attribution_revision: attribution?.revision ?? 0,
    calculation_version: CALCULATION_VERSION,
  };
}

function persistEvaluation(
  ctx: Ctx,
  input: {
    goalId: number | null;
    goalSlug: string;
    goalRevision: number;
    date: string;
    coverage: number;
    finalStatus: FinalStatus;
    snapshot: unknown;
    hash: string;
    results: AcResult[];
  },
): EvaluationView {
  const existing = one<{ id: number; revision: number; final_status: FinalStatus }>(
    ctx.db,
    `SELECT id, revision, final_status FROM evaluations
     WHERE goal_slug = ? AND period_date = ? AND snapshot_hash = ?`,
    input.goalSlug,
    input.date,
    input.hash,
  );
  if (existing) {
    if (input.finalStatus !== "pending" && existing.final_status === "pending") {
      run(
        ctx.db,
        "UPDATE evaluations SET final_status = ? WHERE id = ?",
        input.finalStatus,
        existing.id,
      );
      existing.final_status = input.finalStatus;
    }
    return evaluationView(ctx, existing.id);
  }
  const revision =
    (one<{ revision: number }>(
      ctx.db,
      "SELECT MAX(revision) AS revision FROM evaluations WHERE goal_slug = ? AND period_date = ?",
      input.goalSlug,
      input.date,
    )?.revision ?? 0) + 1;
  const evaluationId = ctx.db.transaction(() => {
    const result = run(
      ctx.db,
      `INSERT INTO evaluations
       (goal_id, goal_slug, goal_revision, period_date, revision, calculation_version,
        thresholds_json, snapshot_json, snapshot_hash, coverage, final_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.goalId,
      input.goalSlug,
      input.goalRevision,
      input.date,
      revision,
      CALCULATION_VERSION,
      JSON.stringify({
        adherence: ctx.config.adherenceThreshold,
        coverage: ctx.config.coverageThreshold,
        goal_hours: ctx.config.goalHours,
      }),
      JSON.stringify(input.snapshot),
      input.hash,
      input.coverage,
      input.finalStatus,
      ctx.now().toISOString(),
    );
    const id = Number(result.lastInsertRowid);
    for (const item of input.results) {
      run(
        ctx.db,
        `INSERT INTO evaluation_results
         (evaluation_id, ac_id, title, status, value, threshold, coverage, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        item.ac_id,
        item.title,
        item.status,
        item.value,
        item.threshold,
        item.coverage,
        JSON.stringify(item.evidence),
      );
    }
    return id;
  })();
  return evaluationView(ctx, evaluationId);
}

export function evaluationView(ctx: Ctx, id: number): EvaluationView {
  const evaluation = one<{
    id: number;
    goal_id: number | null;
    goal_slug: string;
    goal_revision: number;
    period_date: string;
    revision: number;
    calculation_version: number;
    coverage: number | null;
    final_status: FinalStatus;
    created_at: string;
  }>(ctx.db, "SELECT * FROM evaluations WHERE id = ?", id);
  if (!evaluation) throw new AppError("evaluation_not_found", "Evaluation not found");
  const results = many<{
    ac_id: string;
    title: string;
    status: AcStatus;
    value: number;
    threshold: number;
    coverage: number;
    evidence_json: string;
  }>(
    ctx.db,
    "SELECT ac_id, title, status, value, threshold, coverage, evidence_json FROM evaluation_results WHERE evaluation_id = ? ORDER BY ac_id",
    id,
  );
  return {
    ref: display("evaluation", evaluation.id),
    id: evaluation.id,
    goal_ref: evaluation.goal_id ? display("goal", evaluation.goal_id) : null,
    goal_revision: evaluation.goal_revision,
    revision: evaluation.revision,
    period_date: evaluation.period_date,
    calculation_version: evaluation.calculation_version,
    final_status: evaluation.final_status,
    coverage: evaluation.coverage ?? 0,
    as_of: evaluation.created_at,
    results: results.map((row) => ({
      ...row,
      evidence: JSON.parse(row.evidence_json) as Record<string, unknown>,
    })),
  };
}

export interface EvaluationHistoryRow {
  id: number;
  period_date: string;
  revision: number;
  final_status: string;
  coverage: number | null;
  created_at: string;
  ref: string;
}

export function evaluationHistory(ctx: Ctx, goalSlug: string, limit = 20): EvaluationHistoryRow[] {
  const rows = many<Omit<EvaluationHistoryRow, "ref">>(
    ctx.db,
    "SELECT id, period_date, revision, final_status, coverage, created_at FROM evaluations WHERE goal_slug = ? ORDER BY id DESC LIMIT ?",
    goalSlug,
    limit,
  );
  return rows.map((row) => ({ ...row, ref: display("evaluation", row.id) }));
}

export function goalCheckText(view: EvaluationView, now: Date, timezone: string): string[] {
  const pending = view.final_status === "pending";
  const lines = [
    `As of: ${localTimeAt(now, timezone)} — ${pending ? "day still in progress" : "day closed"}`,
  ];
  const [first, second, third] = view.results;
  if (first) {
    lines.push(
      `Qualifying tasks: ${first.value} / ${first.threshold}       ${statusText(first.status, first.value, first.threshold)}`,
    );
  }
  if (second) {
    lines.push(
      `Goal time:        ${formatDuration(second.value)} / ${formatDuration(second.threshold)}    ${statusText(second.status, second.value, second.threshold)}`,
    );
  }
  if (third) {
    const evidence = third.evidence as {
      required_task_refs?: string[];
      missing_task_refs?: string[];
    };
    const required = evidence.required_task_refs?.length ?? 0;
    const missing = evidence.missing_task_refs?.length ?? 0;
    lines.push(
      `Progress entries: ${required - missing} / ${required}       ${statusText(third.status, third.value, third.threshold)}`,
    );
  }
  lines.push(`Coverage:         ${formatPercent(view.coverage)}`);
  lines.push(`Final daily result: ${view.final_status}`);
  if (view.results.some((result) => result.status === "insufficient_data")) {
    lines.push("Missing data is not counted as idle time or as failure.");
  }
  return lines;
}

function statusText(status: AcStatus, value: number, threshold: number): string {
  if (status === "met") return "met";
  if (status === "insufficient_data") return "insufficient data";
  return value < threshold ? "target not reached" : "not met";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
