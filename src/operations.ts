import type { Ctx } from "./db.js";
import { many, one, run } from "./db.js";
import { AppError, errorPayload } from "./errors.js";
import { operationId } from "./ids.js";

interface OperationRow {
  id: string;
  status: string;
  result_json: string | null;
}

export interface OperationSpec {
  id?: string;
  actor: string;
  command: string;
}

export interface OperationResult<T> {
  value: T;
  id: string;
  replayed: boolean;
}

export function withOperation<T>(ctx: Ctx, spec: OperationSpec, work: () => T): OperationResult<T> {
  const id = operationId(spec.id);
  const existing = one<OperationRow>(
    ctx.db,
    "SELECT id, status, result_json FROM operations WHERE id = ?",
    id,
  );
  if (existing?.status === "done" && existing.result_json) {
    return { value: JSON.parse(existing.result_json) as T, id, replayed: true };
  }
  if (existing?.status === "pending") {
    throw new AppError(
      "operation_pending",
      `Operation ${id} is still pending. Run \`day status\` before retrying.`,
      { exitCode: 4 },
    );
  }

  upsertPending(ctx, id, spec);
  try {
    const value = ctx.db.transaction(() => {
      const result = work();
      run(
        ctx.db,
        "UPDATE operations SET status = 'done', result_json = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(result) ?? "null",
        ctx.now().toISOString(),
        id,
      );
      return result;
    })();
    return { value, id, replayed: false };
  } catch (error) {
    run(
      ctx.db,
      "UPDATE operations SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?",
      errorPayload(error).error.code,
      ctx.now().toISOString(),
      id,
    );
    throw error;
  }
}

function upsertPending(ctx: Ctx, id: string, spec: OperationSpec): void {
  const timestamp = ctx.now().toISOString();
  run(
    ctx.db,
    `INSERT INTO operations (id, actor, command, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = 'pending', error_code = NULL, updated_at = excluded.updated_at`,
    id,
    spec.actor,
    spec.command,
    timestamp,
    timestamp,
  );
}

export function listOperations(ctx: Ctx, limit = 20) {
  return many<Record<string, unknown>>(
    ctx.db,
    "SELECT * FROM operations ORDER BY created_at DESC LIMIT ?",
    limit,
  );
}
