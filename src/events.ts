import { randomUUID } from "node:crypto";
import type { Ctx } from "./db.js";
import { many, one, run } from "./db.js";
import { AppError } from "./errors.js";
import { display } from "./ids.js";
import {
  addDays,
  endOfLocalDay,
  formatDateShort,
  interval,
  localDateAt,
  localTimeAt,
  overlaps,
  parseInstant,
  parseWhen,
  relativeDay,
  startOfLocalDay,
  zonedToUtc,
} from "./time.js";

export interface EventRow {
  id: number;
  source: string;
  source_id: string;
  title: string;
  start_utc: string;
  end_utc: string;
  timezone: string;
  all_day: number;
  recurrence: string | null;
  recurrence_until: string | null;
  reminder_minutes: number | null;
  kind: string;
  task_id: number | null;
  session_id: number | null;
  status: string;
  external_revision: string | null;
  series_id: number | null;
  cancelled_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface AddEventInput {
  title: string;
  start: Date;
  end: Date;
  timezone?: string;
  allDay?: boolean;
  recurrence?: string | null;
  recurrenceUntil?: string | null;
  reminderMinutes?: number;
  kind?: string;
  taskId?: number;
  sessionId?: number;
  source?: string;
  sourceId?: string;
  externalRevision?: string;
  seriesId?: number;
  status?: string;
}

export function addEvent(ctx: Ctx, input: AddEventInput): EventRow {
  if (input.end <= input.start) {
    throw new AppError("invalid_event", "Event end must be after its start");
  }
  const timestamp = ctx.now().toISOString();
  const result = run(
    ctx.db,
    `INSERT INTO events
     (source, source_id, title, start_utc, end_utc, timezone, all_day, recurrence, recurrence_until,
      reminder_minutes, kind, task_id, session_id, external_revision, series_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.source ?? "local",
    input.sourceId ?? `local-${randomUUID()}`,
    input.title,
    input.start.toISOString(),
    input.end.toISOString(),
    input.timezone ?? ctx.timezone,
    input.allDay ? 1 : 0,
    input.recurrence ?? null,
    input.recurrenceUntil ?? null,
    input.reminderMinutes ?? null,
    input.kind ?? "appointment",
    input.taskId ?? null,
    input.sessionId ?? null,
    input.externalRevision ?? null,
    input.seriesId ?? null,
    input.status ?? "confirmed",
    timestamp,
    timestamp,
  );
  return requireEvent(ctx, Number(result.lastInsertRowid));
}

export function getEvent(ctx: Ctx, id: number): EventRow | undefined {
  return one<EventRow>(ctx.db, "SELECT * FROM events WHERE id = ?", id);
}

export function requireEvent(ctx: Ctx, id: number): EventRow {
  const event = getEvent(ctx, id);
  if (!event) throw new AppError("event_not_found", `Event ${display("event", id)} was not found`);
  return event;
}

export interface EventView extends EventRow {
  ref: string;
  occurrence_ref: string;
  local_date: string;
  start_time: string;
  end_time: string;
  time_label: string;
  day_label: string;
  cancelled: boolean;
  task_ref: string | null;
  session_ref: string | null;
}

export function eventView(ctx: Ctx, event: EventRow, occurrenceDate?: string): EventView {
  const timezone = event.timezone || ctx.timezone;
  const date = occurrenceDate ?? localDateAt(parseInstant(event.start_utc), timezone);
  const today = localDateAt(ctx.now(), timezone);
  const ref = display("event", event.id);
  return {
    ...event,
    ref,
    occurrence_ref: occurrenceDate ? `${ref}@${date}` : ref,
    local_date: date,
    start_time: localTimeAt(event.start_utc, timezone),
    end_time: localTimeAt(event.end_utc, timezone),
    time_label: timeRangeLabel(ctx, event),
    day_label: relativeDay(date, today),
    cancelled: event.status === "cancelled",
    task_ref: event.task_id ? display("task", event.task_id) : null,
    session_ref: event.session_id ? display("session", event.session_id) : null,
  };
}

function timeRangeLabel(ctx: Ctx, event: EventRow): string {
  const timezone = event.timezone || ctx.timezone;
  const startDate = localDateAt(parseInstant(event.start_utc), timezone);
  const endDate = localDateAt(parseInstant(event.end_utc), timezone);
  if (event.all_day) return "All day";
  const start = localTimeAt(event.start_utc, timezone);
  const end = localTimeAt(event.end_utc, timezone);
  return startDate === endDate
    ? `${start}–${end}`
    : `${start}–${end} (${formatDateShort(endDate)})`;
}

export function occurrencesBetween(ctx: Ctx, from: Date, to: Date): EventView[] {
  const events = many<EventRow>(ctx.db, "SELECT * FROM events ORDER BY start_utc, id");
  const overrides = new Map<string, EventRow>();
  for (const event of events) {
    if (event.series_id)
      overrides.set(
        `${event.series_id}:${localDateAt(parseInstant(event.start_utc), event.timezone)}`,
        event,
      );
  }
  const result: EventView[] = [];
  for (const event of events) {
    if (event.series_id) continue;
    if (!event.recurrence) {
      const value = interval(event.start_utc, event.end_utc);
      if (overlaps(value, { start: from.getTime(), end: to.getTime() })) {
        result.push(eventView(ctx, event));
      }
      continue;
    }
    for (const date of recurrenceDates(event, from, to)) {
      const override = overrides.get(`${event.id}:${date}`);
      if (override) {
        if (override.status !== "cancelled") result.push(eventView(ctx, override, date));
        continue;
      }
      if (event.status === "cancelled") continue;
      const occurrence = occurrenceRow(event, date);
      if (
        occurrence &&
        overlaps(interval(occurrence.start_utc, occurrence.end_utc), {
          start: from.getTime(),
          end: to.getTime(),
        })
      ) {
        result.push(eventView(ctx, occurrence, date));
      }
    }
  }
  return result.sort((a, b) => a.start_utc.localeCompare(b.start_utc) || a.id - b.id);
}

function recurrenceDates(event: EventRow, from: Date, to: Date): string[] {
  const timezone = event.timezone || "Europe/Warsaw";
  const first = localDateAt(parseInstant(event.start_utc), timezone);
  const last = event.recurrence_until ?? localDateAt(to, timezone);
  const rangeStart = localDateAt(from, timezone);
  const rangeEnd = localDateAt(to, timezone);
  const result: string[] = [];
  let cursor = first < rangeStart ? rangeStart : first;
  const weekdays = weeklyDays(event.recurrence);
  while (cursor <= rangeEnd && cursor <= last && result.length < 370) {
    if (matchesRecurrence(cursor, first, event.recurrence, weekdays)) result.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return result;
}

function weeklyDays(recurrence: string | null): Set<number> {
  const match = /BYDAY=([A-Z,]+)/.exec(recurrence ?? "");
  if (!match?.[1]) return new Set();
  const names: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  return new Set(match[1].split(",").map((name) => names[name] ?? -1));
}

function matchesRecurrence(
  date: string,
  first: string,
  recurrence: string | null,
  weekdays: Set<number>,
): boolean {
  if (recurrence?.includes("FREQ=DAILY")) return true;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekdays.size > 0) return weekdays.has(weekday);
  const firstWeekday = new Date(`${first}T12:00:00Z`).getUTCDay();
  return weekday === firstWeekday;
}

function occurrenceRow(event: EventRow, date: string): EventRow | null {
  const timezone = event.timezone || "Europe/Warsaw";
  const startTime = localTimeAt(event.start_utc, timezone);
  const duration = parseInstant(event.end_utc).getTime() - parseInstant(event.start_utc).getTime();
  const start = zonedToUtc(date, startTime, timezone);
  return {
    ...event,
    start_utc: start.toISOString(),
    end_utc: new Date(start.getTime() + duration).toISOString(),
  };
}

export function findEventRef(ctx: Ctx, ref: string): { event: EventRow; date?: string } {
  const match = /^E(\d+)(?:@(\d{4}-\d{2}-\d{2}))?$/i.exec(ref.trim());
  if (!match?.[1])
    throw new AppError("invalid_reference", `Expected an event reference such as E01`);
  const id = Number(match[1]);
  const event = requireEvent(ctx, id);
  const date = match[2];
  if (!date) return { event };
  const occurrence = occurrenceRow(event, date);
  if (!occurrence) throw new AppError("event_not_found", `Event ${ref} has no occurrence`);
  return { event: occurrence, date };
}

export interface UpdateEventInput {
  title?: string;
  start?: Date;
  end?: Date;
  reminderMinutes?: number | null;
  recurrence?: string | null;
  status?: string;
  externalRevision?: string | null;
}

export function updateEvent(ctx: Ctx, id: number, input: UpdateEventInput): EventRow {
  const event = requireEvent(ctx, id);
  const start = input.start ?? parseInstant(event.start_utc);
  const end = input.end ?? parseInstant(event.end_utc);
  if (end <= start) throw new AppError("invalid_event", "Event end must be after its start");
  run(
    ctx.db,
    `UPDATE events SET title = ?, start_utc = ?, end_utc = ?, reminder_minutes = ?,
       recurrence = ?, status = ?, external_revision = ?, revision = revision + 1, updated_at = ?
     WHERE id = ?`,
    input.title ?? event.title,
    start.toISOString(),
    end.toISOString(),
    input.reminderMinutes === undefined ? event.reminder_minutes : input.reminderMinutes,
    input.recurrence === undefined ? event.recurrence : input.recurrence,
    input.status ?? event.status,
    input.externalRevision === undefined ? event.external_revision : input.externalRevision,
    ctx.now().toISOString(),
    id,
  );
  return requireEvent(ctx, id);
}

export function cancelEvent(ctx: Ctx, id: number): EventRow {
  return updateEvent(ctx, id, { status: "cancelled" });
}

export function updateOccurrence(
  ctx: Ctx,
  event: EventRow,
  date: string,
  input: UpdateEventInput,
): EventRow {
  const occurrence = occurrenceRow(event, date);
  if (!occurrence) throw new AppError("event_not_found", "Occurrence not found");
  const sourceId = `${event.source_id}@${date}`;
  const existing = one<EventRow>(
    ctx.db,
    "SELECT * FROM events WHERE source = ? AND source_id = ?",
    event.source,
    sourceId,
  );
  if (existing) {
    return updateEvent(ctx, existing.id, input);
  }
  return addEvent(ctx, {
    title: input.title ?? event.title,
    start: input.start ?? parseInstant(occurrence.start_utc),
    end: input.end ?? parseInstant(occurrence.end_utc),
    timezone: event.timezone,
    reminderMinutes:
      input.reminderMinutes === undefined
        ? (event.reminder_minutes ?? undefined)
        : (input.reminderMinutes ?? undefined),
    kind: event.kind,
    taskId: event.task_id ?? undefined,
    sessionId: event.session_id ?? undefined,
    source: event.source,
    sourceId,
    seriesId: event.id,
    recurrence: null,
    status: input.status,
  });
}

export function eventConflicts(
  ctx: Ctx,
  start: Date,
  end: Date,
  excludeSessionId?: number,
): EventView[] {
  const view = occurrencesBetween(ctx, start, end);
  return view.filter((event) => {
    if (event.status === "cancelled") return false;
    if (excludeSessionId && event.session_id === excludeSessionId) return false;
    return overlaps(interval(event.start_utc, event.end_utc), {
      start: start.getTime(),
      end: end.getTime(),
    });
  });
}

export function nextEvent(ctx: Ctx, after: Date = ctx.now()): EventView | undefined {
  const to = new Date(after.getTime() + 7 * 86_400_000);
  return occurrencesBetween(ctx, after, to).find(
    (event) => event.status !== "cancelled" && parseInstant(event.start_utc) > after,
  );
}

export function eventsOnDate(ctx: Ctx, date: string): EventView[] {
  const timezone = ctx.timezone;
  return occurrencesBetween(ctx, startOfLocalDay(date, timezone), endOfLocalDay(date, timezone));
}

export function showEvent(ctx: Ctx, ref: string) {
  const found = findEventRef(ctx, ref);
  const view = eventView(ctx, found.event, found.date);
  const reminder =
    view.reminder_minutes === null
      ? "none"
      : `${view.reminder_minutes} minutes before${
          view.source === "local"
            ? " (shown on the dashboard; no system notification)"
            : " (source may not deliver it)"
        }`;
  return { ...view, reminder_text: reminder };
}

export function addLocalEvent(
  ctx: Ctx,
  input: {
    title: string;
    when: string;
    duration?: string;
    reminderMinutes?: number;
    recurrence?: string;
    allDay?: boolean;
  },
) {
  const start = parseWhen(input.when, ctx.now(), ctx.timezone);
  const duration = input.duration ? input.duration : input.allDay ? "24h" : "1h";
  const seconds = parseDurationForEvent(duration);
  return addEvent(ctx, {
    title: input.title,
    start,
    end: new Date(start.getTime() + seconds * 1000),
    timezone: ctx.timezone,
    reminderMinutes: input.reminderMinutes,
    recurrence: input.recurrence,
    allDay: input.allDay,
  });
}

function parseDurationForEvent(value: string): number {
  const match = /^(\d+)([hms])$/.exec(value);
  if (!match) throw new AppError("invalid_duration", `Expected 30m, 1h, or 24h. Got: ${value}`);
  const amount = Number(match[1]);
  return match[2] === "h" ? amount * 3600 : match[2] === "m" ? amount * 60 : amount;
}
