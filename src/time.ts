import { AppError } from "./errors.js";

export interface Interval {
  start: number;
  end: number;
}

const DAY_MS = 86_400_000;

export function parseInstant(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError("invalid_time", `Invalid timestamp: ${value}`);
  }
  return date;
}

export function toIso(date: Date): string {
  return date.toISOString();
}

export function nowDate(nowOverride?: string): Date {
  return nowOverride ? parseInstant(nowOverride) : new Date();
}

export function zonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function localDateAt(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function localTimeAt(date: Date | string, timeZone: string): string {
  const parts = zonedParts(typeof date === "string" ? parseInstant(date) : date, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function offsetAt(utcMs: number, timeZone: string): number {
  const parts = zonedParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - utcMs;
}

export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) {
    throw new AppError("invalid_time", `Expected YYYY-MM-DD and HH:mm, got ${date} ${time}`);
  }
  const [, year, month, day] = dateMatch;
  const [, hour, minute] = timeMatch;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  let guess = base;
  for (let index = 0; index < 3; index += 1) {
    guess = base - offsetAt(guess, timeZone);
  }
  return new Date(guess);
}

export function startOfLocalDay(date: string, timeZone: string): Date {
  return zonedToUtc(date, "00:00", timeZone);
}

export function endOfLocalDay(date: string, timeZone: string): Date {
  return startOfLocalDay(addDays(date, 1), timeZone);
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days);
  const result = new Date(value);
  return `${result.getUTCFullYear()}-${pad(result.getUTCMonth() + 1)}-${pad(result.getUTCDate())}`;
}

export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1 + months, day ?? 1));
  return `${result.getUTCFullYear()}-${pad(result.getUTCMonth() + 1)}-${pad(result.getUTCDate())}`;
}

export function startOfWeek(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const weekday = value.getUTCDay();
  const shift = weekday === 0 ? -6 : 1 - weekday;
  return addDays(date, shift);
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function startOfQuarter(date: string): string {
  const month = Number(date.slice(5, 7));
  const quarterStart = Math.floor((month - 1) / 3) * 3 + 1;
  return `${date.slice(0, 4)}-${pad(quarterStart)}-01`;
}

export function startOfYear(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

export function formatDateLong(date: string): string {
  const value = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(value);
}

export function formatDateShort(date: string): string {
  const value = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(value);
}

export function relativeDay(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  if (date === addDays(today, -1)) return "Yesterday";
  return formatDateShort(date);
}

export function parseWhen(value: string, now: Date, timeZone: string): Date {
  if (value === "now") return now;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(value)) return parseInstant(value);
  const today = localDateAt(now, timeZone);
  const relative = /^(today|tomorrow|yesterday)(?:@(\d{2}:\d{2}))?$/.exec(value);
  if (relative) {
    const offset = relative[1] === "tomorrow" ? 1 : relative[1] === "yesterday" ? -1 : 0;
    const time = relative[2] ?? localTimeAt(now, timeZone);
    return zonedToUtc(addDays(today, offset), time, timeZone);
  }
  const dated = /^(\d{4}-\d{2}-\d{2})(?:@(\d{2}:\d{2}))?$/.exec(value);
  if (dated) {
    const time = dated[2] ?? "00:00";
    return zonedToUtc(dated[1] ?? today, time, timeZone);
  }
  throw new AppError(
    "invalid_time",
    `Use now, today@HH:mm, tomorrow@HH:mm, YYYY-MM-DD@HH:mm, or an ISO timestamp. Got: ${value}`,
  );
}

export function parseDuration(value: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value.trim());
  if (!match || value.trim() === "") {
    throw new AppError(
      "invalid_duration",
      `Expected a duration such as 30m, 1h, or 90s. Got: ${value}`,
    );
  }
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  if (seconds <= 0) throw new AppError("invalid_duration", "Duration must be positive");
  return seconds;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function formatPercent(ratio: number): string {
  const value = Math.round(ratio * 1000) / 10;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function interval(start: string | Date, end: string | Date): Interval {
  const startMs = typeof start === "string" ? parseInstant(start).getTime() : start.getTime();
  const endMs = typeof end === "string" ? parseInstant(end).getTime() : end.getTime();
  return { start: startMs, end: endMs };
}

export function isValidInterval(value: Interval): boolean {
  return Number.isFinite(value.start) && Number.isFinite(value.end) && value.end > value.start;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function clip(value: Interval, from: number, to: number): Interval | null {
  const start = Math.max(value.start, from);
  const end = Math.min(value.end, to);
  return end > start ? { start, end } : null;
}

export function union(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter(isValidInterval)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged.at(-1);
    if (last && current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

export function subtract(base: Interval, remove: Interval[]): Interval[] {
  const result: Interval[] = [];
  let cursor = base.start;
  for (const cut of union(remove)) {
    if (cut.end <= cursor) continue;
    if (cut.start >= base.end) break;
    if (cut.start > cursor) result.push({ start: cursor, end: Math.min(cut.start, base.end) });
    cursor = Math.max(cursor, cut.end);
    if (cursor >= base.end) break;
  }
  if (cursor < base.end) result.push({ start: cursor, end: base.end });
  return result;
}

export function subtractAll(base: Interval[], remove: Interval[]): Interval[] {
  return base.flatMap((item) => subtract(item, remove));
}

export function totalSeconds(intervals: Interval[]): number {
  return union(intervals).reduce((sum, item) => sum + (item.end - item.start) / 1000, 0);
}

export function intersectionSeconds(a: Interval[], b: Interval): number {
  return totalSeconds(a.map((value) => clip(value, b.start, b.end)).filter(Boolean) as Interval[]);
}

export function startOfIsoDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

export function daysBetween(from: string, to: string): string[] {
  const result: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    result.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return result;
}

export function daysInMonth(date: string): number {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, month ?? 1, 0)).getUTCDate();
}

export { DAY_MS };
