import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { Ctx } from "./db.js";
import { many, one, run } from "./db.js";
import { AppError } from "./errors.js";
import { display } from "./ids.js";
import type { SessionRow } from "./metrics.js";
import { requireTask } from "./tasks.js";
import { clip, formatPercent, interval, localTimeAt, totalSeconds, union } from "./time.js";

export type MatchType = "project" | "tmux" | "app" | "url";

export interface RuleRow {
  id: number;
  task_id: number;
  match_type: MatchType;
  pattern: string;
  rank: number;
  version: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ObservationRow {
  id: number;
  source: string;
  bucket: string;
  event_id: string;
  host: string | null;
  device: string | null;
  start_utc: string;
  end_utc: string;
  app: string | null;
  project: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  url: string | null;
  idle: number;
  demo: number;
  invalid_reason: string | null;
  received_at: string;
  revision: number;
}

export interface AttributionRow {
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
}

export function addRule(
  ctx: Ctx,
  input: { taskId: number; matchType: MatchType; pattern: string; rank?: number },
): RuleRow {
  requireTask(ctx, input.taskId);
  const timestamp = ctx.now().toISOString();
  const result = run(
    ctx.db,
    `INSERT INTO rules (task_id, match_type, pattern, rank, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.taskId,
    input.matchType,
    input.pattern,
    input.rank ?? 0,
    timestamp,
    timestamp,
  );
  return requireRule(ctx, Number(result.lastInsertRowid));
}

export function requireRule(ctx: Ctx, id: number): RuleRow {
  const rule = one<RuleRow>(ctx.db, "SELECT * FROM rules WHERE id = ?", id);
  if (!rule) throw new AppError("rule_not_found", `Rule ${display("rule", id)} was not found`);
  return rule;
}

export function listRules(ctx: Ctx): RuleRow[] {
  return many<RuleRow>(ctx.db, "SELECT * FROM rules ORDER BY id");
}

export function updateRule(
  ctx: Ctx,
  id: number,
  input: { pattern?: string; rank?: number; active?: boolean },
): RuleRow {
  const rule = requireRule(ctx, id);
  run(
    ctx.db,
    `UPDATE rules SET pattern = ?, rank = ?, active = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    input.pattern ?? rule.pattern,
    input.rank ?? rule.rank,
    input.active === undefined ? rule.active : input.active ? 1 : 0,
    ctx.now().toISOString(),
    id,
  );
  return requireRule(ctx, id);
}

interface MatchResult {
  matches: RuleRow[];
  rank: number;
  status: "accepted" | "ambiguous" | "unassigned";
  rule?: RuleRow;
}

export function matchRules(ctx: Ctx, observation: ObservationRow): MatchResult {
  const rules = many<RuleRow>(ctx.db, "SELECT * FROM rules WHERE active = 1 ORDER BY id");
  const matches = rules.filter((rule) => ruleMatches(rule, observation));
  if (matches.length === 0) return { matches, rank: 0, status: "unassigned" };
  const rank = Math.max(...matches.map((rule) => rule.rank));
  const top = matches.filter((rule) => rule.rank === rank);
  if (top.length > 1) return { matches, rank, status: "ambiguous" };
  return { matches, rank, status: "accepted", rule: top[0] };
}

function ruleMatches(rule: RuleRow, observation: ObservationRow): boolean {
  if (rule.match_type === "project") {
    return Boolean(observation.project) && pathMatches(observation.project ?? "", rule.pattern);
  }
  if (rule.match_type === "url") {
    return Boolean(observation.url) && (observation.url ?? "").startsWith(rule.pattern);
  }
  if (rule.match_type === "app") {
    return (
      Boolean(observation.app) &&
      (observation.app ?? "").toLowerCase().startsWith(rule.pattern.toLowerCase())
    );
  }
  const context = [observation.tmux_session, observation.tmux_window, observation.tmux_pane]
    .filter(Boolean)
    .join(":");
  return context.startsWith(rule.pattern);
}

function pathMatches(value: string, pattern: string): boolean {
  const expandedPattern = pattern.startsWith("~")
    ? resolvePath(homedir(), pattern.slice(2))
    : pattern;
  const expandedValue = value.startsWith("~") ? resolvePath(homedir(), value.slice(2)) : value;
  return expandedValue === expandedPattern || expandedValue.startsWith(`${expandedPattern}/`);
}

export function currentAttribution(ctx: Ctx, observationId: number): AttributionRow | undefined {
  return one<AttributionRow>(
    ctx.db,
    `SELECT * FROM attributions
     WHERE observation_id = ? AND superseded_by IS NULL
     ORDER BY revision DESC, id DESC LIMIT 1`,
    observationId,
  );
}

export function attributeObservation(
  ctx: Ctx,
  observation: ObservationRow,
  options: { force?: boolean; method?: string; reason?: string } = {},
): AttributionRow {
  if (observation.invalid_reason) {
    throw new AppError("invalid_observation", `Observation O${observation.id} is invalid`);
  }
  const current = currentAttribution(ctx, observation.id);
  if (current && !options.force && isProtectedMethod(current.method)) return current;
  const decision = decideAttribution(ctx, observation);
  return insertAttribution(ctx, {
    observation,
    ...decision,
    method: options.method ?? decision.method,
    reason: options.reason ?? null,
    revision: (current?.revision ?? 0) + 1,
    start: observation.start_utc,
    end: observation.end_utc,
  });
}

function isProtectedMethod(method: string): boolean {
  return method === "manual" || method === "agent_accepted";
}

function decideAttribution(ctx: Ctx, observation: ObservationRow) {
  const match = matchRules(ctx, observation);
  const task = match.rule ? requireTask(ctx, match.rule.task_id) : undefined;
  const session = sessionForObservation(ctx, observation);
  return {
    sessionId: session?.id ?? null,
    taskId: task?.id ?? null,
    goalId: task?.goal_id ?? null,
    status: match.status,
    method: match.status === "accepted" ? `${match.rule?.match_type ?? "rule"}_rule` : "no_match",
    rule: match.rule,
  };
}

function sessionForObservation(ctx: Ctx, observation: ObservationRow): SessionRow | undefined {
  const sessions = many<SessionRow>(
    ctx.db,
    `SELECT * FROM sessions
     WHERE state IN ('running', 'ended') AND planned_start < ? AND planned_end > ?
     ORDER BY id`,
    observation.end_utc,
    observation.start_utc,
  );
  return sessions.length === 1 ? sessions[0] : undefined;
}

interface InsertAttributionInput {
  observation: ObservationRow;
  sessionId: number | null;
  taskId: number | null;
  goalId: number | null;
  status: string;
  method: string;
  rule: RuleRow | undefined;
  reason: string | null;
  revision: number;
  start: string;
  end: string;
}

function insertAttribution(ctx: Ctx, input: InsertAttributionInput): AttributionRow {
  return ctx.db.transaction(() => {
    const previous = currentAttribution(ctx, input.observation.id);
    const timestamp = ctx.now().toISOString();
    const result = run(
      ctx.db,
      `INSERT INTO attributions
       (observation_id, session_id, task_id, goal_id, start_utc, end_utc, status, method,
        rule_id, rule_version, reason, revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.observation.id,
      input.sessionId,
      input.taskId,
      input.goalId,
      input.start,
      input.end,
      input.status,
      input.method,
      input.rule?.id ?? null,
      input.rule?.version ?? null,
      input.reason,
      input.revision,
      timestamp,
    );
    const id = Number(result.lastInsertRowid);
    if (previous) {
      run(ctx.db, "UPDATE attributions SET superseded_by = ? WHERE id = ?", id, previous.id);
    }
    return one<AttributionRow>(
      ctx.db,
      "SELECT * FROM attributions WHERE id = ?",
      id,
    ) as AttributionRow;
  })();
}

export function attributeRange(
  ctx: Ctx,
  from: Date,
  to: Date,
  options: { force?: boolean } = {},
): { updated: number; skipped: number } {
  if (to <= from) throw new AppError("invalid_interval", "The attribution interval is empty");
  const observations = many<ObservationRow>(
    ctx.db,
    `SELECT * FROM observations
     WHERE invalid_reason IS NULL AND start_utc < ? AND end_utc > ? ORDER BY start_utc`,
    to.toISOString(),
    from.toISOString(),
  );
  let updated = 0;
  let skipped = 0;
  for (const observation of observations) {
    const current = currentAttribution(ctx, observation.id);
    if (
      !options.force &&
      current &&
      (current.method === "manual" || current.method === "agent_accepted")
    ) {
      skipped += 1;
      continue;
    }
    attributeObservation(ctx, observation, { force: true, method: "rule" });
    updated += 1;
  }
  return { updated, skipped };
}

export interface ManualAssignInput {
  sessionId: number;
  from: Date;
  to: Date;
  taskId: number;
  reason: string;
}

export function manualAssign(ctx: Ctx, input: ManualAssignInput) {
  const session = one<SessionRow>(ctx.db, "SELECT * FROM sessions WHERE id = ?", input.sessionId);
  if (!session)
    throw new AppError(
      "session_not_found",
      `Session ${display("session", input.sessionId)} not found`,
    );
  const task = requireTask(ctx, input.taskId);
  if (input.to <= input.from)
    throw new AppError("invalid_interval", "The correction interval is empty");
  const observations = many<ObservationRow>(
    ctx.db,
    `SELECT * FROM observations
     WHERE invalid_reason IS NULL AND start_utc < ? AND end_utc > ? ORDER BY start_utc`,
    input.to.toISOString(),
    input.from.toISOString(),
  );
  if (observations.length === 0) {
    throw new AppError(
      "no_observations",
      "No observed interval exists in that range. Day keeps corrections tied to evidence.",
    );
  }
  const revisionIds: number[] = [];
  for (const observation of observations) {
    const part = clip(
      interval(observation.start_utc, observation.end_utc),
      input.from.getTime(),
      input.to.getTime(),
    );
    if (!part) continue;
    const current = currentAttribution(ctx, observation.id);
    const row = insertAttribution(ctx, {
      observation,
      sessionId: session.id,
      taskId: task.id,
      goalId: task.goal_id,
      status: "accepted",
      method: "manual",
      rule: undefined,
      reason: input.reason,
      revision: (current?.revision ?? 0) + 1,
      start: new Date(part.start).toISOString(),
      end: new Date(part.end).toISOString(),
    });
    revisionIds.push(row.id);
  }
  return { revisionIds, task, session };
}

export function explainAt(ctx: Ctx, sessionId: number, at: Date) {
  const observation = one<ObservationRow>(
    ctx.db,
    `SELECT * FROM observations
     WHERE invalid_reason IS NULL AND start_utc <= ? AND end_utc > ?
     ORDER BY start_utc DESC LIMIT 1`,
    at.toISOString(),
    at.toISOString(),
  );
  if (!observation) {
    return { session: sessionId, at: at.toISOString(), observation: null, attribution: null };
  }
  const attribution = currentAttribution(ctx, observation.id);
  const rule = attribution?.rule_id
    ? one<RuleRow>(ctx.db, "SELECT * FROM rules WHERE id = ?", attribution.rule_id)
    : undefined;
  const task = attribution?.task_id
    ? one<{ id: number; title: string }>(
        ctx.db,
        "SELECT id, title FROM tasks WHERE id = ?",
        attribution.task_id,
      )
    : undefined;
  const goal = attribution?.goal_id
    ? one<{ id: number; title: string }>(
        ctx.db,
        "SELECT id, title FROM goals WHERE id = ?",
        attribution.goal_id,
      )
    : undefined;
  return {
    session: sessionId,
    at: at.toISOString(),
    observation: { ...observation, ref: display("observation", observation.id) },
    attribution: attribution
      ? { ...attribution, ref: display("attribution", attribution.id) }
      : null,
    rule: rule ? { ...rule, ref: display("rule", rule.id) } : null,
    task: task ? { ...task, ref: display("task", task.id) } : null,
    goal: goal ? { ...goal, ref: display("goal", goal.id) } : null,
  };
}

export interface SuggestionRow {
  id: number;
  observation_id: number;
  task_id: number;
  method: string;
  model_version: string | null;
  uncertainty: number | null;
  status: string;
  created_at: string;
  decided_at: string | null;
}

export function suggestAttribution(
  ctx: Ctx,
  input: {
    observationId: number;
    taskId: number;
    method: string;
    modelVersion?: string;
    uncertainty?: number;
  },
): SuggestionRow {
  const observation = one<ObservationRow>(
    ctx.db,
    "SELECT * FROM observations WHERE id = ?",
    input.observationId,
  );
  if (!observation) throw new AppError("observation_not_found", "Observation not found");
  requireTask(ctx, input.taskId);
  const result = run(
    ctx.db,
    `INSERT INTO suggestions (observation_id, task_id, method, model_version, uncertainty, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.observationId,
    input.taskId,
    input.method,
    input.modelVersion ?? null,
    input.uncertainty ?? null,
    ctx.now().toISOString(),
  );
  return one<SuggestionRow>(
    ctx.db,
    "SELECT * FROM suggestions WHERE id = ?",
    Number(result.lastInsertRowid),
  ) as SuggestionRow;
}

export function acceptSuggestion(ctx: Ctx, id: number, reason: string) {
  const suggestion = one<{ id: number; observation_id: number; task_id: number; status: string }>(
    ctx.db,
    "SELECT * FROM suggestions WHERE id = ?",
    id,
  );
  if (!suggestion) throw new AppError("suggestion_not_found", "Suggestion not found");
  if (suggestion.status !== "proposed") {
    throw new AppError("suggestion_decided", "Suggestion has already been decided");
  }
  const observation = one<ObservationRow>(
    ctx.db,
    "SELECT * FROM observations WHERE id = ?",
    suggestion.observation_id,
  );
  if (!observation) throw new AppError("observation_not_found", "Observation not found");
  const task = requireTask(ctx, suggestion.task_id);
  const current = currentAttribution(ctx, observation.id);
  const attribution = insertAttribution(ctx, {
    observation,
    sessionId: sessionForObservation(ctx, observation)?.id ?? null,
    taskId: task.id,
    goalId: task.goal_id,
    status: "accepted",
    method: "agent_accepted",
    rule: undefined,
    reason,
    revision: (current?.revision ?? 0) + 1,
    start: observation.start_utc,
    end: observation.end_utc,
  });
  run(
    ctx.db,
    "UPDATE suggestions SET status = 'accepted', decided_at = ? WHERE id = ?",
    ctx.now().toISOString(),
    id,
  );
  return attribution;
}

export function assignmentSummary(ctx: Ctx, sessionId: number) {
  const rows = many<AttributionRow>(
    ctx.db,
    `SELECT * FROM attributions
     WHERE session_id = ? AND superseded_by IS NULL ORDER BY start_utc`,
    sessionId,
  );
  const accepted = totalSeconds(
    rows
      .filter((row) => row.status === "accepted")
      .map((row) => interval(row.start_utc, row.end_utc)),
  );
  return {
    revisions: rows.length,
    accepted_seconds: accepted,
    by_status: rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {}),
    rows: rows.map((row) => ({ ...row, ref: display("attribution", row.id) })),
  };
}

export function explainText(view: ReturnType<typeof explainAt>, timezone: string): string[] {
  if (!view.observation || !view.attribution) {
    return [
      `No observation at ${localTimeAt(view.at, timezone)} in session S${String(view.session).padStart(2, "0")}`,
    ];
  }
  const lines = [
    `Observation: ${view.observation.ref}`,
    `Source: ${view.observation.source} watcher`,
  ];
  if (view.observation.project) lines.push(`Foreground project: ${view.observation.project}`);
  if (view.observation.app) lines.push(`Application: ${view.observation.app}`);
  if (view.observation.url) lines.push(`URL: ${view.observation.url}`);
  if (view.rule) lines.push(`Rule: ${view.rule.ref}, version ${view.rule.version}`);
  if (view.task) lines.push(`Task: ${view.task.ref}`);
  if (view.goal) lines.push(`Goal: ${view.goal.ref}`);
  lines.push(`Status: ${view.attribution.status}`);
  lines.push(`Method: ${view.attribution.method}`);
  if (view.attribution.reason) lines.push(`Reason: ${view.attribution.reason}`);
  return lines;
}

export function manualAssignText(
  result: ReturnType<typeof manualAssign>,
  metrics: { adherence: number; coverage: number; adherence_status: string },
  sessionRef: string,
): string[] {
  return [
    `Attribution revision: ${result.revisionIds.map((id) => display("attribution", id)).join(", ")}`,
    "Method: manual correction",
    "Previous attribution retained",
    `Session adherence after recalculation: ${formatPercent(metrics.adherence)}`,
    ...(metrics.adherence_status === "insufficient_data" ? ["Result: insufficient_data"] : []),
    `Session: ${sessionRef}`,
  ];
}

export function currentObservationTime(ctx: Ctx, sessionId: number, at: Date) {
  return one<ObservationRow>(
    ctx.db,
    `SELECT o.* FROM observations o
     JOIN sessions s ON s.id = ?
     WHERE o.invalid_reason IS NULL AND o.start_utc <= ? AND o.end_utc > ?
       AND o.start_utc < s.planned_end AND o.end_utc > s.planned_start
     ORDER BY o.start_utc DESC LIMIT 1`,
    sessionId,
    at.toISOString(),
    at.toISOString(),
  );
}

export { union };
