import type { Ctx } from "./db.js";
import { many, one, run } from "./db.js";
import { AppError } from "./errors.js";
import { display } from "./ids.js";
import { interval, totalSeconds } from "./time.js";

export interface GoalRow {
  id: number;
  title: string;
  catalog: string;
  source: string;
  source_id: string | null;
  spec_id: string | null;
  status: string;
  revision: number;
  available: number;
  stale: number;
  created_at: string;
  updated_at: string;
}

export interface CriterionRow {
  id: number;
  goal_id: number;
  text: string;
  position: number;
  revision: number;
  created_at: string;
}

export interface AddGoalInput {
  title: string;
  criteria: string[];
  catalog?: string;
  source?: string;
  sourceId?: string;
  specId?: string;
  status?: string;
}

export function addGoal(ctx: Ctx, input: AddGoalInput) {
  const title = input.title.trim();
  if (!title) throw new AppError("invalid_goal", "Goal title is required");
  const timestamp = ctx.now().toISOString();
  const catalog = input.catalog ?? "personal";
  const goal = ctx.db.transaction(() => {
    const result = run(
      ctx.db,
      `INSERT INTO goals (title, catalog, source, source_id, spec_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      title,
      catalog,
      input.source ?? "local",
      input.sourceId ?? null,
      input.specId ?? null,
      input.status ?? "draft",
      timestamp,
      timestamp,
    );
    const goalId = Number(result.lastInsertRowid);
    const criteria = (input.criteria.length > 0 ? input.criteria : [""]).filter(Boolean);
    const criterionIds = criteria.map((text, index) => addCriterion(ctx, goalId, text, index));
    return { goalId, criterionIds };
  })();
  return { ...goal, goal: getGoal(ctx, goal.goalId) };
}

function addCriterion(ctx: Ctx, goalId: number, text: string, position: number): number {
  const result = run(
    ctx.db,
    "INSERT INTO goal_criteria (goal_id, text, position, created_at) VALUES (?, ?, ?, ?)",
    goalId,
    text,
    position,
    ctx.now().toISOString(),
  );
  return Number(result.lastInsertRowid);
}

export function getGoal(ctx: Ctx, id: number): GoalRow | undefined {
  return one<GoalRow>(ctx.db, "SELECT * FROM goals WHERE id = ?", id);
}

export function requireGoal(ctx: Ctx, id: number): GoalRow {
  const goal = getGoal(ctx, id);
  if (!goal) throw new AppError("goal_not_found", `Goal ${display("goal", id)} was not found`);
  return goal;
}

export function resolveGoalRef(ctx: Ctx, ref: string): GoalRow {
  const short = /^G(\d+)$/i.exec(ref.trim());
  if (short?.[1]) return requireGoal(ctx, Number(short[1]));
  const goal = one<GoalRow>(
    ctx.db,
    "SELECT * FROM goals WHERE spec_id = ? OR source_id = ? OR (catalog = 'personal' AND title = ?) ORDER BY id LIMIT 1",
    ref,
    ref,
    ref,
  );
  if (!goal) throw new AppError("goal_not_found", `Goal ${ref} was not found`);
  return goal;
}

export function listGoals(ctx: Ctx, catalog?: string): GoalRow[] {
  return catalog
    ? many<GoalRow>(ctx.db, "SELECT * FROM goals WHERE catalog = ? ORDER BY id", catalog)
    : many<GoalRow>(ctx.db, "SELECT * FROM goals ORDER BY id");
}

export function criteriaFor(ctx: Ctx, goalId: number): CriterionRow[] {
  return many<CriterionRow>(
    ctx.db,
    "SELECT * FROM goal_criteria WHERE goal_id = ? ORDER BY position, id",
    goalId,
  );
}

export function goalSummary(ctx: Ctx, goal: GoalRow) {
  const criteria = criteriaFor(ctx, goal.id);
  const taskCount =
    one<{ count: number }>(
      ctx.db,
      "SELECT COUNT(*) AS count FROM tasks WHERE goal_id = ? AND deleted_at IS NULL",
      goal.id,
    )?.count ?? 0;
  const rows = many<{ start_utc: string; end_utc: string }>(
    ctx.db,
    `SELECT start_utc, end_utc FROM attributions
     WHERE goal_id = ? AND status = 'accepted' AND superseded_by IS NULL`,
    goal.id,
  );
  const recorded = totalSeconds(rows.map((row) => interval(row.start_utc, row.end_utc)));
  return {
    ...goal,
    ref: display("goal", goal.id),
    criteria: criteria.map((item) => ({ ...item, ref: display("criterion", item.id) })),
    task_count: taskCount,
    recorded_seconds: recorded,
  };
}

export interface GoalImportRecord {
  type: string;
  id?: string;
  slug?: string;
  title?: string;
  spec_id?: string;
  description?: string;
  intent?: string;
  [key: string]: unknown;
}

export function importGoalRecords(ctx: Ctx, records: GoalImportRecord[], catalog: string) {
  const specs = records.filter((record) => record.type === "spec");
  const criteria = records.filter((record) => record.type === "acceptance_criterion");
  const imported: Array<{ id: number; sourceId: string }> = [];
  for (const spec of specs) {
    if (!spec.id || !spec.title) continue;
    const existing = one<GoalRow>(
      ctx.db,
      "SELECT * FROM goals WHERE catalog = ? AND source_id = ?",
      catalog,
      spec.id,
    );
    if (existing) {
      imported.push({ id: existing.id, sourceId: spec.id });
      continue;
    }
    const specCriteria = criteria
      .filter((item) => item.spec_id === spec.id)
      .map((item) => String(item.intent ?? item.title ?? ""));
    const created = addGoal(ctx, {
      title: spec.title,
      criteria: specCriteria,
      catalog,
      source: "coherence",
      sourceId: spec.id,
      specId: spec.id,
      status: "draft",
    });
    imported.push({ id: created.goalId, sourceId: spec.id });
  }
  return imported;
}

export function intentionalDayGoal(ctx: Ctx): GoalRow | undefined {
  return one<GoalRow>(
    ctx.db,
    "SELECT * FROM goals WHERE catalog = 'personal' AND (spec_id = 'SPEC-G01' OR source_id = 'SPEC-G01') ORDER BY id LIMIT 1",
  );
}
