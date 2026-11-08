import type { Ctx } from "./db.js";
import { many, one, run } from "./db.js";
import { AppError } from "./errors.js";
import { display } from "./ids.js";
import { attributeObservation, currentAttribution, type ObservationRow } from "./attribution.js";
import { formatDuration, interval, localTimeAt, parseInstant, totalSeconds } from "./time.js";

export interface RecordObservationInput {
  source: string;
  bucket?: string;
  eventId?: string;
  start: string;
  end: string;
  app?: string;
  project?: string;
  host?: string;
  device?: string;
  tmuxSession?: string;
  tmuxWindow?: string;
  tmuxPane?: string;
  url?: string;
  idle?: boolean;
  demo?: boolean;
}

export interface ObservationResult {
  observation: ObservationRow | null;
  excluded: boolean;
  invalidReason: string | null;
  attributionRef: string | null;
}

export function recordObservation(ctx: Ctx, input: RecordObservationInput): ObservationResult {
  const capture = captureState(ctx);
  if (capture.paused && !input.demo) {
    throw new AppError(
      "capture_paused",
      "Activity capture is paused. Run `day activity resume` first.",
    );
  }
  const start = parseInstant(input.start);
  const end = parseInstant(input.end);
  const invalidReason = validateObservation(start, end);
  if (isExcluded(ctx, input)) {
    insertCoverage(ctx, {
      source: input.source,
      device: input.device ?? null,
      watcher: input.source,
      start,
      end,
      status: "excluded",
      reason: "excluded by user",
    });
    return { observation: null, excluded: true, invalidReason: null, attributionRef: null };
  }
  const stored = storeObservation(ctx, input, start, end, invalidReason);
  touchSource(ctx, input.source, end.toISOString());
  if (invalidReason || input.idle) {
    return {
      observation: stored.observation,
      excluded: false,
      invalidReason,
      attributionRef: null,
    };
  }
  const attribution = attributeObservation(ctx, stored.observation, { force: stored.existed });
  return {
    observation: stored.observation,
    excluded: false,
    invalidReason: null,
    attributionRef: display("attribution", attribution.id),
  };
}

interface StoredObservation {
  observation: ObservationRow;
  existed: boolean;
}

function storeObservation(
  ctx: Ctx,
  input: RecordObservationInput,
  start: Date,
  end: Date,
  invalidReason: string | null,
): StoredObservation {
  const bucket = input.bucket ?? "default";
  const sourceId = input.eventId ?? `${input.source}-${start.getTime()}-${end.getTime()}`;
  const existing = one<ObservationRow>(
    ctx.db,
    "SELECT * FROM observations WHERE source = ? AND bucket = ? AND event_id = ?",
    input.source,
    bucket,
    sourceId,
  );
  const timestamp = ctx.now().toISOString();
  let observationId = existing?.id ?? 0;
  ctx.db.transaction(() => {
    const values = { input, start, end, invalidReason, timestamp };
    observationId = existing
      ? updateObservation(ctx, existing.id, values)
      : insertObservation(ctx, bucket, sourceId, values);
  })();
  return {
    observation: one<ObservationRow>(
      ctx.db,
      "SELECT * FROM observations WHERE id = ?",
      observationId,
    ) as ObservationRow,
    existed: Boolean(existing),
  };
}

interface ObservationValues {
  input: RecordObservationInput;
  start: Date;
  end: Date;
  invalidReason: string | null;
  timestamp: string;
}

function updateObservation(ctx: Ctx, id: number, values: ObservationValues): number {
  const { input, start, end, invalidReason, timestamp } = values;
  run(
    ctx.db,
    `UPDATE observations SET host = ?, device = ?, start_utc = ?, end_utc = ?, app = ?, project = ?,
       tmux_session = ?, tmux_window = ?, tmux_pane = ?, url = ?, idle = ?, demo = ?,
       invalid_reason = ?, received_at = ?, revision = revision + 1
     WHERE id = ?`,
    input.host ?? null,
    input.device ?? null,
    start.toISOString(),
    end.toISOString(),
    input.app ?? null,
    input.project ?? null,
    input.tmuxSession ?? null,
    input.tmuxWindow ?? null,
    input.tmuxPane ?? null,
    input.url ?? null,
    input.idle ? 1 : 0,
    input.demo ? 1 : 0,
    invalidReason,
    timestamp,
    id,
  );
  return id;
}

function insertObservation(
  ctx: Ctx,
  bucket: string,
  sourceId: string,
  values: ObservationValues,
): number {
  const { input, start, end, invalidReason, timestamp } = values;
  const result = run(
    ctx.db,
    `INSERT INTO observations
     (source, bucket, event_id, host, device, start_utc, end_utc, app, project,
      tmux_session, tmux_window, tmux_pane, url, idle, demo, invalid_reason, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.source,
    bucket,
    sourceId,
    input.host ?? null,
    input.device ?? null,
    start.toISOString(),
    end.toISOString(),
    input.app ?? null,
    input.project ?? null,
    input.tmuxSession ?? null,
    input.tmuxWindow ?? null,
    input.tmuxPane ?? null,
    input.url ?? null,
    input.idle ? 1 : 0,
    input.demo ? 1 : 0,
    invalidReason,
    timestamp,
  );
  return Number(result.lastInsertRowid);
}

function validateObservation(start: Date, end: Date): string | null {
  if (end <= start) return "negative_duration";
  const earliest = Date.UTC(1970, 0, 1);
  const latest = Date.UTC(2100, 0, 1);
  if (start.getTime() < earliest || end.getTime() > latest) return "impossible_timestamp";
  if (end.getTime() - start.getTime() > 36 * 3_600_000) return "interval_too_long";
  return null;
}

function isExcluded(ctx: Ctx, input: RecordObservationInput): boolean {
  const exclusions = many<{ match_type: string; pattern: string }>(
    ctx.db,
    "SELECT * FROM exclusions",
  );
  return exclusions.some((exclusion) => {
    if (exclusion.match_type === "app")
      return (input.app ?? "").toLowerCase().includes(exclusion.pattern.toLowerCase());
    if (exclusion.match_type === "project")
      return (input.project ?? "").startsWith(exclusion.pattern);
    if (exclusion.match_type === "url") return (input.url ?? "").startsWith(exclusion.pattern);
    return false;
  });
}

export function captureState(ctx: Ctx): {
  paused: boolean;
  paused_at: string | null;
  reason: string | null;
} {
  const row = one<{ paused: number; paused_at: string | null; reason: string | null }>(
    ctx.db,
    "SELECT paused, paused_at, reason FROM capture_state WHERE id = 1",
  );
  return {
    paused: Boolean(row?.paused),
    paused_at: row?.paused_at ?? null,
    reason: row?.reason ?? null,
  };
}

export function pauseCapture(ctx: Ctx, reason?: string): void {
  run(
    ctx.db,
    "UPDATE capture_state SET paused = 1, paused_at = ?, reason = ?, updated_at = ? WHERE id = 1",
    ctx.now().toISOString(),
    reason ?? null,
    ctx.now().toISOString(),
  );
}

export function resumeCapture(ctx: Ctx): void {
  const state = captureState(ctx);
  if (!state.paused) return;
  const started = state.paused_at ? parseInstant(state.paused_at) : ctx.now();
  insertCoverage(ctx, {
    source: "capture",
    device: null,
    watcher: "capture",
    start: started,
    end: ctx.now(),
    status: "paused",
    reason: state.reason,
  });
  run(
    ctx.db,
    "UPDATE capture_state SET paused = 0, paused_at = NULL, reason = NULL, updated_at = ? WHERE id = 1",
    ctx.now().toISOString(),
  );
}

function insertCoverage(
  ctx: Ctx,
  input: {
    source: string;
    device: string | null;
    watcher: string;
    start: Date;
    end: Date;
    status: string;
    reason: string | null;
  },
): void {
  run(
    ctx.db,
    `INSERT INTO coverage_intervals (source, device, watcher, start_utc, end_utc, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.source,
    input.device,
    input.watcher,
    input.start.toISOString(),
    input.end.toISOString(),
    input.status,
    input.reason,
    ctx.now().toISOString(),
  );
}

export function addExclusion(ctx: Ctx, matchType: string, pattern: string) {
  if (!["app", "project", "url"].includes(matchType)) {
    throw new AppError("invalid_exclusion", "Exclusion type must be app, project, or url");
  }
  run(
    ctx.db,
    "INSERT INTO exclusions (match_type, pattern, created_at) VALUES (?, ?, ?)",
    matchType,
    pattern,
    ctx.now().toISOString(),
  );
}

export interface ExclusionRow {
  id: number;
  match_type: string;
  pattern: string;
  created_at: string;
}

export function listExclusions(ctx: Ctx): ExclusionRow[] {
  return many<ExclusionRow>(ctx.db, "SELECT * FROM exclusions ORDER BY id");
}

export interface ImportRecord {
  source?: string;
  bucket?: string;
  event_id?: string;
  eventId?: string;
  start: string;
  end: string;
  app?: string;
  project?: string;
  url?: string;
  host?: string;
  device?: string;
  idle?: boolean;
  demo?: boolean;
  tmux_session?: string;
  tmux_window?: string;
  tmux_pane?: string;
}

export function importObservations(ctx: Ctx, source: string, records: ImportRecord[]) {
  validateImport(records);
  let imported = 0;
  let checkpoint: string | null = null;
  try {
    ctx.db.transaction(() => {
      for (const record of records) {
        const result = recordObservation(ctx, {
          source: record.source ?? source,
          bucket: record.bucket,
          eventId: record.event_id ?? record.eventId,
          start: record.start,
          end: record.end,
          app: record.app,
          project: record.project,
          url: record.url,
          host: record.host,
          device: record.device,
          idle: record.idle,
          demo: record.demo,
          tmuxSession: record.tmux_session,
          tmuxWindow: record.tmux_window,
          tmuxPane: record.tmux_pane,
        });
        if (result.observation && !result.invalidReason) {
          imported += 1;
          if (!checkpoint || result.observation.end_utc > checkpoint) {
            checkpoint = result.observation.end_utc;
          }
        }
      }
      if (checkpoint) touchSource(ctx, source, checkpoint);
    })();
  } catch (error) {
    recordSourceFailure(ctx, source, error instanceof Error ? error.message : String(error));
    throw error;
  }
  return { imported, checkpoint };
}

function validateImport(records: ImportRecord[]): void {
  if (!Array.isArray(records)) throw new AppError("invalid_import", "Import must be a JSON array");
  for (const record of records) {
    if (!record.start || !record.end) {
      throw new AppError("invalid_import", "Every imported record needs start and end");
    }
    parseInstant(record.start);
    parseInstant(record.end);
  }
}

export function touchSource(ctx: Ctx, source: string, checkpoint: string): void {
  const timestamp = ctx.now().toISOString();
  run(
    ctx.db,
    `INSERT INTO source_state (source, last_checkpoint, last_success_at, consecutive_errors, stale, updated_at)
     VALUES (?, ?, ?, 0, 0, ?)
     ON CONFLICT(source) DO UPDATE SET
       last_checkpoint = CASE WHEN source_state.last_checkpoint IS NULL OR source_state.last_checkpoint < ?
                              THEN ? ELSE source_state.last_checkpoint END,
       last_success_at = excluded.last_success_at,
       consecutive_errors = 0,
       stale = 0,
       updated_at = excluded.updated_at`,
    source,
    checkpoint,
    timestamp,
    timestamp,
    checkpoint,
    checkpoint,
  );
}

export function recordSourceFailure(ctx: Ctx, source: string, message: string): void {
  const timestamp = ctx.now().toISOString();
  run(
    ctx.db,
    `INSERT INTO source_state (source, last_error, consecutive_errors, stale, updated_at)
     VALUES (?, ?, 1, 0, ?)
     ON CONFLICT(source) DO UPDATE SET
       last_error = excluded.last_error,
       consecutive_errors = consecutive_errors + 1,
       stale = CASE WHEN consecutive_errors + 1 >= 3 THEN 1 ELSE stale END,
       updated_at = excluded.updated_at`,
    source,
    message,
    timestamp,
  );
}

export function sourceStates(ctx: Ctx) {
  return many<{
    source: string;
    last_checkpoint: string | null;
    last_success_at: string | null;
    last_error: string | null;
    consecutive_errors: number;
    stale: number;
    updated_at: string;
  }>(ctx.db, "SELECT * FROM source_state ORDER BY source");
}

export function activityStatus(ctx: Ctx) {
  const states = sourceStates(ctx);
  const capture = captureState(ctx);
  const lastObservation = one<ObservationRow>(
    ctx.db,
    "SELECT * FROM observations ORDER BY received_at DESC, id DESC LIMIT 1",
  );
  const attribution = lastObservation ? currentAttribution(ctx, lastObservation.id) : undefined;
  return {
    capture: capture.paused ? "paused" : "enabled",
    paused_at: capture.paused_at,
    sources: states,
    last_observation: lastObservation
      ? {
          ...lastObservation,
          ref: display("observation", lastObservation.id),
          start_time: localTimeAt(lastObservation.start_utc, ctx.timezone),
          end_time: localTimeAt(lastObservation.end_utc, ctx.timezone),
        }
      : null,
    last_attribution: attribution
      ? {
          ...attribution,
          ref: display("attribution", attribution.id),
          task_ref: attribution.task_id ? display("task", attribution.task_id) : null,
          goal_ref: attribution.goal_id ? display("goal", attribution.goal_id) : null,
        }
      : null,
  };
}

export function observationSeconds(ctx: Ctx, from: Date, to: Date): number {
  const rows = many<ObservationRow>(
    ctx.db,
    `SELECT * FROM observations
     WHERE invalid_reason IS NULL AND start_utc < ? AND end_utc > ? ORDER BY start_utc`,
    to.toISOString(),
    from.toISOString(),
  );
  return totalSeconds(
    rows
      .map((row) => interval(row.start_utc, row.end_utc))
      .map((value) => ({
        start: Math.max(value.start, from.getTime()),
        end: Math.min(value.end, to.getTime()),
      }))
      .filter((value) => value.end > value.start),
  );
}

export function listObservations(
  ctx: Ctx,
  from: Date,
  to: Date,
  limit: number,
  offset: number,
): { rows: Array<ObservationRow & { ref: string; demo_label: string }>; total: number } {
  if (to.getTime() - from.getTime() > 7 * 86_400_000) {
    throw new AppError("range_too_large", "Raw observation queries are limited to 7 days");
  }
  const total =
    one<{ count: number }>(
      ctx.db,
      "SELECT COUNT(*) AS count FROM observations WHERE start_utc < ? AND end_utc > ?",
      to.toISOString(),
      from.toISOString(),
    )?.count ?? 0;
  const rows = many<ObservationRow>(
    ctx.db,
    `SELECT * FROM observations WHERE start_utc < ? AND end_utc > ?
     ORDER BY start_utc LIMIT ? OFFSET ?`,
    to.toISOString(),
    from.toISOString(),
    Math.min(limit, 500),
    offset,
  );
  return {
    rows: rows.map((row) => ({
      ...row,
      ref: display("observation", row.id),
      demo_label: row.demo ? "demo" : "real",
    })),
    total,
  };
}

export function activityStatusText(ctx: Ctx): string[] {
  const status = activityStatus(ctx);
  const lines = [
    `Desktop watcher: ${watcherLabel(status.sources, "desktop", ctx.now())}`,
    `Browser watcher: unsupported (no browser extension in this example)`,
    `Tmux watcher: ${watcherLabel(status.sources, "tmux", ctx.now())}`,
    `Capture: ${status.capture}`,
  ];
  if (status.last_observation) {
    if (status.last_observation.project)
      lines.push(`Foreground project: ${status.last_observation.project}`);
    if (status.last_observation.app) lines.push(`Application: ${status.last_observation.app}`);
    lines.push(`Last update: ${status.last_observation.end_time} (${status.last_observation.ref})`);
  } else {
    lines.push("Last update: never");
  }
  if (status.last_attribution?.task_ref) {
    lines.push(
      `Matching task: ${status.last_attribution.task_ref} (${status.last_attribution.method})`,
    );
  } else if (status.last_attribution) {
    lines.push(`Matching task: none (${status.last_attribution.status})`);
  }
  return lines;
}

function watcherLabel(
  sources: Array<{ source: string; last_success_at: string | null; stale: number }>,
  source: string,
  now: Date,
): string {
  const state = sources.find((row) => row.source === source);
  if (!state?.last_success_at) return "not running";
  if (state.stale) return `stale (last ${localTimeAt(state.last_success_at, "UTC")} UTC)`;
  const age = now.getTime() - parseInstant(state.last_success_at).getTime();
  return age < 120_000 ? "running" : `last update ${formatDuration(age / 1000)} ago`;
}
