import type { Command } from "commander";
import { display, parseRef } from "../ids.js";
import { addNote, deleteNote, listNotes, noteView, updateNote, type NoteLink } from "../notes.js";
import {
  addConclusion,
  addExperiment,
  experimentText,
  listExperiments,
  requireExperiment,
  showExperiment,
  type ExperimentMetric,
} from "../experiments.js";
import { report, reportText, type Period } from "../reports.js";
import { exportData, importData, writeBackup, deleteEntity } from "../data.js";
import {
  action,
  currentArgs,
  currentOpts,
  collect,
  mutate,
  output,
  resolveDate,
  withCtx,
  type CommonOptions,
} from "../cli-util.js";

interface Options extends CommonOptions {
  opId?: string;
  task?: string;
  goal?: string;
  session?: string;
  experiment?: string;
  visibility?: string;
  limit?: string;
  text?: string;
  hypothesis?: string;
  change?: string;
  metric?: string;
  baseline?: string;
  period?: string;
  note?: string[];
  author?: string;
  method?: string;
  date?: string;
  out?: string;
  in?: string;
  public?: boolean;
  force?: boolean;
}

export function registerNoteCommands(program: Command): void {
  const note = program.command("note").description("Private notes beside activity and results");

  note
    .command("add")
    .argument("<text>")
    .option("--task <ref>")
    .option("--goal <ref>")
    .option("--session <ref>")
    .option("--experiment <ref>")
    .option("--visibility <name>", "private or public", "private")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const text = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const links = noteLinks(options);
          const result = mutate(ctx, `note add`, options.opId, () =>
            addNote(ctx, { text, links, visibility: options.visibility }),
          );
          output(result.value, options, [
            `Note: ${result.value.ref}`,
            `Visibility: ${result.value.visibility}`,
            ...(result.value.links.length > 0
              ? [`Links: ${result.value.links.map((link) => link.ref).join(", ")}`]
              : []),
          ]);
        });
      }),
    );

  note
    .command("list")
    .option("--limit <number>", "maximum notes", "20")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const rows = listNotes(ctx, Number(options.limit ?? 20));
          output(
            rows,
            options,
            rows.map(
              (row) => `${row.ref}  ${row.created_at.slice(0, 16).replace("T", " ")}  ${row.text}`,
            ),
          );
        });
      }),
    );

  note
    .command("show")
    .argument("<ref>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const view = noteView(ctx, parseRef(ref, "note"));
          output(view, options, [
            `${view.ref}  ${view.visibility}`,
            view.text,
            ...view.links.map((link) => `Link: ${link.ref}`),
            ...view.revisions.map(
              (revision) => `Revision ${revision.revision}: ${revision.text} (${revision.author})`,
            ),
          ]);
        });
      }),
    );

  note
    .command("update")
    .argument("<ref>")
    .requiredOption("--text <text>")
    .option("--visibility <name>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `note update ${ref}`, options.opId, () =>
            updateNote(ctx, parseRef(ref, "note"), {
              text: options.text ?? "",
              visibility: options.visibility,
            }),
          );
          output(result.value, options, [
            `${result.value.ref} updated · revision ${result.value.revisions.at(-1)?.revision ?? 0}`,
          ]);
        });
      }),
    );

  note
    .command("delete")
    .argument("<ref>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `note delete ${ref}`, options.opId, () =>
            deleteNote(ctx, parseRef(ref, "note"), ctx.config.actor),
          );
          output(result.value, options, [
            `Deleted: ${result.value.deleted}`,
            result.value.backup_effect,
          ]);
        });
      }),
    );
}

function noteLinks(options: Options): NoteLink[] {
  const links: NoteLink[] = [];
  if (options.task) links.push({ kind: "task", ref: options.task });
  if (options.goal) links.push({ kind: "goal", ref: options.goal });
  if (options.session) links.push({ kind: "session", ref: options.session });
  if (options.experiment) links.push({ kind: "experiment", ref: options.experiment });
  return links;
}

export function registerExperimentCommands(program: Command): void {
  const experiment = program
    .command("experiment")
    .description("Personal experiments and comparisons");

  experiment
    .command("add")
    .argument("<title>")
    .requiredOption("--hypothesis <text>")
    .requiredOption(
      "--metric <metric>",
      "session-adherence, goal-time, qualifying-tasks, progress-completeness",
    )
    .requiredOption("--baseline <range>", "YYYY-MM-DD..YYYY-MM-DD")
    .requiredOption("--period <range>", "YYYY-MM-DD..YYYY-MM-DD")
    .option("--change <text>")
    .option("--note <ref>", "link a note (repeatable)", collect, [])
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const title = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `experiment add ${title}`, options.opId, () =>
            addExperiment(ctx, {
              title,
              hypothesis: options.hypothesis ?? "",
              change: options.change,
              metric: options.metric as ExperimentMetric,
              baseline: options.baseline ?? "",
              period: options.period ?? "",
              noteIds: (options.note ?? []).map((ref) => parseRef(ref, "note")),
            }),
          );
          output(result.value, options, experimentText(result.value));
        });
      }),
    );

  experiment
    .command("list")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const rows = listExperiments(ctx);
          output(
            rows,
            options,
            rows.map(
              (row) =>
                `${row.ref}  ${row.title}  ${row.metric}  ${row.baseline_start}..${row.period_end}`,
            ),
          );
        });
      }),
    );

  experiment
    .command("show")
    .argument("<ref>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const view = showExperiment(ctx, parseRef(ref, "experiment"));
          output(view, options, experimentText(view));
        });
      }),
    );

  experiment
    .command("conclude")
    .argument("<ref>")
    .requiredOption("--text <text>")
    .option("--method <method>", "manual or agent", "manual")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          requireExperiment(ctx, parseRef(ref, "experiment"));
          const result = mutate(ctx, `experiment conclude ${ref}`, options.opId, () =>
            addConclusion(ctx, parseRef(ref, "experiment"), {
              text: options.text ?? "",
              method: options.method,
            }),
          );
          output(result.value, options, [
            `Conclusion for ${ref}: ${result.value.text}`,
            `Method: ${options.method ?? "manual"}`,
          ]);
        });
      }),
    );
}

export function registerReportCommand(program: Command): void {
  const reportCommand = program
    .command("report")
    .option("--period <period>", "day, week, month, quarter, or year", "week")
    .option("--date <date>", "local date (default today)")
    .option("--json", "JSON output");
  reportCommand.action(
    action(() => {
      const options = reportCommand.opts<Options>();
      const period = (options.period ?? "week") as Period;
      if (!["day", "week", "month", "quarter", "year"].includes(period)) {
        throw new Error("Period must be day, week, month, quarter, or year");
      }
      withCtx((ctx) => {
        const view = report(ctx, period, resolveDate(ctx, options.date));
        output(view, options, reportText(view, ctx.config.baseUrl));
      });
    }),
  );
}

export function registerDataCommands(program: Command): void {
  const data = program.command("data").description("Export, restore, and delete personal records");

  data
    .command("export")
    .requiredOption("--out <path>", "write a backup file")
    .option("--public", "only records selected for publication")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const result = writeBackup(ctx, options.out ?? "", { publicOnly: options.public });
          output(result, options, [
            `Backup: ${result.file}`,
            `Checksum: ${result.checksum}`,
            ...Object.entries(result.counts).map(([table, count]) => `${table}: ${count}`),
          ]);
        });
      }),
    );

  data
    .command("import")
    .requiredOption("--in <path>", "backup file")
    .option("--force", "restore over existing records")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const result = importData(ctx, options.in ?? "", options.force);
          output(result, options, [
            `Tables: ${result.tables}`,
            `Checksum matches: ${result.matches ? "yes" : "no"}`,
            ...Object.entries(result.restored).map(([table, count]) => `${table}: ${count}`),
          ]);
        });
      }),
    );

  data
    .command("delete")
    .option("--task <ref>")
    .option("--note <ref>")
    .option("--session <ref>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<{
          task?: string;
          note?: string;
          session?: string;
          opId?: string;
          json?: boolean;
        }>();
        withCtx((ctx) => {
          const result = mutate(ctx, "data delete", options.opId, () =>
            deleteEntity(ctx, { task: options.task, note: options.note, session: options.session }),
          );
          output(result.value, options, [`Deleted: ${result.value.deleted}`, result.value.effect]);
        });
      }),
    );
}

export { exportData, display };
