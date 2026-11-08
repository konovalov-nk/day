import type { Command } from "commander";
import { spawn } from "node:child_process";
import { buildDashboard, dashboardText } from "../dashboard.js";
import { ci, deploy, prepare, setup, start, status, statusText, stop } from "../service.js";
import { action, output, withCtx, withCtxAsync, type CommonOptions } from "../cli-util.js";
import { serveForever } from "../serve.js";

interface Options extends CommonOptions {
  browser?: boolean;
  demo?: boolean;
}

export function registerServiceCommands(program: Command): void {
  const open = program
    .command("open")
    .description("Print the dashboard URL")
    .option("--browser", "open the URL in the default browser")
    .option("--json", "JSON output");
  open.action(
    action(() => {
      const options = open.opts<Options>();
      withCtx((ctx) => {
        output({ url: ctx.config.baseUrl }, options, [`Opened: ${ctx.config.baseUrl}`]);
        if (options.browser) {
          spawn("xdg-open", [ctx.config.baseUrl], { detached: true, stdio: "ignore" }).unref();
        }
      });
    }),
  );

  const today = program
    .command("today")
    .description("Show the current day")
    .option("--json", "JSON output");
  today.action(
    action(() => {
      const options = today.opts<Options>();
      withCtx((ctx) => {
        const data = buildDashboard(ctx);
        output(data, options, dashboardText(data));
      });
    }),
  );

  program
    .command("serve")
    .description("Run the dashboard in the foreground")
    .action(
      action(async () => {
        const { createCtx } = await import("../db.js");
        await serveForever(createCtx());
      }),
    );

  const prepareCommand = program
    .command("prepare")
    .description("Check local requirements")
    .option("--json", "JSON output");
  prepareCommand.action(
    action(async () => {
      const options = prepareCommand.opts<Options>();
      await withCtxAsync(async (ctx) => {
        const checks = await prepare(ctx);
        output(
          checks,
          options,
          checks.map((check) => `${symbol(check.status)} ${check.name}: ${check.detail}`),
        );
        if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
      });
    }),
  );

  const setupCommand = program
    .command("setup")
    .description("Create configuration and local stores without replacing data")
    .option("--demo", "also create the labelled demo scenario")
    .option("--json", "JSON output");
  setupCommand.action(
    action(() => {
      const options = setupCommand.opts<Options>();
      withCtx((ctx) => {
        const result = setup(ctx, { demo: options.demo });
        output(result, options, [
          result.created_env
            ? `Configuration: ${result.env_path}`
            : "Configuration: existing .env kept",
          ...result.imported_goals.map(
            (goal) => `Imported goal: G${String(goal.id).padStart(2, "0")} (${goal.sourceId})`,
          ),
          ...(result.demo?.seeded ? ["Demo scenario: created"] : []),
          result.password_hint,
          "Next: `make ci`, then `make start`.",
        ]);
      });
    }),
  );

  program
    .command("ci")
    .description("Run checks with disposable stores")
    .action(
      action(() => {
        withCtx((ctx) => {
          const code = ci(ctx);
          process.exitCode = code;
          output({ exit_code: code }, {}, [
            code === 0 ? "CI passed" : `CI failed with exit code ${code}`,
          ]);
        });
      }),
    );

  const startCommand = program
    .command("start")
    .description("Start the dashboard")
    .option("--json", "JSON output");
  startCommand.action(
    action(() => {
      const options = startCommand.opts<Options>();
      withCtx((ctx) => {
        const result = start(ctx);
        output(result, options, [
          `Started: ${result.url}`,
          `PID: ${result.pid}`,
          "Credentials: see .env (DAY_USER / DAY_PASSWORD).",
          "Watchers: run `day activity watch` in another terminal when needed.",
        ]);
      });
    }),
  );

  const stopCommand = program
    .command("stop")
    .description("Stop the dashboard, preserving data")
    .option("--json", "JSON output");
  stopCommand.action(
    action(() => {
      const options = stopCommand.opts<Options>();
      withCtx((ctx) => {
        const result = stop(ctx);
        output(result, options, [
          result.stopped ? `Stopped: pid ${result.pid}` : "Already stopped",
        ]);
      });
    }),
  );

  const statusCommand = program
    .command("status")
    .description("Show service, watcher, and store status")
    .option("--json", "JSON output");
  statusCommand.action(
    action(() => {
      const options = statusCommand.opts<Options>();
      withCtx((ctx) => {
        const view = status(ctx);
        output(view, options, statusText(ctx, view));
        if (!view.server.running) process.exitCode = 1;
      });
    }),
  );

  const deployCommand = program
    .command("deploy")
    .description("Check local HTTPS deployment through Caddy")
    .option("--json", "JSON output");
  deployCommand.action(
    action(() => {
      const options = deployCommand.opts<Options>();
      withCtx((ctx) => {
        const result = deploy(ctx);
        output(result, options, [
          ...result.steps,
          result.ok ? "Deployment check: ok" : "Deployment check: failed",
        ]);
        if (!result.ok) process.exitCode = 1;
      });
    }),
  );
}

function symbol(status: "ok" | "warn" | "fail"): string {
  if (status === "ok") return "✓";
  if (status === "warn") return "!";
  return "✗";
}
