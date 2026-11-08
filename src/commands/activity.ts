import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { display, parseRef } from "../ids.js";
import {
  acceptSuggestion,
  addRule,
  attributeRange,
  explainAt,
  explainText,
  listRules,
  manualAssign,
  manualAssignText,
  suggestAttribution,
  updateRule,
  type MatchType,
} from "../attribution.js";
import {
  activityStatus,
  activityStatusText,
  addExclusion,
  importObservations,
  listExclusions,
  pauseCapture,
  recordObservation,
  resumeCapture,
  type ImportRecord,
} from "../activity.js";
import { requireSession } from "../sessions.js";
import { sessionMetrics } from "../metrics.js";
import {
  localDateAt,
  localTimeAt,
  parseDuration,
  parseInstant,
  parseWhen,
  zonedToUtc,
} from "../time.js";
import {
  action,
  currentArgs,
  currentOpts,
  parseClock,
  mutate,
  output,
  withCtx,
  type CommonOptions,
} from "../cli-util.js";

interface Options extends CommonOptions {
  opId?: string;
  task?: string;
  project?: string;
  urlPrefix?: string;
  app?: string;
  tmux?: string;
  rank?: string;
  pattern?: string;
  disable?: boolean;
  enable?: boolean;
  source?: string;
  at?: string;
  url?: string;
  start?: string;
  end?: string;
  duration?: string;
  file?: string;
  eventId?: string;
  bucket?: string;
  device?: string;
  host?: string;
  idle?: boolean;
  demo?: boolean;
  session?: string;
  from?: string;
  to?: string;
  reason?: string;
  force?: boolean;
  observation?: string;
  method?: string;
  modelVersion?: string;
  uncertainty?: string;
}

export function registerRuleCommands(program: Command): void {
  const rule = program.command("rule").description("Attribution rules");

  rule
    .command("add")
    .requiredOption("--task <ref>")
    .option("--project <pattern>", "project path prefix")
    .option("--url-prefix <prefix>", "active browser tab URL prefix")
    .option("--app <name>", "foreground application")
    .option("--tmux <pattern>", "tmux session:window:pane prefix")
    .option("--rank <number>", "higher wins when rules conflict")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const match = ruleMatch(options);
          const result = mutate(ctx, "rule add", options.opId, () =>
            addRule(ctx, {
              taskId: parseRef(options.task ?? "", "task"),
              matchType: match.type,
              pattern: match.pattern,
              rank: options.rank ? Number(options.rank) : 0,
            }),
          );
          output(result.value, options, ruleLines(ctx, result.value));
        });
      }),
    );

  rule
    .command("list")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const rows = listRules(ctx);
          output(
            rows,
            options,
            rows.map(
              (row) =>
                `${display("rule", row.id)}  v${row.version}  ${row.active ? "active" : "disabled"}  ${row.match_type}:${row.pattern}  -> ${display("task", row.task_id)}  rank ${row.rank}`,
            ),
          );
        });
      }),
    );

  rule
    .command("update")
    .argument("<ref>")
    .option("--pattern <pattern>")
    .option("--rank <number>")
    .option("--disable")
    .option("--enable")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `rule update ${ref}`, options.opId, () =>
            updateRule(ctx, parseRef(ref, "rule"), {
              pattern: options.pattern,
              rank: options.rank ? Number(options.rank) : undefined,
              active: options.disable ? false : options.enable ? true : undefined,
            }),
          );
          output(result.value, options, ruleLines(ctx, result.value));
        });
      }),
    );
}

export function parseSessionTime(
  ctx: import("../db.js").Ctx,
  sessionId: number,
  value: string,
): Date {
  if (/^\d{2}:\d{2}$/.test(value)) {
    const session = requireSession(ctx, sessionId);
    const date = localDateAt(parseInstant(session.planned_start), ctx.timezone);
    return zonedToUtc(date, value, ctx.timezone);
  }
  return parseWhen(value, ctx.now(), ctx.timezone);
}

function ruleMatch(options: Options): { type: MatchType; pattern: string } {
  if (options.project) return { type: "project", pattern: options.project };
  if (options.urlPrefix) return { type: "url", pattern: options.urlPrefix };
  if (options.app) return { type: "app", pattern: options.app };
  if (options.tmux) return { type: "tmux", pattern: options.tmux };
  throw new Error("Choose one of --project, --url-prefix, --app, or --tmux");
}

function ruleLines(
  ctx: import("../db.js").Ctx,
  rule: import("../attribution.js").RuleRow,
): string[] {
  const match =
    rule.match_type === "project"
      ? `foreground project ${rule.pattern}`
      : rule.match_type === "url"
        ? `active browser tab with URL prefix ${rule.pattern}`
        : rule.match_type === "app"
          ? `foreground application ${rule.pattern}`
          : `tmux context ${rule.pattern}`;
  return [
    `Rule: ${display("rule", rule.id)}, version ${rule.version}`,
    `Match: ${match}`,
    `Assign matched activity to: ${display("task", rule.task_id)}`,
    `Rank: ${rule.rank}`,
  ];
}

export function registerActivityCommands(program: Command): void {
  const activity = program.command("activity").description("Record, inspect, and correct activity");
  registerWatchCommands(activity);
  registerImportCommands(activity);
  registerCorrectionCommands(activity);
}

function registerWatchCommands(activity: Command): void {
  activity
    .command("watch")
    .description("Record foreground tmux or desktop activity")
    .option("--source <source>", "tmux or desktop", "tmux")
    .option("--project <path>", "override the project path")
    .option("--interval <seconds>", "poll interval", "10")
    .action(
      action(async () => {
        const options = currentOpts<Options & { interval?: string }>();
        const { createCtx } = await import("../db.js");
        const { watchForever } = await import("../watcher.js");
        watchForever(createCtx(), {
          source: options.source === "desktop" ? "desktop" : "tmux",
          project: options.project,
          intervalSeconds: Math.max(2, Number(options.interval ?? 10)),
        });
      }),
    );

  activity
    .command("status")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          output(activityStatus(ctx), options, activityStatusText(ctx));
        });
      }),
    );

  activity
    .command("record")
    .requiredOption("--source <source>", "tmux, desktop, browser, manual, or activitywatch")
    .requiredOption("--start <when>", "interval start")
    .option("--end <when>", "interval end")
    .option("--duration <duration>", "alternative to --end")
    .option("--project <path>")
    .option("--app <name>")
    .option("--url <url>")
    .option("--tmux <session:window:pane>")
    .option("--event-id <id>")
    .option("--bucket <bucket>")
    .option("--device <device>")
    .option("--host <host>")
    .option("--idle", "record idle time")
    .option("--demo", "label a synthetic demo observation")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const start = parseClock(ctx, options.start ?? "");
          const end = options.end
            ? parseClock(ctx, options.end)
            : new Date(start.getTime() + parseDuration(options.duration ?? "1m") * 1000);
          const [tmuxSession, tmuxWindow, tmuxPane] = (options.tmux ?? "").split(":");
          const result = recordObservation(ctx, {
            source: options.source ?? "manual",
            start: start.toISOString(),
            end: end.toISOString(),
            project: options.project,
            app: options.app,
            url: options.url,
            tmuxSession: tmuxSession || undefined,
            tmuxWindow: tmuxWindow || undefined,
            tmuxPane: tmuxPane || undefined,
            eventId: options.eventId,
            bucket: options.bucket,
            device: options.device,
            host: options.host,
            idle: options.idle,
            demo: options.demo,
          });
          const view = {
            observation: result.observation
              ? { ...result.observation, ref: display("observation", result.observation.id) }
              : null,
            attribution: result.attributionRef,
            excluded: result.excluded,
            invalid_reason: result.invalidReason,
          };
          output(view, options, [
            ...(result.excluded
              ? ["Interval excluded before storage."]
              : result.observation
                ? [
                    `Observation: ${display("observation", result.observation.id)}`,
                    `Source: ${result.observation.source}`,
                    `Interval: ${localTimeAt(start.toISOString(), ctx.timezone)}–${localTimeAt(end.toISOString(), ctx.timezone)}`,
                    ...(result.invalidReason
                      ? [`Stored as invalid: ${result.invalidReason}`]
                      : [`Attribution: ${result.attributionRef ?? "none"}`]),
                    ...(options.demo ? ["Demo observation (does not satisfy real tracking)."] : []),
                  ]
                : []),
          ]);
        });
      }),
    );
}

function registerImportCommands(activity: Command): void {
  activity
    .command("import")
    .requiredOption("--file <path>", "JSON array of ActivityWatch events")
    .option("--source <source>", "source name", "activitywatch")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const records = JSON.parse(readFileSync(options.file ?? "", "utf8")) as ImportRecord[];
          const result = mutate(ctx, `activity import ${options.file}`, undefined, () =>
            importObservations(ctx, options.source ?? "activitywatch", records),
          );
          output(result.value, options, [
            `Imported: ${result.value.imported}`,
            `Checkpoint: ${result.value.checkpoint ?? "unchanged"}`,
          ]);
        });
      }),
    );

  activity
    .command("pause")
    .option("--reason <text>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options & { reason?: string }>();
        withCtx((ctx) => {
          mutate(ctx, "activity pause", options.opId, () => pauseCapture(ctx, options.reason));
          output({ capture: "paused" }, options, [
            "Capture paused",
            "This interval will appear as paused, not as idle time",
          ]);
        });
      }),
    );

  activity
    .command("resume")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          mutate(ctx, "activity resume", options.opId, () => resumeCapture(ctx));
          output({ capture: "enabled" }, options, ["Capture resumed"]);
        });
      }),
    );
}

function registerCorrectionCommands(activity: Command): void {
  activity
    .command("explain")
    .requiredOption("--session <ref>")
    .requiredOption("--at <when>", "local time or timestamp")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const sessionId = parseRef(options.session ?? "", "session");
          const at = parseSessionTime(ctx, sessionId, options.at ?? "");
          const view = explainAt(ctx, sessionId, at);
          output(view, options, explainText(view, ctx.timezone));
        });
      }),
    );

  activity
    .command("assign")
    .requiredOption("--session <ref>")
    .requiredOption("--from <when>")
    .requiredOption("--to <when>")
    .requiredOption("--task <ref>")
    .requiredOption("--reason <text>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const sessionId = parseRef(options.session ?? "", "session");
          requireSession(ctx, sessionId);
          const result = mutate(ctx, "activity assign", options.opId, () =>
            manualAssign(ctx, {
              sessionId,
              from: parseSessionTime(ctx, sessionId, options.from ?? ""),
              to: parseSessionTime(ctx, sessionId, options.to ?? ""),
              taskId: parseRef(options.task ?? "", "task"),
              reason: options.reason ?? "",
            }),
          );
          const session = requireSession(ctx, sessionId);
          const metrics = sessionMetrics(ctx, session);
          output(
            { ...result.value, metrics, session_ref: display("session", sessionId) },
            options,
            manualAssignText(
              result.value,
              {
                adherence: metrics.adherence,
                coverage: metrics.coverage,
                adherence_status: metrics.adherence_status,
              },
              display("session", sessionId),
            ),
          );
        });
      }),
    );

  activity
    .command("attribute")
    .requiredOption("--from <when>")
    .requiredOption("--to <when>")
    .option("--force", "replace manual corrections")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const result = attributeRange(
            ctx,
            parseWhen(options.from ?? "", ctx.now(), ctx.timezone),
            parseWhen(options.to ?? "", ctx.now(), ctx.timezone),
            { force: options.force },
          );
          output(result, options, [
            `Updated: ${result.updated}`,
            `Skipped manual corrections: ${result.skipped}`,
          ]);
        });
      }),
    );

  activity
    .command("exclude")
    .option("--app <pattern>")
    .option("--project <pattern>")
    .option("--url <prefix>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          if (options.app) addExclusion(ctx, "app", options.app);
          if (options.project) addExclusion(ctx, "project", options.project);
          if (options.url) addExclusion(ctx, "url", options.url);
          const rows = listExclusions(ctx);
          output(
            rows,
            options,
            rows.map((row) => `${row.id}  ${row.match_type}:${row.pattern}`),
          );
        });
      }),
    );

  activity
    .command("suggest")
    .requiredOption("--observation <ref>")
    .requiredOption("--task <ref>")
    .requiredOption("--method <method>")
    .option("--model-version <version>")
    .option("--uncertainty <number>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const row = suggestAttribution(ctx, {
            observationId: parseRef(options.observation ?? "", "observation"),
            taskId: parseRef(options.task ?? "", "task"),
            method: options.method ?? "llm",
            modelVersion: options.modelVersion,
            uncertainty: options.uncertainty ? Number(options.uncertainty) : undefined,
          });
          output(row, options, [
            `Suggestion: ${display("suggestion", Number(row.id))}`,
            `Status: ${row.status}`,
            `Method: ${String(row.method)} ${String(row.model_version ?? "")}`,
            `Uncertainty: ${String(row.uncertainty ?? "unknown")}`,
            "Suggestions are not accepted attributions until accepted.",
          ]);
        });
      }),
    );

  activity
    .command("accept-suggestion")
    .argument("<ref>")
    .requiredOption("--reason <text>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const row = acceptSuggestion(ctx, parseRef(ref, "suggestion"), options.reason ?? "");
          output(row, options, [
            `Attribution: ${display("attribution", row.id)}`,
            `Task: ${row.task_id ? display("task", row.task_id) : "none"}`,
            "Method: agent_accepted",
          ]);
        });
      }),
    );
}
