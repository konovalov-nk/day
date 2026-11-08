import type { Command } from "commander";
import { display, parseRef } from "../ids.js";
import {
  addTask,
  completeTask,
  groupedTasks,
  requireTask,
  setTaskState,
  taskContext,
  taskShow,
  updateTask,
  type TaskRow,
} from "../tasks.js";
import {
  cancelSession,
  endSession,
  requireSession,
  retimeSession,
  scheduleSession,
  sessionShow,
  sessionShowText,
  startSession,
} from "../sessions.js";
import { getEvent } from "../events.js";
import { sessionMetrics } from "../metrics.js";
import {
  endOfLocalDay,
  formatPercent,
  localTimeAt,
  parseDuration,
  parseWhen,
  startOfLocalDay,
} from "../time.js";
import {
  action,
  currentArgs,
  currentOpts,
  collect,
  mutate,
  output,
  today,
  withCtx,
  type CommonOptions,
} from "../cli-util.js";

interface Options extends CommonOptions {
  goal?: string[];
  clearGoals?: boolean;
  urgent?: string;
  importance?: string;
  state?: string;
  title?: string;
  opId?: string;
}

const CATEGORY_ORDER = [
  "inbox",
  "urgent_high",
  "nonurgent_high",
  "urgent_low",
  "nonurgent_low",
] as const;

export function registerTaskCommands(program: Command): void {
  const task = program.command("task").description("Capture, classify, start, and complete tasks");

  task
    .command("add")
    .argument("<title>")
    .option("--json", "JSON output")
    .option("--op-id <id>", "idempotency operation ID")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const title = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `task add ${title}`, options.opId, () =>
            addTask(ctx, { title }),
          );
          output({ ...result.value, ref: display("task", result.value.id) }, options, [
            `Created: ${display("task", result.value.id)}`,
            "Category: inbox",
            "Goal: not set",
          ]);
        });
      }),
    );

  task
    .command("update")
    .argument("<ref>")
    .option("--title <title>")
    .option("--goal <ref>", "goal reference (repeatable)", collect, [])
    .option("--no-goals", "remove goal links")
    .option("--urgent <yes|no>")
    .option("--importance <high|low>")
    .option("--state <state>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options & { goals?: boolean }>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const id = parseRef(ref, "task");
          const result = mutate(ctx, `task update ${ref}`, options.opId, () =>
            updateTask(ctx, id, {
              title: options.title,
              goalRefs: options.goal && options.goal.length > 0 ? options.goal : undefined,
              clearGoals: options.clearGoals || options.goals === false,
              urgency: urgency(options.urgent),
              importance: importance(options.importance),
              state: options.state as TaskRow["state"] | undefined,
            }),
          );
          output(
            { ...result.value, ref: display("task", result.value.id) },
            options,
            taskShowText(taskShow(ctx, id)),
          );
        });
      }),
    );

  task
    .command("list")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const groups = groupedTasks(ctx);
          const view = Object.fromEntries(
            Object.entries(groups).map(([key, rows]) => [
              key,
              rows.map((row) => ({ ...row, ref: display("task", row.id) })),
            ]),
          );
          output(view, options, taskListText(groups));
        });
      }),
    );

  task
    .command("show")
    .argument("<ref>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const view = taskShow(ctx, parseRef(ref, "task"));
          output(view, options, taskShowText(view));
        });
      }),
    );

  task
    .command("context")
    .argument("<ref>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const view = taskContext(ctx, parseRef(ref, "task"));
          output(view, { ...options, json: true });
        });
      }),
    );

  task
    .command("start")
    .argument("<ref>")
    .requiredOption("--duration <duration>", "planned duration, e.g. 30m")
    .option("--at <when>", "start time (default now)")
    .option("--allow-overlap", "allow overlapping appointments")
    .option("--replace", "end a running session before starting")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<
          Options & { duration: string; at?: string; allowOverlap?: boolean; replace?: boolean }
        >();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const id = parseRef(ref, "task");
          const start = options.at ? parseWhen(options.at, ctx.now(), ctx.timezone) : ctx.now();
          const result = mutate(ctx, `task start ${ref}`, options.opId, () =>
            startSession(ctx, {
              taskId: id,
              durationSeconds: parseDuration(options.duration),
              start,
              allowOverlap: options.allowOverlap,
              replace: options.replace,
            }),
          );
          printSessionStart(ctx, result.value, result.operationId, options);
        });
      }),
    );

  task
    .command("schedule")
    .argument("<ref>")
    .requiredOption("--start <when>", "start time, e.g. tomorrow@09:00")
    .requiredOption("--duration <duration>", "planned duration, e.g. 30m")
    .option("--allow-overlap", "allow overlapping appointments")
    .option("--replace", "end a running session before scheduling")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<
          Options & { start: string; duration: string; allowOverlap?: boolean; replace?: boolean }
        >();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `task schedule ${ref}`, options.opId, () =>
            scheduleSession(ctx, {
              taskId: parseRef(ref, "task"),
              start: parseWhen(options.start, ctx.now(), ctx.timezone),
              durationSeconds: parseDuration(options.duration),
              allowOverlap: options.allowOverlap,
              replace: options.replace,
            }),
          );
          printSessionStart(ctx, result.value, result.operationId, options);
        });
      }),
    );

  task
    .command("complete")
    .argument("<ref>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `task complete ${ref}`, options.opId, () =>
            completeTask(ctx, parseRef(ref, "task")),
          );
          output({ ...result.value, ref: display("task", result.value.id) }, options, [
            `${display("task", result.value.id)}  ${result.value.title}`,
            "State: completed",
          ]);
        });
      }),
    );

  task
    .command("cancel")
    .argument("<ref>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `task cancel ${ref}`, options.opId, () =>
            setTaskState(ctx, parseRef(ref, "task"), "cancelled"),
          );
          output({ ...result.value, ref: display("task", result.value.id) }, options, [
            `${display("task", result.value.id)}  ${result.value.title}`,
            "State: cancelled",
          ]);
        });
      }),
    );

  registerSessionCommands(program);
}

function printSessionStart(
  ctx: import("../db.js").Ctx,
  session: import("../metrics.js").SessionRow,
  operationId: string,
  options: Options,
): void {
  const task = requireTask(ctx, session.task_id);
  const event = session.event_id ? getEvent(ctx, session.event_id) : undefined;
  output({ ...session, ref: display("session", session.id), operation_id: operationId }, options, [
    `Session: ${display("session", session.id)}`,
    `Task: ${display("task", task.id)} — ${task.title}`,
    `Goal: ${session.goal_id ? display("goal", session.goal_id) : "none"}`,
    `Calendar block: ${
      event
        ? `${display("event", event.id)}, ${localTimeAt(event.start_utc, ctx.timezone)}–${localTimeAt(event.end_utc, ctx.timezone)}`
        : "none"
    }`,
    `State: ${session.state}`,
  ]);
}

function urgency(value: string | undefined): "urgent" | "not_urgent" | undefined {
  if (value === undefined) return undefined;
  return ["yes", "true", "1", "urgent"].includes(value.toLowerCase()) ? "urgent" : "not_urgent";
}

function importance(value: string | undefined): "high" | "low" | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "high" || normalized === "low") return normalized;
  return undefined;
}

function taskShowText(view: ReturnType<typeof taskShow>): string[] {
  const goals = view.goals.map((goal) => `${goal.ref} — ${goal.title}`).join(", ");
  const lines = [
    `${view.ref}  ${view.title}`,
    `Goal: ${goals || "not set"}`,
    `Category: ${view.category_text}`,
    `State: ${view.state}`,
  ];
  if (view.last_progress) lines.push(`Last progress: ${view.last_progress.summary}`);
  if (view.last_session)
    lines.push(`Last session: ${view.last_session.ref} (${view.last_session.state})`);
  return lines;
}

function taskListText(groups: ReturnType<typeof groupedTasks>): string[] {
  const labels: Record<string, string> = {
    inbox: "Inbox",
    urgent_high: "Urgent + high priority",
    nonurgent_high: "Non-urgent + high priority",
    urgent_low: "Urgent + low priority",
    nonurgent_low: "Non-urgent + low priority",
  };
  return CATEGORY_ORDER.map((key) => {
    const tasks = groups[key];
    const detail =
      tasks.length > 0
        ? `  ${tasks.map((row) => `${display("task", row.id)} ${row.title}`).join(", ")}`
        : "";
    return `${`${labels[key]}:`.padEnd(32)}${String(tasks.length).padStart(2)}${detail}`;
  });
}

function registerSessionCommands(program: Command): void {
  const session = program.command("session").description("Inspect and close work sessions");

  session
    .command("show")
    .argument("<ref>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const id = parseRef(ref, "session");
          output(sessionShow(ctx, id), options, sessionShowText(ctx, id));
        });
      }),
    );

  session
    .command("end")
    .argument("<ref>")
    .requiredOption("--progress <text>", "what changed during the session")
    .option("--artifact <path>", "optional result link")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options & { progress: string; artifact?: string }>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const id = parseRef(ref, "session");
          const result = mutate(ctx, `session end ${ref}`, options.opId, () =>
            endSession(ctx, id, {
              progress: options.progress,
              artifact: options.artifact,
              operationId: options.opId,
            }),
          );
          const row = result.value.session;
          const task = requireTask(ctx, row.task_id);
          output(
            {
              session: { ...row, ref: display("session", row.id) },
              progress_id: display("progress", result.value.progressId),
              operation_id: result.operationId,
            },
            options,
            [
              `Session ${display("session", row.id)}: ended at ${localTimeAt(row.actual_end ?? ctx.now().toISOString(), ctx.timezone)}`,
              `Progress entry: ${display("progress", result.value.progressId)}`,
              ...(options.artifact ? [`Result: ${options.artifact}`] : []),
              `Task ${display("task", task.id)}: paused, not completed`,
            ],
          );
        });
      }),
    );

  session
    .command("start")
    .argument("<ref>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const id = parseRef(ref, "session");
          const result = mutate(ctx, `session start ${ref}`, options.opId, () => {
            const row = requireSession(ctx, id);
            if (row.state !== "planned") {
              throw new Error("Only a planned session can be started");
            }
            const timestamp = ctx.now().toISOString();
            ctx.db
              .prepare(
                "UPDATE sessions SET state = 'running', actual_start = ?, updated_at = ? WHERE id = ?",
              )
              .run(timestamp, timestamp, id);
            ctx.db
              .prepare(
                "UPDATE tasks SET state = 'in_progress', updated_at = ? WHERE id = ? AND state NOT IN ('completed','cancelled')",
              )
              .run(timestamp, row.task_id);
            return requireSession(ctx, id);
          });
          output(result.value, options, [
            `Session: ${display("session", result.value.id)}`,
            `State: ${result.value.state}`,
          ]);
        });
      }),
    );

  session
    .command("cancel")
    .argument("<ref>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `session cancel ${ref}`, options.opId, () =>
            cancelSession(ctx, parseRef(ref, "session")),
          );
          output(result.value, options, [
            `Session ${display("session", result.value.id)}: cancelled`,
          ]);
        });
      }),
    );

  session
    .command("retime")
    .argument("<ref>")
    .requiredOption("--start <when>")
    .requiredOption("--duration <duration>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options & { start: string; duration: string }>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const start = parseWhen(options.start, ctx.now(), ctx.timezone);
          const end = new Date(start.getTime() + parseDuration(options.duration) * 1000);
          const result = mutate(ctx, `session retime ${ref}`, options.opId, () =>
            retimeSession(ctx, parseRef(ref, "session"), start, end),
          );
          output(result.value, options, [
            `Session ${display("session", result.value.id)}: plan revision ${result.value.plan_revision}`,
            `Planned: ${localTimeAt(result.value.planned_start, ctx.timezone)}–${localTimeAt(result.value.planned_end, ctx.timezone)}`,
          ]);
        });
      }),
    );

  session
    .command("list")
    .option("--date <date>", "local date (default today)")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options & { date?: string }>();
        withCtx((ctx) => {
          const date = options.date ?? today(ctx);
          const rows = sessionList(ctx, date);
          output(
            rows,
            options,
            rows.map(
              (row) => `${row.ref}  ${row.task_ref}  ${row.state}  ${formatPercent(row.adherence)}`,
            ),
          );
        });
      }),
    );
}

function sessionList(ctx: import("../db.js").Ctx, date: string) {
  const rows = ctx.db
    .prepare(
      "SELECT * FROM sessions WHERE planned_start < ? AND planned_end > ? ORDER BY planned_start",
    )
    .all(
      endOfLocalDay(date, ctx.timezone).toISOString(),
      startOfLocalDay(date, ctx.timezone).toISOString(),
    ) as Array<{
    id: number;
    task_id: number;
    state: string;
    planned_start: string;
    planned_end: string;
  }>;
  return rows.map((row) => ({
    ...row,
    ref: display("session", row.id),
    task_ref: display("task", row.task_id),
    adherence: sessionMetrics(ctx, {
      id: row.id,
      task_id: row.task_id,
      goal_id: null,
      event_id: null,
      planned_start: row.planned_start,
      planned_end: row.planned_end,
      actual_start: null,
      actual_end: null,
      state: row.state,
      plan_revision: 1,
      operation_id: null,
      created_at: "",
      updated_at: "",
    }).adherence,
  }));
}
