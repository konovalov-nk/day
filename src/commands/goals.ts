import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { display } from "../ids.js";
import {
  addGoal,
  goalSummary,
  importGoalRecords,
  listGoals,
  requireGoal,
  resolveGoalRef,
} from "../goals.js";
import { evaluateIntentionalDay, evaluationHistory, goalCheckText } from "../evaluations.js";
import { formatDuration, formatPercent } from "../time.js";
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
import { registerActivityCommands, registerRuleCommands } from "./activity.js";

interface Options extends CommonOptions {
  opId?: string;
  criterion?: string[];
  catalog?: string;
  specId?: string;
  sourceId?: string;
  date?: string;
  final?: boolean;
  file?: string;
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
  excludeApp?: string;
  excludeProject?: string;
  excludeUrl?: string;
}

export function registerGoalCommands(program: Command): void {
  const goal = program.command("goal").description("Personal goals, criteria, and daily checks");

  goal
    .command("add")
    .argument("<title>")
    .option("--criterion <text>", "acceptance criterion (repeatable)", collect, [])
    .option("--catalog <name>", "personal, software, or test", "personal")
    .option("--spec-id <id>")
    .option("--source-id <id>")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const title = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const result = mutate(ctx, `goal add ${title}`, options.opId, () =>
            addGoal(ctx, {
              title,
              criteria: options.criterion ?? [],
              catalog: options.catalog,
              specId: options.specId,
              sourceId: options.sourceId,
            }),
          );
          const view = goalSummary(ctx, requireGoal(ctx, result.value.goalId));
          output(view, options, [
            `Goal: ${display("goal", view.id)}`,
            ...(view.criteria[0] ? [`Criterion: ${view.criteria[0].ref}`] : []),
            `Stored in: ${view.catalog === "personal" ? "personal" : view.catalog} Coherence catalog`,
            `Status: ${view.status}`,
          ]);
        });
      }),
    );

  goal
    .command("show")
    .argument("<ref>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const ref = currentArgs()[0] ?? "";
        withCtx((ctx) => {
          const view = goalSummary(ctx, resolveGoalRef(ctx, ref));
          output(view, options, goalLines(view));
        });
      }),
    );

  goal
    .command("list")
    .option("--catalog <name>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const views = listGoals(ctx, options.catalog).map((row) => goalSummary(ctx, row));
          output(
            views,
            options,
            views.map(
              (view) =>
                `${view.ref}  ${view.title}  [${view.catalog}]  ${view.task_count} tasks  ${formatDuration(view.recorded_seconds)}`,
            ),
          );
        });
      }),
    );

  goal
    .command("import")
    .requiredOption("--file <path>", "JSONL exported from Coherence")
    .option("--catalog <name>", "personal, software, or test", "personal")
    .option("--op-id <id>")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const result = mutate(ctx, `goal import ${options.file}`, options.opId, () => {
            const records = readFileSync(options.file ?? "", "utf8")
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line) as Record<string, unknown>);
            return importGoalRecords(ctx, records as never, options.catalog ?? "personal");
          });
          output(
            result.value,
            options,
            result.value.map((item) => `Imported: ${display("goal", item.id)} (${item.sourceId})`),
          );
        });
      }),
    );

  goal
    .command("check")
    .argument("[slug]", "goal slug", "intentional-day")
    .option("--date <date>", "local date (default today)")
    .option("--final", "finalize the day result")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const slug = currentArgs()[0] ?? "intentional-day";
        if (slug !== "intentional-day") {
          throw new Error("Only the intentional-day goal check is implemented");
        }
        withCtx((ctx) => {
          const view = evaluateIntentionalDay(ctx, resolveDate(ctx, options.date), {
            final: options.final,
          });
          output(view, options, goalCheckText(view, ctx.now(), ctx.timezone));
        });
      }),
    );

  goal
    .command("history")
    .argument("[slug]", "goal slug", "intentional-day")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        const slug = currentArgs()[0] ?? "intentional-day";
        withCtx((ctx) => {
          const rows = evaluationHistory(ctx, slug);
          output(
            rows,
            options,
            rows.map(
              (row) =>
                `${row.ref}  ${row.period_date}  rev ${row.revision}  ${row.final_status}  ${formatPercent(Number(row.coverage ?? 0))}`,
            ),
          );
        });
      }),
    );

  registerRuleCommands(program);
  registerActivityCommands(program);
}

function goalLines(view: ReturnType<typeof goalSummary>): string[] {
  return [
    `${view.ref}  ${view.title}`,
    ...view.criteria.map((criterion) => `${criterion.ref}  ${criterion.text}`),
    `Tasks: ${view.task_count}`,
    `Recorded time: ${formatDuration(view.recorded_seconds)}`,
    `Catalog: ${view.catalog}`,
    `Status: ${view.status}`,
    ...(view.stale ? ["State: cached; Coherence is unavailable"] : []),
  ];
}
