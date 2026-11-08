import type { Command } from "commander";
import { display } from "../ids.js";
import {
  addLocalEvent,
  cancelEvent,
  eventView,
  findEventRef,
  occurrencesBetween,
  showEvent,
  updateEvent,
  updateOccurrence,
} from "../events.js";
import type { Ctx } from "../db.js";
import { endOfLocalDay, parseDuration, parseWhen, startOfLocalDay } from "../time.js";
import {
  action,
  currentArgs,
  currentOpts,
  mutate,
  output,
  resolveDate,
  withCtx,
  type CommonOptions,
} from "../cli-util.js";
import { importCalendarEvents } from "../calendar-import.js";

interface Options extends CommonOptions {
  opId?: string;
  date?: string;
  at?: string;
  from?: string;
  to?: string;
  duration?: string;
  reminder?: string;
  recurrence?: string;
  allDay?: boolean;
  title?: string;
  start?: string;
  end?: string;
  file?: string;
}

export function registerCalendarCommands(program: Command): void {
  const calendar = program
    .command("calendar")
    .description("Manage local calendar blocks and imports");

  calendar
    .command("add")
    .argument("<title>")
    .requiredOption("--at <when>", "start, e.g. tomorrow@09:00")
    .option("--duration <duration>", "duration (default 1h)", "1h")
    .option("--reminder <minutes>", "reminder minutes before")
    .option("--recurrence <rule>", "FREQ=DAILY or FREQ=WEEKLY;BYDAY=MO,TH")
    .option("--all-day", "all-day event")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const title = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `calendar add ${title}`, options.opId, () => {
            const event = addLocalEvent(ctx, {
              title,
              when: options.at ?? "",
              duration: options.allDay ? "24h" : options.duration,
              reminderMinutes: options.reminder ? Number(options.reminder) : undefined,
              recurrence: options.recurrence,
              allDay: options.allDay,
            });
            return eventView(ctx, event);
          });
          output(result.value, options, eventLines(ctx, result.value));
        });
      }),
    );

  calendar
    .command("list")
    .option("--date <date>", "local date (default today)")
    .option("--from <date>", "first local date")
    .option("--to <date>", "last local date")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const from = options.from
            ? resolveDate(ctx, options.from)
            : resolveDate(ctx, options.date);
          const to = options.to ?? from;
          const events = occurrencesBetween(
            ctx,
            startOfLocalDay(from, ctx.timezone),
            endOfLocalDay(to, ctx.timezone),
          );
          output(
            events,
            options,
            events.map(
              (event) =>
                `${event.day_label.padEnd(9)} ${event.time_label.padEnd(13)} ${event.ref}  ${event.title}${event.status === "cancelled" ? " (cancelled)" : ""}`,
            ),
          );
        });
      }),
    );

  calendar
    .command("show")
    .argument("<ref>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const view = showEvent(ctx, ref);
          output(view, options, [
            `${view.occurrence_ref}  ${view.title}`,
            `${view.day_label}, ${view.time_label}`,
            `Reminder: ${view.reminder_text}`,
            `Source: ${view.source === "local" ? "local calendar" : view.source}`,
            ...(view.recurrence ? [`Recurrence: ${view.recurrence}`] : []),
            ...(view.session_ref ? [`Session: ${view.session_ref}`] : []),
          ]);
        });
      }),
    );

  calendar
    .command("update")
    .argument("<ref>")
    .option("--title <title>")
    .option("--start <when>")
    .option("--duration <duration>")
    .option("--reminder <minutes>")
    .option("--recurrence <rule>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `calendar update ${ref}`, options.opId, () => {
            const found = findEventRef(ctx, ref);
            const start = options.start
              ? parseWhen(options.start, ctx.now(), ctx.timezone)
              : undefined;
            const end =
              start && options.duration
                ? new Date(start.getTime() + parseDuration(options.duration) * 1000)
                : undefined;
            const input = {
              title: options.title,
              start,
              end,
              reminderMinutes: options.reminder ? Number(options.reminder) : undefined,
              recurrence: options.recurrence,
            };
            return found.date
              ? updateOccurrence(ctx, found.event, found.date, input)
              : updateEvent(ctx, found.event.id, input);
          });
          const view = eventView(ctx, result.value);
          output(view, options, eventLines(ctx, view));
        });
      }),
    );

  calendar
    .command("cancel")
    .argument("<ref>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `calendar cancel ${ref}`, options.opId, () => {
            const found = findEventRef(ctx, ref);
            return found.date
              ? updateOccurrence(ctx, found.event, found.date, { status: "cancelled" })
              : cancelEvent(ctx, found.event.id);
          });
          output(result.value, options, [`Event ${display("event", result.value.id)}: cancelled`]);
        });
      }),
    );

  calendar
    .command("import")
    .requiredOption("--file <path>", "JSON array of events")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const result = mutate(ctx, `calendar import ${options.file}`, undefined, () =>
            importCalendarEvents(ctx, options.file ?? ""),
          );
          output(result.value, options, [
            `Imported: ${result.value.imported}`,
            `Updated: ${result.value.updated}`,
            `Unchanged: ${result.value.unchanged}`,
          ]);
        });
      }),
    );
}

function eventLines(ctx: Ctx, event: ReturnType<typeof eventView>): string[] {
  const reminder =
    event.reminder_minutes === null
      ? "Reminder: none"
      : `Reminder: ${event.reminder_minutes} minutes before`;
  return [
    `${event.occurrence_ref}  ${event.title}`,
    `${event.day_label}, ${event.time_label}`,
    reminder,
    `Source: ${event.source === "local" ? "local calendar" : event.source}`,
  ];
}

export { eventLines };
