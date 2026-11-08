import { readFileSync } from "node:fs";
import type { Ctx } from "./db.js";
import { one } from "./db.js";
import { recordSourceFailure, touchSource } from "./activity.js";
import { updateEvent } from "./events.js";
import { parseInstant } from "./time.js";

interface ImportedEvent {
  source: string;
  id: string;
  title: string;
  start: string;
  end: string;
  timezone?: string;
  reminder_minutes?: number;
  recurrence?: string;
  all_day?: boolean;
  external_revision?: string;
  cancelled?: boolean;
}

export function importCalendarEvents(ctx: Ctx, file: string) {
  let records: ImportedEvent[];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
    records = parsed as ImportedEvent[];
  } catch (error) {
    recordSourceFailure(ctx, "calendar", error instanceof Error ? error.message : String(error));
    throw error;
  }
  const counts = { imported: 0, updated: 0, unchanged: 0 };
  ctx.db.transaction(() => {
    for (const record of records) {
      upsertImportedEvent(ctx, record, counts);
    }
    touchSource(ctx, "calendar", ctx.now().toISOString());
  })();
  return counts;
}

function upsertImportedEvent(
  ctx: Ctx,
  record: ImportedEvent,
  counts: { imported: number; updated: number; unchanged: number },
): void {
  const existing = one<{ id: number; external_revision: string | null }>(
    ctx.db,
    "SELECT id, external_revision FROM events WHERE source = ? AND source_id = ?",
    record.source,
    record.id,
  );
  if (existing && existing.external_revision === (record.external_revision ?? null)) {
    counts.unchanged += 1;
    return;
  }
  if (existing) {
    updateEvent(ctx, existing.id, {
      title: record.title,
      start: parseInstant(record.start),
      end: parseInstant(record.end),
      reminderMinutes: record.reminder_minutes ?? null,
      recurrence: record.recurrence ?? null,
      status: record.cancelled ? "cancelled" : "confirmed",
      externalRevision: record.external_revision ?? null,
    });
    counts.updated += 1;
    return;
  }
  addImportedEvent(ctx, record);
  counts.imported += 1;
}

function addImportedEvent(ctx: Ctx, record: ImportedEvent): void {
  ctx.db
    .prepare(
      `INSERT INTO events
       (source, source_id, title, start_utc, end_utc, timezone, all_day, recurrence,
        reminder_minutes, kind, external_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'appointment', ?, ?, ?)`,
    )
    .run(
      record.source,
      record.id,
      record.title,
      parseInstant(record.start).toISOString(),
      parseInstant(record.end).toISOString(),
      record.timezone ?? ctx.timezone,
      record.all_day ? 1 : 0,
      record.recurrence ?? null,
      record.reminder_minutes ?? null,
      record.external_revision ?? null,
      ctx.now().toISOString(),
      ctx.now().toISOString(),
    );
}
