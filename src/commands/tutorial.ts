import type { Command } from "commander";
import {
  tutorialNext,
  tutorialReset,
  tutorialStatus,
  tutorialText,
  TUTORIAL_STEPS,
} from "../tutorial.js";
import { demoSeed, demoStatus } from "../demo.js";
import {
  action,
  currentArgs,
  currentOpts,
  output,
  withCtx,
  withCtxAsync,
  type CommonOptions,
} from "../cli-util.js";

interface Options extends CommonOptions {
  opId?: string;
}

export function registerTutorialCommand(program: Command): void {
  const tutorial = program
    .command("tutorial")
    .argument("[action]", "status, next, reset, or start", "status")
    .description("Guided first task cycle")
    .option("--json", "JSON output");

  tutorial.action(
    action(async () => {
      const options = currentOpts<Options>();
      const actionName = currentArgs()[0] ?? "status";
      if (actionName === "status" || actionName === "start") {
        withCtx((ctx) => {
          const steps = tutorialStatus(ctx);
          output(steps, options, [
            "Day tutorial",
            ...tutorialText(steps),
            "",
            `Next: ${steps.find((step) => step.status !== "done")?.hint ?? "All steps are complete."}`,
          ]);
        });
        return;
      }
      if (actionName === "reset") {
        withCtx((ctx) => {
          tutorialReset(ctx);
          output({ reset: true, steps: TUTORIAL_STEPS.length }, options, [
            "Tutorial progress reset. Records are kept.",
          ]);
        });
        return;
      }
      if (actionName === "next") {
        await withCtxAsync(async (ctx) => {
          const result = await tutorialNext(ctx, ctx.config.baseUrl);
          if (result.complete) {
            output(result, options, [
              "Tutorial complete.",
              `Website: ${result.tomorrow.website}`,
              ...(result.tomorrow.last_progress
                ? [`Last progress: ${result.tomorrow.last_progress}`]
                : []),
              ...(result.tomorrow.command ? [`Tomorrow: ${result.tomorrow.command}`] : []),
            ]);
            return;
          }
          const check = result.check;
          output(result, options, [
            ...(check.ok
              ? [`Step complete: ${check.step} — ${check.evidence}`]
              : [`Step pending: ${check.step} — ${check.evidence}`]),
            ...(check.hint ? [`Hint: ${check.hint}`] : []),
            `Next: ${result.next_step?.hint ?? "run `day tutorial next` again"}`,
          ]);
        });
        return;
      }
      throw new Error("Use tutorial status, next, reset, or start");
    }),
  );
}

export function registerDemoCommands(program: Command): void {
  const demo = program.command("demo").description("Synthetic scenario for local exploration");

  demo
    .command("seed")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const result = demoSeed(ctx);
          output(result, options, [
            result.seeded ? "Demo scenario created." : "Demo scenario already exists.",
            `Goal: ${result.result.goal}`,
            `Tasks: ${result.result.tasks.join(", ")}`,
            `Event: ${result.result.event}`,
            `Session: ${result.result.session}`,
            `Rules: ${result.result.rules.join(", ")}`,
            `Observations: ${result.result.observations.join(", ")}`,
            `Progress: ${result.result.progress}`,
            `Note: ${result.result.note}`,
            `Experiment: ${result.result.experiment}`,
            `Evaluation: ${result.result.evaluation}`,
            "Observations are labelled demo; real tracking still needs a watcher.",
          ]);
        });
      }),
    );

  demo
    .command("status")
    .option("--json", "JSON output")
    .action(
      action(() => {
        const options = currentOpts<Options>();
        withCtx((ctx) => {
          const seeded = demoStatus(ctx);
          output({ seeded }, options, [seeded ? "Demo data: present" : "Demo data: none"]);
        });
      }),
    );
}
