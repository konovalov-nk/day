import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Ctx } from "./db.js";
import { many, run } from "./db.js";
import { AppError } from "./errors.js";
import { display } from "./ids.js";
import { deleteNote } from "./notes.js";
import { requireTask } from "./tasks.js";

const PRIVATE_TABLES = [
  "goals",
  "goal_criteria",
  "tasks",
  "task_goals",
  "events",
  "sessions",
  "session_plan_revisions",
  "progress_entries",
  "observations",
  "coverage_intervals",
  "rules",
  "attributions",
  "suggestions",
  "notes",
  "note_revisions",
  "note_links",
  "experiments",
  "experiment_notes",
  "experiment_conclusions",
  "evaluations",
  "evaluation_results",
  "source_state",
  "tutorial_state",
  "exclusions",
] as const;

const PUBLIC_TABLES = [
  "goals",
  "goal_criteria",
  "tasks",
  "task_goals",
  "sessions",
  "progress_entries",
  "evaluations",
  "evaluation_results",
] as const;

export function exportData(ctx: Ctx, options: { publicOnly?: boolean } = {}) {
  const tables = options.publicOnly ? PUBLIC_TABLES : PRIVATE_TABLES;
  const data: Record<string, unknown[]> = {};
  for (const table of tables)
    data[table] = many<Record<string, unknown>>(ctx.db, `SELECT * FROM ${table}`);
  const counts = Object.fromEntries(
    Object.entries(data).map(([table, rows]) => [table, rows.length]),
  );
  const body = JSON.stringify({
    schema_version: 1,
    public: Boolean(options.publicOnly),
    tables: data,
  });
  return {
    schema_version: 1,
    exported_at: ctx.now().toISOString(),
    public: Boolean(options.publicOnly),
    tables: data,
    counts,
    checksum: createHash("sha256").update(body).digest("hex"),
  };
}

export function writeBackup(
  ctx: Ctx,
  file: string,
  options: { publicOnly?: boolean } = {},
): { file: string; counts: Record<string, number>; checksum: string } {
  const data = exportData(ctx, options);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return { file, counts: data.counts, checksum: data.checksum };
}

interface BackupFile {
  schema_version: number;
  public?: boolean;
  tables: Record<string, Array<Record<string, unknown>>>;
  counts: Record<string, number>;
  checksum: string;
}

export function importData(ctx: Ctx, file: string, force = false) {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as BackupFile;
  if (parsed.schema_version !== 1)
    throw new AppError("invalid_backup", "Unsupported backup version");
  const nonEmpty =
    (many<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM tasks")[0]?.count ?? 0) > 0;
  if (nonEmpty && !force) {
    throw new AppError(
      "backup_not_empty",
      "Restore into a separate empty installation, or pass --force",
    );
  }
  const tables = Object.keys(parsed.tables);
  ctx.db.transaction(() => {
    for (const table of [...tables].reverse()) {
      if (isKnownTable(table)) run(ctx.db, `DELETE FROM ${table}`);
    }
    for (const table of tables) {
      if (!isKnownTable(table)) throw new AppError("invalid_backup", `Unknown table: ${table}`);
      for (const row of parsed.tables[table] ?? []) insertRow(ctx, table, row);
    }
  })();
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] =
      many<{ count: number }>(ctx.db, `SELECT COUNT(*) AS count FROM ${table}`)[0]?.count ?? 0;
  }
  const body = JSON.stringify({
    schema_version: 1,
    public: Boolean(parsed.public),
    tables: parsed.tables,
  });
  const checksum = createHash("sha256").update(body).digest("hex");
  const matches =
    checksum === parsed.checksum && tables.every((table) => counts[table] === parsed.counts[table]);
  return { restored: counts, checksum, matches, tables: tables.length };
}

function isKnownTable(table: string): boolean {
  return (PRIVATE_TABLES as readonly string[]).includes(table);
}

function insertRow(ctx: Ctx, table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  const placeholders = keys.map(() => "?").join(", ");
  run(
    ctx.db,
    `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`,
    ...keys.map((key) => row[key]),
  );
}

export function deleteEntity(
  ctx: Ctx,
  options: { task?: string; note?: string; session?: string },
): { deleted: string; effect: string } {
  if (options.note) {
    const result = deleteNote(ctx, Number(options.note.replace(/^N/i, "")), ctx.config.actor);
    return { deleted: result.deleted, effect: result.backup_effect };
  }
  if (options.task) {
    const id = Number(options.task.replace(/^T/i, ""));
    requireTask(ctx, id);
    ctx.db.transaction(() => {
      run(ctx.db, "DELETE FROM suggestions WHERE task_id = ?", id);
      run(ctx.db, "DELETE FROM rules WHERE task_id = ?", id);
      run(
        ctx.db,
        "DELETE FROM attributions WHERE task_id = ? OR session_id IN (SELECT id FROM sessions WHERE task_id = ?)",
        id,
        id,
      );
      run(ctx.db, "DELETE FROM progress_entries WHERE task_id = ?", id);
      run(ctx.db, "DELETE FROM sessions WHERE task_id = ?", id);
      run(ctx.db, "DELETE FROM events WHERE task_id = ?", id);
      run(ctx.db, "DELETE FROM task_goals WHERE task_id = ?", id);
      run(ctx.db, "DELETE FROM tasks WHERE id = ?", id);
      run(ctx.db, "DELETE FROM evaluation_results");
      run(ctx.db, "DELETE FROM evaluations");
      run(
        ctx.db,
        "INSERT INTO deletions (entity, entity_id, actor, deleted_at) VALUES ('task', ?, ?, ?)",
        id,
        ctx.config.actor,
        ctx.now().toISOString(),
      );
    })();
    return {
      deleted: display("task", id),
      effect:
        "Sessions, progress, calendar blocks, and attributions were removed. Raw observations remain without task links. Evaluation history was invalidated. Existing backups still contain the old task.",
    };
  }
  if (options.session) {
    const id = Number(options.session.replace(/^S/i, ""));
    ctx.db.transaction(() => {
      run(ctx.db, "DELETE FROM attributions WHERE session_id = ?", id);
      run(ctx.db, "DELETE FROM progress_entries WHERE session_id = ?", id);
      run(ctx.db, "DELETE FROM session_plan_revisions WHERE session_id = ?", id);
      run(ctx.db, "DELETE FROM sessions WHERE id = ?", id);
      run(ctx.db, "DELETE FROM events WHERE session_id = ?", id);
      run(
        ctx.db,
        "INSERT INTO deletions (entity, entity_id, actor, deleted_at) VALUES ('session', ?, ?, ?)",
        id,
        ctx.config.actor,
        ctx.now().toISOString(),
      );
    })();
    return {
      deleted: display("session", id),
      effect:
        "The session, its progress entries, attributions, and calendar block were removed. Raw observations remain.",
    };
  }
  throw new AppError("delete_target", "Choose --task, --note, or --session");
}
